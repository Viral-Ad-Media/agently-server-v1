"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  isUuid,
  isE164,
  cleanPhone,
  normalizeDirectRecipients,
  normalizeArray,
  normalizeScheduleStatus,
  normalizeScheduleType,
  normalizeTimesPerDay,
  normalizeDaysOfWeek,
  resolveStartAt,
  buildEffectiveSchedulerLimits,
  buildRunCandidates,
  detailedOutcome,
  displayStatusForRun,
  durationSecondsForRun,
  retryAtForRun,
  serializeSchedule,
  serializeRun,
} = require("../../lib/outreach-utils");

const router = express.Router();

function nowIso() {
  return new Date().toISOString();
}

function oneTimeOverflowMode() {
  const value = String(process.env.SCHEDULER_ONE_TIME_OVERFLOW_MODE || "fail")
    .trim()
    .toLowerCase();
  return ["fail", "queue"].includes(value) ? value : "fail";
}

function isOneTimeOverflowFailEnabled(schedule) {
  return (
    String(schedule?.schedule_type || "") === "one_time" &&
    oneTimeOverflowMode() === "fail"
  );
}

function pagination(req) {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.query.limit || "25", 10)),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  return { page, limit, from, to };
}

async function ensureAgent(db, organizationId, voiceAgentId) {
  if (!voiceAgentId || !isUuid(voiceAgentId)) return null;
  const { data } = await db
    .from("voice_agents")
    .select("*")
    .eq("id", voiceAgentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data || null;
}

async function ensureFromNumber(
  db,
  organizationId,
  { fromNumberId, fromNumber, voiceAgentId },
) {
  let q = db
    .from("twilio_phone_numbers")
    .select("*")
    .eq("organization_id", organizationId);
  if (fromNumberId) q = q.eq("id", fromNumberId);
  else if (fromNumber) q = q.eq("phone_number", fromNumber);
  else if (voiceAgentId) q = q.eq("assigned_voice_agent_id", voiceAgentId);
  else return null;
  const { data } = await q.maybeSingle();
  return data || null;
}

async function loadLeads(db, organizationId, leadIds) {
  const ids = [...new Set(normalizeArray(leadIds).filter(isUuid))];
  if (!ids.length) return [];
  const { data, error } = await db
    .from("leads")
    .select("*")
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (error) throw error;
  return data || [];
}

async function refreshScheduleProgress(db, organizationId, scheduleId) {
  const { data: runs } = await db
    .from("lead_outreach_runs")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("schedule_id", scheduleId);
  const progress = {
    totalRuns: (runs || []).length,
    pending: 0,
    processing: 0,
    queuedToTwilio: 0,
    completed: 0,
    failed: 0,
    noAnswer: 0,
    voicemail: 0,
    skipped: 0,
    retryScheduled: 0,
    blocked: 0,
    remaining: 0,
  };
  for (const run of runs || []) {
    const status = run.status || "queued";
    if (status === "queued") progress.pending += 1;
    else if (status === "initiated") progress.processing += 1;
    else if (status === "completed") progress.completed += 1;
    else if (status === "failed") progress.failed += 1;
  }
  progress.remaining = progress.pending + progress.processing;
  await db
    .from("lead_outreach_schedules")
    .update({ progress, updated_at: nowIso() })
    .eq("id", scheduleId)
    .eq("organization_id", organizationId);
  return progress;
}

async function generateRunsForSchedule(
  db,
  organizationId,
  schedule,
  { replacePending = false } = {},
) {
  const leadIds =
    Array.isArray(schedule.lead_ids) && schedule.lead_ids.length
      ? schedule.lead_ids
      : schedule.lead_id
        ? [schedule.lead_id]
        : [];
  const directRecipients = normalizeDirectRecipients(
    schedule.direct_recipients || schedule.metadata?.directRecipients || [],
  );
  const leads = await loadLeads(db, organizationId, leadIds);
  const scheduledTimes = buildRunCandidates(schedule, {
    horizonDays: Number(schedule.metadata?.generation_horizon_days || 30),
    maxRuns: Number(schedule.metadata?.generation_max_runs || 500),
  });

  if (replacePending) {
    await db
      .from("lead_outreach_runs")
      .delete()
      .eq("organization_id", organizationId)
      .eq("schedule_id", schedule.id)
      .eq("status", "queued");
  }

  const rows = [];
  for (const lead of leads) {
    const destination = cleanPhone(lead.phone || lead.mobile || "");
    if (!isE164(destination)) continue;
    scheduledTimes.forEach((scheduledFor, index) => {
      rows.push({
        organization_id: organizationId,
        schedule_id: schedule.id,
        lead_id: lead.id,
        voice_agent_id: schedule.voice_agent_id,
        from_number_id: schedule.from_number_id || null,
        destination_phone: destination,
        target_phone: destination,
        target_name: lead.name || "Unknown",
        run_key: `lead:${lead.id}:${scheduledFor}:${index + 1}`,
        scheduled_for: scheduledFor,
        status: "queued",
        attempt_number: index + 1,
        outcome_metadata: {
          scheduleType: schedule.schedule_type,
          callPurpose: schedule.call_purpose || "",
          targetType: "lead",
        },
      });
    });
  }

  for (const recipient of directRecipients) {
    scheduledTimes.forEach((scheduledFor, index) => {
      rows.push({
        organization_id: organizationId,
        schedule_id: schedule.id,
        lead_id: null,
        voice_agent_id: schedule.voice_agent_id,
        from_number_id: schedule.from_number_id || null,
        destination_phone: recipient.phone,
        target_phone: recipient.phone,
        target_name: recipient.name || "Direct recipient",
        run_key: `direct:${recipient.phone}:${scheduledFor}:${index + 1}`,
        scheduled_for: scheduledFor,
        status: "queued",
        attempt_number: index + 1,
        outcome_metadata: {
          scheduleType: schedule.schedule_type,
          callPurpose: schedule.call_purpose || "",
          targetType: "direct_number",
          directRecipient: recipient,
        },
      });
    });
  }

  if (isOneTimeOverflowFailEnabled(schedule)) {
    const limits = buildEffectiveSchedulerLimits({
      schedule,
      env: process.env,
    });
    const maxInitialCalls = Math.max(
      1,
      Number(limits.maxOrgConcurrentCalls || 1),
    );
    rows.forEach((row, index) => {
      if (index >= maxInitialCalls) {
        row.status = "failed";
        row.completed_at = nowIso();
        row.error_code = "ONE_TIME_CONCURRENCY_LIMIT_EXCEEDED";
        row.error_message =
          "This one-time batch exceeded the schedule concurrency limit. Add this recipient to the next batch if you want to call them.";
        row.outcome_metadata = {
          ...(row.outcome_metadata || {}),
          outcome: "one_time_limit_exceeded",
          displayOutcome: "one_time_limit_exceeded",
          deferred_reason: null,
          maxConcurrentCalls: maxInitialCalls,
          overflowIndex: index + 1,
          instruction: "add_to_next_batch",
        };
      }
    });
  }

  if (!rows.length) {
    await refreshScheduleProgress(db, organizationId, schedule.id);
    return { inserted: 0, runs: [] };
  }

  const { data: existingRows, error: existingError } = await db
    .from("lead_outreach_runs")
    .select("run_key")
    .eq("organization_id", organizationId)
    .eq("schedule_id", schedule.id);
  if (existingError) throw existingError;
  const existingKeys = new Set(
    (existingRows || []).map((row) => row.run_key).filter(Boolean),
  );
  const rowsToInsert = rows.filter(
    (row) => !row.run_key || !existingKeys.has(row.run_key),
  );

  const inserted = [];
  for (let i = 0; i < rowsToInsert.length; i += 100) {
    const chunk = rowsToInsert.slice(i, i + 100);
    console.log("[outreach] creating scheduled run rows", {
      count: chunk.length,
      queued: chunk.filter((row) => row.status === "queued").length,
      failedOverflow: chunk.filter(
        (row) => row.error_code === "ONE_TIME_CONCURRENCY_LIMIT_EXCEEDED",
      ).length,
      scheduleId: schedule.id,
    });
    const { data, error } = await db
      .from("lead_outreach_runs")
      .insert(chunk)
      .select();
    if (error) throw error;
    inserted.push(...(data || []));
    for (const run of data || [])
      console.log("[outreach] run created id=", run.id);
  }
  await refreshScheduleProgress(db, organizationId, schedule.id);
  return { inserted: inserted.length, runs: inserted };
}

function buildScheduleStatusResponse(schedule, runs) {
  const recipients = (runs || []).map((run) => ({
    runId: run.id,
    name: run.target_name || "Recipient",
    phone: run.destination_phone || run.target_phone || "",
    displayStatus: displayStatusForRun(run),
    status: run.status,
    twilioCallSid: run.twilio_call_sid || null,
    callRecordId: run.call_record_id || null,
    durationSeconds: durationSecondsForRun(run),
    outcome: detailedOutcome(run),
    retryAt: retryAtForRun(run),
    errorCode: run.error_code || null,
    errorMessage: run.error_message || null,
    scheduledFor: run.scheduled_for || null,
    startedAt: run.started_at || null,
    completedAt: run.completed_at || null,
  }));
  const counts = {
    totalRecipients: recipients.length,
    queued: 0,
    deferred: 0,
    initiated: 0,
    answered: 0,
    completed: 0,
    noAnswer: 0,
    voicemail: 0,
    busy: 0,
    failed: 0,
    retryScheduled: 0,
  };
  for (const recipient of recipients) {
    if (recipient.outcome === "queued") counts.queued += 1;
    else if (recipient.outcome === "deferred_concurrency_limit")
      counts.deferred += 1;
    else if (
      recipient.outcome === "initiated" ||
      recipient.status === "initiated"
    )
      counts.initiated += 1;
    else if (recipient.outcome === "answered") counts.answered += 1;
    else if (recipient.outcome === "completed") counts.completed += 1;
    else if (recipient.outcome === "no_answer") counts.noAnswer += 1;
    else if (recipient.outcome === "voicemail") counts.voicemail += 1;
    else if (recipient.outcome === "busy") counts.busy += 1;
    else if (recipient.outcome === "retry_scheduled")
      counts.retryScheduled += 1;
    else if (recipient.outcome === "failed") counts.failed += 1;
  }
  const nextQueued = (runs || [])
    .filter((run) => String(run.status || "") === "queued")
    .sort((a, b) =>
      String(a.scheduled_for || "").localeCompare(
        String(b.scheduled_for || ""),
      ),
    )[0];
  return {
    schedule: {
      id: schedule.id,
      name: schedule.name || "",
      status:
        schedule.status || (schedule.is_active === false ? "paused" : "active"),
      ...counts,
      nextRunAt: nextQueued?.scheduled_for || null,
    },
    recipients,
  };
}

router.post(
  "/schedules",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const organizationId = req.orgId;
    const voiceAgentId = body.voiceAgentId || body.voice_agent_id;
    const fromNumberId = body.fromNumberId || body.from_number_id || null;
    const fromNumber = cleanPhone(body.fromNumber || body.from_number || "");
    const leadIds = normalizeArray(
      body.leadIds || body.lead_ids || body.leadId || body.lead_id,
    ).filter(isUuid);
    const directRecipients = normalizeDirectRecipients(
      body.directRecipients ||
        body.direct_recipients ||
        body.directNumbers ||
        body.direct_numbers ||
        body.recipients ||
        body.numbers ||
        [],
    );
    const scheduleType = normalizeScheduleType(
      body.scheduleType || body.schedule_type,
    );
    const status = normalizeScheduleStatus(body.status || "active", "active");
    const timezone =
      String(
        body.timezone || req.organization?.timezone || "America/New_York",
      ).trim() || "America/New_York";
    let startAt = null;
    try {
      startAt = resolveStartAt(body, timezone);
    } catch (err) {
      return res.status(400).json({
        error: {
          code: "INVALID_SCHEDULE_TIME",
          message:
            "Schedule time could not be parsed. Please provide a valid date, time, and timezone.",
          detail: err.message || String(err),
        },
      });
    }
    const timesPerDay = normalizeTimesPerDay(
      body.timesPerDay || body.times_per_day,
      body.startTime || body.start_time || body.time || undefined,
    );
    const daysOfWeek = normalizeDaysOfWeek(
      body.daysOfWeek || body.days_of_week,
    );

    if (!voiceAgentId) {
      return res.status(400).json({
        error: {
          code: "VOICE_AGENT_REQUIRED",
          message: "voiceAgentId is required.",
        },
      });
    }
    if (!leadIds.length && !directRecipients.length) {
      return res.status(400).json({
        error: {
          code: "RECIPIENTS_REQUIRED",
          message:
            "Provide at least one leadId or one direct recipient phone number.",
        },
      });
    }
    if (!startAt) {
      return res.status(400).json({
        error: {
          code: "START_AT_REQUIRED",
          message: "startAt is required as an ISO UTC timestamp.",
        },
      });
    }

    const scheduledAt = new Date(startAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({
        error: {
          code: "INVALID_SCHEDULE_TIME",
          message:
            "Schedule time could not be parsed. Please choose a valid future time.",
          timezone,
        },
      });
    }

    const minimumLeadSeconds = Math.max(
      0,
      Number(process.env.SCHEDULE_MIN_LEAD_SECONDS || 60),
    );
    const earliestAllowed = new Date(Date.now() + minimumLeadSeconds * 1000);
    if (scheduleType === "one_time" && scheduledAt < earliestAllowed) {
      return res.status(400).json({
        error: {
          code: "SCHEDULE_TIME_IN_PAST",
          message:
            "Schedule time is already in the past. Please choose a future time.",
          scheduledForUtc: scheduledAt.toISOString(),
          earliestAllowedUtc: earliestAllowed.toISOString(),
          minimumLeadSeconds,
          timezone,
        },
      });
    }

    const agent = await ensureAgent(db, organizationId, voiceAgentId);
    if (!agent)
      return res.status(404).json({
        error: {
          code: "VOICE_AGENT_NOT_FOUND",
          message: "Voice agent not found.",
        },
      });

    const number = await ensureFromNumber(db, organizationId, {
      fromNumberId,
      fromNumber,
      voiceAgentId,
    });
    if (!number) {
      return res.status(404).json({
        error: {
          code: "FROM_NUMBER_NOT_FOUND",
          message:
            "A configured from-number is required for scheduled outbound calls.",
        },
      });
    }

    const leads = await loadLeads(db, organizationId, leadIds);
    if (leads.length !== leadIds.length) {
      return res.status(400).json({
        error: {
          code: "INVALID_LEADS",
          message: "One or more leads were not found for this tenant.",
        },
      });
    }

    const targetType =
      directRecipients.length && leadIds.length
        ? "lead_list"
        : directRecipients.length
          ? directRecipients.length === 1
            ? "direct_number"
            : "direct_numbers"
          : leadIds.length === 1
            ? "lead"
            : "lead_list";

    console.log("[outreach] creating schedule", {
      organizationId,
      voiceAgentId,
      scheduleType,
      startAt,
    });
    console.log("[outreach] target_type", { targetType });
    console.log("[outreach] direct recipients count", {
      count: directRecipients.length,
    });

    const row = {
      organization_id: organizationId,
      voice_agent_id: voiceAgentId,
      from_number_id: number.id,
      from_number:
        number.phone_number || fromNumber || agent.twilio_phone_number || "",
      lead_id:
        leadIds.length === 1 && directRecipients.length === 0
          ? leadIds[0]
          : null,
      lead_ids: leadIds,
      direct_recipients: directRecipients,
      target_type: targetType,
      name:
        String(body.name || "Scheduled outreach").trim() ||
        "Scheduled outreach",
      call_purpose: String(
        body.callPurpose || body.call_purpose || body.purpose || "",
      ).trim(),
      custom_instructions: String(
        body.customInstructions || body.custom_instructions || "",
      ).trim(),
      schedule_type: scheduleType,
      start_at: new Date(startAt).toISOString(),
      timezone,
      days_of_week: daysOfWeek,
      times_per_day: timesPerDay,
      max_calls_per_day: Math.max(
        1,
        Number(
          body.maxCallsPerDay ||
            body.max_calls_per_day ||
            body.maxDailyOutboundCalls ||
            body.max_daily_outbound_calls ||
            100,
        ),
      ),
      max_attempts_per_lead: Math.max(
        1,
        Number(body.maxAttemptsPerLead || body.max_attempts_per_lead || 1),
      ),
      retry_delay_minutes: Math.max(
        1,
        Number(body.retryDelayMinutes || body.retry_delay_minutes || 60),
      ),
      voicemail_behavior: String(
        body.voicemailBehavior || body.voicemail_behavior || "hangup",
      ),
      status,
      is_active: status === "active",
      windows: timesPerDay.map((time) => ({
        weekdays: daysOfWeek.length
          ? daysOfWeek
          : ["mon", "tue", "wed", "thu", "fri"],
        time,
      })),
      extra_context: String(body.customInstructions || body.callPurpose || ""),
      progress: {},
      metadata: {
        createdBy: req.user?.id || null,
        scheduleVersion: 1,
        directRecipients,
        limits: {
          ...(body.limits && typeof body.limits === "object"
            ? body.limits
            : {}),
          ...(body.maxConcurrentCalls
            ? { maxConcurrentCalls: Number(body.maxConcurrentCalls) }
            : {}),
          ...(body.maxOutboundCallsPerMinute
            ? {
                maxOutboundCallsPerMinute: Number(
                  body.maxOutboundCallsPerMinute,
                ),
              }
            : {}),
          ...(body.maxDailyOutboundCalls
            ? { maxDailyOutboundCalls: Number(body.maxDailyOutboundCalls) }
            : {}),
        },
        ...(body.metadata && typeof body.metadata === "object"
          ? body.metadata
          : {}),
      },
    };

    const { data: schedule, error } = await db
      .from("lead_outreach_schedules")
      .insert(row)
      .select()
      .single();
    if (error) throw error;

    const generated = await generateRunsForSchedule(
      db,
      organizationId,
      schedule,
      { replacePending: false },
    );
    const effectiveLimits = buildEffectiveSchedulerLimits({
      organization: req.organization || {},
      schedule,
      env: process.env,
    });
    const totalRecipients = leadIds.length + directRecipients.length;
    const warning =
      totalRecipients > effectiveLimits.maxOrgConcurrentCalls
        ? {
            code: "BATCH_EXCEEDS_CONCURRENCY_LIMIT",
            message:
              scheduleType === "one_time" && oneTimeOverflowMode() === "fail"
                ? `Your current plan allows ${effectiveLimits.maxOrgConcurrentCalls} concurrent calls. ${totalRecipients} recipients were included, so excess recipients in this one-time batch will be marked as not called. Add them to the next batch if needed.`
                : `Your current plan allows ${effectiveLimits.maxOrgConcurrentCalls} concurrent calls. ${totalRecipients} recipients will be called in batches. Excess recipients will be queued for the next available slot.`,
          }
        : null;
    res.status(201).json({
      success: true,
      schedule: serializeSchedule(schedule),
      generatedRuns: generated.inserted,
      warning,
    });
  }),
);

router.get(
  "/schedules",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { page, limit, from, to } = pagination(req);
    let q = db
      .from("lead_outreach_schedules")
      .select("*", { count: "exact" })
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (req.query.status) q = q.eq("status", String(req.query.status));
    if (req.query.agentId)
      q = q.eq("voice_agent_id", String(req.query.agentId));
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({
      success: true,
      schedules: (data || []).map(serializeSchedule),
      page,
      limit,
      total: count || 0,
    });
  }),
);

router.get(
  "/schedules/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    res.json({ success: true, schedule: serializeSchedule(data) });
  }),
);

router.patch(
  "/schedules/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const updates = { updated_at: nowIso() };
    if (body.name !== undefined) updates.name = String(body.name || "");
    if (body.callPurpose !== undefined || body.call_purpose !== undefined)
      updates.call_purpose = String(
        body.callPurpose || body.call_purpose || "",
      );
    if (
      body.customInstructions !== undefined ||
      body.custom_instructions !== undefined
    )
      updates.custom_instructions = String(
        body.customInstructions || body.custom_instructions || "",
      );
    if (body.status !== undefined) {
      updates.status = normalizeScheduleStatus(body.status, "active");
      updates.is_active = updates.status === "active";
    }
    const patchTimezone = String(body.timezone || "").trim();
    if (body.timezone !== undefined)
      updates.timezone = patchTimezone || "America/New_York";
    const resolvedStartAt = resolveStartAt(
      body,
      patchTimezone || "America/New_York",
    );
    if (resolvedStartAt) updates.start_at = resolvedStartAt;
    if (body.daysOfWeek !== undefined || body.days_of_week !== undefined)
      updates.days_of_week = normalizeDaysOfWeek(
        body.daysOfWeek || body.days_of_week,
      );
    if (body.timesPerDay !== undefined || body.times_per_day !== undefined)
      updates.times_per_day = normalizeTimesPerDay(
        body.timesPerDay || body.times_per_day,
      );
    if (body.maxCallsPerDay !== undefined)
      updates.max_calls_per_day = Math.max(1, Number(body.maxCallsPerDay));
    if (body.maxAttemptsPerLead !== undefined)
      updates.max_attempts_per_lead = Math.max(
        1,
        Number(body.maxAttemptsPerLead),
      );
    if (body.retryDelayMinutes !== undefined)
      updates.retry_delay_minutes = Math.max(1, Number(body.retryDelayMinutes));
    if (body.voicemailBehavior !== undefined)
      updates.voicemail_behavior = String(body.voicemailBehavior || "hangup");
    if (
      body.limits !== undefined ||
      body.maxConcurrentCalls !== undefined ||
      body.maxOutboundCallsPerMinute !== undefined ||
      body.maxDailyOutboundCalls !== undefined
    ) {
      const existing = await db
        .from("lead_outreach_schedules")
        .select("metadata")
        .eq("id", req.params.id)
        .eq("organization_id", req.orgId)
        .maybeSingle();
      const metadata =
        existing.data?.metadata && typeof existing.data.metadata === "object"
          ? existing.data.metadata
          : {};
      updates.metadata = {
        ...metadata,
        limits: {
          ...(metadata.limits || {}),
          ...(body.limits && typeof body.limits === "object"
            ? body.limits
            : {}),
          ...(body.maxConcurrentCalls
            ? { maxConcurrentCalls: Number(body.maxConcurrentCalls) }
            : {}),
          ...(body.maxOutboundCallsPerMinute
            ? {
                maxOutboundCallsPerMinute: Number(
                  body.maxOutboundCallsPerMinute,
                ),
              }
            : {}),
          ...(body.maxDailyOutboundCalls
            ? { maxDailyOutboundCalls: Number(body.maxDailyOutboundCalls) }
            : {}),
        },
      };
    }

    const { data, error } = await db
      .from("lead_outreach_schedules")
      .update(updates)
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    res.json({ success: true, schedule: serializeSchedule(data) });
  }),
);

async function updateScheduleStatus(req, res, status) {
  const db = getSupabase();
  const { data, error } = await db
    .from("lead_outreach_schedules")
    .update({ status, is_active: status === "active", updated_at: nowIso() })
    .eq("id", req.params.id)
    .eq("organization_id", req.orgId)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data)
    return res.status(404).json({ error: { message: "Schedule not found." } });
  res.json({ success: true, schedule: serializeSchedule(data) });
}

router.post(
  "/schedules/:id/pause",
  requireAuth,
  requireAdmin,
  asyncHandler((req, res) => updateScheduleStatus(req, res, "paused")),
);
router.post(
  "/schedules/:id/resume",
  requireAuth,
  requireAdmin,
  asyncHandler((req, res) => updateScheduleStatus(req, res, "active")),
);
router.post(
  "/schedules/:id/cancel",
  requireAuth,
  requireAdmin,
  asyncHandler((req, res) => updateScheduleStatus(req, res, "cancelled")),
);

router.post(
  "/schedules/:id/generate-runs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: schedule, error } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!schedule)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    const generated = await generateRunsForSchedule(db, req.orgId, schedule, {
      replacePending: !!req.body?.replacePending,
    });
    res.json({
      success: true,
      generatedRuns: generated.inserted,
      runs: generated.runs.map(serializeRun),
    });
  }),
);

router.get(
  "/schedules/:id/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const [
      { data: schedule, error: scheduleError },
      { data: runs, error: runsError },
    ] = await Promise.all([
      db
        .from("lead_outreach_schedules")
        .select("*")
        .eq("id", req.params.id)
        .eq("organization_id", req.orgId)
        .maybeSingle(),
      db
        .from("lead_outreach_runs")
        .select("*")
        .eq("schedule_id", req.params.id)
        .eq("organization_id", req.orgId)
        .order("scheduled_for", { ascending: true }),
    ]);
    if (scheduleError) throw scheduleError;
    if (runsError) throw runsError;
    if (!schedule)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    res.json({
      success: true,
      ...buildScheduleStatusResponse(schedule, runs || []),
    });
  }),
);

router.get(
  "/schedules/:id/runs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { page, limit, from, to } = pagination(req);
    let q = db
      .from("lead_outreach_runs")
      .select("*", { count: "exact" })
      .eq("organization_id", req.orgId)
      .eq("schedule_id", req.params.id)
      .order("scheduled_for", { ascending: false })
      .range(from, to);
    if (req.query.status) q = q.eq("status", String(req.query.status));
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({
      success: true,
      runs: (data || []).map(serializeRun),
      page,
      limit,
      total: count || 0,
    });
  }),
);

router.get(
  "/runs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { page, limit, from, to } = pagination(req);
    let q = db
      .from("lead_outreach_runs")
      .select("*", { count: "exact" })
      .eq("organization_id", req.orgId)
      .order("scheduled_for", { ascending: false })
      .range(from, to);
    if (req.query.status) q = q.eq("status", String(req.query.status));
    if (req.query.scheduleId)
      q = q.eq("schedule_id", String(req.query.scheduleId));
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({
      success: true,
      runs: (data || []).map(serializeRun),
      page,
      limit,
      total: count || 0,
    });
  }),
);

router.get(
  "/runs/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("lead_outreach_runs")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res.status(404).json({ error: { message: "Run not found." } });
    res.json({ success: true, run: serializeRun(data) });
  }),
);

router.get(
  "/metrics",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [
      { data: schedules },
      { data: todayRuns },
      { data: pendingRuns },
      { data: failedRuns },
      { data: completedRuns },
    ] = await Promise.all([
      db
        .from("lead_outreach_schedules")
        .select("id,status")
        .eq("organization_id", req.orgId),
      db
        .from("lead_outreach_runs")
        .select("id,status,scheduled_for")
        .eq("organization_id", req.orgId)
        .gte("scheduled_for", today.toISOString()),
      db
        .from("lead_outreach_runs")
        .select("id,status,outcome_metadata,scheduled_for")
        .eq("organization_id", req.orgId)
        .eq("status", "queued"),
      db
        .from("lead_outreach_runs")
        .select("id,status,outcome_metadata,error_code,error_message")
        .eq("organization_id", req.orgId)
        .eq("status", "failed"),
      db
        .from("lead_outreach_runs")
        .select("id,status,outcome_metadata,call_duration,completed_at")
        .eq("organization_id", req.orgId)
        .in("status", ["completed", "initiated"]),
    ]);
    const next = await db
      .from("lead_outreach_runs")
      .select("scheduled_for")
      .eq("organization_id", req.orgId)
      .eq("status", "queued")
      .gte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle();
    res.json({
      success: true,
      metrics: {
        scheduledCallsToday: (todayRuns || []).length,
        pendingScheduledCalls: (pendingRuns || []).length,
        activeSchedules: (schedules || []).filter((s) => s.status === "active")
          .length,
        activeCampaigns: (schedules || []).filter((s) => s.status === "active")
          .length,
        scheduledRecipientsTotal: (todayRuns || []).length,
        scheduledRecipientsCalled: (completedRuns || []).length,
        scheduledRecipientsAnswered: (completedRuns || []).filter(
          (run) => detailedOutcome(run) === "answered",
        ).length,
        scheduledRecipientsNoAnswer: (failedRuns || []).filter(
          (run) => detailedOutcome(run) === "no_answer",
        ).length,
        scheduledRecipientsVoicemail: (completedRuns || []).filter(
          (run) => detailedOutcome(run) === "voicemail",
        ).length,
        scheduledRecipientsDeferred: (pendingRuns || []).filter(
          (run) => detailedOutcome(run) === "deferred_concurrency_limit",
        ).length,
        scheduledRecipientsFailed: (failedRuns || []).length,
        failedScheduledCalls: (failedRuns || []).length,
        callsCompletedFromCampaigns: (completedRuns || []).length,
        nextScheduledCallAt: next.data?.scheduled_for || null,
        nextScheduledCallTime: next.data?.scheduled_for || null,
      },
    });
  }),
);

module.exports = router;
