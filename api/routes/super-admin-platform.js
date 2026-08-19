"use strict";

/**
 * agently-server/api/routes/super-admin-platform.js
 * Mounted at /api/super-admin/platform
 *
 * Backend for the "Agently assistant" super-admin screen. The frontend has
 * always called these endpoints; no router implemented them, so the screen
 * reported "This screen could not finish loading". (Until now the path was
 * accidentally serving the TOUR router, whose responses the screen could not
 * parse — see api/index.js.)
 *
 * Everything here is behind requireSuperAdmin. It edits the platform's own
 * assistant — its prompt, FAQs, public knowledge sources and spend cap — and
 * reads confidentiality violations, none of which any tenant may see or touch.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const {
  requireSuperAdmin,
  logSecurityEvent,
} = require("../../lib/super-admin-auth");
const {
  PLATFORM_ORG_ID,
  PLATFORM_KNOWLEDGE_BASE_ID,
  PLATFORM_CHATBOT_ID,
  SUPPORT_EMAIL,
  getPlatformOrganization,
  getPlatformChatbot,
  getPlatformSpendStatus,
  invalidatePlatformCache,
} = require("../../lib/platform-assistant");

const router = express.Router();
router.use(requireSuperAdmin);

const str = (v, fallback = "") =>
  v === undefined || v === null ? fallback : String(v);

function serializeChatbot(row) {
  const settings =
    row && typeof row.settings === "object" && row.settings ? row.settings : {};
  return {
    id: str(row?.id, PLATFORM_CHATBOT_ID),
    name: str(row?.name, "Agently Assistant"),
    headerTitle: str(row?.header_title || settings.headerTitle, "Agently"),
    welcomeMessage: str(row?.welcome_message || settings.welcomeMessage, ""),
    placeholder: str(settings.placeholder, "Ask about Agently…"),
    accentColor: str(settings.accentColor || row?.accent_color, "#F59E0B"),
    position: str(settings.position, "bottom-right"),
    customPrompt: str(row?.custom_prompt, ""),
    suggestedPrompts: Array.isArray(settings.suggestedPrompts)
      ? settings.suggestedPrompts.map((p) => str(p))
      : [],
    supportEmail: str(settings.supportEmail, SUPPORT_EMAIL),
    confidentialityMode: str(settings.confidentialityMode, "strict"),
    isActive: row?.is_active !== false,
    knowledgeBaseId: str(
      row?.knowledge_base_id,
      PLATFORM_KNOWLEDGE_BASE_ID || "",
    ),
  };
}

// ── GET / — everything the admin screen renders ──────────────
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const db = getSupabase();
    const [org, chatbot, spend] = await Promise.all([
      getPlatformOrganization().catch(() => null),
      getPlatformChatbot().catch(() => null),
      getPlatformSpendStatus().catch(() => null),
    ]);

    const kbId = chatbot?.knowledge_base_id || PLATFORM_KNOWLEDGE_BASE_ID;
    const orgId = org?.id || PLATFORM_ORG_ID;

    const [faqs, sources, violations, supportRequests] = await Promise.all([
      db
        .from("faqs")
        .select("id,question,answer,is_published,display_order,created_at")
        .eq("organization_id", orgId)
        .order("display_order", { ascending: true })
        .limit(500)
        .then((r) => r.data || [], () => []),
      db
        .from("knowledge_sources")
        .select("id,url,title,scrape_status,last_scraped_at,created_at")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(200)
        .then((r) => r.data || [], () => []),
      db
        .from("platform_assistant_violations")
        .select("id,question,matched_terms,raw_response,created_at")
        .order("created_at", { ascending: false })
        .limit(100)
        .then((r) => r.data || [], () => []),
      db
        .from("platform_support_requests")
        .select(
          "id,contact_name,contact_email,subject,body,status,created_at,organization_id,attachments",
        )
        .order("created_at", { ascending: false })
        .limit(200)
        .then((r) => r.data || [], () => []),
    ]);

    res.json({
      chatbot: serializeChatbot(chatbot),
      organization: {
        id: orgId,
        name: str(org?.name, "Agently"),
        dailySpendCapUsd: Number(org?.platform_daily_spend_cap_usd || 0),
      },
      spend: {
        capUsd: Number(spend?.capUsd || org?.platform_daily_spend_cap_usd || 0),
        spentUsd: Number(spend?.spentUsd || 0),
        degraded: Boolean(spend?.degraded),
      },
      faqs: faqs.map((f) => ({
        id: f.id,
        question: str(f.question),
        answer: str(f.answer),
        isPublished: f.is_published !== false,
        displayOrder: Number(f.display_order || 0),
        createdAt: f.created_at,
      })),
      sources: sources.map((s) => ({
        id: s.id,
        url: str(s.url),
        title: str(s.title),
        status: str(s.scrape_status, "pending"),
        lastScrapedAt: s.last_scraped_at,
      })),
      violations: violations.map((v) => ({
        id: v.id,
        question: str(v.question),
        matchedTerms: Array.isArray(v.matched_terms) ? v.matched_terms : [],
        rawResponse: str(v.raw_response),
        createdAt: v.created_at,
      })),
      supportRequests: supportRequests.map((s) => ({
        id: s.id,
        contactName: str(s.contact_name),
        contactEmail: str(s.contact_email),
        subject: str(s.subject),
        body: str(s.body),
        status: str(s.status, "open"),
        createdAt: s.created_at,
        attachments: Array.isArray(s.attachments) ? s.attachments : [],
      })),
    });
  }),
);

// ── PATCH /chatbot — prompt, copy, appearance ────────────────
router.patch(
  "/chatbot",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const chatbot = await getPlatformChatbot().catch(() => null);
    if (!chatbot?.id) {
      return res.status(404).json({
        error: {
          code: "PLATFORM_CHATBOT_MISSING",
          message: "The platform chatbot row does not exist yet.",
        },
      });
    }

    const settings =
      typeof chatbot.settings === "object" && chatbot.settings
        ? { ...chatbot.settings }
        : {};
    for (const key of [
      "placeholder",
      "accentColor",
      "position",
      "supportEmail",
      "confidentialityMode",
      "headerTitle",
      "welcomeMessage",
    ]) {
      if (body[key] !== undefined) settings[key] = str(body[key]);
    }
    if (Array.isArray(body.suggestedPrompts)) {
      settings.suggestedPrompts = body.suggestedPrompts
        .map((p) => str(p).trim())
        .filter(Boolean)
        .slice(0, 8);
    }

    const patch = { settings, updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = str(body.name);
    if (body.headerTitle !== undefined) patch.header_title = str(body.headerTitle);
    if (body.welcomeMessage !== undefined)
      patch.welcome_message = str(body.welcomeMessage);
    if (body.customPrompt !== undefined)
      patch.custom_prompt = str(body.customPrompt);
    if (body.isActive !== undefined) patch.is_active = Boolean(body.isActive);

    const { error } = await db
      .from("chatbots")
      .update(patch)
      .eq("id", chatbot.id);
    if (error) throw error;

    invalidatePlatformCache();
    await logSecurityEvent(req, "platform_assistant_updated", true, {
      adminEmail: req.superAdmin.email,
      fields: Object.keys(patch),
    });

    // The assistant answers strictly from its FAQs and indexed public pages.
    // Editing the prompt cannot widen what it is allowed to disclose, but it
    // can change tone in ways worth noticing, so flag rather than silently ok.
    const warning =
      body.customPrompt !== undefined
        ? "Prompt changed. Confidentiality rules still apply and are enforced separately."
        : null;

    res.json({ success: true, warning });
  }),
);

// ── PATCH /settings — daily spend cap ────────────────────────
router.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    const cap = Number(req.body?.dailySpendCapUsd);
    if (!Number.isFinite(cap) || cap < 0) {
      return res.status(400).json({
        error: {
          code: "INVALID_CAP",
          message: "dailySpendCapUsd must be zero or greater.",
        },
      });
    }
    const db = getSupabase();
    const { error } = await db
      .from("organizations")
      .update({ platform_daily_spend_cap_usd: cap })
      .eq("id", PLATFORM_ORG_ID);
    if (error) throw error;
    invalidatePlatformCache();
    await logSecurityEvent(req, "platform_spend_cap_updated", true, {
      adminEmail: req.superAdmin.email,
      dailySpendCapUsd: cap,
    });
    res.json({ success: true });
  }),
);

// ── FAQs ─────────────────────────────────────────────────────
router.post(
  "/faqs",
  asyncHandler(async (req, res) => {
    const question = str(req.body?.question).trim();
    const answer = str(req.body?.answer).trim();
    if (!question || !answer) {
      return res.status(400).json({
        error: { code: "INVALID_FAQ", message: "Question and answer are required." },
      });
    }
    const db = getSupabase();
    const { error } = await db.from("faqs").insert({
      organization_id: PLATFORM_ORG_ID,
      knowledge_base_id: PLATFORM_KNOWLEDGE_BASE_ID,
      chatbot_id: PLATFORM_CHATBOT_ID,
      question,
      answer,
      source: "super_admin",
      is_published: true,
    });
    if (error) throw error;
    invalidatePlatformCache();
    res.json({ success: true });
  }),
);

// Bulk import. One FAQ per line as "question, answer" — the format the admin
// screen's help text documents.
router.post(
  "/faqs/import",
  asyncHandler(async (req, res) => {
    const text = str(req.body?.text);
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(",");
        if (idx === -1) return null;
        const question = line.slice(0, idx).trim();
        const answer = line.slice(idx + 1).trim();
        if (!question || !answer) return null;
        return {
          organization_id: PLATFORM_ORG_ID,
          knowledge_base_id: PLATFORM_KNOWLEDGE_BASE_ID,
          chatbot_id: PLATFORM_CHATBOT_ID,
          question,
          answer,
          source: "super_admin_import",
          is_published: true,
        };
      })
      .filter(Boolean);

    if (!rows.length) {
      return res.status(400).json({
        error: {
          code: "NOTHING_TO_IMPORT",
          message: "No lines matched the expected \"question, answer\" format.",
        },
      });
    }

    const db = getSupabase();
    const { error } = await db.from("faqs").insert(rows);
    if (error) throw error;
    invalidatePlatformCache();
    res.json({ success: true, imported: rows.length });
  }),
);

router.patch(
  "/faqs/:id",
  asyncHandler(async (req, res) => {
    const patch = {};
    if (req.body?.question !== undefined) patch.question = str(req.body.question);
    if (req.body?.answer !== undefined) patch.answer = str(req.body.answer);
    if (req.body?.isPublished !== undefined)
      patch.is_published = Boolean(req.body.isPublished);
    if (req.body?.displayOrder !== undefined)
      patch.display_order = Number(req.body.displayOrder) || 0;
    if (!Object.keys(patch).length) {
      return res
        .status(400)
        .json({ error: { code: "NO_CHANGES", message: "Nothing to update." } });
    }
    const db = getSupabase();
    // Scoped to the platform org so this endpoint can never edit a tenant FAQ.
    const { error } = await db
      .from("faqs")
      .update(patch)
      .eq("id", req.params.id)
      .eq("organization_id", PLATFORM_ORG_ID);
    if (error) throw error;
    invalidatePlatformCache();
    res.json({ success: true });
  }),
);

router.delete(
  "/faqs/:id",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { error } = await db
      .from("faqs")
      .delete()
      .eq("id", req.params.id)
      .eq("organization_id", PLATFORM_ORG_ID);
    if (error) throw error;
    invalidatePlatformCache();
    res.json({ success: true });
  }),
);

// ── Knowledge sources ────────────────────────────────────────
router.post(
  "/sources",
  asyncHandler(async (req, res) => {
    const url = str(req.body?.url).trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        error: { code: "INVALID_URL", message: "Enter a full http(s) URL." },
      });
    }
    const db = getSupabase();
    const { error } = await db.from("knowledge_sources").insert({
      organization_id: PLATFORM_ORG_ID,
      knowledge_base_id: PLATFORM_KNOWLEDGE_BASE_ID,
      source_type: "url",
      url,
      normalized_url: url.replace(/#.*$/, "").replace(/\/+$/, ""),
      title: str(req.body?.title).trim() || null,
      scrape_status: "pending",
    });
    if (error) throw error;
    invalidatePlatformCache();
    res.json({ success: true });
  }),
);

router.delete(
  "/sources/:id",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { error } = await db
      .from("knowledge_sources")
      .delete()
      .eq("id", req.params.id)
      .eq("organization_id", PLATFORM_ORG_ID);
    if (error) throw error;
    invalidatePlatformCache();
    res.json({ success: true });
  }),
);

// ── Support requests ─────────────────────────────────────────
router.patch(
  "/support-requests/:id",
  asyncHandler(async (req, res) => {
    const status = str(req.body?.status).trim().toLowerCase();
    if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
      return res.status(400).json({
        error: {
          code: "INVALID_STATUS",
          message: "Status must be open, in_progress, resolved or closed.",
        },
      });
    }
    const db = getSupabase();
    const { error } = await db
      .from("platform_support_requests")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  }),
);

module.exports = router;
