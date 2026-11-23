"use strict";
/*
 * Front Desk: structured assessment, price-sheet quotes, owner approval.
 *
 * The model never sets a price. It reads the photo and proposes line items
 * using codes from the business's own price sheet; priceLines() then prices
 * them deterministically from that sheet. A code the sheet does not contain
 * is dropped, so a hallucinated service can never appear on a quote.
 *
 * Quotes at or under the owner's auto-send limit go to the customer by email
 * straight away. Anything above it, or anything the business has not opted
 * to auto-send (limit 0), waits for the owner to approve in the dashboard.
 * Email is the only outbound channel here; nothing is sent by SMS/WhatsApp.
 */

const jwt = require("jsonwebtoken");

const UNITS = new Set(["ea", "hr", "sq", "sqft", "lf", "ft", "m", "m2", "job", "visit"]);
const RECOMMENDATIONS = new Set(["repair", "replace", "inspect", "no_action"]);
const QUOTE_STATUSES = ["draft", "pending_approval", "sent", "accepted", "declined", "void"];
const MAX_SHEET_ITEMS = 100;
const MAX_QTY = 10000;

const DEFAULT_SETTINGS = Object.freeze({
  quotesEnabled: false,
  autoSendLimitCents: 0,
  currency: "USD",
  rangeLowPct: 90,
  rangeHighPct: 120,
  priceSheet: [],
  conversationsEnabled: true,
});

function int(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .slice(0, 32);
}

/** Owner input -> stored price sheet. Drops junk rows instead of failing the save. */
function normalizePriceSheet(input) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== "object") continue;
    const label = String(raw.label || "").trim().slice(0, 120);
    const code = cleanCode(raw.code || label);
    const priceCents = int(raw.priceCents ?? raw.price_cents, NaN, 0, 100000000);
    if (!code || !label || !Number.isFinite(priceCents) || seen.has(code)) continue;
    seen.add(code);
    const unit = String(raw.unit || "ea").trim().toLowerCase();
    out.push({ code, label, unit: UNITS.has(unit) ? unit : "ea", priceCents });
    if (out.length >= MAX_SHEET_ITEMS) break;
  }
  return out;
}

function serializeSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    quotesEnabled: row.quotes_enabled === true,
    autoSendLimitCents: int(row.auto_send_limit_cents, 0, 0, 100000000),
    currency: String(row.currency || "USD").toUpperCase().slice(0, 3),
    rangeLowPct: int(row.range_low_pct, 90, 50, 100),
    rangeHighPct: int(row.range_high_pct, 120, 100, 200),
    priceSheet: normalizePriceSheet(row.price_sheet),
    conversationsEnabled: row.conversations_enabled !== false,
  };
}

async function loadSettings(db, organizationId) {
  if (!organizationId) return { ...DEFAULT_SETTINGS };
  try {
    const { data } = await db
      .from("frontdesk_settings")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();
    return serializeSettings(data);
  } catch (_) {
    // Table not migrated yet: behave as if the feature is off.
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(db, organizationId, patch = {}) {
  const current = await loadSettings(db, organizationId);
  const next = {
    organization_id: organizationId,
    quotes_enabled: patch.quotesEnabled === undefined ? current.quotesEnabled : patch.quotesEnabled === true,
    auto_send_limit_cents:
      patch.autoSendLimitCents === undefined
        ? current.autoSendLimitCents
        : int(patch.autoSendLimitCents, 0, 0, 100000000),
    currency: String(patch.currency || current.currency).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "USD",
    range_low_pct: patch.rangeLowPct === undefined ? current.rangeLowPct : int(patch.rangeLowPct, 90, 50, 100),
    range_high_pct: patch.rangeHighPct === undefined ? current.rangeHighPct : int(patch.rangeHighPct, 120, 100, 200),
    price_sheet: patch.priceSheet === undefined ? current.priceSheet : normalizePriceSheet(patch.priceSheet),
    conversations_enabled:
      patch.conversationsEnabled === undefined ? current.conversationsEnabled : patch.conversationsEnabled !== false,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("frontdesk_settings")
    .upsert(next, { onConflict: "organization_id" })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return serializeSettings(data || next);
}

/* ── Assessment ─────────────────────────────────────────────── */

/** Extra instructions appended to the vision prompt when the business has a price sheet. */
function assessmentInstructions(settings) {
  const sheet = (settings?.priceSheet || [])
    .map((i) => `${i.code} = ${i.label} (per ${i.unit})`)
    .join("\n");
  return `
ALSO ASSESS THE PROBLEM FOR THE BUSINESS OWNER. Add these keys to the same JSON object:
 "assessment": {"issue": 2 to 6 words naming the problem, or "" if nothing is wrong,
   "severity": integer 0 (nothing wrong) to 5 (urgent / severe),
   "recommendation": "repair" | "replace" | "inspect" | "no_action",
   "line_items": array of {"code", "qty"} for the work this most likely needs},
 "regions": array of up to 6 areas of the image that show the problem, each
   {"label": 1 to 4 words, "box": [x, y, width, height] as fractions 0 to 1 of the image, origin top-left, "severity": 0 to 5}.
   Only mark what is clearly visible. Use an empty array when nothing specific can be pointed at, and for video frames.
${
  sheet
    ? `For line_items use ONLY these codes from the business's price list, with a realistic quantity in the item's own unit.
- Fixed-price items (per job, visit or ea) need no measuring: when the problem matches one, include it with qty 1, even if the business will confirm on site or a consultation comes first. The owner reviews every estimate before the customer sees it.
- Measured items (per m2, sqft, ft, lf, m or hr) need a real size: give a quantity only when something of known size in the photo makes the size clear. Otherwise leave them out and use a fixed-price item that fits instead.
- Return an empty line_items array only when nothing on the list matches the problem, or nothing is wrong. Recommend "inspect" when the job still needs to be seen in person.
PRICE LIST CODES:
${sheet}
Do NOT state any price or total in "reply". The system adds the estimate itself.`
    : `This business has no price list, so return an empty line_items array.`
}`;
}

function clampFrac(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/** Tolerant normaliser for the model's regions: bad boxes are dropped, good ones clipped to the image. */
function normalizeRegions(input) {
  const out = [];
  for (const r of Array.isArray(input) ? input : []) {
    const b = Array.isArray(r?.box) ? r.box.map(clampFrac) : null;
    if (!b || b.length !== 4 || b.some((v) => v === null)) continue;
    const [x, y] = b;
    const w = Math.min(b[2], 1 - x);
    const h = Math.min(b[3], 1 - y);
    if (w < 0.01 || h < 0.01) continue;
    out.push({
      label: String(r.label || "Area").slice(0, 40),
      box: [x, y, w, h].map((v) => Math.round(v * 1000) / 1000),
      severity: int(r.severity, 0, 0, 5),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeAssessment(input, settings) {
  const a = input && typeof input === "object" ? input : {};
  const codes = new Map((settings?.priceSheet || []).map((i) => [i.code, i]));
  const merged = new Map();
  for (const li of Array.isArray(a.line_items) ? a.line_items : []) {
    const code = cleanCode(li?.code);
    const qty = Number(li?.qty);
    if (!codes.has(code) || !Number.isFinite(qty) || qty <= 0) continue;
    merged.set(code, Math.min(MAX_QTY, (merged.get(code) || 0) + qty));
  }
  const rec = String(a.recommendation || "").toLowerCase();
  return {
    issue: String(a.issue || "").slice(0, 80),
    severity: int(a.severity, 0, 0, 5),
    recommendation: RECOMMENDATIONS.has(rec) ? rec : "inspect",
    lineItems: [...merged].map(([code, qty]) => ({ code, qty: Math.round(qty * 100) / 100 })),
  };
}

/* ── Pricing ────────────────────────────────────────────────── */

function priceLines(lineItems, settings) {
  const sheet = new Map((settings?.priceSheet || []).map((i) => [i.code, i]));
  const lines = [];
  for (const li of lineItems || []) {
    const item = sheet.get(li.code);
    if (!item) continue;
    lines.push({
      code: item.code,
      description: item.label,
      qty: li.qty,
      unit: item.unit,
      unitPriceCents: item.priceCents,
      totalCents: Math.round(item.priceCents * li.qty),
    });
  }
  const subtotalCents = lines.reduce((s, l) => s + l.totalCents, 0);
  // A photo estimate carries uncertainty: present a range, pinned on inspection.
  return {
    lines,
    subtotalCents,
    lowCents: Math.round((subtotalCents * (settings?.rangeLowPct ?? 90)) / 100),
    highCents: Math.round((subtotalCents * (settings?.rangeHighPct ?? 120)) / 100),
  };
}

function money(cents, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(
      Math.round(Number(cents || 0) / 100),
    );
  } catch (_) {
    return `${currency} ${Math.round(Number(cents || 0) / 100)}`;
  }
}

/** Goes out without the owner only when they set a limit and the top of the range is inside it. */
function needsApproval(quote, settings) {
  const limit = Number(settings?.autoSendLimitCents || 0);
  return !(limit > 0 && Number(quote.highCents ?? quote.high_cents) <= limit);
}

/** What the assistant may say in chat about a fresh quote. Never a price that still needs approval. */
function quoteChatLine(quote, settings, { hasEmail }) {
  if (!quote || !quote.lines?.length) return "";
  if (needsApproval(quote, settings))
    return hasEmail
      ? "I've passed this to the team to prepare your quote. You'll get it by email."
      : "I've passed this to the team to prepare a quote. Leave your email and they'll send it over.";
  const range = `${money(quote.lowCents, settings.currency)} to ${money(quote.highCents, settings.currency)}`;
  return hasEmail
    ? `Going by our price list, a rough estimate is ${range}, to be confirmed on inspection. I've emailed you the breakdown.`
    : `Going by our price list, a rough estimate is ${range}, to be confirmed on inspection. Leave your email and I'll send the full breakdown.`;
}

/* ── Quote tokens (public quote page linked from the email) ──── */

function quoteSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not configured.");
  return `frontdesk-quote:${s}`;
}
function signQuoteToken(quoteId) {
  return jwt.sign({ q: quoteId }, quoteSecret(), { expiresIn: "60d" });
}
function verifyQuoteToken(token) {
  try {
    const p = jwt.verify(String(token || ""), quoteSecret());
    return typeof p.q === "string" ? p.q : null;
  } catch (_) {
    return null;
  }
}

/* ── Quote rows ─────────────────────────────────────────────── */

function serializeQuote(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id || null,
    mediaId: row.chat_media_id || null,
    chatbotId: row.chatbot_id || null,
    status: row.status,
    lines: Array.isArray(row.lines) ? row.lines : [],
    subtotalCents: row.subtotal_cents,
    lowCents: row.low_cents,
    highCents: row.high_cents,
    currency: row.currency,
    assessment: row.assessment || null,
    summary: row.summary || "",
    sentTo: row.sent_to || null,
    sentAt: row.sent_at || null,
    approvedAt: row.approved_at || null,
    acceptedAt: row.accepted_at || null,
    createdAt: row.created_at,
  };
}

/** Builds and stores a draft quote from an analysed photo. Returns null when there is nothing to price. */
async function createQuoteFromAnalysis(db, { media, analysis, settings }) {
  if (!settings?.quotesEnabled || !analysis?.assessment?.lineItems?.length) return null;
  const priced = priceLines(analysis.assessment.lineItems, settings);
  if (!priced.lines.length || priced.subtotalCents <= 0) return null;
  const row = {
    organization_id: media.organization_id,
    chatbot_id: media.chatbot_id,
    lead_id: media.lead_id || null,
    session_id: media.session_id || null,
    chat_media_id: media.id,
    status: "draft",
    lines: priced.lines,
    subtotal_cents: priced.subtotalCents,
    low_cents: priced.lowCents,
    high_cents: priced.highCents,
    currency: settings.currency,
    assessment: analysis.assessment,
    summary: String(analysis.summary || "").slice(0, 500),
  };
  const { data, error } = await db.from("lead_quotes").insert(row).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

async function loadLead(db, organizationId, leadId) {
  if (!leadId) return null;
  const { data } = await db
    .from("leads")
    .select("id,name,email,phone,organization_id,crm_stage")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data || null;
}

async function organizationName(db, organizationId) {
  try {
    const { data } = await db.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    return data?.name || "our team";
  } catch (_) {
    return "our team";
  }
}

function publicBaseUrl() {
  return String(process.env.API_PUBLIC_URL || process.env.PUBLIC_API_URL || process.env.API_URL || "").replace(/\/+$/, "");
}
function quoteUrl(quoteId) {
  const base = publicBaseUrl();
  return base ? `${base}/api/chatbot-public/quote/${signQuoteToken(quoteId)}` : null;
}

/**
 * Emails a quote to its lead and marks it sent. `force` is the owner's
 * approval; without it a quote that needs approval is parked instead.
 * Returns { status, quote, reason? } and never throws for a missing email.
 */
async function dispatchQuote(db, quoteRow, { settings, force = false, approvedBy = null, deps = {} } = {}) {
  const email = deps.email || require("./email");
  const now = new Date().toISOString();
  const lead = await loadLead(db, quoteRow.organization_id, quoteRow.lead_id);
  if (!lead) return { status: quoteRow.status, quote: quoteRow, reason: "no_lead" };

  const update = async (patch) => {
    const { data, error } = await db
      .from("lead_quotes")
      .update({ ...patch, updated_at: now })
      .eq("id", quoteRow.id)
      .eq("organization_id", quoteRow.organization_id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data || { ...quoteRow, ...patch };
  };

  if (!force && needsApproval(quoteRow, settings)) {
    if (quoteRow.status === "pending_approval") return { status: "pending_approval", quote: quoteRow };
    const parked = await update({ status: "pending_approval" });
    await notifyOwner(db, {
      organizationId: quoteRow.organization_id,
      type: "quote_needs_approval",
      title: "A quote is waiting for your approval",
      body: `${lead.name || "A customer"}: ${money(quoteRow.low_cents, quoteRow.currency)} to ${money(quoteRow.high_cents, quoteRow.currency)}`,
      entityId: quoteRow.id,
      metadata: { lead_id: lead.id, quote_id: quoteRow.id },
    });
    return { status: "pending_approval", quote: parked };
  }

  if (!lead.email) {
    // Approved, but nowhere to send it: keep it visible to the owner.
    const parked = await update({
      status: "pending_approval",
      ...(force ? { approved_by: approvedBy, approved_at: now } : {}),
    });
    return { status: "pending_approval", quote: parked, reason: "no_email" };
  }

  await email.sendQuoteEmail(
    {
      toEmail: lead.email,
      customerName: lead.name,
      businessName: await organizationName(db, quoteRow.organization_id),
      quote: serializeQuote(quoteRow),
      quoteUrl: quoteUrl(quoteRow.id),
    },
    { organizationId: quoteRow.organization_id, metadata: { quote_id: quoteRow.id, lead_id: lead.id } },
  );
  const sent = await update({
    status: "sent",
    sent_to: lead.email,
    sent_at: now,
    ...(force ? { approved_by: approvedBy, approved_at: now } : {}),
  });
  try {
    await db
      .from("leads")
      .update({
        crm_stage: ["appointment_set", "won"].includes(lead.crm_stage) ? lead.crm_stage : "proposal_sent",
        estimated_value_cents: Math.round((quoteRow.low_cents + quoteRow.high_cents) / 2),
        last_activity_at: now,
        updated_at: now,
      })
      .eq("id", lead.id);
    const { recordLeadActivity } = require("./lead-crm-events");
    await recordLeadActivity(db, {
      leadId: lead.id,
      organizationId: quoteRow.organization_id,
      activityType: "email",
      title: force ? "Quote approved and emailed" : "Quote emailed automatically",
      body: `${money(quoteRow.low_cents, quoteRow.currency)} to ${money(quoteRow.high_cents, quoteRow.currency)}`,
      channel: "email",
      direction: "outbound",
      provider: "resend",
      chatbotId: quoteRow.chatbot_id,
      createdBy: approvedBy,
      metadata: { quote_id: quoteRow.id },
    });
  } catch (e) {
    console.warn("[frontdesk] lead update after quote skipped:", e.message);
  }
  return { status: "sent", quote: sent };
}

/** A visitor just left contact details: their draft quotes from this visit now have somewhere to go. */
async function claimSessionQuotes(db, { chatbotId, sessionId, leadId, settings, deps }) {
  if (!chatbotId || !sessionId || !leadId) return [];
  const { data, error } = await db
    .from("lead_quotes")
    .update({ lead_id: leadId, updated_at: new Date().toISOString() })
    .eq("chatbot_id", chatbotId)
    .eq("session_id", sessionId)
    .is("lead_id", null)
    .select("*");
  if (error) throw new Error(error.message);
  const results = [];
  for (const q of data || []) {
    if (q.status !== "draft") continue;
    try {
      results.push(await dispatchQuote(db, q, { settings, deps }));
    } catch (e) {
      console.warn("[frontdesk] quote dispatch failed:", e.message);
    }
  }
  return results;
}

async function notifyOwner(db, { organizationId, type, title, body, entityType = "quote", entityId = null, metadata = {} }) {
  try {
    await db.from("tenant_notifications").insert({
      organization_id: organizationId,
      user_id: null,
      type,
      title,
      body,
      entity_type: entityType,
      entity_id: entityId,
      voice_agent_id: null,
      call_record_id: null,
      is_read: false,
      metadata,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[frontdesk] notification skipped:", e.message);
  }
}

/* ── KPIs ───────────────────────────────────────────────────── */

function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Pure: funnel numbers from rows already scoped to one organization and period. */
function computeKpis({ media = [], quotes = [], leads = [] }) {
  const mediaAt = new Map(media.map((m) => [m.id, Date.parse(m.created_at)]));
  const live = quotes.filter((q) => q.status !== "void");
  const sent = live.filter((q) => q.sent_at);
  const quotedLeadIds = new Set(sent.map((q) => q.lead_id).filter(Boolean));
  const stageOf = new Map(leads.map((l) => [l.id, l.crm_stage || "new"]));
  const booked = [...quotedLeadIds].filter((id) => ["appointment_set", "won"].includes(stageOf.get(id))).length;
  const secondsToQuote = sent
    .map((q) => (Date.parse(q.sent_at) - (mediaAt.get(q.chat_media_id) ?? Date.parse(q.created_at))) / 1000)
    .filter((s) => s >= 0);
  const byStage = {};
  for (const l of leads) byStage[l.crm_stage || "new"] = (byStage[l.crm_stage || "new"] || 0) + 1;
  return {
    photosReceived: media.length,
    quotesCreated: live.length,
    quotesSent: sent.length,
    quotesPendingApproval: live.filter((q) => q.status === "pending_approval").length,
    quotesAccepted: live.filter((q) => q.status === "accepted").length,
    quotedValueCents: sent.reduce((s, q) => s + Math.round((q.low_cents + q.high_cents) / 2), 0),
    medianSecondsToQuote: median(secondsToQuote),
    quotedLeads: quotedLeadIds.size,
    bookedAfterQuote: booked,
    bookedRate: quotedLeadIds.size ? booked / quotedLeadIds.size : null,
    leadsByStage: byStage,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  QUOTE_STATUSES,
  normalizePriceSheet,
  serializeSettings,
  loadSettings,
  saveSettings,
  assessmentInstructions,
  normalizeRegions,
  normalizeAssessment,
  priceLines,
  money,
  needsApproval,
  quoteChatLine,
  signQuoteToken,
  verifyQuoteToken,
  quoteUrl,
  publicBaseUrl,
  serializeQuote,
  createQuoteFromAnalysis,
  dispatchQuote,
  claimSessionQuotes,
  notifyOwner,
  computeKpis,
  loadLead,
  organizationName,
};
