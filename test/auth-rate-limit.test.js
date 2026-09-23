"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness(rpc) {
  const module = { exports: {} };
  const calls = [], logs = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/auth-rate-limit.js"), "utf8"), {
    module, process: { env: {} }, console: { error: (...args) => logs.push(args) },
    require(id) {
      // The real helper, not a stub: bucketing on a forgeable address is the
      // same as having no per-IP limit, so this module must get the shared one.
      if (id === "./client-ip") return require("../lib/client-ip");
      assert.equal(id, "./supabase");
      return { getSupabase: () => ({ rpc: async (...args) => { calls.push(args); return rpc(...args); } }) };
    },
  });
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { limiter: module.exports, res, calls, logs };
}

test("every credential policy denies requests on database errors", async () => {
  const h = harness(async () => ({ error: { message: "private-database-details" } }));
  for (const policy of Object.keys(h.limiter.LIMITS)) {
    assert.equal(await h.limiter.enforce({}, h.res, [[policy, "private@example.test"]]), false);
    assert.equal(h.res.statusCode, 503);
    assert.equal(h.res.body.error.code, "AUTH_TEMPORARILY_UNAVAILABLE");
    assert.equal(h.res.body.error.retryable, true);
    assert.equal(h.res.headers["Retry-After"], "30");
  }
  assert.equal(JSON.stringify(h.logs).includes("private"), false);
  assert.equal(JSON.stringify(h.res.body).includes("private"), false);
});

test("rejected RPC promises also fail closed", async () => {
  const h = harness(async () => { throw new Error("transport failure"); });
  const result = await h.limiter.hit("login_email", "test@example.test");
  assert.equal(result.allowed, false);
  assert.equal(result.degraded, true);
});

test("empty, ambiguous and malformed decisions cannot bypass limits", async () => {
  for (const data of [null, [], {}, [{ allowed: true }, { allowed: true }],
    { allowed: "true", retry_after_secs: 30 }, { allowed: true },
    { allowed: true, retry_after_secs: NaN }, { allowed: false, retry_after_secs: -1 },
    { allowed: true, retry_after_secs: "30" }]) {
    const h = harness(async () => ({ data, error: null }));
    assert.equal(await h.limiter.enforce({}, h.res, [["login_email", "test"]]), false);
    assert.equal(h.res.statusCode, 503);
  }
});

test("healthy responses allow requests and normalize bucket identities", async () => {
  for (const data of [{ allowed: true, retry_after_secs: 900 }, [{ allowed: true, retry_after_secs: 900 }]]) {
    const h = harness(async () => ({ data, error: null }));
    assert.equal(await h.limiter.enforce({}, h.res, [["login_email", " PERSON@Example.test "]]), true);
    assert.equal(h.calls[0][0], "auth_rate_limit_hit");
    assert.equal(h.calls[0][1].p_bucket, "login_email:person@example.test");
    assert.equal(h.calls[0][1].p_limit, 10);
    assert.equal(h.res.statusCode, null);
  }
});

test("exhausted counters retain the normal 429 response", async () => {
  const h = harness(async () => ({ data: [{ allowed: false, retry_after_secs: 120 }], error: null }));
  assert.equal(await h.limiter.enforce({}, h.res, [["login_ip", "test"]]), false);
  assert.equal(h.res.statusCode, 429);
  assert.equal(h.res.body.error.code, "RATE_LIMITED");
  assert.equal(h.res.headers["Retry-After"], "120");
});

test("a failing second policy blocks an otherwise allowed request", async () => {
  let count = 0;
  const h = harness(async () => ++count === 1
    ? { data: { allowed: true, retry_after_secs: 60 } }
    : { error: { message: "unavailable" } });
  assert.equal(await h.limiter.enforce({}, h.res, [["login_email", "test"], ["login_ip", "test"]]), false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.res.statusCode, 503);
});

test("denial stops subsequent checks", async () => {
  const h = harness(async () => ({ error: { message: "unavailable" } }));
  assert.equal(await h.limiter.enforce({}, h.res, [["login_email", "test"], ["login_ip", "test"]]), false);
  assert.equal(h.calls.length, 1);
});

test("recovery immediately restores access when the shared counter allows it", async () => {
  let healthy = false;
  const h = harness(async () => healthy
    ? { data: { allowed: true, retry_after_secs: 900 } }
    : { error: { message: "unavailable" } });
  assert.equal((await h.limiter.hit("login_email", "test")).allowed, false);
  healthy = true;
  assert.equal((await h.limiter.hit("login_email", "test")).allowed, true);
});

test("denied retry intervals are positive and bounded", async () => {
  for (const [retry, expected] of [[0, 1], [1.2, 2], [999999, 900]]) {
    const h = harness(async () => ({ data: { allowed: false, retry_after_secs: retry } }));
    assert.equal((await h.limiter.hit("login_email", "test")).retryAfterSecs, expected);
  }
});
