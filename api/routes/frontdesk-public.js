"use strict";
/*
 * Public Front Desk endpoints used by the chat widget and by the links in
 * customer emails. Mounted under /api/chatbot-public alongside the existing
 * widget routes.
 *
 *   GET  /conversation          owner replies for this visit, or resume by link
 *   GET  /slots                 next few open appointment times
 *   POST /book                  book one, as a known lead
 *   GET  /quote/:token          the estimate page linked from the quote email
 *   POST /quote/:token/accept   accept it, optionally booking a visit
 *
 * Identity: a visitor is either this browser visit (a random session id) or a
 * lead holding the signed token capture-lead issued. Neither endpoint accepts
 * a bare lead id, and booking always requires the lead token or a quote token.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { clientIp } = require("../../lib/client-ip");
const { asyncHandler } = require("../../middleware/error");
const chatMedia = require("../../lib/chat-media");
const inbox = require("../../lib/chat-inbox");
const frontdesk = require("../../lib/frontdesk");

const router = express.Router();

/* Cheap per-process limiter. These endpoints do not call a paid model. */
const hits = new Map();
function limited(key, max, windowMs = 60000) {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now - e.start > windowMs) {
    hits.set(key, { start: now, count: 1 });
    return false;
  }
  e.count += 1;
  return e.count > max;
}
setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [k, e] of hits) if (e.start < cutoff) hits.delete(k);
}, 300000).unref?.();

function tooMany(res) {
  res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } });
}

async function loadChatbot(db, chatbotId) {
  if (!chatbotId) return null;
  const { data } = await db
    .from("chatbots")
    .select("id,organization_id,voice_agent_id,name,header_title")
    .eq("id", chatbotId)
    .maybeSingle();
  return data || null;
}

/** Up to n slots, no two in the same half-day, so the customer sees real choice. */
function pickSlots(slots, n = 3, timeZone = "UTC") {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(slots) ? slots : []) {
    const d = new Date(s.start);
    if (Number.isNaN(d.getTime())) continue;
    let key;
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" })
          .formatToParts(d)
          .map((p) => [p.type, p.value]),
      );
      key = `${parts.year}-${parts.month}-${parts.day}:${Number(parts.hour) < 12 ? "am" : "pm"}`;
    } catch (_) {
      key = d.toISOString().slice(0, 13);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: d.toISOString(), label: s.label || d.toISOString() });
    if (out.length >= n) break;
  }
  return out;
}

/** Open times for an organization, or [] when no calendar is connected or it is unreachable. */
async function openSlots(organizationId, { n = 3, deps = {} } = {}) {
  const cal = deps.calendar || require("../../lib/calendar-booking");
  try {
    const from = new Date(Date.now() + 2 * 3600000); // at least two hours' notice
    const result = await cal.checkAvailability(organizationId, { from });
    if (!result?.success) return [];
    return pickSlots(result.slots, n, result.timeZone || result.timezone || "UTC");
  } catch (e) {
    console.warn("[frontdesk-public] availability failed:", e.message);
    return [];
  }
}

/**
 * The customer-facing answer when booking failed because the business has no
 * usable calendar, or null when the failure was something else (a slot taken).
 */
function bookingUnavailable(result, businessName) {
  if (result?.code !== "not_connected" && result?.code !== "needs_reconnect") return null;
  const who = String(businessName || "").trim() || "The team";
  return {
    success: false,
    code: "BOOKING_UNAVAILABLE",
    message: `Online booking isn't available right now. ${who} has your details and will contact you to arrange a time.`,
    slots: [],
  };
}

async function bookForLead(db, { organizationId, lead, startISO, chatbotId, title, notes, deps = {} }) {
  const cal = deps.calendar || require("../../lib/calendar-booking");
  const result = await cal.bookAppointment(
    organizationId,
    {
      startISO,
      attendeeName: lead.name,
      attendeeEmail: lead.email || null,
      attendeePhone: lead.phone || null,
      title: title || "Visit booked from website chat",
      notes: notes || null,
      leadId: lead.id,
    },
    db,
  );
  if (result?.success) {
    const now = new Date().toISOString();
    try {
      await db
        .from("leads")
        .update({ crm_stage: "appointment_set", status: "contacted", last_activity_at: now, updated_at: now })
        .eq("id", lead.id)
        .eq("organization_id", organizationId);
      const { recordLeadActivity } = require("../../lib/lead-crm-events");
      await recordLeadActivity(db, {
        leadId: lead.id,
        organizationId,
        activityType: "appointment",
        title: "Visit booked by the customer",
        body: result.message || startISO,
        channel: "chat",
        direction: "inbound",
        provider: "agently_chatbot",
        chatbotId: chatbotId || null,
        metadata: { starts_at: startISO },
      });
    } catch (e) {
      console.warn("[frontdesk-public] lead update after booking skipped:", e.message);
    }
  }
  return result;
}

/* ── Conversation: poll for owner replies, or resume from an email link ── */
router.get(
  "/conversation",
  asyncHandler(async (req, res) => {
    const chatbotId = String(req.query.chatbotId || "").trim();
    if (!chatbotId) return res.status(400).json({ error: { message: "chatbotId is required." } });
    if (limited(`conv:${clientIp(req)}:${chatbotId}`, 40)) return tooMany(res);
    const db = getSupabase();

    let row = null;
    let resumed = false;
    if (req.query.resume) {
      const conversationId = inbox.verifyResumeToken(req.query.resume, chatbotId);
      if (!conversationId) return res.status(404).json({ error: { message: "This link has expired." } });
      const { data } = await db
        .from("chat_conversations")
        .select("*")
        .eq("id", conversationId)
        .eq("chatbot_id", chatbotId)
        .maybeSingle();
      row = data || null;
      resumed = true;
    } else {
      const sessionId = chatMedia.cleanSessionId(req.query.sessionId);
      if (!sessionId) return res.status(400).json({ error: { message: "sessionId is required." } });
      row = await inbox.findConversation(db, { chatbotId, sessionId });
    }
    if (!row) return res.json({ status: "none", messages: [] });

    const after = !resumed && req.query.after && !Number.isNaN(Date.parse(req.query.after)) ? new Date(req.query.after).toISOString() : null;
    const messages = await inbox.messagesForVisitor(db, row.id, { after, all: resumed, limit: resumed ? 100 : 30 });
    // Lets the owner's dashboard tell whether a reply will be seen live.
    db.from("chat_conversations")
      .update({ visitor_seen_at: new Date().toISOString() })
      .eq("id", row.id)
      .then(() => {}, () => {});
    res.json({
      status: row.status,
      messages,
      ...(resumed
        ? {
            sessionId: row.session_id,
            // A resumed customer is the lead: give the widget its lead token back.
            mediaToken: row.lead_id ? chatMedia.signMediaToken({ leadId: row.lead_id, chatbotId }) : undefined,
          }
        : {}),
    });
  }),
);

/* ── Booking from chat ─────────────────────────────────────── */
router.get(
  "/slots",
  asyncHandler(async (req, res) => {
    const chatbotId = String(req.query.chatbotId || "").trim();
    if (limited(`slots:${clientIp(req)}:${chatbotId}`, 12)) return tooMany(res);
    const db = getSupabase();
    const chatbot = await loadChatbot(db, chatbotId);
    if (!chatbot) return res.status(404).json({ error: { message: "Chat not found." } });
    res.json({ slots: await openSlots(chatbot.organization_id) });
  }),
);

router.post(
  "/book",
  asyncHandler(async (req, res) => {
    const { chatbotId, startISO, leadToken } = req.body || {};
    if (limited(`book:${clientIp(req)}:${chatbotId}`, 6)) return tooMany(res);
    const db = getSupabase();
    const chatbot = await loadChatbot(db, String(chatbotId || ""));
    if (!chatbot) return res.status(404).json({ error: { message: "Chat not found." } });
    const leadId = chatMedia.verifyMediaToken(leadToken, chatbot.id);
    if (!leadId)
      return res.status(401).json({
        error: { code: "LEAD_REQUIRED", message: "I need your name and email before I can book that." },
      });
    const lead = await frontdesk.loadLead(db, chatbot.organization_id, leadId);
    if (!lead) return res.status(404).json({ error: { message: "I couldn't find your details. Please enter them again." } });
    const result = await bookForLead(db, {
      organizationId: chatbot.organization_id,
      lead,
      startISO,
      chatbotId: chatbot.id,
    });
    const unavailable = bookingUnavailable(result, chatbot.header_title || chatbot.name);
    if (unavailable) {
      // No usable calendar: no time was ever on offer, so "that time is taken"
      // would be untrue. Tell the customer the team will call, and tell the
      // owner a customer is waiting to be booked by hand.
      await frontdesk
        .notifyOwner(db, {
          organizationId: chatbot.organization_id,
          type: "booking_requested",
          title: "A customer asked to book from the website chat",
          body: `${lead.name || "A customer"} wants a visit. Online booking isn't available (${result.code === "needs_reconnect" ? "the calendar needs reconnecting" : "no calendar connected"}), so please contact them to arrange a time.`,
          entityType: "lead",
          entityId: lead.id,
          metadata: { lead_id: lead.id, requested_start: startISO || null, reason: result.code },
        })
        .catch((e) => console.warn("[frontdesk-public] booking request notice skipped:", e.message));
      return res.status(409).json(unavailable);
    }
    if (!result?.success)
      return res.status(409).json({
        success: false,
        message: "That time is no longer available. Here are the next open times.",
        slots: await openSlots(chatbot.organization_id),
      });
    res.json({ success: true, message: result.message || "You're booked. A confirmation is on its way." });
  }),
);

/* ── Quote page (linked from the quote email) ───────────────── */
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function quotePage({ business, quote, token, slots, notice }) {
  const m = (c) => frontdesk.money(c, quote.currency);
  const rows = quote.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="r">${esc(l.qty)} ${esc(l.unit)}</td><td class="r">${m(l.totalCents)}</td></tr>`,
    )
    .join("");
  const done = quote.status === "accepted";
  const action = done
    ? `<p class="ok">Thanks, ${esc(business)} has your confirmation.</p>`
    : slots.length
      ? `<h2>Book a visit</h2><p class="muted">Pick a time and we'll confirm the estimate in person.</p>
<form method="post" action="${esc(token)}/accept">${slots
          .map((s) => `<button name="startISO" value="${esc(s.start)}">${esc(s.label)}</button>`)
          .join("")}<button class="ghost" name="startISO" value="">Accept without booking yet</button></form>`
      : `<form method="post" action="${esc(token)}/accept"><button name="startISO" value="">Accept this estimate</button></form>
<p class="muted">${esc(business)} will contact you to arrange a time.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Estimate from ${esc(business)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px 16px}
main{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:24px 0 4px}table{width:100%;border-collapse:collapse;margin:16px 0}
td{padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:14px}.r{text-align:right;white-space:nowrap;padding-left:12px}
.total{font-size:20px;font-weight:800;margin:12px 0 4px}.muted{color:#64748b;font-size:13px;margin:4px 0 12px}
button{display:block;width:100%;margin:8px 0;padding:14px;border:0;border-radius:12px;background:#0f172a;color:#fff;font-weight:700;font-size:14px;cursor:pointer}
button.ghost{background:#fff;color:#0f172a;border:1px solid #cbd5e1}.ok{background:#ecfdf5;color:#047857;padding:12px 14px;border-radius:12px;font-weight:600}
.note{background:#fffbeb;color:#92400e;padding:12px 14px;border-radius:12px;font-size:14px}</style></head><body><main>
<h1>Your estimate from ${esc(business)}</h1>
${notice ? `<p class="${notice.ok ? "ok" : "note"}">${esc(notice.text)}</p>` : ""}
${quote.summary ? `<p class="muted">${esc(quote.summary)}</p>` : ""}
<table>${rows}</table>
<p class="total">${m(quote.lowCents)} to ${m(quote.highCents)}</p>
<p class="muted">An estimate from your photo, not a final price. It is confirmed when we see the job.</p>
${action}
</main></body></html>`;
}

async function loadQuoteByToken(db, token) {
  const quoteId = frontdesk.verifyQuoteToken(token);
  if (!quoteId) return null;
  const { data } = await db.from("lead_quotes").select("*").eq("id", quoteId).maybeSingle();
  // Only a quote that was actually sent to the customer has a public page.
  if (!data || !["sent", "accepted"].includes(data.status)) return null;
  return data;
}

function notFoundPage(res) {
  res
    .status(404)
    .type("html")
    .send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center;color:#64748b">This estimate link has expired. Please contact the business for a new one.</body></html>`);
}

router.get(
  "/quote/:token",
  asyncHandler(async (req, res) => {
    if (limited(`quote:${clientIp(req)}`, 30)) return tooMany(res);
    const db = getSupabase();
    const row = await loadQuoteByToken(db, req.params.token);
    if (!row) return notFoundPage(res);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(
      quotePage({
        business: await frontdesk.organizationName(db, row.organization_id),
        quote: frontdesk.serializeQuote(row),
        token: req.params.token,
        slots: row.status === "accepted" ? [] : await openSlots(row.organization_id),
      }),
    );
  }),
);

router.post(
  "/quote/:token/accept",
  asyncHandler(async (req, res) => {
    if (limited(`quote-accept:${clientIp(req)}`, 10)) return tooMany(res);
    const db = getSupabase();
    const row = await loadQuoteByToken(db, req.params.token);
    if (!row) return notFoundPage(res);
    const business = await frontdesk.organizationName(db, row.organization_id);
    const lead = await frontdesk.loadLead(db, row.organization_id, row.lead_id);
    const startISO = String(req.body?.startISO || "").trim();
    let notice = { ok: true, text: "Estimate accepted. Thank you!" };
    let current = row;

    if (startISO && lead && row.status !== "accepted") {
      const booked = await bookForLead(db, {
        organizationId: row.organization_id,
        lead,
        startISO,
        chatbotId: row.chatbot_id,
        title: "Visit booked from an estimate",
        notes: row.summary || null,
      });
      if (!booked?.success) {
        res.setHeader("Cache-Control", "no-store");
        return res.type("html").send(
          quotePage({
            business,
            quote: frontdesk.serializeQuote(row),
            token: "../" + req.params.token,
            slots: await openSlots(row.organization_id),
            notice: { ok: false, text: "That time was just taken. Please pick another." },
          }),
        );
      }
      notice = { ok: true, text: booked.message || "You're booked. A confirmation is on its way." };
    }

    if (row.status !== "accepted") {
      const now = new Date().toISOString();
      const { data } = await db
        .from("lead_quotes")
        .update({ status: "accepted", accepted_at: now, updated_at: now })
        .eq("id", row.id)
        .select("*")
        .maybeSingle();
      current = data || { ...row, status: "accepted" };
      await frontdesk.notifyOwner(db, {
        organizationId: row.organization_id,
        type: "quote_accepted",
        title: startISO ? "A customer accepted a quote and booked a visit" : "A customer accepted a quote",
        body: `${lead?.name || "A customer"}: ${frontdesk.money(row.low_cents, row.currency)} to ${frontdesk.money(row.high_cents, row.currency)}`,
        entityId: row.id,
        metadata: { lead_id: row.lead_id, quote_id: row.id, starts_at: startISO || null },
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(
      quotePage({ business, quote: frontdesk.serializeQuote(current), token: "../" + req.params.token, slots: [], notice }),
    );
  }),
);

module.exports = router;
module.exports.pickSlots = pickSlots;
module.exports.openSlots = openSlots;
module.exports.bookForLead = bookForLead;
module.exports.bookingUnavailable = bookingUnavailable;
module.exports.quotePage = quotePage;
