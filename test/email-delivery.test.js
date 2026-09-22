"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Webhook } = require("svix");
const secret = "whsec_" + Buffer.from("isolated-webhook-test-secret-32!!").toString("base64");

function harness(db) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/email-delivery.js"), "utf8"), {
    module, Buffer, process: { env: {} }, console: { error() {} },
    require(id) { return id === "./supabase" ? { getSupabase: () => db } : require(id); },
  });
  const lib = module.exports;
  const handler = lib.createResendWebhookHandler({ getDb: () => db, getSecret: () => secret, getSender: () => "support@example.test" });
  return { lib, handler };
}
function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
}
function payload(type = "email.bounced") {
  return { type, created_at: new Date().toISOString(), data: {
    email_id: "message-1", from: "Agently <support@example.test>", to: ["person@example.test"], subject: "123456 is your code",
  } };
}
function request(event, ageSeconds = 0) {
  const body = JSON.stringify(event);
  const timestamp = new Date(Date.now() - ageSeconds * 1000);
  const id = "msg_test";
  return { body: Buffer.from(body), headers: {
    "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign(id, timestamp, body),
  } };
}

test("signed blocking events persist only minimal data before acknowledgement", async () => {
  for (const type of ["email.bounced", "email.complained", "email.suppressed"]) {
    const calls = [];
    const h = harness({ rpc: async (...args) => { calls.push(args); return { error: null }; } });
    const res = response();
    await h.handler(request(payload(type)), res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "record_email_delivery_block");
    assert.equal(calls[0][1].p_reason, type);
    assert.equal(calls[0][1].p_recipient_hash, h.lib.recipientHash("PERSON@example.test "));
    assert.equal(JSON.stringify(calls).includes("123456"), false);
    assert.equal(JSON.stringify(calls).includes("person@example.test"), false);
  }
});

test("invalid, stale, future or body-tampered signatures cannot write data", async () => {
  const h = harness({ rpc: () => { throw new Error("Must not write"); } });
  const tampered = request(payload());
  tampered.body = Buffer.from(tampered.body.toString() + " ");
  const invalid = request(payload()); invalid.headers["svix-signature"] = "v1,invalid";
  const missing = request(payload()); delete missing.headers["svix-id"];
  const parsed = request(payload()); parsed.body = payload();
  for (const req of [tampered, invalid, missing, parsed, request(payload(), 600), request(payload(), -600)]) {
    const res = response(); await h.handler(req, res);
    assert.equal(res.statusCode, 400);
  }
});

test("storage failure returns 503 so the provider retries", async () => {
  for (const rpc of [async () => ({ error: { message: "private db error" } }), async () => { throw new Error("private db error"); }]) {
    const h = harness({ rpc }); const res = response();
    await h.handler(request(payload()), res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.stringify(res.body).includes("private"), false);
  }
});

test("unrelated senders and nonblocking events never change blocks", async () => {
  let writes = 0;
  const h = harness({ rpc: async () => { writes++; return {}; } });
  const other = payload(); other.data.from = "other@example.test";
  for (const event of [other, payload("email.delivered"), payload("email.delivery_delayed"), payload("email.opened")]) {
    const res = response(); await h.handler(request(event), res);
    assert.equal(res.body.ignored, true);
  }
  assert.equal(writes, 0);
});

test("ambiguous or malformed recipient data is rejected without persistence", async () => {
  let writes = 0;
  const h = harness({ rpc: async () => { writes++; return {}; } });
  for (const to of [[], ["a@example.test", "b@example.test"], ["invalid"], "a@example.test"]) {
    const event = payload(); event.data.to = to;
    const res = response(); await h.handler(request(event), res);
    assert.equal(res.statusCode, 400);
  }
  const event = payload(); event.created_at = "invalid";
  const res = response(); await h.handler(request(event), res);
  assert.equal(res.statusCode, 400);
  assert.equal(writes, 0);
});

test("missing signing configuration cannot acknowledge an event", async () => {
  const h = harness({}); const res = response();
  await h.lib.createResendWebhookHandler({ getSecret: () => "" })(request(payload()), res);
  assert.equal(res.statusCode, 503);
});

test("recipient guard covers To, CC and BCC and fails closed on query errors", async () => {
  for (const [result, errorCode] of [
    [{ data: [], error: null }, null],
    [{ data: [{ recipient_hash: "blocked" }], error: null }, "EMAIL_RECIPIENT_BLOCKED"],
    [{ data: null, error: {} }, "EMAIL_DELIVERY_UNAVAILABLE"],
  ]) {
    const query = { select() { return this; }, in(_name, hashes) { assert.equal(hashes.length, 3); return this; }, eq(name, value) { assert.equal(name, "blocked"); assert.equal(value, true); return Promise.resolve(result); } };
    const h = harness({ from(name) { assert.equal(name, "email_delivery_blocks"); return query; } });
    const sending = h.lib.assertEmailRecipientsAllowed({ to: "One <one@example.test>", cc: ["two@example.test"], bcc: "three@example.test" });
    if (errorCode) await assert.rejects(sending, { code: errorCode }); else await sending;
  }
});
