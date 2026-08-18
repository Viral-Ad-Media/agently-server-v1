"use strict";

const express = require("express");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { getSupabase } = require("../../lib/supabase");
const { getBillingPlatformSettings } = require("../../lib/billing-settings");
const {
  stripeConfigured,
  stripeCheckoutConfigured,
} = require("../../lib/stripe-billing");
const { asyncHandler } = require("../../middleware/error");
const {
  authenticateSuperAdmin,
  requireSuperAdmin,
  logSecurityEvent,
  isEnabled,
} = require("../../lib/super-admin-auth");

const router = express.Router();
const ALLOWED_TEMPLATES = new Set(["product_update", "editorial", "guide"]);
const ALLOWED_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "image",
  "quote",
  "bullets",
  "video",
]);

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 110);
}

function sanitizeColor(value) {
  const raw = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : undefined;
}

function sanitizeBlockStyle(value) {
  if (!value || typeof value !== "object") return undefined;
  const allowedFonts = new Set(["default", "sans", "serif", "display", "mono"]);
  const allowedAlignments = new Set(["left", "center", "right"]);
  const allowedFits = new Set(["cover", "contain"]);
  const style = {};
  const fontFamily = String(value.fontFamily || "").trim();
  const textAlign = String(value.textAlign || "").trim();
  const mediaFit = String(value.mediaFit || "").trim();
  if (allowedFonts.has(fontFamily)) style.fontFamily = fontFamily;
  if (allowedAlignments.has(textAlign)) style.textAlign = textAlign;
  if (allowedFits.has(mediaFit)) style.mediaFit = mediaFit;
  const textColor = sanitizeColor(value.textColor);
  const backgroundColor = sanitizeColor(value.backgroundColor);
  if (textColor) style.textColor = textColor;
  if (backgroundColor) style.backgroundColor = backgroundColor;
  if (value.fontSize !== undefined)
    style.fontSize = clamp(value.fontSize, 12, 92, 18);
  if (value.widthPercent !== undefined)
    style.widthPercent = clamp(value.widthPercent, 35, 100, 100);
  if (value.paddingY !== undefined)
    style.paddingY = clamp(value.paddingY, 0, 96, 0);
  if (value.borderRadius !== undefined)
    style.borderRadius = clamp(value.borderRadius, 0, 48, 20);
  if (value.overlayOpacity !== undefined)
    style.overlayOpacity = clamp(value.overlayOpacity, 0, 0.92, 0.5);
  const backgroundImageUrl = String(value.backgroundImageUrl || "")
    .trim()
    .slice(0, 3000);
  if (backgroundImageUrl) style.backgroundImageUrl = backgroundImageUrl;
  return Object.keys(style).length ? style : undefined;
}

function sanitizeBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const type = String(block.type || "").toLowerCase();
    if (!ALLOWED_BLOCK_TYPES.has(type)) return [];
    const id = String(block.id || uuidv4());
    const style = sanitizeBlockStyle(block.style);
    const withStyle = style ? { style } : {};
    if (type === "image") {
      const url = String(block.url || "")
        .trim()
        .slice(0, 3000);
      if (!url) return [];
      return [
        {
          id,
          type,
          url,
          alt: String(block.alt || "")
            .trim()
            .slice(0, 300),
          caption: String(block.caption || "")
            .trim()
            .slice(0, 500),
          ...withStyle,
        },
      ];
    }
    if (type === "video") {
      const url = String(block.url || "")
        .trim()
        .slice(0, 3000);
      if (!url) return [];
      return [
        {
          id,
          type,
          url,
          caption: String(block.caption || "")
            .trim()
            .slice(0, 500),
          posterUrl: String(block.posterUrl || "")
            .trim()
            .slice(0, 3000),
          ...withStyle,
        },
      ];
    }
    if (type === "bullets") {
      const items = Array.isArray(block.items)
        ? block.items
            .map((item) =>
              String(item || "")
                .trim()
                .slice(0, 1000),
            )
            .filter(Boolean)
            .slice(0, 30)
        : [];
      return [
        {
          id,
          type,
          items,
          readAloud: Boolean(block.readAloud),
          ...withStyle,
        },
      ];
    }
    return [
      {
        id,
        type,
        text: String(block.text || "")
          .trim()
          .slice(0, type === "heading" ? 500 : 12000),
        readAloud: Boolean(block.readAloud),
        ...withStyle,
      },
    ];
  });
}

function serializePost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || "",
    status: row.status || "draft",
    templateKey: row.template_key || "product_update",
    coverImageUrl: row.cover_image_url || "",
    authorName: row.author_name || "Agently Team",
    contentBlocks: Array.isArray(row.content_blocks) ? row.content_blocks : [],
    seoTitle: row.seo_title || "",
    seoDescription: row.seo_description || "",
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by || "",
  };
}

async function uniqueSlug(db, base, postId = null) {
  const root = slugify(base) || `update-${Date.now()}`;
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? root : `${root}-${index + 1}`;
    let query = db
      .from("blog_posts")
      .select("id")
      .eq("slug", candidate)
      .limit(1);
    if (postId) query = query.neq("id", postId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return candidate;
  }
  return `${root}-${Date.now()}`;
}

async function loadWalletRows(db, organizationIds) {
  if (!organizationIds.length) return [];
  const view = await db
    .from("billing_admin_wallet_overview")
    .select("*")
    .in("organization_id", organizationIds);
  if (!view.error) return view.data || [];
  const fallback = await db
    .from("billing_wallets")
    .select("*")
    .in("organization_id", organizationIds);
  if (fallback.error) return [];
  return fallback.data || [];
}

function walletBalance(row) {
  return Number(
    row?.wallet_balance_usd ?? row?.balance_usd ?? row?.balance ?? 0,
  );
}

function rateKey(value) {
  return (
    String(value ?? "*")
      .trim()
      .toLowerCase() || "*"
  );
}

function marginFromRates(rates, provider, services) {
  const serviceList = Array.isArray(services) ? services : [services];
  for (const service of serviceList) {
    const match = (rates || []).find(
      (row) =>
        rateKey(row.plan_key) === "*" &&
        rateKey(row.provider) === rateKey(provider) &&
        rateKey(row.service) === rateKey(service) &&
        rateKey(row.event_type) === "*" &&
        rateKey(row.unit) === "*" &&
        rateKey(row.billing_mode) === "target_margin",
    );
    const margin = Number(match?.target_margin_percent);
    if (Number.isFinite(margin)) return margin;
  }
  return null;
}

async function loadPlatformPricing(db) {
  const [settings, rateResult] = await Promise.all([
    getBillingPlatformSettings(db),
    db
      .from("billing_admin_customer_rate_settings")
      .select(
        "plan_key,provider,service,event_type,unit,billing_mode,target_margin_percent,notes,updated_at",
      ),
  ]);

  const rates = rateResult.error ? [] : rateResult.data || [];
  const defaultMargin =
    marginFromRates(rates, "*", "*") ??
    Number(settings.defaultTargetMarginPercent || 70);

  return {
    minimumTopUpUsd: Number(settings.minimumTopUpUsd || 10),
    defaultMarginPercent: defaultMargin,
    openAiRealtimeMarginPercent:
      marginFromRates(rates, "openai", ["realtime_call", "realtime"]) ??
      defaultMargin,
    elevenLabsMarginPercent:
      marginFromRates(rates, "elevenlabs", "*") ?? defaultMargin,
    twilioCallMarginPercent:
      marginFromRates(rates, "twilio", "voice") ?? defaultMargin,
    twilioNumberMarginPercent:
      marginFromRates(rates, "twilio", "phone_number") ?? defaultMargin,
    stripeCheckoutEnabled: stripeCheckoutConfigured(),
    stripeWebhookConfigured: stripeConfigured(),
    settingsSource: settings.source,
    updatedAt: settings.updatedAt || null,
  };
}

router.get("/auth/config", (_req, res) => {
  if (!isEnabled())
    return res.status(404).json({ error: { message: "Not found." } });
  return res.json({
    enabled: true,
    otpRequired: Boolean(
      String(process.env.SUPER_ADMIN_TOTP_SECRET || "").trim(),
    ),
  });
});

router.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const result = await authenticateSuperAdmin(req, req.body || {});
    if (!result.ok) {
      if (result.retryAfterSeconds)
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
      return res
        .status(result.status || 401)
        .json({ error: { message: result.message } });
    }
    return res.json({
      token: result.token,
      email: result.email,
      expiresInSeconds: result.expiresInSeconds,
      otpRequired: result.otpRequired,
    });
  }),
);

router.use(requireSuperAdmin);

router.get("/auth/session", (req, res) => {
  res.json({ authenticated: true, email: req.superAdmin.email });
});

// ── GET /api/super-admin/tenant-economics ────────────────────
// Per-tenant spend, true provider cost, and our margin. Sits behind the
// router-level requireSuperAdmin above, so it is never reachable by a tenant
// — this exposes internal cost and profit, which tenants must not see.
// ?format=csv returns a downloadable file instead of JSON.
router.get(
  "/tenant-economics",
  asyncHandler(async (req, res) => {
    const db = getSupabase();

    // Aggregate per organization from the charge ledger.
    const { data: charges, error: chargeError } = await db
      .from("billing_customer_usage_charges")
      .select(
        "organization_id,provider,service,quantity,unit,internal_cost_usd,customer_charge_usd,gross_profit_usd",
      )
      .limit(50000);
    if (chargeError) throw chargeError;

    const byOrg = new Map();
    for (const row of charges || []) {
      const orgId = row.organization_id || "unknown";
      if (!byOrg.has(orgId)) {
        byOrg.set(orgId, {
          organizationId: orgId,
          organizationName: "",
          walletBalanceUsd: null,
          cost: 0,
          charged: 0,
          profit: 0,
          lines: new Map(),
        });
      }
      const org = byOrg.get(orgId);
      const cost = Number(row.internal_cost_usd || 0);
      const charged = Number(row.customer_charge_usd || 0);
      org.cost += cost;
      org.charged += charged;
      org.profit += Number(row.gross_profit_usd || 0);
      const key = `${row.provider}/${row.service}`;
      const line = org.lines.get(key) || { line: key, unit: row.unit, quantity: 0, cost: 0, charged: 0 };
      line.quantity += Number(row.quantity || 0);
      line.cost += cost;
      line.charged += charged;
      org.lines.set(key, line);
    }

    // Attach names and live wallet balances.
    const orgIds = [...byOrg.keys()].filter((id) => id !== "unknown");
    if (orgIds.length) {
      const [{ data: orgs }, { data: wallets }] = await Promise.all([
        db.from("organizations").select("id,name").in("id", orgIds),
        db.from("billing_wallets").select("organization_id,balance_usd").in("organization_id", orgIds),
      ]);
      for (const o of orgs || []) {
        const row = byOrg.get(o.id);
        if (row) row.organizationName = o.name || "";
      }
      for (const w of wallets || []) {
        const row = byOrg.get(w.organization_id);
        if (row) row.walletBalanceUsd = Number(w.balance_usd || 0);
      }
    }

    const round = (v) => Math.round(Number(v || 0) * 1e6) / 1e6;
    const tenants = [...byOrg.values()]
      .map((o) => ({
        organizationId: o.organizationId,
        organizationName: o.organizationName,
        walletBalanceUsd: o.walletBalanceUsd,
        providerCostUsd: round(o.cost),
        chargedUsd: round(o.charged),
        grossProfitUsd: round(o.profit),
        marginPercent: o.charged > 0 ? Math.round((1000 * o.profit) / o.charged) / 10 : null,
        multiple: o.cost > 0 ? Math.round((1000 * o.charged) / o.cost) / 1000 : null,
        lines: [...o.lines.values()]
          .map((l) => ({ ...l, cost: round(l.cost), charged: round(l.charged) }))
          .sort((a, b) => b.cost - a.cost),
      }))
      .sort((a, b) => b.chargedUsd - a.chargedUsd);

    const totals = tenants.reduce(
      (acc, t) => ({
        providerCostUsd: round(acc.providerCostUsd + t.providerCostUsd),
        chargedUsd: round(acc.chargedUsd + t.chargedUsd),
        grossProfitUsd: round(acc.grossProfitUsd + t.grossProfitUsd),
      }),
      { providerCostUsd: 0, chargedUsd: 0, grossProfitUsd: 0 },
    );

    if (String(req.query.format || "").toLowerCase() === "csv") {
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [
        ["Organization", "Org ID", "Line", "Unit", "Quantity", "Our cost USD", "Charged USD", "Profit USD"],
      ];
      for (const t of tenants) {
        for (const l of t.lines) {
          rows.push([
            t.organizationName,
            t.organizationId,
            l.line,
            l.unit || "",
            l.quantity,
            l.cost.toFixed(6),
            l.charged.toFixed(6),
            (l.charged - l.cost).toFixed(6),
          ]);
        }
        rows.push([t.organizationName, t.organizationId, "TOTAL", "", "", t.providerCostUsd.toFixed(6), t.chargedUsd.toFixed(6), t.grossProfitUsd.toFixed(6)]);
      }
      rows.push(["ALL TENANTS", "", "TOTAL", "", "", totals.providerCostUsd.toFixed(6), totals.chargedUsd.toFixed(6), totals.grossProfitUsd.toFixed(6)]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="agently-tenant-economics-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send(rows.map((r) => r.map(esc).join(",")).join("\n"));
    }

    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        ...totals,
        marginPercent:
          totals.chargedUsd > 0
            ? Math.round((1000 * totals.grossProfitUsd) / totals.chargedUsd) / 10
            : null,
        multiple:
          totals.providerCostUsd > 0
            ? Math.round((1000 * totals.chargedUsd) / totals.providerCostUsd) / 1000
            : null,
      },
      tenants,
    });
  }),
);

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const db = getSupabase();
    const [usersResult, orgsResult, postsResult] = await Promise.all([
      db.from("users").select("id", { count: "exact", head: true }),
      db.from("organizations").select("id", { count: "exact", head: true }),
      db
        .from("blog_posts")
        .select("id", { count: "exact", head: true })
        .eq("status", "published"),
    ]);
    const walletResult = await db
      .from("billing_admin_wallet_overview")
      .select("*")
      .limit(1000);
    const walletRows = walletResult.error
      ? (await db.from("billing_wallets").select("*").limit(1000)).data || []
      : walletResult.data || [];
    const balances = walletRows.map(walletBalance);
    res.json({
      metrics: {
        users: Number(usersResult.count || 0),
        organizations: Number(orgsResult.count || 0),
        publishedPosts: Number(postsResult.count || 0),
        lowCreditOrganizations: balances.filter((balance) => balance < 1)
          .length,
        totalCustomerCreditUsd: balances.reduce((sum, value) => sum + value, 0),
      },
    });
  }),
);

router.get(
  "/billing/pricing",
  asyncHandler(async (_req, res) => {
    const pricing = await loadPlatformPricing(getSupabase());
    res.json({
      pricing,
      notes: {
        marginMeaning:
          "Gross margin. Customer price is vendor cost divided by (1 - margin).",
        appliesTo:
          "New usage across all plans and organizations. Historical charges are not repriced.",
      },
    });
  }),
);

router.patch(
  "/billing/pricing",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const values = {
      minimumTopUpUsd: Number(body.minimumTopUpUsd),
      defaultMarginPercent: Number(body.defaultMarginPercent),
      openAiRealtimeMarginPercent: Number(body.openAiRealtimeMarginPercent),
      elevenLabsMarginPercent: Number(body.elevenLabsMarginPercent),
      twilioCallMarginPercent: Number(body.twilioCallMarginPercent),
      twilioNumberMarginPercent: Number(body.twilioNumberMarginPercent),
    };

    if (
      !Number.isFinite(values.minimumTopUpUsd) ||
      values.minimumTopUpUsd < 0.5 ||
      values.minimumTopUpUsd > 100000
    ) {
      return res.status(400).json({
        error: {
          message: "Minimum top-up must be between $0.50 and $100,000.",
        },
      });
    }
    for (const [key, value] of Object.entries(values)) {
      if (key === "minimumTopUpUsd") continue;
      if (!Number.isFinite(value) || value < 0 || value > 95) {
        return res.status(400).json({
          error: { message: `${key} must be between 0% and 95%.` },
        });
      }
    }

    const db = getSupabase();
    const { data, error } = await db.rpc("billing_admin_set_platform_pricing", {
      p_minimum_top_up_usd: values.minimumTopUpUsd,
      p_default_margin_percent: values.defaultMarginPercent,
      p_openai_realtime_margin_percent: values.openAiRealtimeMarginPercent,
      p_elevenlabs_margin_percent: values.elevenLabsMarginPercent,
      p_twilio_voice_margin_percent: values.twilioCallMarginPercent,
      p_twilio_phone_number_margin_percent: values.twilioNumberMarginPercent,
      p_updated_by: req.superAdmin.email,
    });
    if (error) throw error;

    await logSecurityEvent(req, "platform_billing_pricing_updated", true, {
      adminEmail: req.superAdmin.email,
      values,
    });

    res.json({
      success: true,
      result: data,
      pricing: await loadPlatformPricing(db),
    });
  }),
);

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const page = clamp(req.query.page, 1, 100000, 1);
    const pageSize = clamp(req.query.pageSize, 10, 100, 25);
    const search = String(req.query.search || "").trim();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = db.from("users").select("*", { count: "exact" });
    if (search) {
      const safe = search.replace(/[,%()]/g, " ").trim();
      query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%`);
    }
    const {
      data: users,
      error,
      count,
    } = await query.order("email", { ascending: true }).range(from, to);
    if (error) throw error;

    const organizationIds = Array.from(
      new Set(
        (users || []).map((user) => user.organization_id).filter(Boolean),
      ),
    );
    const [orgResult, walletRows] = await Promise.all([
      organizationIds.length
        ? db.from("organizations").select("*").in("id", organizationIds)
        : Promise.resolve({ data: [], error: null }),
      loadWalletRows(db, organizationIds),
    ]);
    if (orgResult.error) throw orgResult.error;
    const orgMap = new Map((orgResult.data || []).map((org) => [org.id, org]));
    const walletMap = new Map(
      walletRows.map((row) => [row.organization_id, row]),
    );

    const rows = (users || []).map((user) => {
      const org = orgMap.get(user.organization_id) || {};
      const wallet = walletMap.get(user.organization_id) || {};
      return {
        id: user.id,
        name: user.name || "",
        email: user.email || "",
        role: user.role || "Viewer",
        createdAt: user.created_at || null,
        organizationId: user.organization_id || null,
        organizationName: org.name || "",
        plan: org.plan || "None",
        subscriptionStatus: org.subscription_status || "unknown",
        onboarded: Boolean(org.onboarded),
        walletBalanceUsd: walletBalance(wallet),
        walletCreditsAddedUsd: Number(
          wallet.total_credits_usd ?? wallet.total_credit_usd ?? 0,
        ),
        walletDeductionsUsd: Number(
          wallet.total_debits_usd ?? wallet.total_deductions_usd ?? 0,
        ),
        walletStatus: wallet.wallet_status || wallet.status || "unknown",
      };
    });

    res.json({ rows, page, pageSize, total: Number(count || 0) });
  }),
);

// ── POST /api/super-admin/wallets/:organizationId/top-up ──
// Adds credit to a tenant's wallet directly from the dashboard, so you can
// test billing-gated features without going through Stripe/the internal
// billing-usage HTML console. Uses the same RPC the internal console uses.
router.post(
  "/wallets/:organizationId/top-up",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const organizationId = String(req.params.organizationId || "").trim();
    const amountUsd = Number(req.body?.amountUsd);
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res
        .status(400)
        .json({ error: { message: "amountUsd must be greater than zero." } });
    }
    const { data, error } = await db.rpc("billing_admin_top_up_wallet", {
      p_organization_id: organizationId,
      p_amount_usd: amountUsd,
      p_source: "super_admin_dashboard_top_up",
      p_external_id: `sa-topup-${Date.now()}`,
      p_metadata: {
        adminEmail: req.superAdmin.email,
        note: String(req.body?.note || "").slice(0, 300),
      },
    });
    if (error) throw error;
    await logSecurityEvent(req, "wallet_manual_top_up", true, {
      adminEmail: req.superAdmin.email,
      organizationId,
      amountUsd,
    });
    res.json({ success: true, transaction: data });
  }),
);

router.post(
  "/users/:userId/delete-preview",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const userId = String(req.params.userId || "").trim();
    const { data: user, error: userError } = await db
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    if (userError || !user)
      return res.status(404).json({ error: { message: "User not found." } });
    const scope = String(
      req.body?.scope || (user.role === "Owner" ? "organization" : "user"),
    ).toLowerCase();
    const { data, error } = await db.rpc(
      "billing_admin_preview_user_or_org_deletion",
      {
        p_user_id: user.id,
        p_user_email: user.email || null,
        p_organization_id: user.organization_id || null,
        p_delete_scope: scope,
      },
    );
    if (error) throw error;
    await logSecurityEvent(req, "deletion_preview", true, {
      adminEmail: req.superAdmin.email,
      userId,
      scope,
    });
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organization_id,
      },
      scope,
      rows: data || [],
    });
  }),
);

// PATCH: powers the warning modal. Read-only. Merges the database view with a
// live carrier listing so orphaned numbers are surfaced too.
router.post(
  "/organizations/:organizationId/teardown-preview",
  asyncHandler(async (req, res) => {
    const { previewTenantTeardown } = require("../../lib/tenant-teardown");
    const preview = await previewTenantTeardown({
      organizationId: String(req.params.organizationId || "").trim(),
    });
    await logSecurityEvent(req, "teardown_preview", true, {
      adminEmail: req.superAdmin.email,
      organizationId: req.params.organizationId,
      numbers: preview.totals.numbers,
    });
    res.json(preview);
  }),
);

router.delete(
  "/users/:userId",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const userId = String(req.params.userId || "").trim();
    const { data: user, error: userError } = await db
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    if (userError || !user)
      return res.status(404).json({ error: { message: "User not found." } });
    if (
      String(user.email || "").toLowerCase() ===
      String(process.env.SUPER_ADMIN_EMAIL || "").toLowerCase()
    ) {
      return res.status(400).json({
        error: {
          message: "The configured super-admin account cannot be deleted here.",
        },
      });
    }
    const scope = String(
      req.body?.scope || (user.role === "Owner" ? "organization" : "user"),
    ).toLowerCase();
    const requiredConfirm =
      scope === "organization"
        ? "DELETE_ORGANIZATION_DATA"
        : "DELETE_USER_DATA";
    if (String(req.body?.confirm || "") !== requiredConfirm) {
      return res.status(400).json({
        error: {
          message: `Type ${requiredConfirm} to confirm this permanent deletion.`,
        },
      });
    }
    // PATCH: organization-scope deletion now releases the tenant's phone
    // numbers and closes their subaccount BEFORE wiping the database.
    // Previously this route made no provider call of any kind, so numbers
    // stayed rented on the master account and kept billing us forever, with
    // the only record of their existence deleted in the same request.
    let teardown = null;
    if (scope === "organization" && user.organization_id) {
      const { teardownTenant } = require("../../lib/tenant-teardown");
      try {
        teardown = await teardownTenant({
          organizationId: user.organization_id,
          userId: user.id,
          userEmail: user.email || null,
          confirm: requiredConfirm,
          adminEmail: req.superAdmin.email,
          allowPartial: req.body?.allowPartial === true,
        });
        await logSecurityEvent(req, "account_deleted", true, {
          adminEmail: req.superAdmin.email,
          userId,
          userEmail: user.email,
          organizationId: user.organization_id,
          scope,
          numbersReleased: teardown.numbers.released,
          subaccountsClosed: teardown.subaccounts.closed.length,
        });
        return res.json({ success: true, scope, ...teardown });
      } catch (err) {
        // Deliberately fail CLOSED. A tenant left in the database is
        // recoverable; a forgotten rented number is not.
        await logSecurityEvent(req, "account_deleted", false, {
          adminEmail: req.superAdmin.email,
          userId,
          organizationId: user.organization_id,
          reason: err.message,
        });
        return res.status(err.status || 500).json({
          error: {
            code: err.code || "TEARDOWN_FAILED",
            message: err.message,
            details: err.details || null,
          },
        });
      }
    }

    const { data, error } = await db.rpc(
      "billing_admin_delete_user_or_org_everything",
      {
        p_user_id: user.id,
        p_user_email: user.email || null,
        p_organization_id: user.organization_id || null,
        p_delete_scope: scope,
        p_confirm: requiredConfirm,
      },
    );
    if (error) throw error;
    await logSecurityEvent(req, "account_deleted", true, {
      adminEmail: req.superAdmin.email,
      userId,
      userEmail: user.email,
      organizationId: user.organization_id,
      scope,
    });
    res.json({ success: true, scope, result: data });
  }),
);

router.get(
  "/blog",
  asyncHandler(async (_req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("blog_posts")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(250);
    if (error) throw error;
    res.json({ posts: (data || []).map(serializePost) });
  }),
);

router.post(
  "/blog",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const title = String(body.title || "")
      .trim()
      .slice(0, 250);
    if (!title)
      return res
        .status(400)
        .json({ error: { message: "A blog title is required." } });
    const status = ["draft", "published", "archived"].includes(body.status)
      ? body.status
      : "draft";
    const slug = await uniqueSlug(db, body.slug || title);
    const now = new Date().toISOString();
    const payload = {
      slug,
      title,
      excerpt: String(body.excerpt || "")
        .trim()
        .slice(0, 1200),
      status,
      template_key: ALLOWED_TEMPLATES.has(body.templateKey)
        ? body.templateKey
        : "product_update",
      cover_image_url:
        String(body.coverImageUrl || "")
          .trim()
          .slice(0, 3000) || null,
      author_name: String(body.authorName || "Agently Team")
        .trim()
        .slice(0, 160),
      content_blocks: sanitizeBlocks(body.contentBlocks),
      seo_title:
        String(body.seoTitle || "")
          .trim()
          .slice(0, 250) || null,
      seo_description:
        String(body.seoDescription || "")
          .trim()
          .slice(0, 500) || null,
      published_at: status === "published" ? now : null,
      created_by: req.superAdmin.email,
      updated_by: req.superAdmin.email,
      updated_at: now,
    };
    const { data, error } = await db
      .from("blog_posts")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    await logSecurityEvent(req, "blog_created", true, {
      adminEmail: req.superAdmin.email,
      postId: data.id,
      status,
    });
    res.status(201).json({ post: serializePost(data) });
  }),
);

router.patch(
  "/blog/:postId",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const postId = String(req.params.postId || "").trim();
    const { data: existing, error: existingError } = await db
      .from("blog_posts")
      .select("*")
      .eq("id", postId)
      .single();
    if (existingError || !existing)
      return res
        .status(404)
        .json({ error: { message: "Blog post not found." } });
    const body = req.body || {};
    const title = String(body.title ?? existing.title)
      .trim()
      .slice(0, 250);
    if (!title)
      return res
        .status(400)
        .json({ error: { message: "A blog title is required." } });
    const status = ["draft", "published", "archived"].includes(body.status)
      ? body.status
      : existing.status;
    const slug = await uniqueSlug(
      db,
      body.slug || existing.slug || title,
      postId,
    );
    const now = new Date().toISOString();
    const payload = {
      slug,
      title,
      excerpt: String(body.excerpt ?? existing.excerpt ?? "")
        .trim()
        .slice(0, 1200),
      status,
      template_key: ALLOWED_TEMPLATES.has(body.templateKey)
        ? body.templateKey
        : existing.template_key,
      cover_image_url:
        String(body.coverImageUrl ?? existing.cover_image_url ?? "")
          .trim()
          .slice(0, 3000) || null,
      author_name: String(
        body.authorName ?? existing.author_name ?? "Agently Team",
      )
        .trim()
        .slice(0, 160),
      content_blocks:
        body.contentBlocks === undefined
          ? existing.content_blocks
          : sanitizeBlocks(body.contentBlocks),
      seo_title:
        String(body.seoTitle ?? existing.seo_title ?? "")
          .trim()
          .slice(0, 250) || null,
      seo_description:
        String(body.seoDescription ?? existing.seo_description ?? "")
          .trim()
          .slice(0, 500) || null,
      published_at:
        status === "published" ? existing.published_at || now : null,
      updated_by: req.superAdmin.email,
      updated_at: now,
    };
    const { data, error } = await db
      .from("blog_posts")
      .update(payload)
      .eq("id", postId)
      .select("*")
      .single();
    if (error) throw error;
    await logSecurityEvent(req, "blog_updated", true, {
      adminEmail: req.superAdmin.email,
      postId,
      status,
    });
    res.json({ post: serializePost(data) });
  }),
);

router.delete(
  "/blog/:postId",
  asyncHandler(async (req, res) => {
    const postId = String(req.params.postId || "").trim();
    if (String(req.body?.confirm || "") !== "DELETE_BLOG_POST") {
      return res
        .status(400)
        .json({ error: { message: "Type DELETE_BLOG_POST to confirm." } });
    }
    const db = getSupabase();
    const { error } = await db.from("blog_posts").delete().eq("id", postId);
    if (error) throw error;
    await logSecurityEvent(req, "blog_deleted", true, {
      adminEmail: req.superAdmin.email,
      postId,
    });
    res.json({ success: true });
  }),
);

router.post(
  "/blog/upload",
  asyncHandler(async (req, res) => {
    const dataUrl = String(req.body?.dataUrl || "");
    const match = dataUrl.match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/,
    );
    if (!match)
      return res
        .status(400)
        .json({ error: { message: "Upload a JPG, PNG, or WebP image." } });
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: { message: "The image must be smaller than 5 MB." } });
    }
    const extension =
      match[1] === "image/jpeg"
        ? ".jpg"
        : match[1] === "image/png"
          ? ".png"
          : ".webp";
    const cleanName =
      path
        .basename(
          String(req.body?.filename || "blog-image"),
          path.extname(String(req.body?.filename || "")),
        )
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "blog-image";
    const storagePath = `${new Date().getUTCFullYear()}/${uuidv4()}-${cleanName}${extension}`;
    const db = getSupabase();
    const { error } = await db.storage
      .from("blog-media")
      .upload(storagePath, buffer, {
        contentType: match[1],
        upsert: false,
        cacheControl: "31536000",
      });
    if (error) throw error;
    const { data } = db.storage.from("blog-media").getPublicUrl(storagePath);
    await logSecurityEvent(req, "blog_image_uploaded", true, {
      adminEmail: req.superAdmin.email,
      storagePath,
      size: buffer.length,
    });
    res.status(201).json({ url: data.publicUrl, storagePath });
  }),
);

module.exports = router;
