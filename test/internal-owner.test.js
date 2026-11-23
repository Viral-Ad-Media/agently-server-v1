"use strict";
/*
 * Owner-mode endpoints (/api/internal/owner/*), exercised over real HTTP with
 * the shared-secret guard in place.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { makeFakeSupabase } = require("./helpers/fake-supabase");

const ORG = "org-owner";
const OTHER = "org-other";
const SECRET = "owner-test-secret";

async function withServer(seed, fn, { gmailStub, draftStub } = {}) {
  const supabaseModule = require("../lib/supabase");
  const gmail = require("../lib/gmail-send");
  const db = makeFakeSupabase({
    voice_agents:[{id:"a1",organization_id:ORG,calendar_integration_id:"c1"}],
    agent_operator_settings:[{voice_agent_id:"a1",organization_id:ORG,email_integration_id:"e1",allow_shared_leads:true}],
    calendar_integrations:[{id:"c1",organization_id:ORG,status:"connected"}],
    email_integrations:[{id:"e1",organization_id:ORG,status:"connected",provider_user_email:"owner@example.test"}],
    ...seed,
  });
  const originalGet = supabaseModule.getSupabase;
  const originalSend = gmail.sendGmail;
  const originalDraft = gmail.draftEmail;
  const originalConnection = gmail.getEmailConnectionRow;
  const prevSecret = process.env.INTERNAL_API_SECRET;
  supabaseModule.getSupabase = () => db;
  if (gmailStub) gmail.sendGmail = gmailStub;
  if (draftStub) {
    gmail.draftEmail = draftStub;
    gmail.getEmailConnectionRow = async () => ({ id:"e1",status:"connected",label: "Business", provider_user_email: "owner@example.test" });
  }
  process.env.INTERNAL_API_SECRET = SECRET;
  delete require.cache[require.resolve("../api/routes/internal-owner")];
  const app = express();
  app.use(express.json());
  app.use("/api/internal/owner", require("../api/routes/internal-owner"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const post = async (path, body, secret = SECRET) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/owner${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-agently-internal-secret": secret } : {}) },
      body: JSON.stringify({voiceAgentId:"a1",...body}),
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    await fn(post, db);
  } finally {
    server.close();
    supabaseModule.getSupabase = originalGet;
    gmail.sendGmail = originalSend;
    gmail.draftEmail = originalDraft;
    gmail.getEmailConnectionRow = originalConnection;
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
    delete require.cache[require.resolve("../api/routes/internal-owner")];
  }
}

const LEADS = [
  { id: "l1", organization_id: ORG, name: "Luqman", email: "luqman@example.com", tags: ["vip"], created_at: "2026-10-01" },
  { id: "l2", organization_id: ORG, name: "Ada", email: null, tags: ["vip"], created_at: "2026-10-02" },
  { id: "l3", organization_id: ORG, name: "Bo", email: "bo@example.com", tags: ["cold"], created_at: "2026-10-03" },
  { id: "x1", organization_id: OTHER, name: "Stranger", email: "s@example.com", tags: ["vip"], created_at: "2026-10-04" },
];

test("owner endpoints refuse a request without the shared secret", async () => {
  await withServer({ leads: LEADS }, async (post) => {
    const r = await post("/leads", { organizationId: ORG }, null);
    assert.equal(r.status, 401);
  });
});

test("find leads by tag stays inside the organization", async () => {
  await withServer({ leads: LEADS }, async (post) => {
    const { json } = await post("/leads", { organizationId: ORG, tag: "VIP" });
    assert.deepEqual(json.leads.map((l) => l.id).sort(), ["l1", "l2"]);
    assert.equal(json.leads.find((l) => l.id === "l1").email, "luqman@example.com", "verified owner can review the actual saved recipient");
    assert.ok(!json.leads.some((l) => l.email === "s@example.com"), "no foreign recipient is exposed");
    assert.ok(json.availableTags.includes("cold"));
  });
});

test("send refuses a draft whose address is not the one on file", async () => {
  const sent = [];
  await withServer(
    { leads: LEADS },
    async (post) => {
      const { json } = await post("/email/send", {
        organizationId: ORG,
        drafts: [
          { leadId: "l1", name: "Luqman", to: "attacker@evil.test", subject: "s", body: "b" },
          { leadId: "x1", name: "Stranger", to: "s@example.com", subject: "s", body: "b" },
          { leadId: "l3", name: "Bo", to: "bo@example.com", subject: "s", body: "b" },
        ],
      });
      assert.equal(json.sent, 1);
      assert.equal(json.failed, 2);
    },
    {
      gmailStub: async (_db, org, params) => {
        sent.push({ org, to: params.to });
        return { success: true };
      },
    },
  );
  assert.deepEqual(sent, [{ org: ORG, to: "bo@example.com" }], "only the matching, in-org lead was emailed");
});

test("reschedule of an unknown or foreign appointment changes nothing", async () => {
  await withServer(
    { appointments: [{ id: "ap-x", organization_id: OTHER, status: "booked", attendee_name: "S" }] },
    async (post) => {
      const { json } = await post("/reschedule", { organizationId: ORG, appointmentId: "ap-x", newStartISO: "2099-01-01T10:00:00Z" });
      assert.equal(json.success, false);
      assert.equal(json.code, "not_found");
    },
  );
});

test("knowledge overview reads only the agent's own knowledge base", async () => {
  await withServer(
    {
      voice_agents: [{ id: "a1", organization_id: ORG, name: "Timi", knowledge_base_id: "kb1" }],
      knowledge_bases: [{ id: "kb1", organization_id: ORG, name: "Viral Ad Media" }],
      knowledge_sources: [{ id: "s1", organization_id: ORG, knowledge_base_id: "kb1", source_type: "website", title: "Home", url: "https://v.test", product_count: 3 }],
      knowledge_source_files: [
        { id: "f1", organization_id: ORG, knowledge_base_id: "kb1", filename: "pricing.pdf", file_type: "pdf", status: "indexed" },
        { id: "f2", organization_id: OTHER, knowledge_base_id: "kb1", filename: "theirs.pdf", file_type: "pdf", status: "indexed" },
      ],
      faqs: [{ id: "q1", organization_id: ORG, knowledge_base_id: "kb1" }],
    },
    async (post) => {
      const { json } = await post("/knowledge", { organizationId: ORG, voiceAgentId: "a1" });
      assert.equal(json.knowledgeBase.name, "Viral Ad Media");
      assert.deepEqual(json.uploadedFiles.map((f) => f.name), ["pricing.pdf"]);
      assert.equal(json.counts.faqs, 1);
      assert.equal(json.counts.products, 3);
    },
  );
});

test("appointment missing email can draft using the explicitly selected saved lead", async () => {
  await withServer({ leads: LEADS, appointments: [{ id: "ap1", organization_id: ORG, integration_id:"c1", attendee_name: "Luqman", attendee_email: null, starts_at: "2026-10-09T12:30:00Z", timezone: "Africa/Lagos" }] }, async (post) => {
    const { json } = await post("/email/prepare", { organizationId: ORG, appointmentId: "ap1", leadIds: ["l1"], purpose: "meeting_invite" });
    assert.equal(json.success, true);
    assert.equal(json.drafts[0].to, "luqman@example.com");
    assert.equal(json.drafts[0].leadId, "l1");
    assert.equal(json.drafts[0].appointmentId, "ap1");
    const foreign = await post("/email/prepare", { organizationId: ORG, appointmentId: "ap1", leadIds: ["x1"] });
    assert.equal(foreign.json.success, false);
  }, { draftStub: async () => ({ subject: "Appointment", body: "Confirmed details", purpose: "meeting_invite" }) });
});

test("contact corrections validate the address and cannot change another tenant", async () => {
  await withServer({ leads: LEADS.map((l) => ({ ...l })) }, async (post) => {
    assert.equal((await post("/lead/contact", { organizationId: ORG, leadId: "x1", email: "new@example.test" })).json.success, false);
    assert.equal((await post("/lead/contact", { organizationId: ORG, leadId: "l1", email: "bad,address" })).json.code, "invalid_email");
    const saved = await post("/lead/contact", { organizationId: ORG, leadId: "l1", email: "correct@example.test" });
    assert.equal(saved.json.lead.email, "correct@example.test");
  });
});
