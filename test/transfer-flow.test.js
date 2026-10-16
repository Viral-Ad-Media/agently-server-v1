"use strict";

const assert = require("assert");
const test = require("node:test");
const flow = require("../lib/transfer-flow");

test("transfer numbers normalize the way the call server does", () => {
  assert.strictEqual(flow.normalizeTransferNumber("(254) 268-8827"), "+12542688827");
  assert.strictEqual(flow.normalizeTransferNumber("+44 20 7946 0958"), "+442079460958");
  assert.strictEqual(flow.normalizeTransferNumber("123"), "");
  assert.strictEqual(
    flow.transferNumberForAgent({ call_transfer_number: "", escalation_phone: "(254) 268-8827" }),
    "+12542688827",
  );
  assert.strictEqual(flow.transferNumberForAgent(null), "");
});

test("attempts clamp to 1-3 and default to 2", () => {
  assert.strictEqual(flow.clampAttempts(undefined), 2);
  assert.strictEqual(flow.clampAttempts("abc"), 2);
  assert.strictEqual(flow.clampAttempts(0), 1);
  assert.strictEqual(flow.clampAttempts(7), 3);
  assert.strictEqual(flow.clampAttempts("3"), 3);
});

test("answered -> hang up; unanswered -> retry until the last attempt, then back to the agent", () => {
  assert.strictEqual(flow.isBridged({ DialCallStatus: "completed" }), true);
  assert.strictEqual(flow.isBridged({ DialBridged: "true", DialCallStatus: "no-answer" }), true);
  assert.strictEqual(flow.isBridged({ DialCallStatus: "no-answer" }), false);

  assert.strictEqual(flow.nextTransferStep({ bridged: true, attempt: 1, maxAttempts: 2 }), "hangup");
  assert.strictEqual(flow.nextTransferStep({ bridged: false, attempt: 1, maxAttempts: 2 }), "retry");
  assert.strictEqual(flow.nextTransferStep({ bridged: false, attempt: 2, maxAttempts: 2 }), "resume");
  assert.strictEqual(flow.nextTransferStep({ bridged: false, attempt: 1, maxAttempts: 1 }), "resume");
  assert.strictEqual(flow.nextTransferStep({ bridged: false, attempt: 2, maxAttempts: 3 }), "retry");
  // A missing max falls back to the default of two attempts.
  assert.strictEqual(flow.nextTransferStep({ bridged: false, attempt: 2 }), "resume");
});

test("the retry callback keeps the call identity and moves the counter on", () => {
  const url = new URL(
    flow.nextAttemptActionUrl("https://api.example.test/", {
      attempt: "1", max: "2", agentId: "agent-1", orgId: "org-1", callRecordId: "rec-1", direction: "outbound",
    }, 2),
  );
  assert.strictEqual(url.pathname, "/api/twilio/transfer-status");
  assert.strictEqual(url.searchParams.get("attempt"), "2");
  assert.strictEqual(url.searchParams.get("max"), "2");
  assert.strictEqual(url.searchParams.get("agentId"), "agent-1");
  assert.strictEqual(url.searchParams.get("direction"), "outbound");
  assert.strictEqual(flow.nextAttemptActionUrl("http://insecure.test", {}, 2), "");
});

test("retry TwiML holds the caller and dials again with an escaped callback", () => {
  const twiml = flow.buildRetryTwiml("+12542688827", "https://api.example.test/api/twilio/transfer-status?attempt=2&max=2");
  assert.match(twiml, /<Say>I'm still trying to reach someone for you\. Please hold\.<\/Say>/);
  assert.match(twiml, /<Dial answerOnBridge="true" timeout="20" action="https:\/\/api\.example\.test\/api\/twilio\/transfer-status\?attempt=2&amp;max=2" method="POST"><Number>\+12542688827<\/Number><\/Dial>/);
});
