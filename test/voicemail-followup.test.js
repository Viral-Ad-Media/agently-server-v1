"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { planVoicemailFollowup, applyVoicemailFollowup } = require("../lib/voicemail-followup");

const NOW = new Date("2026-10-13T10:00:00.000Z");

test("voicemail follow-up planning respects retry limits and zero", () => {
  assert.equal(planVoicemailFollowup({ action: "hangup" }, null, NOW), null);
  assert.deepEqual(
    planVoicemailFollowup({ action: "callback_later", callbackDelayMinutes: 30, maxRedialAttempts: 1 }, { attempt_number: 1 }, NOW),
    { kind: "automatic_retry", dueAt: "2026-10-13T10:30:00.000Z", nextAttempt: 2 },
  );
  assert.equal(
    planVoicemailFollowup({ action: "callback_later", maxRedialAttempts: 0 }, { attempt_number: 1 }, NOW).kind,
    "staff_task",
  );
  assert.equal(
    planVoicemailFollowup({ action: "manual_followup" }, null, NOW).kind,
    "staff_task",
  );
});

test("scheduled voicemail requeues once and records the callback", async () => {
  const db = makeFakeSupabase({
    call_records: [{ id: "call-1", organization_id: "org-1", voice_agent_id: "agent-1", lead_id: "lead-1", twilio_call_sid: "CA-test-1", status: "completed", voicemail_detected: true, metadata: { scheduleRunId: "run-1" } }],
    voice_agents: [{ id: "agent-1", organization_id: "org-1", voicemail_behavior: "callback_later", voicemail_callback_delay_minutes: 30, voicemail_max_redial_attempts: 1 }],
    lead_outreach_runs: [{ id: "run-1", organization_id: "org-1", lead_id: "lead-1", status: "completed", attempt_number: 1, outcome_metadata: {} }],
  });
  const result = await applyVoicemailFollowup(db, "CA-test-1", NOW);
  assert.equal(result.kind, "automatic_retry");
  assert.equal(db._rows("lead_outreach_runs")[0].status, "queued");
  assert.equal(db._rows("lead_outreach_runs")[0].attempt_number, 2);
  assert.equal(db._rows("lead_outreach_runs")[0].scheduled_for, "2026-10-13T10:30:00.000Z");
  assert.equal(db._rows("call_records")[0].call_category, "callback_scheduled");
  assert.deepEqual(await applyVoicemailFollowup(db, "CA-test-1", NOW), { skipped: "already_processed" });
});

test("manual voicemail creates one lead task and marks review", async () => {
  const db = makeFakeSupabase({
    call_records: [{ id: "call-2", organization_id: "org-1", voice_agent_id: "agent-1", lead_id: "lead-1", twilio_call_sid: "CA-test-2", status: "completed", voicemail_detected: true, metadata: {} }],
    voice_agents: [{ id: "agent-1", organization_id: "org-1", voicemail_behavior: "manual_followup" }],
    leads: [{ id: "lead-1", organization_id: "org-1", name: "Test lead" }],
    lead_tasks: [],
  });
  const result = await applyVoicemailFollowup(db, "CA-test-2", NOW);
  assert.equal(result.kind, "staff_task");
  assert.equal(db._rows("lead_tasks").length, 1);
  assert.equal(db._rows("lead_tasks")[0].metadata.source_call_sid, "CA-test-2");
  assert.equal(db._rows("leads")[0].needs_human_review, true);
  assert.equal(db._rows("call_records")[0].call_category, "manual_followup_required");
  await applyVoicemailFollowup(db, "CA-test-2", NOW);
  assert.equal(db._rows("lead_tasks").length, 1);
});
