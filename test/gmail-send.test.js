"use strict";
/*
 * Send-from-Gmail. What must never break:
 *   - the grant stays SEND-ONLY (a restricted scope means a paid annual
 *     security assessment, a business decision, not a code change);
 *   - one tenant can never send through another tenant's Gmail;
 *   - header injection cannot add recipients;
 *   - suppressed recipients are never mailed, and every attempt is logged;
 *   - a re-grant never destroys the stored refresh token.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const TEST_KEY = "c".repeat(64);
function ensureKey() {
  if (process.env.CALENDAR_TOKEN_KEY !== TEST_KEY) process.env.CALENDAR_TOKEN_KEY = TEST_KEY;
}
ensureKey();

const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { encryptSecret, decryptSecret } = require("../lib/crypto");
const gmail = require("../lib/gmail-send");

const ORG = "org-sender";
const OTHER = "org-other";

function gmailRow({ id, organizationId = ORG, isDefault = false, automations = {}, status = "connected", email }) {
  ensureKey();
  const binding = { organizationId, provider: "gmail", connectionId: id };
  return {
    id,
    organization_id: organizationId,
    provider: "gmail",
    label: `Label ${id}`,
    provider_user_id: `sub-${id}`,
    provider_user_email: email || `${id}@gmail.test`,
    access_token_encrypted: encryptSecret(`access-${id}`, binding),
    refresh_token_encrypted: encryptSecret(`refresh-${id}`, binding),
    expires_at: "2099-01-01T00:00:00.000Z",
    status,
    is_default: isDefault,
    automations,
    connected_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function db(rows = [], sends = []) {
  return makeFakeSupabase({ email_integrations: rows, email_sends: sends, organizations: [{ id: ORG, name: "Viral Ad Media" }] });
}

function decodeRaw(raw) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** Records Gmail calls; answers like the Gmail API. */
function gmailFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
    return new Response(JSON.stringify({ id: "msg-123" }), { status: 200 });
  };
  return { calls, fetchImpl };
}

const allow = async () => {};

test("the OAuth grant is send-only: gmail.send and nothing restricted", () => {
  const scopes = gmail.GMAIL_SCOPES.split(" ");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  const restricted = ["gmail.readonly", "gmail.modify", "gmail.compose", "gmail.insert", "gmail.metadata", "mail.google.com"];
  for (const r of restricted) assert.ok(!gmail.GMAIL_SCOPES.includes(r), `${r} would require a CASA assessment`);
});

test("sends through the default Gmail with the right token and a well-formed message", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true, email: "owner@gmail.test" })]);
  const { calls, fetchImpl } = gmailFetch();
  const result = await gmail.sendGmail(
    d,
    ORG,
    { to: "lead@example.com", subject: "Your link", body: "Hi Ann,\n\nHere it is: https://x.test/a\n\nTimi" },
    { fetchImpl, assertAllowed: allow },
  );
  assert.equal(result.success, true);
  assert.equal(result.messageId, "msg-123");
  const call = calls[0];
  assert.match(call.url, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/);
  assert.equal(call.options.headers.authorization, "Bearer access-g1");
  const mime = decodeRaw(JSON.parse(call.options.body).raw);
  assert.match(mime, /^From: Label g1 <owner@gmail\.test>\r\n/);
  assert.match(mime, /\r\nTo: lead@example\.com\r\n/);
  assert.match(mime, /\r\nSubject: Your link\r\n/);
  const sent = d._tables.email_sends;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, "sent");
  assert.equal(sent[0].integration_id, "g1");
});

test("a CRLF in the subject cannot inject a Bcc header", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const { calls, fetchImpl } = gmailFetch();
  await gmail.sendGmail(
    d,
    ORG,
    { to: "lead@example.com", subject: "Hello\r\nBcc: attacker@evil.test", body: "x" },
    { fetchImpl, assertAllowed: allow },
  );
  const mime = decodeRaw(JSON.parse(calls[0].options.body).raw);
  assert.ok(!/\r\nBcc:/i.test(mime), "no injected header line");
});

test("an invalid or multi-address recipient is rejected before anything is sent", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const { calls, fetchImpl } = gmailFetch();
  for (const to of ["not-an-email", "a@b.com, c@d.com", "a@b.com\r\nBcc: x@y.z"]) {
    await assert.rejects(
      () => gmail.sendGmail(d, ORG, { to, subject: "s", body: "b" }, { fetchImpl, assertAllowed: allow }),
      (e) => e.status === 400,
    );
  }
  assert.equal(calls.length, 0);
});

test("another tenant's Gmail connection id is never used", async () => {
  const d = db([gmailRow({ id: "theirs", organizationId: OTHER, isDefault: true })]);
  const { calls, fetchImpl } = gmailFetch();
  await assert.rejects(
    () => gmail.sendGmail(d, ORG, { to: "a@b.com", subject: "s", body: "b", connectionId: "theirs" }, { fetchImpl, assertAllowed: allow }),
    (e) => e.code === "gmail_not_connected",
  );
  assert.equal(calls.length, 0);
});

test("a suppressed recipient is blocked and logged, never sent", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const { calls, fetchImpl } = gmailFetch();
  const blocked = async () => {
    const e = new Error("blocked");
    e.code = "EMAIL_RECIPIENT_BLOCKED";
    throw e;
  };
  await assert.rejects(
    () => gmail.sendGmail(d, ORG, { to: "a@b.com", subject: "s", body: "b" }, { fetchImpl, assertAllowed: blocked }),
    (e) => e.status === 422,
  );
  assert.equal(calls.length, 0);
  assert.equal(d._tables.email_sends[0].status, "blocked");
});

test("the daily cap stops sending", async () => {
  const now = new Date().toISOString();
  const sends = Array.from({ length: gmail.DAILY_SEND_CAP }, (_, i) => ({
    id: `s${i}`,
    organization_id: ORG,
    status: "sent",
    to_email: "a@b.com",
    created_at: now,
  }));
  const d = db([gmailRow({ id: "g1", isDefault: true })], sends);
  const { calls, fetchImpl } = gmailFetch();
  await assert.rejects(
    () => gmail.sendGmail(d, ORG, { to: "a@b.com", subject: "s", body: "b" }, { fetchImpl, assertAllowed: allow }),
    (e) => e.status === 429,
  );
  assert.equal(calls.length, 0);
});

test("Gmail answering 401 marks the sender for reconnect", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const { fetchImpl } = gmailFetch(401);
  await assert.rejects(
    () => gmail.sendGmail(d, ORG, { to: "a@b.com", subject: "s", body: "b" }, { fetchImpl, assertAllowed: allow }),
    (e) => e.code === "needs_reconnect",
  );
  assert.equal(d._tables.email_integrations[0].status, "needs_reconnect");
  assert.equal(d._tables.email_sends[0].status, "failed");
});

test("a re-grant without a refresh token keeps the stored one", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const saved = await gmail.saveGmailConnection(d, ORG, {
    accessToken: "new-access",
    refreshToken: null,
    providerUserId: "sub-g1",
    providerUserEmail: "g1@gmail.test",
  });
  assert.equal(saved.id, "g1");
  const binding = { organizationId: ORG, provider: "gmail", connectionId: "g1" };
  assert.equal(decryptSecret(saved.refresh_token_encrypted, binding), "refresh-g1");
  assert.equal(decryptSecret(saved.access_token_encrypted, binding), "new-access");
});

test("a second business's Gmail becomes a second sender, not an overwrite", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const saved = await gmail.saveGmailConnection(d, ORG, {
    accessToken: "a2",
    refreshToken: "r2",
    providerUserId: "sub-second",
    providerUserEmail: "second@gmail.test",
  });
  assert.notEqual(saved.id, "g1");
  assert.equal(saved.is_default, false, "the existing default stays the default");
  assert.equal(d._tables.email_integrations.length, 2);
  // Its tokens are bound to its own row id.
  const binding = { organizationId: ORG, provider: "gmail", connectionId: saved.id };
  assert.equal(decryptSecret(saved.refresh_token_encrypted, binding), "r2");
});

test("connections listed to the browser never carry ciphertext", async () => {
  const d = db([gmailRow({ id: "g1", isDefault: true })]);
  const [row] = await gmail.listEmailConnections(d, ORG);
  assert.equal(row.id, "g1");
  assert.ok(!("access_token_encrypted" in row));
  assert.ok(!("refresh_token_encrypted" in row));
});

test("drafting keeps a provided link verbatim", async () => {
  const fakeOpenAI = {
    chat: {
      completions: {
        create: async () => ({
          model: "gpt-4o-mini",
          usage: {},
          choices: [{ message: { content: JSON.stringify({ subject: "Rescheduling", body: "Hi Ann, pick a new time.\n\nTimi" }) } }],
        }),
      },
    },
  };
  const draft = await gmail.draftEmail(
    { purpose: "reschedule", lead: { name: "Ann" }, link: "https://cal.test/r/abc" },
    { openai: fakeOpenAI },
  );
  assert.equal(draft.subject, "Rescheduling");
  assert.ok(draft.body.includes("https://cal.test/r/abc"));
});

test("booking-confirmation automation is off unless switched on", async () => {
  const appointment = { id: "ap1", attendee_email: "ann@example.com", attendee_name: "Ann", starts_at: "2099-01-01T10:00:00.000Z" };
  const draft = async () => ({ subject: "Confirmed", body: "See you then." });

  const off = db([gmailRow({ id: "g1", isDefault: true })]);
  const offFetch = gmailFetch();
  assert.equal(await gmail.sendBookingConfirmation(off, ORG, appointment, { draft, fetchImpl: offFetch.fetchImpl, assertAllowed: allow }), "off");
  assert.equal(offFetch.calls.length, 0);

  const on = db([gmailRow({ id: "g1", isDefault: true, automations: { booking_confirmation: true } })]);
  const onFetch = gmailFetch();
  assert.equal(await gmail.sendBookingConfirmation(on, ORG, appointment, { draft, fetchImpl: onFetch.fetchImpl, assertAllowed: allow }), "sent");
  assert.equal(onFetch.calls.length, 1);
  assert.equal(on._tables.email_sends[0].purpose, "booking_confirmation");
});
