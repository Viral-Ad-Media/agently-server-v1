"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load the actual mail module with isolated provider/ledger dependencies.
// No credentials, network, .env or real database are used by these tests.
function mailHarness(send, log = async () => {}, guard = async () => {}) {
  const module = { exports: {} };
  const events = [];
  const sent = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/email.js"), "utf8"), {
    module,
    process: { env: { RESEND_API_KEY: "test-placeholder" } },
    console: { warn() {} },
    require(id) {
      if (id === "./email-delivery") return { assertEmailRecipientsAllowed: guard };
      if (id === "resend") return { Resend: class {
        constructor() { this.emails = { send: async (options) => { sent.push(options); return send(options); } }; }
      } };
      if (id === "./usage-ledger") return { logEmailUsage: async (event) => { events.push(event); await log(event); } };
      if (id === "./app-url") return { getAppBaseUrl: () => "https://example.test", buildAppHashUrl: () => "https://example.test/#/login" };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { mail: module.exports, events, sent };
}

for (const method of ["sendLoginOtpEmail", "sendEmailVerificationCodeEmail"]) {
  test(`${method}: provider rejection is a failure and is not metered`, async () => {
    const h = mailHarness(async () => ({ data: null, error: { message: "private provider detail" } }));
    await assert.rejects(h.mail[method]("person@example.test", "123456", 600), (e) =>
      e.code === "EMAIL_SEND_FAILED" && !e.message.includes("private provider detail"));
    assert.equal(h.events.length, 0);
  });

  test(`${method}: accepted message retains its code only in email content`, async () => {
    const h = mailHarness(async () => ({ data: { id: "message-1" }, error: null, debug: "123456" }));
    await h.mail[method]("person@example.test", "123456", 600, {
      organizationId: "org-1", billable: false, metadata: { subject: "123456" },
    });
    assert.match(h.sent[0].html, /123456/);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].providerMessageId, "message-1");
    assert.equal(h.events[0].organizationId, "org-1");
    assert.equal(h.events[0].billable, false);
    assert.equal(h.events[0].subject, null);
    assert.equal(JSON.stringify(h.events).includes("123456"), false);
  });
}

test("missing or malformed provider acknowledgement never counts as sent", async () => {
  for (const result of [undefined, {}, { data: {} }, { data: { id: 123 } }, { data: { id: " " } }, { data: { id: "message-1" }, error: { name: "error" } }]) {
    const h = mailHarness(async () => result);
    await assert.rejects(h.mail.sendLoginOtpEmail("person@example.test", "123456", 600), { code: "EMAIL_SEND_FAILED" });
    assert.equal(h.events.length, 0);
  }
});

test("transport exceptions reject without recording email usage", async () => {
  const h = mailHarness(async () => { throw new Error("network unavailable"); });
  await assert.rejects(h.mail.sendLoginOtpEmail("person@example.test", "123456", 600), /network unavailable/);
  assert.equal(h.events.length, 0);
});

test("ledger failure does not turn an accepted send into a retry/duplicate email", async () => {
  const h = mailHarness(async () => ({ data: { id: "message-1" }, error: null }), async () => { throw new Error("ledger unavailable"); });
  await h.mail.sendLoginOtpEmail("person@example.test", "123456", 600);
  assert.equal(h.sent.length, 1);
});

test("ordinary accepted mail still records its subject and usage context", async () => {
  const h = mailHarness(async () => ({ data: { id: "welcome-1" }, error: null }));
  await h.mail.sendWelcomeEmail("person@example.test", "Person", "Business", { metadata: { source: "signup" } });
  assert.equal(h.events[0].emailType, "welcome");
  assert.match(h.events[0].subject, /Welcome to Agently/);
  assert.equal(h.events[0].metadata.source, "signup");
});

test("blocked recipients cannot be sent to or metered", async () => {
  const h = mailHarness(async () => { throw new Error("Must not send"); }, undefined,
    async () => { const e = new Error("blocked"); e.code = "EMAIL_RECIPIENT_BLOCKED"; throw e; });
  await assert.rejects(h.mail.sendLoginOtpEmail("person@example.test", "123456", 600), { code: "EMAIL_RECIPIENT_BLOCKED" });
  assert.equal(h.sent.length, 0);
  assert.equal(h.events.length, 0);
});

function authDeliveryHarness(mail) {
  const module = { exports: {} };
  const invalidated = [];
  const dependencies = {
    express: { Router: () => ({ get() {}, post() {} }) },
    crypto: {}, bcryptjs: {},
    "../../lib/supabase": {}, "../../lib/auth": {}, "../../lib/serializers": {},
    "../../lib/email": mail,
    "../../middleware/auth": {},
    "../../middleware/error": { asyncHandler: (handler) => handler },
    "../../lib/app-url": {}, "../../lib/activation-gate": {},
    "../../lib/auth-providers": {}, "../../lib/auth-pending": {},
    "../../lib/auth-sessions": {},
    "../../lib/auth-rate-limit": { clientIp: () => "test", userAgent: () => "test" },
    "../../lib/auth-codes": {
      PURPOSE_EMAIL_VERIFY: "email_verify", PURPOSE_LOGIN_OTP: "login_otp",
      issueCode: async () => ({ code: "123456", expiresInSeconds: 600 }),
      invalidateCodes: async (...args) => invalidated.push(args),
    },
  };
  // Expose the internal orchestration only inside the test VM; production
  // exports remain unchanged. All route source is loaded, not copied here.
  const source = fs.readFileSync(path.join(__dirname, "../api/routes/auth.js"), "utf8");
  vm.runInNewContext(source + "\nmodule.exports = { deliverCode };", {
    module, console: { error() {} }, process: { env: {} },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected auth dependency: ${id}`);
    },
  });
  const response = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { deliver: module.exports.deliverCode, invalidated, response };
}

for (const purpose of ["email_verify", "login_otp"]) {
  test(`${purpose}: blocked recipients receive support guidance without sending`, async () => {
    const h = mailHarness(async () => { throw new Error("Must not send"); }, undefined,
      async () => { const e = new Error("blocked"); e.code = "EMAIL_RECIPIENT_BLOCKED"; throw e; });
    const auth = authDeliveryHarness(h.mail);
    const result = await auth.deliver({}, auth.response, { email: "person@example.test", purpose });
    assert.equal(result, null);
    assert.equal(auth.response.statusCode, 502);
    assert.equal(auth.response.body.error.retryable, false);
    assert.match(auth.response.body.error.message, /contact support/);
    assert.equal(auth.invalidated.length, 1);
    assert.equal(h.sent.length, 0);
    assert.equal(h.events.length, 0);
  });

  test(`${purpose}: SDK rejection invalidates the code and returns a retryable 502`, async () => {
    const h = mailHarness(async () => ({ data: null, error: { message: "private rejection" } }));
    const auth = authDeliveryHarness(h.mail);
    const result = await auth.deliver({}, auth.response, {
      email: "PERSON@example.test", user: { id: "user-1", organization_id: "org-1" }, purpose,
    });
    assert.equal(result, null);
    assert.equal(auth.response.statusCode, 502);
    assert.equal(auth.response.body.error.code, "EMAIL_DELIVERY_FAILED");
    assert.equal(auth.response.body.error.retryable, true);
    assert.equal(auth.invalidated.length, 1);
    assert.equal(auth.invalidated[0][0], "person@example.test");
    assert.equal(auth.invalidated[0][1], purpose);
    assert.equal(h.events.length, 0);
    assert.equal(JSON.stringify(auth.response.body).includes("private rejection"), false);
  });

  test(`${purpose}: accepted email keeps the code usable and returns its expiry`, async () => {
    const h = mailHarness(async () => ({ data: { id: "message-1" }, error: null }));
    const auth = authDeliveryHarness(h.mail);
    const result = await auth.deliver({}, auth.response, { email: "person@example.test", purpose });
    assert.equal(result.expiresInSeconds, 600);
    assert.equal(auth.invalidated.length, 0);
    assert.equal(auth.response.statusCode, null);
    assert.equal(h.events.length, 1);
  });
}
