"use strict";
/*
 * p7: webhook health.
 *
 * The assertion that matters most is that "I cannot tell" is reported as NOT
 * ok. A monitor that answers healthy when its own query failed is worse than
 * no monitor, because it converts an outage into a green light — the same
 * shape as every fail-open this codebase has already been bitten by.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

/* Swap lib/supabase so health() reads scripted rows. */
function withRows(rows, error = null) {
  const original = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id === "./supabase" || id === "../lib/supabase") {
      return {
        getSupabase: () => ({
          from: () => {
            const chain = {
              select: () => chain,
              gte: () => chain,
              order: () => chain,
              limit: () => Promise.resolve({ data: rows, error }),
              insert: () => Promise.resolve({ error: null }),
            };
            return chain;
          },
        }),
      };
    }
    if (id === "./logger" || id === "../lib/logger") {
      return { log: { info() {}, warn() {}, error() {}, debug() {} } };
    }
    return original.apply(this, arguments);
  };
  delete require.cache[require.resolve("../lib/webhook-monitor")];
  const mod = require("../lib/webhook-monitor");
  Module.prototype.require = original;
  return mod;
}

const delivery = (provider, outcome, ms = 20) => ({
  provider,
  outcome,
  status_code: outcome === "accepted" ? 200 : 500,
  duration_ms: ms,
  received_at: new Date().toISOString(),
});

test("a healthy provider reports ok", async () => {
  const m = withRows([
    delivery("stripe", "accepted"),
    delivery("stripe", "accepted"),
    delivery("stripe", "accepted"),
    delivery("stripe", "accepted"),
  ]);
  const r = await m.health();
  assert.equal(r.ok, true);
  assert.equal(r.providers.stripe.total, 4);
  assert.equal(r.providers.stripe.failure_rate, 0);
  assert.deepEqual(r.unhealthy, []);
});

test("a provider failing most deliveries is unhealthy and named", async () => {
  const m = withRows([
    delivery("stripe", "error"),
    delivery("stripe", "error"),
    delivery("stripe", "error"),
    delivery("stripe", "accepted"),
  ]);
  const r = await m.health();
  assert.equal(r.ok, false);
  assert.deepEqual(r.unhealthy, ["stripe"]);
  assert.equal(r.providers.stripe.failure_rate, 0.75);
});

test("one failure out of many is not an outage", async () => {
  const m = withRows([
    ...Array.from({ length: 9 }, () => delivery("resend", "accepted")),
    delivery("resend", "error"),
  ]);
  const r = await m.health();
  assert.equal(r.ok, true, "a 10% failure rate must not page anyone at 3am");
});

test("a quiet provider is not judged — silence is not failure", async () => {
  const m = withRows([delivery("stripe", "error")]);
  const r = await m.health();
  assert.equal(r.providers.stripe.judged, false, "one failed delivery is not a sample");
  assert.equal(r.ok, true);
});

test("a failed query reports NOT ok rather than healthy", async () => {
  const m = withRows(null, { message: "relation does not exist" });
  const r = await m.health();
  assert.equal(r.ok, false, "not being able to tell is not the same as healthy");
  assert.equal(r.unknown, true);
  assert.match(r.reason, /does not exist/);
});

test("recording never throws, even when the write fails", async () => {
  const original = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id === "./supabase") {
      return { getSupabase: () => { throw new Error("database is on fire"); } };
    }
    if (id === "./logger") return { log: { info() {}, warn() {}, error() {}, debug() {} } };
    return original.apply(this, arguments);
  };
  delete require.cache[require.resolve("../lib/webhook-monitor")];
  const m = require("../lib/webhook-monitor");
  Module.prototype.require = original;

  // A monitoring write must never be able to fail the delivery it monitors.
  await assert.doesNotReject(() =>
    m.record({ provider: "stripe", outcome: "accepted", statusCode: 200 }),
  );
});

test("p95 latency is reported per provider", async () => {
  const m = withRows([
    delivery("stripe", "accepted", 10),
    delivery("stripe", "accepted", 20),
    delivery("stripe", "accepted", 900),
  ]);
  const r = await m.health();
  assert.equal(r.providers.stripe.p95_ms, 900, "the slow tail is what a webhook timeout looks like");
});
