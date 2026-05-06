"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  isUuid,
  isE164,
  cleanPhone,
  normalizeArray,
  normalizeScheduleStatus,
  normalizeScheduleType,
  normalizeTimesPerDay,
  normalizeDaysOfWeek,
  resolveStartAt,
  buildEffectiveSchedulerLimits,
  buildRunCandidates,
  serializeSchedule,
  serializeRun,
} = require("../../lib/outreach-utils");

const router = express.Router();

function nowIso() {
  return new Date().toISOString();
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
    const status = run.status || "pending";
    if (status === "pending") progress.pending += 1;
    else if (status === "processing") progress.processing += 1;
    else if (status === "queued_to_twilio") progress.queuedToTwilio += 1;
    else if (status === "completed") progress.completed += 1;
    else if (status === "failed") progress.failed += 1;
    else if (status === "no_answer") progress.noAnswer += 1;
    else if (status === "voicemail") progress.voicemail += 1;
    else if (status === "skipped") progress.skipped += 1;
    else if (status === "retry_scheduled") progress.retryScheduled += 1;
    else if (String(status).startsWith("blocked")) progress.blocked += 1;
  }
  progress.remaining =
    progress.pending + progress.processing + progress.retryScheduled;
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
      .in("status", ["pending", "retry_scheduled"]);
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
        scheduled_for: scheduledFor,
        status: "pending",
        attempt_number: index + 1,
        outcome_metadata: {
          scheduleType: schedule.schedule_type,
          callPurpose: schedule.call_purpose || "",
        },
      });
    });
  }

  if (!rows.length) {
    await refreshScheduleProgress(db, organizationId, schedule.id);
    return { inserted: 0, runs: [] };
  }

  const inserted = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { data, error } = await db
      .from("lead_outreach_runs")
      .upsert(chunk, {
        onConflict: "schedule_id,lead_id,scheduled_for,attempt_number",
        ignoreDuplicates: true,
      })
      .select();
    if (error) throw error;
    inserted.push(...(data || []));
  }
  await refreshScheduleProgress(db, organizationId, schedule.id);
  return { inserted: inserted.length, runs: inserted };
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
    const scheduleType = normalizeScheduleType(
      body.scheduleType || body.schedule_type,
    );
    const status = normalizeScheduleStatus(body.status || "active", "active");
    const timezone =
      String(
        body.timezone || req.organization?.timezone || "America/New_York",
      ).trim() || "America/New_York";
    const startAt = resolveStartAt(body, timezone);
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
    if (!leadIds.length) {
      return res.status(400).json({
        error: {
          code: "LEADS_REQUIRED",
          message: "At least one leadId is required.",
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

    const row = {
      organization_id: organizationId,
      voice_agent_id: voiceAgentId,
      from_number_id: number.id,
      from_number:
        number.phone_number || fromNumber || agent.twilio_phone_number || "",
      lead_id: leadIds.length === 1 ? leadIds[0] : null,
      lead_ids: leadIds,
      target_type: leadIds.length === 1 ? "lead" : "lead_list",
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
    res.status(201).json({
      success: true,
      schedule: serializeSchedule(schedule),
      generatedRuns: generated.inserted,
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
        .select("id")
        .eq("organization_id", req.orgId)
        .eq("status", "pending"),
      db
        .from("lead_outreach_runs")
        .select("id")
        .eq("organization_id", req.orgId)
        .in("status", [
          "failed",
          "blocked_provider_unavailable",
          "blocked_country",
          "blocked_quota",
        ]),
      db
        .from("lead_outreach_runs")
        .select("id")
        .eq("organization_id", req.orgId)
        .in("status", ["completed", "queued_to_twilio"]),
    ]);
    const next = await db
      .from("lead_outreach_runs")
      .select("scheduled_for")
      .eq("organization_id", req.orgId)
      .eq("status", "pending")
      .gte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle();
    res.json({
      success: true,
      metrics: {
        scheduledCallsToday: (todayRuns || []).length,
        pendingScheduledCalls: (pendingRuns || []).length,
        activeCampaigns: (schedules || []).filter((s) => s.status === "active")
          .length,
        failedScheduledCalls: (failedRuns || []).length,
        callsCompletedFromCampaigns: (completedRuns || []).length,
        nextScheduledCallTime: next.data?.scheduled_for || null,
      },
    });
  }),
);

module.exports = router;
