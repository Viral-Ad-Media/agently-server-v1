"use strict";
/*
 * Front Desk, owner side: price sheet and quote rules, quotes awaiting
 * approval, the chat inbox, and the funnel numbers. Everything is scoped to
 * req.orgId; the database has no row-level policies, so that scoping is the
 * tenant boundary.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const frontdesk = require("../../lib/frontdesk");
const inbox = require("../../lib/chat-inbox");
const chatMedia = require("../../lib/chat-media");
const { getAiGateway } = require("../../lib/ai-gateway");

const router = express.Router();
router.use(requireAuth);

const notFound = (res, what) => res.status(404).json({ error: { message: `${what} not found.` } });

/* ── Settings ───────────────────────────────────────────────── */
router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json({
      settings: await frontdesk.loadSettings(getSupabase(), req.orgId),
      models: { reply: chatMedia.VISION_MODEL, assessment: chatMedia.ASSESS_MODEL },
    });
  }),
);

router.put(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.quotesEnabled === true) {
      const sheet = frontdesk.normalizePriceSheet(
        body.priceSheet ?? (await frontdesk.loadSettings(getSupabase(), req.orgId)).priceSheet,
      );
      if (!sheet.length)
        return res.status(400).json({
          error: { code: "PRICE_SHEET_EMPTY", message: "Add at least one priced item before turning quotes on." },
        });
    }
    res.json({ settings: await frontdesk.saveSettings(getSupabase(), req.orgId, body) });
  }),
);

/* ── Quotes ─────────────────────────────────────────────────── */
async function loadQuote(db, req) {
  const { data } = await db
    .from("lead_quotes")
    .select("*")
    .eq("id", req.params.id)
    .eq("organization_id", req.orgId)
    .maybeSingle();
  return data || null;
}

router.get(
  "/quotes",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    let q = db
      .from("lead_quotes")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (frontdesk.QUOTE_STATUSES.includes(req.query.status)) q = q.eq("status", req.query.status);
    if (req.query.leadId) q = q.eq("lead_id", String(req.query.leadId));
    const { data, error } = await q;
    if (error) return res.json({ quotes: [] }); // not migrated yet
    const rows = data || [];
    const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
    const leads = new Map();
    if (leadIds.length) {
      const { data: ls } = await db
        .from("leads")
        .select("id,name,email")
        .eq("organization_id", req.orgId)
        .in("id", leadIds);
      for (const l of ls || []) leads.set(l.id, l);
    }
    res.json({
      quotes: rows.map((r) => ({
        ...frontdesk.serializeQuote(r),
        leadName: leads.get(r.lead_id)?.name || null,
        leadEmail: leads.get(r.lead_id)?.email || null,
      })),
    });
  }),
);

// Owner edits quantities before approving. Prices always come from the sheet.
router.patch(
  "/quotes/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const row = await loadQuote(db, req);
    if (!row) return notFound(res, "Quote");
    if (!["draft", "pending_approval"].includes(row.status))
      return res.status(409).json({ error: { message: "A quote that was already sent can't be edited." } });
    const settings = await frontdesk.loadSettings(db, req.orgId);
    const assessment = frontdesk.normalizeAssessment({ line_items: req.body?.lines }, settings);
    const priced = frontdesk.priceLines(assessment.lineItems, settings);
    if (!priced.lines.length)
      return res.status(400).json({ error: { message: "A quote needs at least one item from your price list." } });
    const { data, error } = await db
      .from("lead_quotes")
      .update({
        lines: priced.lines,
        subtotal_cents: priced.subtotalCents,
        low_cents: priced.lowCents,
        high_cents: priced.highCents,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ quote: frontdesk.serializeQuote(data) });
  }),
);

router.post(
  "/quotes/:id/approve",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const row = await loadQuote(db, req);
    if (!row) return notFound(res, "Quote");
    if (!["draft", "pending_approval"].includes(row.status))
      return res.status(409).json({ error: { message: "This quote was already handled." } });
    if (!row.lead_id)
      return res.status(409).json({
        error: { code: "NO_LEAD", message: "The customer hasn't left contact details yet, so there is nowhere to send this." },
      });
    let result;
    try {
      result = await frontdesk.dispatchQuote(db, row, {
        settings: await frontdesk.loadSettings(db, req.orgId),
        force: true,
        approvedBy: req.user?.id || null,
      });
    } catch (e) {
      console.error("[frontdesk] quote send failed:", e.message);
      return res.status(502).json({ error: { code: "EMAIL_FAILED", message: "The email didn't go out. Please try again." } });
    }
    if (result.reason === "no_email")
      return res.status(409).json({
        error: { code: "NO_EMAIL", message: "This customer has no email address. Add one to the lead, then approve again." },
        quote: frontdesk.serializeQuote(result.quote),
      });
    res.json({ quote: frontdesk.serializeQuote(result.quote) });
  }),
);

router.post(
  "/quotes/:id/void",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const row = await loadQuote(db, req);
    if (!row) return notFound(res, "Quote");
    const { data } = await db
      .from("lead_quotes")
      .update({ status: "void", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    res.json({ quote: frontdesk.serializeQuote(data || { ...row, status: "void" }) });
  }),
);

/* ── KPIs ───────────────────────────────────────────────────── */
router.get(
  "/kpis",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const safe = async (query) => {
      try {
        const { data, error } = await query;
        return error ? [] : data || [];
      } catch (_) {
        return [];
      }
    };
    const [media, quotes, leads, conversations] = await Promise.all([
      safe(db.from("chat_media").select("id,created_at").eq("organization_id", req.orgId).gte("created_at", since)),
      safe(
        db
          .from("lead_quotes")
          .select("id,lead_id,chat_media_id,status,low_cents,high_cents,sent_at,created_at")
          .eq("organization_id", req.orgId)
          .gte("created_at", since),
      ),
      safe(db.from("leads").select("id,crm_stage").eq("organization_id", req.orgId)),
      safe(db.from("chat_conversations").select("id,status,unread_owner").eq("organization_id", req.orgId)),
    ]);
    res.json({
      days,
      ...frontdesk.computeKpis({ media, quotes, leads }),
      conversationsOpen: conversations.filter((c) => c.status !== "closed").length,
      conversationsUnread: conversations.filter((c) => Number(c.unread_owner) > 0).length,
      ai: getAiGateway().stats(),
    });
  }),
);

/* ── Inbox ──────────────────────────────────────────────────── */
router.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    try {
      res.json({
        conversations: await inbox.listConversations(getSupabase(), {
          organizationId: req.orgId,
          status: req.query.status || null,
          limit: Number.parseInt(req.query.limit, 10) || 50,
        }),
      });
    } catch (e) {
      console.warn("[frontdesk] conversations list failed:", e.message);
      res.json({ conversations: [] });
    }
  }),
);

router.get(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const found = await inbox.getConversation(db, { organizationId: req.orgId, conversationId: req.params.id });
    if (!found) return notFound(res, "Conversation");
    if (found.row.unread_owner) {
      await db.from("chat_conversations").update({ unread_owner: 0 }).eq("id", found.row.id).eq("organization_id", req.orgId);
      found.conversation.unread = 0;
    }
    // Signed URLs for any photos/clips in the thread (private bucket, 1h).
    const mediaIds = [...new Set(found.messages.map((m) => m.mediaId).filter(Boolean))];
    const media = {};
    if (mediaIds.length) {
      const { data: rows } = await db
        .from("chat_media")
        .select("id,kind,storage_path,poster_path,analysis")
        .eq("organization_id", req.orgId)
        .in("id", mediaIds);
      const paths = (rows || []).flatMap((r) => [r.storage_path, r.poster_path]).filter(Boolean);
      const signed = {};
      if (paths.length) {
        const { data: urls } = await db.storage.from(chatMedia.BUCKET).createSignedUrls(paths, 3600);
        for (const u of urls || []) if (u?.path && u.signedUrl) signed[u.path] = u.signedUrl;
      }
      for (const r of rows || [])
        media[r.id] = {
          kind: r.kind,
          url: signed[r.storage_path] || null,
          posterUrl: r.poster_path ? signed[r.poster_path] || null : null,
          summary: r.analysis?.summary || "",
          regions: Array.isArray(r.analysis?.regions) ? r.analysis.regions : [],
        };
    }
    res.json({
      conversation: { ...found.conversation, visitorLive: inbox.visitorIsLive(found.row) },
      messages: found.messages,
      media,
    });
  }),
);

/*
 * Owner reply. Replying takes the chat over from the assistant. The customer
 * sees it in the widget if they are still on the site; if they have gone and
 * left an email address, it is emailed with a link that reopens this chat.
 */
router.post(
  "/conversations/:id/reply",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const message = String(req.body?.message || "").trim().slice(0, 4000);
    if (!message) return res.status(400).json({ error: { message: "Write a reply first." } });
    const found = await inbox.getConversation(db, { organizationId: req.orgId, conversationId: req.params.id });
    if (!found) return notFound(res, "Conversation");
    const [stored] = await inbox.appendMessages(db, found.row, [{ role: "owner", body: message }]);
    await db
      .from("chat_conversations")
      .update({ status: "human" })
      .eq("id", found.row.id)
      .eq("organization_id", req.orgId);

    const live = inbox.visitorIsLive(found.row);
    const wantsEmail = req.body?.email === true || (req.body?.email !== false && !live);
    let delivery = live ? "live" : "waiting";
    if (wantsEmail && found.lead?.email) {
      try {
        const { sendChatReplyEmail } = require("../../lib/email");
        await sendChatReplyEmail(
          {
            toEmail: found.lead.email,
            customerName: found.lead.name,
            businessName: await frontdesk.organizationName(db, req.orgId),
            message,
            resumeUrl: inbox.widgetResumeUrl(found.row),
          },
          { organizationId: req.orgId, userId: req.user?.id, metadata: { conversation_id: found.row.id } },
        );
        delivery = live ? "live_and_email" : "email";
      } catch (e) {
        console.warn("[frontdesk] reply email failed:", e.message);
        delivery = live ? "live" : "email_failed";
      }
    } else if (!live) {
      delivery = found.lead?.email ? "waiting" : "no_email";
    }
    if (found.row.lead_id) {
      try {
        const { recordLeadActivity } = require("../../lib/lead-crm-events");
        await recordLeadActivity(db, {
          leadId: found.row.lead_id,
          organizationId: req.orgId,
          activityType: "chat",
          title: "Team replied in chat",
          body: message.slice(0, 500),
          channel: delivery.includes("email") ? "email" : "chat",
          direction: "outbound",
          provider: "agently_chatbot",
          chatbotId: found.row.chatbot_id,
          createdBy: req.user?.id || null,
          metadata: { conversation_id: found.row.id, delivery },
        });
      } catch (_) {}
    }
    res.json({ message: inbox.serializeMessage(stored), status: "human", delivery });
  }),
);

router.patch(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const status = String(req.body?.status || "");
    if (!inbox.STATUSES.has(status)) return res.status(400).json({ error: { message: "Unknown status." } });
    const { data } = await db
      .from("chat_conversations")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (!data) return notFound(res, "Conversation");
    res.json({ conversation: inbox.serializeConversation(data) });
  }),
);

router.delete(
  "/conversations/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { data } = await getSupabase()
      .from("chat_conversations")
      .delete()
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .select("id");
    if (!(data || []).length) return notFound(res, "Conversation");
    res.json({ success: true });
  }),
);

module.exports = router;
