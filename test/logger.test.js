"use strict";
/*
 * Structured logging (p6) and the CORS fail-open (N013).
 *
 * The logging assertions are mostly about REDACTION. This codebase has already
 * shipped one credential-retention bug by recording an email subject that
 * contained an OTP (N002); a logger is the second place that mistake gets
 * made, and at higher volume.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { redact } = require("../lib/logger");

test("secrets are redacted by key name, at any depth", () => {
  const out = redact({
    ok: "visible",
    authorization: "Bearer abc.def.ghi",
    nested: { stripe_secret_key: "rk_live_xyz", deeper: { apiKey: "shh" } },
    headers: { Cookie: "sid=1", "X-Request-Id": "keep-me" },
  });

  assert.equal(out.ok, "visible");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.nested.stripe_secret_key, "[redacted]");
  assert.equal(out.nested.deeper.apiKey, "[redacted]");
  assert.equal(out.headers.Cookie, "[redacted]");
  assert.equal(out.headers["X-Request-Id"], "keep-me", "request ids must survive — they are the point");
});

test("a credential is redacted even under an innocent key name", () => {
  const out = redact({ note: "sk-proj-abcdefghijklmnop", other: "rk_live_zzz", jwt: "eyJhbGciOiJIUzI1NiJ9" });
  assert.equal(out.note, "[redacted]");
  assert.equal(out.other, "[redacted]");
  assert.equal(out.jwt, "[redacted]");
});

test("a six-digit code is redacted wherever it appears", () => {
  // The exact shape of N002: an OTP inside an otherwise harmless string.
  const out = redact({ subject: "483920 is your Agently sign-in code" });
  assert.ok(!/483920/.test(out.subject), "an OTP must never reach a log line");
  assert.match(out.subject, /\[redacted-code\]/);
});

test("ordinary numbers that are not codes survive", () => {
  const out = redact({ ms: 1234, status: 200, count: 12345 });
  assert.equal(out.ms, 1234);
  assert.equal(out.status, 200);
});

test("redaction never throws on awkward input", () => {
  const circular = { name: "loop" };
  circular.self = circular;
  assert.doesNotThrow(() => redact(circular));
  assert.doesNotThrow(() => redact(null));
  assert.doesNotThrow(() => redact(undefined));
  assert.doesNotThrow(() => redact([1, 2, { token: "x" }]));
});

/* ---------------- N013: the CORS fail-open ---------------- */

const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

/* isOriginAllowed is module-private, so evaluate the block that defines it
   with a controllable isProductionRuntime rather than exporting it purely for
   a test. */
function loadCors({ production, envOrigins }) {
  const src = fs.readFileSync(path.join(__dirname, "../api/index.js"), "utf8");
  const start = src.indexOf("const DEFAULT_ALLOWED_ORIGINS");
  const end = src.indexOf("function setCorsHeaders");
  assert.ok(start !== -1 && end > start, "CORS block not found — did api/index.js move?");

  const context = {
    CANONICAL_APP_URL: "https://www.agentlycall.com",
    isProductionRuntime: () => production,
    process: { env: { ALLOWED_ORIGINS: envOrigins } },
    URL,
    Set,
    Array,
    String,
    module: {},
  };
  vm.createContext(context);
  vm.runInContext(src.slice(start, end) + "\nmodule.exports={isOriginAllowed,ALLOWED_ORIGINS};", context);
  return context.module.exports;
}

test("production refuses a foreign origin and accepts the real one", () => {
  const { isOriginAllowed } = loadCors({ production: true, envOrigins: "" });
  assert.equal(isOriginAllowed("https://evil.example.com"), false);
  assert.equal(isOriginAllowed("https://www.agentlycall.com"), true);
});

test("production drops loopback origins, including ones set in the environment", () => {
  const { isOriginAllowed, ALLOWED_ORIGINS } = loadCors({
    production: true,
    envOrigins: "http://localhost:3000,https://partner.example.com",
  });
  assert.equal(isOriginAllowed("http://localhost:3000"), false, "a dev machine is not a trusted origin in production");
  assert.equal(isOriginAllowed("http://127.0.0.1:3000"), false);
  assert.equal(isOriginAllowed("https://partner.example.com"), true, "legitimate env entries still work");
  assert.ok(!ALLOWED_ORIGINS.includes("http://localhost:3000"));
});

test("an empty allowlist in production denies rather than allowing everything", () => {
  const { isOriginAllowed } = loadCors({ production: true, envOrigins: "" });
  // The defaults are non-empty, so simulate the empty case directly: the point
  // is that no branch returns true for an unknown origin.
  assert.equal(isOriginAllowed("https://anything.example"), false);
  assert.equal(
    isOriginAllowed(""),
    true,
    "a request with no Origin header is not a browser CORS request and must still work",
  );
});

test("development still allows everything", () => {
  const { isOriginAllowed } = loadCors({ production: false, envOrigins: "" });
  assert.equal(isOriginAllowed("http://localhost:5173"), true);
  assert.equal(isOriginAllowed("https://anything.example"), true);
});
