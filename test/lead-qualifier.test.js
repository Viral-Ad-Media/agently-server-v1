"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { qualifyLeadFromCall } = require("../lib/lead-qualifier");

function completion(value) {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }),
      },
    },
  };
}

test("playbook qualification records evidence without booking or discarding the lead", async () => {
  const db = makeFakeSupabase({
    voice_agents: [{
      id: "agent-1",
      organization_id: "org-1",
      qualification_playbook: "Ask about decision authority and timing.",
      qualification_rules: { qualified_min_score: 80, disqualify_signals: ["outside service area"] },
    }],
    leads: [{ id: "lead-1", organization_id: "org-1", voice_agent_id: "agent-1", crm_stage: "contacted", status: "contacted" }],
    lead_activities: [],
  });
  const result = await qualifyLeadFromCall({
    leadId: "lead-1",
    organizationId: "org-1",
    voiceAgentId: "agent-1",
    transcript: [{ speaker: "Caller", text: "I make the decision, but I am outside your service area." }],
    db,
    openai: completion({
      score: 92,
      confidence: 0.9,
      summary: "The decision maker is interested but may be outside the service area.",
      intent: "general_interest",
      next_action: "Confirm the service address with the owner.",
      next_action_days: 1,
      estimated_value_usd: 500,
      disqualified: true,
      disqualify_reason: "Possible service-area mismatch.",
      evidence: ["Caller said they make the decision.", "Caller said they may be outside the service area."],
    }),
    now: new Date("2026-10-09T12:00:00.000Z"),
  });

  assert.equal(result.score, 92);
  const lead = db._rows("leads")[0];
  assert.equal(lead.crm_stage, "contacted", "AI must not mark a possible disqualification lost");
  assert.equal(lead.needs_human_review, true);
  assert.equal(lead.estimated_value_cents, 50000);
  assert.equal(lead.appointment_at, undefined, "qualification cannot create a booking");
  const activity = db._rows("lead_activities")[0];
  assert.equal(activity.activity_type, "ai_qualification");
  assert.equal(activity.metadata.review_required, true);
  assert.equal(activity.metadata.evidence.length, 2);
});

test("no playbook skips the additional model pass", async () => {
  let calls = 0;
  const db = makeFakeSupabase({
    voice_agents: [{ id: "agent-1", organization_id: "org-1", qualification_playbook: "" }],
    leads: [{ id: "lead-1", organization_id: "org-1", voice_agent_id: "agent-1", crm_stage: "contacted" }],
  });
  const result = await qualifyLeadFromCall({
    leadId: "lead-1",
    organizationId: "org-1",
    voiceAgentId: "agent-1",
    transcript: [{ speaker: "Caller", text: "Hello" }],
    db,
    openai: { chat: { completions: { create: async () => { calls += 1; } } } },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("qualification stays assigned to the call's agent and low confidence cannot promote", async () => {
  const db = makeFakeSupabase({voice_agents:[{id:"agent-1",organization_id:"org-1",qualification_playbook:"Ask about timing."}],leads:[{id:"lead-1",organization_id:"org-1",voice_agent_id:"agent-1",crm_stage:"contacted",status:"contacted"}],lead_activities:[]});
  await qualifyLeadFromCall({leadId:"lead-1",organizationId:"org-1",voiceAgentId:"agent-1",transcript:[{speaker:"Caller",text:"Maybe later."}],db,openai:completion({score:95,confidence:0.2,summary:"Timing is uncertain.",next_action:"Ask again later.",evidence:["Caller said maybe later."]})});
  assert.equal(db._rows("leads")[0].crm_stage,"contacted");
  assert.equal(db._rows("leads")[0].needs_human_review,true);
  const foreign=await qualifyLeadFromCall({leadId:"lead-1",organizationId:"org-1",voiceAgentId:"agent-2",transcript:[{speaker:"Caller",text:"Ready."}],db,openai:completion({score:100})});
  assert.equal(foreign,null);
});
