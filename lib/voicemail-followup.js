"use strict";

const { readVoicemailSettings, callbackAt } = require("./voicemail-policy");

const TERMINAL = new Set(["completed", "failed", "busy", "no-answer", "canceled", "cancelled"]);

function planVoicemailFollowup(settings, run, now = new Date()) {
  if (!["callback_later", "manual_followup"].includes(settings.action)) return null;
  const dueAt = settings.action === "callback_later" ? callbackAt(settings, now) : now.toISOString();
  const attempt = Math.max(1, Number(run?.attempt_number) || 1);
  if (settings.action === "callback_later" && run && attempt <= settings.maxRedialAttempts) {
    return { kind: "automatic_retry", dueAt, nextAttempt: attempt + 1 };
  }
  return { kind: "staff_task", dueAt, nextAttempt: null };
}

async function applyVoicemailFollowup(db, callSid, now = new Date()) {
  if (!callSid) return { skipped: "missing_call_sid" };
  const { data: record, error: recordError } = await db
    .from("call_records")
    .select("id,organization_id,voice_agent_id,lead_id,status,metadata,voicemail_detected")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (recordError) throw recordError;
  if (!record) return { skipped: "missing_call_record" };
  if (!TERMINAL.has(String(record.status || "").toLowerCase())) return { skipped: "call_still_active" };
  if (record.voicemail_detected !== true && record.metadata?.voicemail_detected !== true) {
    return { skipped: "not_voicemail" };
  }
  if (record.metadata?.voicemail_followup?.call_sid === callSid) {
    return { skipped: "already_processed" };
  }

  const { data: agent, error: agentError } = await db
    .from("voice_agents")
    .select("voicemail_behavior,voicemail_message,voicemail_settings,voicemail_callback_delay_minutes,voicemail_max_redial_attempts")
    .eq("id", record.voice_agent_id)
    .eq("organization_id", record.organization_id)
    .maybeSingle();
  if (agentError) throw agentError;
  if (!agent) return { skipped: "missing_agent" };
  const settings = readVoicemailSettings(agent);
  const runId = record.metadata?.scheduleRunId || record.metadata?.billing?.run_id || null;
  let run = null;
  if (runId) {
    const { data, error } = await db
      .from("lead_outreach_runs")
      .select("id,organization_id,lead_id,status,attempt_number,outcome_metadata")
      .eq("id", runId)
      .eq("organization_id", record.organization_id)
      .maybeSingle();
    if (error) throw error;
    run = data || null;
  }
  const plan = planVoicemailFollowup(settings, run, now);
  if (!plan) return { skipped: "no_followup_action" };

  let taskId = null;
  if (plan.kind === "automatic_retry") {
    const { data, error } = await db
      .from("lead_outreach_runs")
      .update({
        status: "queued",
        scheduled_for: plan.dueAt,
        attempt_number: plan.nextAttempt,
        completed_at: null,
        twilio_call_sid: null,
        call_record_id: null,
        error_code: "VOICEMAIL_RETRY_SCHEDULED",
        error_message: null,
        outcome_metadata: {
          ...(run.outcome_metadata || {}),
          outcome: "retry_scheduled",
          retryAt: plan.dueAt,
          voicemailRetryPreviousCallSid: callSid,
        },
        updated_at: now.toISOString(),
      })
      .eq("id", run.id)
      .eq("organization_id", record.organization_id)
      .neq("status", "queued")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return { skipped: "run_already_queued" };
  } else {
    const leadId = record.lead_id || run?.lead_id || record.metadata?.leadId || null;
    if (leadId) {
      const { data: lead, error: leadError } = await db
        .from("leads")
        .select("id")
        .eq("id", leadId)
        .eq("organization_id", record.organization_id)
        .maybeSingle();
      if (leadError) throw leadError;
      if (lead) {
        const { data: tasks, error: tasksError } = await db
          .from("lead_tasks")
          .select("id,metadata")
          .eq("lead_id", lead.id)
          .eq("organization_id", record.organization_id)
          .limit(100);
        if (tasksError) throw tasksError;
        taskId = (tasks || []).find((task) => task.metadata?.source_call_sid === callSid)?.id || null;
        if (!taskId) {
          const { data: task, error: taskError } = await db
            .from("lead_tasks")
            .insert({
              lead_id: lead.id,
              organization_id: record.organization_id,
              title: settings.action === "callback_later" ? "Call back after voicemail" : "Review voicemail and follow up",
              description: "The outbound call reached voicemail. Review the call record and follow up with the contact.",
              task_type: "follow_up",
              priority: "normal",
              status: "open",
              due_at: plan.dueAt,
              metadata: { source_call_sid: callSid, voice_agent_id: record.voice_agent_id, voicemail_action: settings.action },
            })
            .select("id")
            .single();
          if (taskError) throw taskError;
          taskId = task.id;
        }
        const { error: leadUpdateError } = await db
          .from("leads")
          .update({ needs_human_review: true, next_action_due_at: plan.dueAt, updated_at: now.toISOString() })
          .eq("id", lead.id)
          .eq("organization_id", record.organization_id);
        if (leadUpdateError) throw leadUpdateError;
      }
    }
  }

  const category = plan.kind === "automatic_retry" ? "callback_scheduled" : "manual_followup_required";
  const { data: latestRecord, error: latestRecordError } = await db
    .from("call_records")
    .select("metadata")
    .eq("id", record.id)
    .eq("organization_id", record.organization_id)
    .maybeSingle();
  if (latestRecordError) throw latestRecordError;
  const { error: recordUpdateError } = await db
    .from("call_records")
    .update({
      call_category: category,
      disposition: plan.kind === "automatic_retry" ? "voicemail_retry_queued" : "voicemail_staff_followup",
      metadata: {
        ...(latestRecord?.metadata || record.metadata || {}),
        voicemail_followup: {
          call_sid: callSid,
          action: settings.action,
          kind: plan.kind,
          due_at: plan.dueAt,
          task_id: taskId,
          run_id: run?.id || null,
          processed_at: now.toISOString(),
        },
      },
    })
    .eq("id", record.id)
    .eq("organization_id", record.organization_id);
  if (recordUpdateError) throw recordUpdateError;
  return { applied: true, kind: plan.kind, dueAt: plan.dueAt, taskId };
}

module.exports = { planVoicemailFollowup, applyVoicemailFollowup };
