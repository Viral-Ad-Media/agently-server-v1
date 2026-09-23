"use strict";
/*
 * N014: alerting.
 *
 * The assertions are mostly about NOT sending. An alerter that mails every
 * minute during an incident gets filtered, and a filtered alerter is worse
 * than none — it produces the belief that someone is watching.
 *
 * No email is sent: the notifier is injected.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { checkOnce, state, RENOTIFY_MS } = require("../lib/health-alerts");

const reset = () => { state.unhealthy = false; state.lastNotifiedAt = 0; };
const ok = async () => ({ ok: true, providers: {}, deliveries: 5, window_minutes: 15 });
const failing = async () => ({
  ok: false, unhealthy: ["stripe"], providers: { stripe: { total: 8, accepted: 1 } },
  deliveries: 8, window_minutes: 15,
});
const unknown = async () => ({ ok: false, unknown: true, reason: "relation does not exist", providers: {} });

function spy() {
  const sent = [];
  return { sent, fn: async (subject, body) => { sent.push({ subject, body }); return true; } };
}

test("a healthy system sends nothing", async () => {
  reset();
  const s = spy();
  const r = await checkOnce({ healthFn: ok, notifyFn: s.fn });
  assert.equal(s.sent.length, 0);
  assert.equal(r.unhealthy, false);
});

test("going unhealthy alerts exactly once, and names the provider", async () => {
  reset();
  const s = spy();
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 1000 });
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].subject, /unhealthy/i);
  assert.match(s.sent[0].body, /stripe/);
});

test("staying unhealthy does NOT alert again on the next check", async () => {
  reset();
  const s = spy();
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 1000 });
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 2000 });
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 3000 });
  assert.equal(s.sent.length, 1, "three failing checks, one email — this is the whole point");
});

test("a long incident re-notifies once the interval passes, not before", async () => {
  reset();
  const s = spy();
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 0 });
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: RENOTIFY_MS - 1 });
  assert.equal(s.sent.length, 1, "one millisecond early is still early");
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: RENOTIFY_MS });
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1].subject, /STILL/);
});

test("recovery is announced, once", async () => {
  reset();
  const s = spy();
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 1000 });
  await checkOnce({ healthFn: ok, notifyFn: s.fn, now: 2000 });
  await checkOnce({ healthFn: ok, notifyFn: s.fn, now: 3000 });
  assert.equal(s.sent.length, 2, "an incident with no 'it stopped' leaves someone refreshing a dashboard");
  assert.match(s.sent[1].subject, /recovered/i);
});

test("an UNKNOWN health result alerts — not being able to tell is not fine", async () => {
  reset();
  const s = spy();
  await checkOnce({ healthFn: unknown, notifyFn: s.fn, now: 1000 });
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].body, /could not be determined/i);
  assert.match(s.sent[0].body, /relation does not exist/);
});

test("recovering and failing again alerts again", async () => {
  reset();
  const s = spy();
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 1000 });
  await checkOnce({ healthFn: ok, notifyFn: s.fn, now: 2000 });
  await checkOnce({ healthFn: failing, notifyFn: s.fn, now: 3000 });
  assert.equal(s.sent.length, 3, "a new incident is a new alert, not a duplicate");
});
