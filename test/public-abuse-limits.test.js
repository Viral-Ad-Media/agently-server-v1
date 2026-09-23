"use strict";
/*
 * c4: abuse and cost controls on the public, unauthenticated endpoint.
 *
 * The assertions that matter are the FAIL-CLOSED ones. This endpoint spends
 * money per call, so a control that cannot reach its counter must refuse, not
 * shrug. Getting that backwards is how a rate limiter becomes decoration —
 * see i10, N005, N013.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

/* Load the module with supabase and logger swapped. */
function load({ rpc, ledger, ledgerError }) {
  const original = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id === "./supabase") {
      return {
        getSupabase: () => ({
          rpc: async (...args) => rpc(...args),
          from: () => {
            const chain = {
              select: () => chain,
              eq: () => chain,
              gte: () => chain,
              limit: () => Promise.resolve({ data: ledger, error: ledgerError || null }),
            };
            return chain;
          },
        }),
      };
    }
    if (id === "./logger") return { log: { info() {}, warn() {}, error() {}, debug() {} } };
    return original.apply(this, arguments);
  };
  delete require.cache[require.resolve("../lib/public-abuse-limits")];
  const mod = require("../lib/public-abuse-limits");
  Module.prototype.require = original;
  return mod;
}

const allowAll = async () => ({ data: [{ allowed: true }], error: null });
const denyAll = async () => ({ data: [{ allowed: false }], error: null });
const args = { scope: "chat", clientIp: "203.0.113.9", chatbotId: "bot-1", organizationId: "org-1" };

test("an ordinary request passes all three gates", async () => {
  const m = load({ rpc: allowAll, ledger: [{ estimated_cost_usd: 0.5 }] });
  const v = await m.checkPublicRequest(args);
  assert.equal(v.ok, true);
});

test("the shared counter refusing produces a 429, not a 503", async () => {
  const m = load({ rpc: denyAll, ledger: [] });
  const v = await m.checkPublicRequest(args);
  assert.equal(v.ok, false);
  assert.equal(v.status, 429, "a genuine limit is a 429; 503 would tell the caller to retry harder");
  assert.equal(v.body.error.code, "RATE_LIMITED");
});

test("an unreachable counter FAILS CLOSED with a retryable 503", async () => {
  const m = load({
    rpc: async () => { throw new Error("connection refused"); },
    ledger: [],
  });
  const v = await m.checkPublicRequest(args);
  assert.equal(v.ok, false, "this endpoint costs money — 'I cannot tell' must mean no");
  assert.equal(v.status, 503);
  assert.equal(v.body.error.code, "RATE_LIMIT_UNAVAILABLE");
  assert.equal(v.body.error.retryable, true);
});

test("an RPC error response also fails closed", async () => {
  const m = load({ rpc: async () => ({ data: null, error: { message: "no such function" } }), ledger: [] });
  const v = await m.checkPublicRequest(args);
  assert.equal(v.ok, false);
  assert.equal(v.status, 503);
});

test("spending past the daily cap refuses, and says so without retrying soon", async () => {
  const m = load({
    rpc: allowAll,
    ledger: Array.from({ length: 30 }, () => ({ estimated_cost_usd: 1 })), // $30 > $25
  });
  const v = await m.checkPublicRequest(args);
  assert.equal(v.ok, false);
  assert.equal(v.body.error.code, "DAILY_LIMIT_REACHED");
  assert.equal(v.body.error.retryable, false, "retrying in 30s will not reset a daily cap");
  assert.ok(v.retryAfter >= 3600);
});

test("spending under the cap passes", async () => {
  const m = load({ rpc: allowAll, ledger: [{ estimated_cost_usd: 24.99 }] });
  assert.equal((await m.checkPublicRequest(args)).ok, true);
});

test("a spend cap that cannot read spend refuses rather than allowing unlimited spend", async () => {
  const m = load({ rpc: allowAll, ledger: null, ledgerError: { message: "timeout" } });
  const v = await m.checkPublicRequest(args);
  assert.equal(v.ok, false, "a blind spend cap must not become an open tab");
  assert.equal(v.body.error.code, "DAILY_LIMIT_REACHED");
});

test("the per-IP ceiling is stricter than the per-chatbot one", () => {
  const m = load({ rpc: allowAll, ledger: [] });
  assert.ok(
    m.POLICIES.public_chat_ip.max < m.POLICIES.public_chat_bot.max,
    "one abuser must hit a wall long before the tenant's whole site does",
  );
  assert.ok(m.POLICIES.public_voice_ip.max < m.POLICIES.public_chat_ip.max, "voice costs more per call");
});

test("the limiter key includes the caller IP, so one abuser cannot exhaust a tenant", async () => {
  const buckets = [];
  const m = load({
    rpc: async (_name, params) => { buckets.push(params.p_bucket); return { data: [{ allowed: true }], error: null }; },
    ledger: [],
  });
  await m.checkPublicRequest(args);
  assert.ok(buckets[0].includes("203.0.113.9"), "the per-IP bucket must contain the address");
  assert.ok(buckets[0].includes("bot-1"), "and the chatbot, so tenants do not share a bucket");
  assert.ok(!buckets[1].includes("203.0.113.9"), "the per-chatbot bucket must NOT be per-IP");
});

test("the RPC is called with the parameter names the database function declares", async () => {
  // This test exists because the first version passed `p_max` instead of
  // `p_limit`. Every unit test still went green — the stub accepted any shape —
  // and production answered 503 to twenty consecutive requests while the
  // fail-closed branch did its job and hid the broken control. A stub that
  // accepts anything tests nothing.
  let params = null;
  const m = load({
    rpc: async (name, p) => { params = { name, p }; return { data: [{ allowed: true }], error: null }; },
    ledger: [],
  });
  await m.checkPublicRequest(args);

  assert.equal(params.name, "auth_rate_limit_hit");
  assert.deepEqual(
    Object.keys(params.p).sort(),
    ["p_bucket", "p_limit", "p_window_secs"],
    "these must match lib/auth-rate-limit.js and the SQL function exactly",
  );
  assert.equal(typeof params.p.p_limit, "number");
  assert.equal(typeof params.p.p_window_secs, "number");
});

/* ---------------- c6: webcall token issuance ---------------- */

const webcallArgs = { organizationId: "org-1", userId: "user-1" };

test("an ordinary test call is issued a token", async () => {
  const m = load({ rpc: allowAll, ledger: [] });
  assert.equal((await m.checkWebcallTokenIssue(webcallArgs)).ok, true);
});

test("issuance is keyed on the SESSION, never on anything the caller sends", async () => {
  const buckets = [];
  const m = load({
    rpc: async (_n, p) => { buckets.push(p.p_bucket); return { data: [{ allowed: true }], error: null }; },
    ledger: [],
  });
  await m.checkWebcallTokenIssue(webcallArgs);

  assert.equal(buckets.length, 3, "per-user, per-org-minute and per-org-hour");
  assert.ok(buckets.every((b) => b.includes("org-1")), "every bucket is scoped to the organization");
  assert.ok(buckets[0].includes("user-1"), "the tightest ceiling is per user");
  // The row's title: an attacker must not be able to choose the key. Nothing
  // here comes from a header, a body field or a query parameter.
  assert.ok(!buckets.some((b) => /x-forwarded|header|::ffff/i.test(b)));
});

test("burning the per-user ceiling refuses with a short retry", async () => {
  const m = load({ rpc: denyAll, ledger: [] });
  const v = await m.checkWebcallTokenIssue(webcallArgs);
  assert.equal(v.ok, false);
  assert.equal(v.status, 429);
  assert.equal(v.retryAfter, 30);
});

test("issuance fails CLOSED when the counter is unreachable", async () => {
  const m = load({ rpc: async () => { throw new Error("unreachable"); }, ledger: [] });
  const v = await m.checkWebcallTokenIssue(webcallArgs);
  assert.equal(v.ok, false, "a token starts a paid session — 'I cannot tell' must mean no");
  assert.equal(v.status, 503);
  assert.equal(v.body.error.code, "RATE_LIMIT_UNAVAILABLE");
});

test("the hourly org ceiling retries much later than the per-minute one", async () => {
  // Only the third check (the hourly one) denies.
  let n = 0;
  const m = load({
    rpc: async () => { n += 1; return { data: [{ allowed: n < 3 }], error: null }; },
    ledger: [],
  });
  const v = await m.checkWebcallTokenIssue(webcallArgs);
  assert.equal(v.ok, false);
  assert.equal(v.retryAfter, 600, "telling someone to retry in 30s against an hourly cap is a lie");
});

test("a per-user ceiling is tighter than the per-org one", () => {
  const m = load({ rpc: allowAll, ledger: [] });
  assert.ok(m.POLICIES.webcall_token_user.max < m.POLICIES.webcall_token_org.max);
  assert.ok(m.POLICIES.webcall_token_org_hour.windowSecs > m.POLICIES.webcall_token_org.windowSecs);
});
