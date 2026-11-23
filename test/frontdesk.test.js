"use strict";
/*
 * Front Desk port: price-sheet quotes with owner approval, the AI gateway,
 * and the owner inbox.
 *
 * What matters most: the model can never put a price or a service on a quote
 * that the business's own sheet does not contain; nothing above the owner's
 * limit reaches a customer without approval; a transcript from a visitor who
 * never left details is deleted; and one tenant cannot read another's chats.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-frontdesk";
const frontdesk = require("../lib/frontdesk");
const inbox = require("../lib/chat-inbox");
const media = require("../lib/chat-media");
const gw = require("../lib/ai-gateway");
const fdPublic = require("../api/routes/frontdesk-public");
const fdWidget = require("../lib/frontdesk-widget");
const { makeFakeSupabase } = require("./helpers/fake-supabase");

/** The fake does not default ids or timestamps the way Postgres does. */
function db(seed) {
  const fake = makeFakeSupabase(seed);
  const from = fake.from.bind(fake);
  fake.from = (table) => {
    const q = from(table);
    const insert = q.insert.bind(q);
    q.insert = (payload) => {
      const fill = (r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r });
      return insert(Array.isArray(payload) ? payload.map(fill) : fill(payload));
    };
    return q;
  };
  return fake;
}

const SHEET = [
  { code: "SHINGLE", label: "Replace shingles", unit: "sq", priceCents: 45000 },
  { code: "FLASH", label: "Reseal flashing", unit: "lf", priceCents: 1500 },
];
const settings = (over = {}) => ({ ...frontdesk.DEFAULT_SETTINGS, quotesEnabled: true, priceSheet: SHEET, ...over });

test("price sheet: junk rows are dropped, codes normalised, duplicates ignored", () => {
  const sheet = frontdesk.normalizePriceSheet([
    { code: "shingle repl", label: "Replace shingles", unit: "SQ", priceCents: 45000 },
    { code: "SHINGLE_REPL", label: "dup", priceCents: 1 },
    { label: "No price" },
    { code: "X", label: "Negative", priceCents: -5 },
    { code: "odd", label: "Odd unit", unit: "parsecs", priceCents: 100 },
    "nonsense",
  ]);
  assert.deepEqual(sheet.map((i) => i.code), ["SHINGLE_REPL", "X", "ODD"]);
  assert.equal(sheet[0].unit, "sq");
  assert.equal(sheet[1].priceCents, 0, "clamped to zero, never negative");
  assert.equal(sheet[2].unit, "ea");
});

test("assessment: only codes on the business's sheet survive", () => {
  const a = frontdesk.normalizeAssessment(
    {
      issue: "Missing shingles",
      severity: 9,
      recommendation: "DEMOLISH",
      line_items: [
        { code: "shingle", qty: 2 },
        { code: "SHINGLE", qty: 1.5 },
        { code: "GOLD_ROOF", qty: 1 },
        { code: "FLASH", qty: -3 },
        { code: "FLASH", qty: "lots" },
      ],
    },
    settings(),
  );
  assert.deepEqual(a.lineItems, [{ code: "SHINGLE", qty: 3.5 }]);
  assert.equal(a.severity, 5);
  assert.equal(a.recommendation, "inspect");
});

test("pricing is deterministic and comes from the sheet", () => {
  const q = frontdesk.priceLines([{ code: "SHINGLE", qty: 2 }, { code: "FLASH", qty: 10 }, { code: "NOPE", qty: 1 }], settings());
  assert.equal(q.lines.length, 2);
  assert.equal(q.subtotalCents, 105000);
  assert.equal(q.lowCents, 94500);
  assert.equal(q.highCents, 126000);
});

test("approval: limit 0 always asks the owner; a limit lets small quotes through", () => {
  const q = { highCents: 126000 };
  assert.equal(frontdesk.needsApproval(q, settings()), true);
  assert.equal(frontdesk.needsApproval(q, settings({ autoSendLimitCents: 126000 })), false);
  assert.equal(frontdesk.needsApproval(q, settings({ autoSendLimitCents: 125999 })), true);
});

test("the chat never states a price that still needs approval", () => {
  const q = { lines: [{}], lowCents: 94500, highCents: 126000 };
  const held = frontdesk.quoteChatLine(q, settings(), { hasEmail: false });
  assert.doesNotMatch(held, /\$/);
  const auto = frontdesk.quoteChatLine(q, settings({ autoSendLimitCents: 200000 }), { hasEmail: true });
  assert.match(auto, /\$945 to \$1,260/);
});

test("regions: boxes are clipped to the image and bad ones dropped", () => {
  const r = frontdesk.normalizeRegions([
    { label: "Lifted flashing", box: [0.8, 0.8, 0.5, 0.5], severity: 3 },
    { label: "bad", box: [0.1, 0.1] },
    { label: "tiny", box: [0.1, 0.1, 0.001, 0.2] },
    { label: "nan", box: ["a", 0, 1, 1] },
  ]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].box, [0.8, 0.8, 0.2, 0.2]);
});

test("analyzeMedia returns assessment and regions when quotes are on, on the assessment model", async () => {
  let sent = null;
  const openai = {
    chat: {
      completions: {
        create: async (req) => {
          sent = req;
          return {
            model: req.model,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: "Two shingles are missing.",
                    summary: "Missing shingles near the ridge",
                    urgency: "medium",
                    confidence: 0.8,
                    assessment: { issue: "Missing shingles", severity: 3, recommendation: "repair", line_items: [{ code: "SHINGLE", qty: 1 }, { code: "MADE_UP", qty: 4 }] },
                    regions: [{ label: "Missing", box: [0.2, 0.3, 0.2, 0.1], severity: 3 }],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };
  const assistant = { loadChatbotContext: async () => ({}), buildAssistantPrompt: () => "BASE", cleanAssistantResponse: (t) => t };
  const r = await media.analyzeMedia(
    { chatbotId: "bot-1", kind: "photo", images: [Buffer.from("img")], settings: settings() },
    { openai, assistant },
  );
  assert.equal(sent.model, media.ASSESS_MODEL);
  assert.equal(sent.max_tokens, undefined, "current models take max_completion_tokens");
  assert.ok(sent.max_completion_tokens > 0);
  assert.match(sent.messages[0].content, /SHINGLE = Replace shingles/);
  assert.match(sent.messages[0].content, /Do NOT state any price/);
  assert.equal(sent.messages.at(-1).content.find((p) => p.type === "image_url").image_url.detail, "high");
  assert.deepEqual(r.analysis.assessment.lineItems, [{ code: "SHINGLE", qty: 1 }]);
  assert.equal(r.analysis.regions.length, 1);
});

test("analyzeMedia falls back when the provider rejects the model", async () => {
  const models = [];
  const openai = {
    chat: {
      completions: {
        create: async (req) => {
          models.push(req.model);
          if (models.length === 1) throw Object.assign(new Error("model not found"), { status: 404 });
          return { model: req.model, choices: [{ message: { content: JSON.stringify({ reply: "ok" }) } }] };
        },
      },
    },
  };
  const assistant = { loadChatbotContext: async () => ({}), buildAssistantPrompt: () => "BASE" };
  const r = await media.analyzeMedia({ chatbotId: "b", kind: "photo", images: [Buffer.from("x")] }, { openai, assistant });
  assert.deepEqual(models, [media.VISION_MODEL, media.FALLBACK_MODEL]);
  assert.equal(r.analysis.reply, "ok");
  assert.deepEqual(media.completionParams("gpt-4o-mini", 10), { model: "gpt-4o-mini", temperature: 0.2, max_tokens: 10 });
});

/* ── Quote lifecycle ── */
function quoteWorld({ email = "pat@example.com", limit = 0 } = {}) {
  const d = db({
    leads: [{ id: "lead-1", organization_id: "org-1", name: "Pat", email, crm_stage: "new" }],
    organizations: [{ id: "org-1", name: "Halcyon Roofing" }],
    lead_quotes: [],
    tenant_notifications: [],
    lead_activities: [],
  });
  const sentMail = [];
  const deps = { email: { sendQuoteEmail: async (m) => sentMail.push(m) } };
  const s = settings({ autoSendLimitCents: limit });
  const analysis = { summary: "Missing shingles", assessment: { lineItems: [{ code: "SHINGLE", qty: 2 }] } };
  const mediaRow = { id: "m1", organization_id: "org-1", chatbot_id: "bot-1", lead_id: "lead-1", session_id: "s".repeat(32) };
  return { d, sentMail, deps, s, analysis, mediaRow };
}

test("a quote over the limit waits for the owner and notifies them, once", async () => {
  const w = quoteWorld();
  const q = await frontdesk.createQuoteFromAnalysis(w.d, { media: w.mediaRow, analysis: w.analysis, settings: w.s });
  assert.equal(q.high_cents, 108000);
  const r = await frontdesk.dispatchQuote(w.d, q, { settings: w.s, deps: w.deps });
  assert.equal(r.status, "pending_approval");
  assert.equal(w.sentMail.length, 0);
  assert.equal(w.d._rows("tenant_notifications").length, 1);
  await frontdesk.dispatchQuote(w.d, r.quote, { settings: w.s, deps: w.deps });
  assert.equal(w.d._rows("tenant_notifications").length, 1, "no second notification");

  const approved = await frontdesk.dispatchQuote(w.d, r.quote, { settings: w.s, deps: w.deps, force: true, approvedBy: "user-1" });
  assert.equal(approved.status, "sent");
  assert.equal(w.sentMail.length, 1);
  assert.equal(w.sentMail[0].toEmail, "pat@example.com");
  assert.equal(w.d._rows("lead_quotes")[0].approved_by, "user-1");
  assert.equal(w.d._rows("leads")[0].crm_stage, "proposal_sent");
  assert.equal(w.d._rows("leads")[0].estimated_value_cents, 94500);
});

test("a quote inside the limit is emailed without the owner", async () => {
  const w = quoteWorld({ limit: 200000 });
  const q = await frontdesk.createQuoteFromAnalysis(w.d, { media: w.mediaRow, analysis: w.analysis, settings: w.s });
  const r = await frontdesk.dispatchQuote(w.d, q, { settings: w.s, deps: w.deps });
  assert.equal(r.status, "sent");
  assert.equal(w.sentMail.length, 1);
});

test("no email address: the quote is parked, never silently dropped", async () => {
  const w = quoteWorld({ email: "", limit: 200000 });
  const q = await frontdesk.createQuoteFromAnalysis(w.d, { media: w.mediaRow, analysis: w.analysis, settings: w.s });
  const r = await frontdesk.dispatchQuote(w.d, q, { settings: w.s, deps: w.deps });
  assert.equal(r.status, "pending_approval");
  assert.equal(r.reason, "no_email");
  assert.equal(w.sentMail.length, 0);
});

test("quotes off or nothing priced: no quote row", async () => {
  const w = quoteWorld();
  assert.equal(await frontdesk.createQuoteFromAnalysis(w.d, { media: w.mediaRow, analysis: w.analysis, settings: settings({ quotesEnabled: false }) }), null);
  assert.equal(await frontdesk.createQuoteFromAnalysis(w.d, { media: w.mediaRow, analysis: { assessment: { lineItems: [] } }, settings: w.s }), null);
  assert.equal(w.d._rows("lead_quotes").length, 0);
});

test("leaving contact details claims only this visit's draft quotes", async () => {
  const w = quoteWorld({ limit: 200000 });
  const anon = { ...w.mediaRow, lead_id: null };
  await frontdesk.createQuoteFromAnalysis(w.d, { media: anon, analysis: w.analysis, settings: w.s });
  await frontdesk.createQuoteFromAnalysis(w.d, { media: { ...anon, id: "m2", session_id: "t".repeat(32) }, analysis: w.analysis, settings: w.s });
  const out = await frontdesk.claimSessionQuotes(w.d, { chatbotId: "bot-1", sessionId: "s".repeat(32), leadId: "lead-1", settings: w.s, deps: w.deps });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "sent");
  const rows = w.d._rows("lead_quotes");
  assert.equal(rows.find((r) => r.session_id === "t".repeat(32)).lead_id, null, "another visitor's quote untouched");
});

test("quote token cannot be forged and the email escapes customer text", () => {
  const t = frontdesk.signQuoteToken("q-1");
  assert.equal(frontdesk.verifyQuoteToken(t), "q-1");
  assert.equal(frontdesk.verifyQuoteToken("q-1"), null);
  assert.equal(frontdesk.verifyQuoteToken(t + "x"), null);
  const html = require("../lib/email").quoteEmailHtml({
    customerName: "<script>x</script>",
    businessName: "A&B",
    quoteUrl: "https://x.test/q",
    quote: { lines: [{ description: "<b>l</b>", qty: 1, unit: "ea", totalCents: 100 }], lowCents: 90, highCents: 120, currency: "USD", summary: "" },
  });
  assert.doesNotMatch(html, /<script>|<b>l<\/b>/);
  const page = fdPublic.quotePage({
    business: "A<B",
    token: "tok",
    slots: [{ start: "2026-12-01T15:00:00.000Z", label: "Tue 9am" }],
    quote: { lines: [{ description: "<i>x</i>", qty: 1, unit: "ea", totalCents: 100 }], lowCents: 90, highCents: 120, currency: "USD", summary: "", status: "sent" },
  });
  assert.doesNotMatch(page, /<i>x<\/i>|A<B/);
  assert.match(page, /name="startISO" value="2026-12-01T15:00:00.000Z"/);
});

test("KPIs: time to quote and booked rate", () => {
  const k = frontdesk.computeKpis({
    media: [{ id: "m1", created_at: "2026-11-16T10:00:00Z" }, { id: "m2", created_at: "2026-11-16T10:00:00Z" }],
    quotes: [
      { id: "q1", lead_id: "l1", chat_media_id: "m1", status: "sent", low_cents: 100, high_cents: 300, sent_at: "2026-11-16T10:01:00Z", created_at: "2026-11-16T10:00:30Z" },
      { id: "q2", lead_id: "l2", chat_media_id: "m2", status: "sent", low_cents: 100, high_cents: 100, sent_at: "2026-11-16T10:05:00Z", created_at: "2026-11-16T10:00:30Z" },
      { id: "q3", lead_id: "l3", status: "pending_approval", low_cents: 1, high_cents: 1, created_at: "2026-11-16T10:00:30Z" },
      { id: "q4", lead_id: "l3", status: "void", low_cents: 1, high_cents: 1, created_at: "2026-11-16T10:00:30Z" },
    ],
    leads: [{ id: "l1", crm_stage: "appointment_set" }, { id: "l2", crm_stage: "proposal_sent" }, { id: "l3" }],
  });
  assert.equal(k.photosReceived, 2);
  assert.equal(k.quotesCreated, 3);
  assert.equal(k.quotesSent, 2);
  assert.equal(k.quotesPendingApproval, 1);
  assert.equal(k.medianSecondsToQuote, 180);
  assert.equal(k.bookedRate, 0.5);
  assert.equal(k.quotedValueCents, 300);
  assert.deepEqual(k.leadsByStage, { appointment_set: 1, proposal_sent: 1, new: 1 });
});

test("slots offered are spread across half-days", () => {
  const slots = fdPublic.pickSlots(
    [
      { start: "2026-12-01T15:00:00Z", label: "a" },
      { start: "2026-12-01T16:00:00Z", label: "b" },
      { start: "2026-12-01T20:00:00Z", label: "c" },
      { start: "2026-12-02T15:00:00Z", label: "d" },
      { start: "2026-12-02T16:00:00Z", label: "e" },
      { start: "garbage", label: "x" },
    ],
    3,
    "America/Chicago",
  );
  assert.deepEqual(slots.map((s) => s.label), ["a", "c", "d"]);
});

/* ── AI gateway ── */
test("gateway: identical concurrent requests share one upstream call and repeats hit the cache", async () => {
  const g = new gw.AiGateway({ attempts: 1 });
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { n: calls };
  };
  const key = { img: Buffer.from("same"), note: "hi" };
  const [a, b] = await Promise.all([g.call("vision", key, fn), g.call("vision", { note: "hi", img: Buffer.from("same") }, fn)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  await g.call("vision", key, fn);
  assert.equal(calls, 1);
  await g.call("vision", { img: Buffer.from("other"), note: "hi" }, fn);
  assert.equal(calls, 2);
  assert.equal(g.stats().cache.hits, 2);
});

test("gateway: failures are not cached, transient errors retry, caller errors do not", async () => {
  const g = new gw.AiGateway({ attempts: 3, sleep: async () => {} });
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n < 3) throw Object.assign(new Error("overloaded"), { status: 503 });
    return "ok";
  };
  assert.equal(await g.call("vision", "k1", flaky), "ok");
  assert.equal(n, 3);
  let bad = 0;
  await assert.rejects(g.call("vision", "k2", async () => { bad += 1; throw Object.assign(new Error("bad request"), { status: 400 }); }));
  assert.equal(bad, 1);
  await assert.rejects(g.call("vision", "k2", async () => { bad += 1; throw Object.assign(new Error("bad request"), { status: 400 }); }));
  assert.equal(bad, 2, "the failure was not cached");
});

test("gateway: breaker opens after repeated provider failures and recovers", async () => {
  let now = 0;
  const b = new gw.CircuitBreaker(2, 1000, () => now);
  const down = async () => { throw Object.assign(new Error("down"), { status: 500 }); };
  await assert.rejects(b.run(down));
  await assert.rejects(b.run(down));
  assert.equal(b.state, "open");
  let reached = false;
  await assert.rejects(b.run(async () => { reached = true; }), { code: "AI_CIRCUIT_OPEN" });
  assert.equal(reached, false, "an open breaker does not call the provider");
  now = 1500;
  assert.equal(b.state, "half_open");
  await b.run(async () => "ok");
  assert.equal(b.state, "closed");
  // A 4xx is our bug, not an outage: it must not open the breaker.
  const c = new gw.CircuitBreaker(1, 1000, () => now);
  await assert.rejects(c.run(async () => { throw Object.assign(new Error("bad"), { status: 400 }); }));
  assert.equal(c.state, "closed");
});

test("gateway: throttle caps concurrency and refuses when the queue is full", async () => {
  const t = new gw.Throttle({ rps: 1000, burst: 1000, concurrency: 2, maxQueue: 3 });
  let live = 0, peak = 0;
  const job = async () => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live -= 1; };
  const jobs = [t.run(job), t.run(job), t.run(job), t.run(job), t.run(job)];
  await assert.rejects(t.run(job), { code: "AI_BUSY" });
  await Promise.all(jobs);
  assert.equal(peak, 2);
  await assert.rejects(gw.withTimeout(new Promise(() => {}), 10, "x"), { code: "AI_TIMEOUT" });
});

/* ── Inbox ── */
test("inbox: messages are stored in order, unread counts, owner reply clears them", async () => {
  const d = db({ chat_conversations: [], chat_inbox_messages: [] });
  const c = await inbox.ensureConversation(d, { organizationId: "org-1", chatbotId: "bot-1", sessionId: "s".repeat(32) });
  assert.ok(c.expires_at, "an anonymous visit expires");
  const again = await inbox.ensureConversation(d, { organizationId: "org-1", chatbotId: "bot-1", sessionId: "s".repeat(32) });
  assert.equal(again.id, c.id);
  await inbox.appendMessages(d, c, [{ role: "visitor", body: "Hi" }, { role: "assistant", body: "Hello!" }, { role: "hacker", body: "x" }, { role: "visitor", body: "" }]);
  let row = d._rows("chat_conversations")[0];
  assert.equal(row.unread_owner, 1);
  assert.equal(row.last_preview, "Hello!");
  const msgs = d._rows("chat_inbox_messages");
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].created_at < msgs[1].created_at);
  await inbox.appendMessages(d, c, [{ role: "owner", body: "This is Sam from the team." }]);
  row = d._rows("chat_conversations")[0];
  assert.equal(row.unread_owner, 0);
  const visible = await inbox.messagesForVisitor(d, c.id, {});
  assert.deepEqual(visible.map((m) => m.role), ["assistant", "owner"], "the visitor is not sent their own messages back");
});

test("inbox: lead capture keeps the conversation; anonymous ones are purged", async () => {
  const d = db({
    chat_conversations: [
      { id: "c1", organization_id: "org-1", chatbot_id: "bot-1", session_id: "s".repeat(32), lead_id: null, expires_at: "2026-01-01T00:00:00Z" },
      { id: "c2", organization_id: "org-1", chatbot_id: "bot-1", session_id: "t".repeat(32), lead_id: null, expires_at: "2026-01-01T00:00:00Z" },
      { id: "c3", organization_id: "org-1", chatbot_id: "bot-1", session_id: "u".repeat(32), lead_id: null, expires_at: "2099-01-01T00:00:00Z" },
    ],
  });
  assert.equal(await inbox.linkSessionConversationToLead(d, { chatbotId: "bot-1", sessionId: "s".repeat(32), leadId: "lead-1" }), 1);
  assert.equal(await inbox.purgeExpiredConversations(d, { now: new Date("2026-11-16T00:00:00Z") }), 1);
  assert.deepEqual(d._rows("chat_conversations").map((r) => r.id).sort(), ["c1", "c3"]);
  assert.equal(d._rows("chat_conversations").find((r) => r.id === "c1").expires_at, null);
});

test("inbox: an owner only sees their own organization's conversations", async () => {
  const d = db({
    chat_conversations: [
      { id: "c1", organization_id: "org-1", chatbot_id: "bot-1", session_id: "a", lead_id: "lead-1", status: "ai", last_message_at: "2026-11-16" },
      { id: "c2", organization_id: "org-2", chatbot_id: "bot-2", session_id: "b", lead_id: null, status: "ai", last_message_at: "2026-11-16" },
    ],
    leads: [{ id: "lead-1", organization_id: "org-1", name: "Pat", email: "pat@example.com" }],
    chat_inbox_messages: [{ id: "x", conversation_id: "c2", role: "visitor", body: "secret", created_at: "2026-11-16" }],
  });
  const list = await inbox.listConversations(d, { organizationId: "org-1" });
  assert.deepEqual(list.map((c) => c.id), ["c1"]);
  assert.equal(list[0].leadName, "Pat");
  assert.equal(await inbox.getConversation(d, { organizationId: "org-1", conversationId: "c2" }), null);
});

test("resume link is bound to its chatbot", () => {
  const t = inbox.signResumeToken({ conversationId: "c1", chatbotId: "bot-1" });
  assert.equal(inbox.verifyResumeToken(t, "bot-1"), "c1");
  assert.equal(inbox.verifyResumeToken(t, "bot-2"), null);
  assert.equal(inbox.verifyResumeToken("c1", "bot-1"), null);
  assert.equal(inbox.visitorIsLive({ visitor_seen_at: new Date().toISOString() }), true);
  assert.equal(inbox.visitorIsLive({ visitor_seen_at: null }), false);
});

test("settings: saved and read back; unknown table means the feature is off", async () => {
  const d = db({ frontdesk_settings: [] });
  const saved = await frontdesk.saveSettings(d, "org-1", { quotesEnabled: true, autoSendLimitCents: 50000.4, priceSheet: SHEET, currency: "usd" });
  assert.equal(saved.autoSendLimitCents, 50000);
  assert.equal(saved.currency, "USD");
  const again = await frontdesk.saveSettings(d, "org-1", { conversationsEnabled: false });
  assert.equal(again.quotesEnabled, true, "a partial save keeps the rest");
  assert.equal(again.conversationsEnabled, false);
  assert.equal(d._rows("frontdesk_settings").length, 1);
  const broken = { from: () => { throw new Error("relation does not exist"); } };
  assert.equal((await frontdesk.loadSettings(broken, "org-1")).quotesEnabled, false);
});

test("front desk widget script parses inside the widget scope", () => {
  assert.doesNotThrow(
    () =>
      new Function(
        `var API='',CID='x',msgs={},history=[],greeted=false,sessionLoaded=false;function addBotMsg(){}function addMsg(){}${fdWidget.SCRIPT}`,
      ),
  );
});

test("booking with no usable calendar tells the customer the team will call, not that a time was taken", () => {
  for (const code of ["not_connected", "needs_reconnect"]) {
    const out = fdPublic.bookingUnavailable({ success: false, code }, "Summit Ridge Roofing");
    assert.equal(out.code, "BOOKING_UNAVAILABLE");
    assert.deepEqual(out.slots, []);
    assert.match(out.message, /Summit Ridge Roofing has your details and will contact you/);
    assert.doesNotMatch(out.message, /no longer available/);
  }
  assert.match(fdPublic.bookingUnavailable({ code: "not_connected" }, "  ").message, /The team has your details/);
  // A slot that was taken is a different failure: the route still offers the next open times.
  assert.equal(fdPublic.bookingUnavailable({ success: false, code: "slot_taken" }, "X"), null);
  assert.equal(fdPublic.bookingUnavailable(null, "X"), null);
});

test("assessment prompt: fixed-price items are quoted without measuring; measured items need a visible scale", () => {
  const text = frontdesk.assessmentInstructions({
    priceSheet: [
      { code: "AC_REFRIGERANT", label: "Refrigerant recharge", unit: "job", priceCents: 40000 },
      { code: "ASPHALT", label: "Asphalt shingle", unit: "m2", priceCents: 4500 },
    ],
  });
  assert.match(text, /AC_REFRIGERANT = Refrigerant recharge \(per job\)/);
  assert.match(text, /Fixed-price items \(per job, visit or ea\) need no measuring/);
  assert.match(text, /Measured items \(per m2, sqft, ft, lf, m or hr\) need a real size/);
  assert.match(text, /empty line_items array only when nothing on the list matches/);
  // The old blanket rule made the model drop menu items it could clearly match.
  assert.doesNotMatch(text, /If the photo is not enough to size the job, return an empty/);
  assert.match(frontdesk.assessmentInstructions({ priceSheet: [] }), /no price list, so return an empty line_items array/);
});

test("embed snippet keeps the widget iframe see-through on dark-scheme websites", () => {
  const { buildEmbedForChatbot } = require("../lib/chatbot-widget-utils");
  const { embedScript } = buildEmbedForChatbot({ id: "cb-1", name: "Summit Ridge" }, "https://api.example.test");
  const rule = embedScript.match(/#agently-widget-cb-1\{[^}]*\}/);
  assert.ok(rule, "launcher rule present");
  assert.match(rule[0], /background:transparent/);
  assert.match(rule[0], /color-scheme:normal/);
});
