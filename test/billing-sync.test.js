"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBillingSyncHandler } = require("../lib/billing-sync-handler");

const secret = "isolated-test-cron-secret";
const request = { headers: { authorization: `Bearer ${secret}` } };
function response() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("billing cron rejects missing/incorrect authorization before loading worker", async () => {
  for (const [configured, headers] of [
    ["", {}], ["", { authorization: "Bearer " }],
    [secret, {}], [secret, { authorization: "Bearer wrong" }],
    [secret, { "x-cron-secret": "wrong" }],
  ]) {
    const handler = createBillingSyncHandler({ getSecret: () => configured,
      getTracker: () => { assert.fail("unauthorized worker access"); } });
    const res = response();
    await handler({ headers }, res);
    assert.equal(res.statusCode, 401);
  }
});

test("billing cron explicitly reports the actual placeholder worker as unavailable", async () => {
  // Default loader uses the real local module without starting its worker.
  const handler = createBillingSyncHandler({ getSecret: () => secret });
  const res = response();
  await handler(request, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "BILLING_SYNC_UNAVAILABLE");
});

test("billing cron accepts both supported credentials and awaits completion", async () => {
  for (const headers of [request.headers, { "x-cron-secret": secret }]) {
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    let calls = 0;
    const handler = createBillingSyncHandler({ getSecret: () => secret,
      getTracker: () => ({ runOnce: () => { calls++; return completion; } }) });
    const res = response();
    const pending = handler({ headers }, res);
    assert.equal(calls, 1);
    assert.equal(res.body, null);
    finish();
    await pending;
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  }
});

test("billing cron handles synchronous and asynchronous failures without leaking details", async () => {
  for (const runOnce of [
    () => { throw new Error("sensitive provider detail"); },
    async () => { throw new Error("sensitive provider detail"); },
  ]) {
    const logs = [];
    const handler = createBillingSyncHandler({ getSecret: () => secret,
      getTracker: () => ({ runOnce }), logger: { error: (...args) => logs.push(args) } });
    const res = response();
    await handler(request, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, "BILLING_SYNC_FAILED");
    assert.equal(JSON.stringify([res.body, logs]).includes("sensitive provider detail"), false);
  }
});
