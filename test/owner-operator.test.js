"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { encryptSecret, decryptSecret } = require("../lib/crypto");
const operator = require("../api/routes/owner-operator")._internals;

const ORG = "operator-org";
const AGENT = "operator-agent";
const KEY = "c".repeat(64);

test("operator refuses an agent from a different tenant", async () => {
  const db = makeFakeSupabase({
    voice_agents: [{ id: AGENT, organization_id: "another-org", name: "Other business" }],
  });
  await assert.rejects(() => operator.requireAgent(db, ORG, AGENT), /belonging to this workspace/);
});

test("lead searches only show the selected agent and shared unassigned leads", async () => {
  const db = makeFakeSupabase({
    voice_agents:[{id:AGENT,organization_id:ORG}],
    agent_operator_settings:[{voice_agent_id:AGENT,organization_id:ORG,allow_shared_leads:true}],
    leads: [
      { id: "mine", organization_id: ORG, voice_agent_id: AGENT, name: "Mina", email: "mina@example.test", tags: ["vip"] },
      { id: "shared", organization_id: ORG, voice_agent_id: null, name: "Sam", email: "sam@example.test", tags: ["vip"] },
      { id: "other", organization_id: ORG, voice_agent_id: "another-agent", name: "Other", email: "other@example.test", tags: ["vip"] },
      { id: "foreign", organization_id: "another-org", voice_agent_id: AGENT, name: "Foreign", email: "foreign@example.test", tags: ["vip"] },
    ],
  });
  const rows = await operator.findLeads(db, ORG, { tag: "vip" }, AGENT);
  assert.deepEqual(rows.map((lead) => lead.id).sort(), ["mine", "shared"]);
});

test("history sent to the model is bounded and excludes system/tool roles", () => {
  const history = [
    { role: "system", content: "untrusted override" },
    { role: "tool", content: "tool output" },
    ...Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` })),
    { role: "user", content: "x".repeat(5000) },
  ];
  const cleaned = operator.cleanHistory(history);
  assert.equal(cleaned.length, 14);
  assert.ok(cleaned.every((item) => ["user", "assistant"].includes(item.role)));
  assert.equal(cleaned.at(-1).content.length, 4000);
});

test("date-only calendar questions use business-local day boundaries across DST", () => {
  const spring = operator.localDateWindow("2026-03-08", 1, "America/New_York");
  const fall = operator.localDateWindow("2026-11-01", 1, "America/New_York");
  assert.equal(spring.from.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(spring.to.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal((spring.to - spring.from) / 3600000, 23);
  assert.equal((fall.to - fall.from) / 3600000, 25);
});

test("pending action payloads are encrypted and bound to one tenant and action id", async () => {
  const before = process.env.CALENDAR_TOKEN_KEY;
  process.env.CALENDAR_TOKEN_KEY = KEY;
  try {
    const db = makeFakeSupabase({ owner_operator_actions: [] });
    const req = { orgId: ORG, user: { id: "owner-1" } };
    const payload = { drafts: [{ to: "lead@example.test", body: "private message content" }], preview: { recipients: [] } };
    const card = await operator.createPendingAction(db, req, { id: AGENT }, "send_emails", payload, "Review drafts.");
    const row = db._tables.owner_operator_actions[0];
    assert.equal(card.id, row.id);
    assert.equal(row.status, "pending");
    assert.equal(row.encrypted_payload.includes("private message content"), false);
    assert.deepEqual(JSON.parse(decryptSecret(row.encrypted_payload, {
      organizationId: ORG,
      provider: "owner_operator_action",
      connectionId: card.id,
    })), payload);
    assert.throws(() => decryptSecret(row.encrypted_payload, {
      organizationId: "another-org",
      provider: "owner_operator_action",
      connectionId: card.id,
    }));
  } finally {
    if (before === undefined) delete process.env.CALENDAR_TOKEN_KEY;
    else process.env.CALENDAR_TOKEN_KEY = before;
  }
});

test("the authenticated owner operator has its own mounted API prefix", () => {
  const source = fs.readFileSync(path.join(__dirname, "../api/index.js"), "utf8");
  assert.match(source, /safeMount\(\s*"\/api\/operator"[\s\S]*?owner-operator/);
});

test("the durable limiter has explicit owner-operator budgets", () => {
  const { LIMITS } = require("../lib/auth-rate-limit");
  assert.deepEqual(LIMITS.owner_operator_chat_user, { windowSecs: 60, max: 30 });
  assert.deepEqual(LIMITS.owner_operator_email_draft_user, { windowSecs: 3600, max: 12 });
  assert.deepEqual(LIMITS.owner_operator_confirm_user, { windowSecs: 3600, max: 20 });
});
