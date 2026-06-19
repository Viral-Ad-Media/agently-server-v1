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
const {
  ScheduleValidationError,
  generateScheduleOccurrences,
} = require("../../lib/schedule-generator");

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

function deriveScheduleStatusFromRuns(schedule, runs = []) {
  const raw = String(schedule?.status || "active").toLowerCase();
  if (
    [
      "completed",
      "complete",
      "done",
      "cancelled",
      "canceled",
      "failed",
      "deleted",
    ].includes(raw)
  )
    return raw;
  if (!runs.length) return raw;
  const terminal = new Set([
    "completed",
    "failed",
    "cancelled",
    "canceled",
    "no-answer",
    "busy",
    "skipped",
  ]);
  const remaining = runs.filter(
    (run) => !terminal.has(String(run.status || "").toLowerCase()),
  ).length;
  if (remaining > 0) return raw;
  const failed = runs.filter((run) =>
    ["failed", "no-answer", "busy"].includes(
      String(run.status || "").toLowerCase(),
    ),
  ).length;
  if (failed >= runs.length) return "failed";
  return "completed";
}

function buildProgressFromRuns(runs = []) {
  const progress = {
    totalRuns: runs.length,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
  };
  for (const run of runs) {
    const status = String(run.status || "queued").toLowerCase();
    if (status === "completed") progress.completed += 1;
    else if (
      ["failed", "no-answer", "busy", "cancelled", "canceled"].includes(status)
    )
      progress.failed += 1;
    else if (status === "initiated") progress.processing += 1;
    else progress.pending += 1;
  }
  progress.remaining = progress.pending + progress.processing;
  return progress;
}

function scheduleValidationResponse(res, error) {
  const details =
    error?.details && typeof error.details === "object" ? error.details : {};
  return res.status(400).json({
    error: {
      code: error.code || "INVALID_SCHEDULE",
      message: error.message || "Invalid schedule configuration.",
      ...details,
    },
  });
}

const RERUN_ELIGIBLE_CATEGORIES = new Set([
  "voicemail",
  "left_voicemail",
  "no_answer",
  "busy",
  "failed",
  "unavailable",
  "callback_scheduled",
  "manual_followup_required",
  "screened",
]);

const RERUN_PROTECTED_CATEGORIES = new Set([
  "answered_human",
  "screened_then_connected",
  "opted_out",
  "transferred",
]);

function normalizeRerunCategory(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!raw) return "unknown";
  const aliases = {
    unanswered: "no_answer",
    noanswer: "no_answer",
    no_answered: "no_answer",
    noanswercall: "no_answer",
    machine: "voicemail",
    answering_machine: "voicemail",
    voicemail_left: "left_voicemail",
    left_message: "left_voicemail",
    message_left: "left_voicemail",
    human: "answered_human",
    answered: "answered_human",
    connected: "answered_human",
    error: "failed",
    provider_failed: "failed",
    invalid: "unavailable",
    not_in_service: "unavailable",
    follow_up: "manual_followup_required",
    manual_followup: "manual_followup_required",
  };
  return aliases[raw] || raw;
}

function normalizeRerunCategoryList(value) {
  const items = normalizeArray(value);
  return [
    ...new Set(
      items
        .flatMap((item) => String(item || "").split(","))
        .map((item) => normalizeRerunCategory(item))
        .filter((item) => item && item !== "all"),
    ),
  ];
}

function isRerunEligibleCategory(category, { includeProtected = false } = {}) {
  const normalized = normalizeRerunCategory(category);
  if (RERUN_PROTECTED_CATEGORIES.has(normalized) && !includeProtected)
    return false;
  return RERUN_ELIGIBLE_CATEGORIES.has(normalized);
}

function metadataObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function stringValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function safeTags(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        String(item || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function categoryFromCallOrRun(call = null, run = null) {
  const callMeta = metadataObject(call?.metadata || call?.call_metadata);
  const runMeta = metadataObject(run?.outcome_metadata || run?.metadata);
  const explicit = stringValue(
    call?.call_category,
    call?.callCategory,
    callMeta.call_category,
    callMeta.callCategory,
    runMeta.call_category,
    runMeta.callCategory,
    runMeta.outcome,
    runMeta.displayOutcome,
  );
  if (explicit) return normalizeRerunCategory(explicit);
  const text = [
    call?.status,
    call?.outcome,
    call?.disposition,
    call?.answered_by,
    callMeta.disposition,
    callMeta.answered_by,
    callMeta.machine_detection_result,
    callMeta.hangup_reason,
    run?.status,
    run?.error_code,
    run?.error_message,
    detailedOutcome(run || {}),
  ]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  if (
    call?.voicemail_detected ||
    callMeta.voicemail_detected ||
    /voicemail|machine|answering_machine/.test(text)
  )
    return "voicemail";
  if (
    call?.screening_detected ||
    callMeta.screening_detected ||
    /screen/.test(text)
  )
    return "screened";
  if (/busy/.test(text)) return "busy";
  if (/no[-_ ]?answer|unanswered|did not pick|not picked/.test(text))
    return "no_answer";
  if (/unavailable|invalid|not in service|not reachable/.test(text))
    return "unavailable";
  if (/callback/.test(text)) return "callback_scheduled";
  if (/follow/.test(text)) return "manual_followup_required";
  if (/opt[_ -]?out|do not call/.test(text)) return "opted_out";
  if (/transfer/.test(text)) return "transferred";
  if (/failed|error|cancelled|canceled/.test(text)) return "failed";
  if (/completed|answered/.test(text)) return "answered_human";
  return "unknown";
}

function phoneFromCallOrRun(call = null, run = null) {
  const callMeta = metadataObject(call?.metadata || call?.call_metadata);
  const directRecipient = metadataObject(
    callMeta.directRecipient ||
      callMeta.direct_recipient ||
      callMeta.recipient ||
      callMeta.target,
  );
  const outboundCandidate = stringValue(
    run?.destination_phone,
    run?.target_phone,
    call?.destination_phone,
    call?.target_phone,
    call?.to,
    callMeta.destination_phone,
    callMeta.target_phone,
    callMeta.to,
    callMeta.to_phone,
    directRecipient.phone,
  );
  if (outboundCandidate) return cleanPhone(outboundCandidate);
  return cleanPhone(
    stringValue(
      call?.caller_phone,
      call?.from,
      callMeta.caller_phone,
      callMeta.from,
      callMeta.from_phone,
    ),
  );
}

function nameFromCallOrRun(call = null, run = null) {
  const callMeta = metadataObject(call?.metadata || call?.call_metadata);
  const directRecipient = metadataObject(
    callMeta.directRecipient ||
      callMeta.direct_recipient ||
      callMeta.recipient ||
      callMeta.target,
  );
  const value = stringValue(
    run?.target_name,
    call?.target_name,
    call?.recipient_name,
    call?.caller_name,
    callMeta.target_name,
    callMeta.recipient_name,
    callMeta.caller_name,
    directRecipient.name,
  );
  return value && !/^unknown caller$/i.test(value) ? value : "Rerun recipient";
}

function leadIdFromCallOrRun(call = null, run = null) {
  const callMeta = metadataObject(call?.metadata || call?.call_metadata);
  const id = stringValue(
    run?.lead_id,
    call?.lead_id,
    callMeta.lead_id,
    callMeta.leadId,
  );
  return isUuid(id) ? id : null;
}

function voiceAgentFromCallOrRun(call = null, run = null) {
  const callMeta = metadataObject(call?.metadata || call?.call_metadata);
  const id = stringValue(
    run?.voice_agent_id,
    call?.voice_agent_id,
    callMeta.voice_agent_id,
    callMeta.voiceAgentId,
  );
  return isUuid(id) ? id : null;
}

function scheduleStartParts(body = {}, timezone = "America/New_York") {
  const explicitDate = stringValue(
    body.startLocalDate,
    body.start_local_date,
    body.date,
  );
  const explicitTime = stringValue(body.startTime, body.start_time, body.time);
  if (explicitDate && explicitTime)
    return { date: explicitDate, time: explicitTime };
  const iso = stringValue(
    body.startAt,
    body.start_at,
    body.scheduledFor,
    body.scheduled_for,
  );
  const date = iso ? new Date(iso) : new Date(Date.now() + 5 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = String(parts.hour === "24" ? "00" : parts.hour).padStart(2, "0");
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

function buildCandidate(call = null, run = null) {
  const category = categoryFromCallOrRun(call, run);
  const phone = phoneFromCallOrRun(call, run);
  const leadId = leadIdFromCallOrRun(call, run);
  const voiceAgentId = voiceAgentFromCallOrRun(call, run);
  return {
    callId: call?.id || run?.call_record_id || null,
    runId: run?.id || null,
    sourceScheduleId: run?.schedule_id || null,
    leadId,
    voiceAgentId,
    phone,
    name: nameFromCallOrRun(call, run),
    category,
    status: call?.status || run?.status || "",
    tags: safeTags(call?.tags),
    eligible: isE164(phone) && isRerunEligibleCategory(category),
  };
}

function filterAndDedupeRerunCandidates(candidates, body = {}) {
  const includeProtected =
    body.includeProtected === true || body.include_protected === true;
  const eligibleOnly =
    body.eligibleOnly !== false && body.eligible_only !== false;
  const categories = normalizeRerunCategoryList(
    body.categories ||
      body.callCategories ||
      body.call_categories ||
      body.callCategory ||
      body.call_category,
  );
  const requestedTags = safeTags(body.tags || body.tag || []);
  const maxRecipients = Math.min(
    500,
    Math.max(1, Number(body.maxRecipients || body.max_recipients || 250)),
  );
  const seen = new Set();
  const result = [];
  for (const candidate of candidates || []) {
    const category = normalizeRerunCategory(candidate.category);
    if (!candidate.phone || !isE164(candidate.phone)) continue;
    if (categories.length && !categories.includes(category)) continue;
    if (
      eligibleOnly &&
      !isRerunEligibleCategory(category, { includeProtected })
    )
      continue;
    if (!includeProtected && RERUN_PROTECTED_CATEGORIES.has(category)) continue;
    if (
      requestedTags.length &&
      !requestedTags.some((tag) => candidate.tags.includes(tag))
    )
      continue;
    const key = candidate.leadId
      ? `lead:${candidate.leadId}`
      : `phone:${candidate.phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...candidate,
      category,
      eligible: isRerunEligibleCategory(category, { includeProtected }),
    });
    if (result.length >= maxRecipients) break;
  }
  return result;
}

async function loadCallsByIdsOrSids(
  db,
  organizationId,
  { callIds = [], callSids = [] } = {},
) {
  const byId = new Map();
  const bySid = new Map();
  const ids = [...new Set((callIds || []).filter(isUuid))];
  if (ids.length) {
    const { data, error } = await db
      .from("call_records")
      .select("*")
      .eq("organization_id", organizationId)
      .in("id", ids);
    if (error) throw error;
    for (const call of data || []) {
      byId.set(call.id, call);
      if (call.twilio_call_sid) bySid.set(call.twilio_call_sid, call);
      if (call.provider_call_id) bySid.set(call.provider_call_id, call);
    }
  }
  const sids = [...new Set((callSids || []).filter(Boolean))].filter(
    (sid) => !bySid.has(sid),
  );
  if (sids.length) {
    const { data, error } = await db
      .from("call_records")
      .select("*")
      .eq("organization_id", organizationId)
      .or(
        `twilio_call_sid.in.(${sids.join(",")}),provider_call_id.in.(${sids.join(",")})`,
      );
    if (!error) {
      for (const call of data || []) {
        byId.set(call.id, call);
        if (call.twilio_call_sid) bySid.set(call.twilio_call_sid, call);
        if (call.provider_call_id) bySid.set(call.provider_call_id, call);
      }
    }
  }
  return { byId, bySid };
}

async function loadRerunCandidates(db, organizationId, body = {}) {
  const sourceScheduleId = stringValue(
    body.scheduleId,
    body.schedule_id,
    body.campaignId,
    body.campaign_id,
  );
  if (sourceScheduleId && isUuid(sourceScheduleId)) {
    const [
      { data: schedule, error: scheduleError },
      { data: runs, error: runsError },
    ] = await Promise.all([
      db
        .from("lead_outreach_schedules")
        .select("*")
        .eq("id", sourceScheduleId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
      db
        .from("lead_outreach_runs")
        .select("*")
        .eq("schedule_id", sourceScheduleId)
        .eq("organization_id", organizationId)
        .order("scheduled_for", { ascending: false })
        .limit(1000),
    ]);
    if (scheduleError) throw scheduleError;
    if (runsError) throw runsError;
    if (!schedule) {
      const err = new Error("Source campaign was not found.");
      err.statusCode = 404;
      throw err;
    }
    const callIds = (runs || [])
      .map((run) => run.call_record_id)
      .filter(Boolean);
    const callSids = (runs || [])
      .map((run) => run.twilio_call_sid)
      .filter(Boolean);
    const { byId, bySid } = await loadCallsByIdsOrSids(db, organizationId, {
      callIds,
      callSids,
    });
    const candidates = (runs || []).map((run) => {
      const call =
        byId.get(run.call_record_id) || bySid.get(run.twilio_call_sid) || null;
      return buildCandidate(call, run);
    });
    return {
      sourceSchedule: schedule,
      rawCandidates: candidates,
      candidates: filterAndDedupeRerunCandidates(candidates, body),
    };
  }

  let q = db
    .from("call_records")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(
      Math.min(
        1000,
        Math.max(1, Number(body.scanLimit || body.scan_limit || 500)),
      ),
    );

  const callIds = normalizeArray(
    body.callIds || body.call_ids || body.callId || body.call_id,
  ).filter(isUuid);
  if (callIds.length) q = q.in("id", callIds);
  const voiceAgentId = stringValue(body.voiceAgentId, body.voice_agent_id);
  if (voiceAgentId && voiceAgentId !== "all")
    q = q.eq("voice_agent_id", voiceAgentId);
  const status = stringValue(body.status);
  if (status && status !== "all") q = q.eq("status", status);
  const tag = stringValue(body.tag);
  if (tag && tag !== "all") q = q.contains("tags", [tag.toLowerCase()]);
  const category = normalizeRerunCategory(
    stringValue(body.callCategory, body.call_category, body.category),
  );
  if (category && category !== "unknown" && category !== "all")
    q = q.eq("call_category", category);

  const { data: calls, error } = await q;
  if (error) throw error;
  const callRecordIds = (calls || []).map((call) => call.id).filter(Boolean);
  const callSids = (calls || [])
    .map((call) => call.twilio_call_sid || call.provider_call_id)
    .filter(Boolean);
  const runByCallId = new Map();
  const runBySid = new Map();
  if (callRecordIds.length) {
    const { data: runs } = await db
      .from("lead_outreach_runs")
      .select("*")
      .eq("organization_id", organizationId)
      .in("call_record_id", callRecordIds);
    for (const run of runs || []) {
      if (run.call_record_id) runByCallId.set(run.call_record_id, run);
      if (run.twilio_call_sid) runBySid.set(run.twilio_call_sid, run);
    }
  }
  if (callSids.length) {
    const { data: runs } = await db
      .from("lead_outreach_runs")
      .select("*")
      .eq("organization_id", organizationId)
      .in("twilio_call_sid", callSids);
    for (const run of runs || []) {
      if (run.call_record_id) runByCallId.set(run.call_record_id, run);
      if (run.twilio_call_sid) runBySid.set(run.twilio_call_sid, run);
    }
  }
  const candidates = (calls || []).map((call) =>
    buildCandidate(
      call,
      runByCallId.get(call.id) ||
        runBySid.get(call.twilio_call_sid) ||
        runBySid.get(call.provider_call_id) ||
        null,
    ),
  );
  return {
    sourceSchedule: null,
    rawCandidates: candidates,
    candidates: filterAndDedupeRerunCandidates(candidates, body),
  };
}

function summarizeRerunCandidates(rawCandidates = [], candidates = []) {
  const byCategory = {};
  const skippedByCategory = {};
  for (const candidate of rawCandidates) {
    const key = normalizeRerunCategory(candidate.category);
    byCategory[key] = (byCategory[key] || 0) + 1;
  }
  const selected = new Set(
    candidates.map(
      (candidate) => candidate.callId || candidate.runId || candidate.phone,
    ),
  );
  for (const candidate of rawCandidates) {
    const key = candidate.callId || candidate.runId || candidate.phone;
    if (selected.has(key)) continue;
    const category = normalizeRerunCategory(candidate.category);
    skippedByCategory[category] = (skippedByCategory[category] || 0) + 1;
  }
  return {
    totalScanned: rawCandidates.length,
    selectedCount: candidates.length,
    byCategory,
    skippedByCategory,
    eligibleCategories: [...RERUN_ELIGIBLE_CATEGORIES],
    protectedCategories: [...RERUN_PROTECTED_CATEGORIES],
  };
}

async function buildRerunSchedulePayload(
  db,
  organizationId,
  req,
  body = {},
  { sourceSchedule = null, candidates = [] } = {},
) {
  if (!candidates.length) {
    const err = new Error("No rerun-eligible recipients matched this filter.");
    err.statusCode = 400;
    err.code = "NO_RERUN_RECIPIENTS";
    throw err;
  }
  const candidateAgents = [
    ...new Set(candidates.map((item) => item.voiceAgentId).filter(Boolean)),
  ];
  const requestedAgentId = stringValue(
    body.voiceAgentId,
    body.voice_agent_id,
    sourceSchedule?.voice_agent_id,
  );
  const voiceAgentId =
    requestedAgentId ||
    (candidateAgents.length === 1 ? candidateAgents[0] : "");
  if (!voiceAgentId || !isUuid(voiceAgentId)) {
    const err = new Error(
      "Select one voice agent before creating a rerun campaign.",
    );
    err.statusCode = 400;
    err.code = "VOICE_AGENT_REQUIRED";
    throw err;
  }
  if (candidateAgents.length > 1 && !requestedAgentId && !sourceSchedule) {
    const err = new Error(
      "This filtered group contains multiple agents. Filter by one agent first.",
    );
    err.statusCode = 400;
    err.code = "MULTIPLE_AGENTS_SELECTED";
    throw err;
  }
  const agent = await ensureAgent(db, organizationId, voiceAgentId);
  if (!agent) {
    const err = new Error("Voice agent not found.");
    err.statusCode = 404;
    throw err;
  }

  const fromNumberId = stringValue(
    body.fromNumberId,
    body.from_number_id,
    sourceSchedule?.from_number_id,
  );
  const fromNumber = cleanPhone(
    stringValue(body.fromNumber, body.from_number, sourceSchedule?.from_number),
  );
  const number = await ensureFromNumber(db, organizationId, {
    fromNumberId,
    fromNumber,
    voiceAgentId,
  });
  if (!number) {
    const err = new Error(
      "A configured from-number is required before creating a rerun campaign.",
    );
    err.statusCode = 404;
    err.code = "FROM_NUMBER_NOT_FOUND";
    throw err;
  }

  const timezone =
    stringValue(
      body.timezone,
      sourceSchedule?.timezone,
      req.organization?.timezone,
      "America/New_York",
    ) || "America/New_York";
  const start = scheduleStartParts(body, timezone);
  const leadIds = [
    ...new Set(candidates.map((item) => item.leadId).filter(isUuid)),
  ];
  const loadedLeads = await loadLeads(db, organizationId, leadIds);
  const loadedLeadIds = new Set(loadedLeads.map((lead) => lead.id));
  const directRecipients = candidates
    .filter(
      (candidate) => !candidate.leadId || !loadedLeadIds.has(candidate.leadId),
    )
    .map((candidate) => ({
      name: candidate.name || "Rerun recipient",
      phone: candidate.phone,
      metadata: {
        rerun: true,
        sourceCallId: candidate.callId,
        sourceRunId: candidate.runId,
        sourceScheduleId:
          candidate.sourceScheduleId || sourceSchedule?.id || null,
        previousCategory: candidate.category,
      },
    }));
  const scheduleType = "one_time";
  const scheduleBody = {
    scheduleType,
    startLocalDate: start.date,
    startTime: start.time,
    timezone,
  };
  const generation = buildOccurrenceGeneration(scheduleBody, {
    timezone,
    scheduleType,
    leads: loadedLeads,
    directRecipients,
  });
  const callPurpose = stringValue(
    body.callPurpose,
    body.call_purpose,
    sourceSchedule?.call_purpose,
    "Follow up with recipients who were not fully reached in the previous campaign.",
  );
  const customInstructions = stringValue(
    body.customInstructions,
    body.custom_instructions,
    sourceSchedule?.custom_instructions,
  );
  const name = stringValue(
    body.name,
    sourceSchedule?.name ? `${sourceSchedule.name} rerun` : "Rerun campaign",
  );
  return {
    scheduleRow: {
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
      target_type:
        directRecipients.length && leadIds.length
          ? "lead_list"
          : directRecipients.length
            ? "direct_numbers"
            : leadIds.length === 1
              ? "lead"
              : "lead_list",
      name,
      call_purpose: callPurpose,
      custom_instructions: customInstructions,
      schedule_type: scheduleType,
      start_at: new Date(generation.firstRunAt).toISOString(),
      timezone,
      days_of_week: [],
      times_per_day: [start.time],
      max_calls_per_day: Math.max(
        1,
        Number(
          body.maxCallsPerDay ||
            body.max_calls_per_day ||
            sourceSchedule?.max_calls_per_day ||
            100,
        ),
      ),
      max_attempts_per_lead: Math.max(
        1,
        Number(body.maxAttemptsPerLead || body.max_attempts_per_lead || 1),
      ),
      retry_delay_minutes: Math.max(
        1,
        Number(
          body.retryDelayMinutes ||
            body.retry_delay_minutes ||
            sourceSchedule?.retry_delay_minutes ||
            60,
        ),
      ),
      voicemail_behavior: stringValue(
        body.voicemailBehavior,
        body.voicemail_behavior,
        sourceSchedule?.voicemail_behavior,
        "hangup",
      ),
      status: "active",
      is_active: true,
      windows: [{ weekdays: [], date: start.date, time: start.time }],
      extra_context: customInstructions || callPurpose,
      progress: {},
      metadata: {
        createdBy: req.user?.id || null,
        scheduleVersion: 1,
        rerun: true,
        rerunOfScheduleId: sourceSchedule?.id || null,
        rerunFilter: {
          callIds: normalizeArray(body.callIds || body.call_ids || []),
          scheduleId: stringValue(
            body.scheduleId,
            body.schedule_id,
            body.campaignId,
            body.campaign_id,
            sourceSchedule?.id,
          ),
          voiceAgentId,
          categories: normalizeRerunCategoryList(
            body.categories ||
              body.callCategories ||
              body.callCategory ||
              body.call_category,
          ),
          tag: stringValue(body.tag),
          eligibleOnly:
            body.eligibleOnly !== false && body.eligible_only !== false,
        },
        rerunSummary: summarizeRerunCandidates(candidates, candidates),
        sourceRecipients: candidates.map((candidate) => ({
          callId: candidate.callId,
          runId: candidate.runId,
          leadId: candidate.leadId,
          phone: candidate.phone,
          name: candidate.name,
          previousCategory: candidate.category,
        })),
        scheduleConfig: scheduleConfigFromBody(scheduleBody, scheduleType),
        recurrenceRule: {
          type: generation.scheduleType,
          timezone: generation.timezone,
          totalRuns: generation.totalRuns,
          firstRunAt: generation.firstRunAt,
          lastRunAt: generation.lastRunAt,
          preview: generation.preview,
        },
        generation: {
          totalRuns: generation.totalRuns,
          firstRunAt: generation.firstRunAt,
          lastRunAt: generation.lastRunAt,
        },
      },
    },
    generation,
    leadIds,
    directRecipients,
    candidates,
  };
}

async function previewRerunCampaign(req, res, sourceScheduleId = null) {
  const db = getSupabase();
  const body = { ...(req.body || {}) };
  if (sourceScheduleId) body.scheduleId = sourceScheduleId;
  const loaded = await loadRerunCandidates(db, req.orgId, body);
  const summary = summarizeRerunCandidates(
    loaded.rawCandidates,
    loaded.candidates,
  );
  let creationPreview = null;
  if (loaded.candidates.length) {
    try {
      const payload = await buildRerunSchedulePayload(
        db,
        req.orgId,
        req,
        body,
        loaded,
      );
      creationPreview = {
        name: payload.scheduleRow.name,
        voiceAgentId: payload.scheduleRow.voice_agent_id,
        fromNumber: payload.scheduleRow.from_number,
        startAt: payload.scheduleRow.start_at,
        timezone: payload.scheduleRow.timezone,
        recipientCount: loaded.candidates.length,
        generatedRuns: payload.generation.totalRuns,
        preview: payload.generation.preview,
      };
    } catch (error) {
      creationPreview = {
        error: error.message || "Could not build rerun preview.",
      };
    }
  }
  res.json({
    success: true,
    summary,
    candidates: loaded.candidates,
    preview: creationPreview,
  });
}

async function createRerunCampaign(req, res, sourceScheduleId = null) {
  const db = getSupabase();
  const body = { ...(req.body || {}) };
  if (sourceScheduleId) body.scheduleId = sourceScheduleId;
  const loaded = await loadRerunCandidates(db, req.orgId, body);
  const payload = await buildRerunSchedulePayload(
    db,
    req.orgId,
    req,
    body,
    loaded,
  );
  const { data: schedule, error } = await db
    .from("lead_outreach_schedules")
    .insert(payload.scheduleRow)
    .select()
    .single();
  if (error) throw error;
  const rows = buildRunRowsFromOccurrences({
    organizationId: req.orgId,
    schedule,
    occurrences: payload.generation.occurrences,
  }).map((row) => {
    const matching = payload.candidates.find((candidate) =>
      candidate.leadId && row.lead_id
        ? candidate.leadId === row.lead_id
        : candidate.phone === row.destination_phone,
    );
    return {
      ...row,
      attempt_number: 1,
      outcome_metadata: {
        ...(row.outcome_metadata || {}),
        rerun: true,
        sourceScheduleId:
          matching?.sourceScheduleId || loaded.sourceSchedule?.id || null,
        sourceCallId: matching?.callId || null,
        sourceRunId: matching?.runId || null,
        previousCategory: matching?.category || null,
      },
    };
  });
  const generated = await insertRunRows(db, req.orgId, schedule, rows);
  res.status(201).json({
    success: true,
    schedule: serializeSchedule(schedule),
    generatedRuns: generated.inserted,
    candidates: payload.candidates,
    summary: summarizeRerunCandidates(loaded.rawCandidates, loaded.candidates),
    preview: {
      firstRunAt: payload.generation.firstRunAt,
      lastRunAt: payload.generation.lastRunAt,
      totalRuns: payload.generation.totalRuns,
    },
  });
}

function maxGeneratedRuns() {
  const parsed = parseInt(
    String(process.env.MAX_GENERATED_RUNS_PER_SCHEDULE || "1000"),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

function minScheduleLeadSeconds() {
  const parsed = parseInt(
    String(process.env.SCHEDULE_MIN_LEAD_SECONDS || "60"),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

function recipientInputsFromLoaded({ leads = [], directRecipients = [] } = {}) {
  const recipients = [];
  for (const lead of leads || []) {
    const destination = cleanPhone(lead.phone || lead.mobile || "");
    if (!isE164(destination)) continue;
    recipients.push({
      type: "lead",
      lead,
      phone: destination,
      name: lead.name || "Unknown",
    });
  }
  for (const recipient of directRecipients || []) {
    recipients.push({
      type: "direct_number",
      directRecipient: recipient,
      phone: recipient.phone,
      name: recipient.name || "Direct recipient",
    });
  }
  return recipients;
}

function scheduleConfigFromBody(body = {}, scheduleType) {
  return {
    scheduleType,
    startLocalDate:
      body.startLocalDate ||
      body.start_local_date ||
      body.localDate ||
      body.date ||
      null,
    startTime:
      body.startTime || body.start_time || body.localTime || body.time || null,
    startTimes: body.startTimes || body.start_times || null,
    timezone: body.timezone || null,
    batchMode: body.batchMode || body.batch_mode || null,
    repeat: body.repeat || null,
    monthEndBehavior: body.monthEndBehavior || body.month_end_behavior || null,
    scheduleConfig: body.scheduleConfig || body.schedule_config || null,
  };
}

function buildOccurrenceGeneration(
  body,
  { timezone, scheduleType, leads, directRecipients } = {},
) {
  return generateScheduleOccurrences({
    ...body,
    scheduleType,
    timezone,
    recipients: recipientInputsFromLoaded({ leads, directRecipients }),
    maxGeneratedRuns: maxGeneratedRuns(),
    minLeadSeconds: minScheduleLeadSeconds(),
  });
}

function buildRunRowsFromOccurrences({
  organizationId,
  schedule,
  occurrences,
}) {
  const rows = [];
  for (const occurrence of occurrences || []) {
    const recipient = occurrence.recipient || {};
    const isLead = recipient.type === "lead" && recipient.lead?.id;
    const phone = cleanPhone(recipient.phone || "");
    if (!isE164(phone)) continue;
    rows.push({
      organization_id: organizationId,
      schedule_id: schedule.id,
      lead_id: isLead ? recipient.lead.id : null,
      voice_agent_id: schedule.voice_agent_id,
      from_number_id: schedule.from_number_id || null,
      destination_phone: phone,
      target_phone: phone,
      target_name:
        recipient.name ||
        (isLead ? recipient.lead.name : "Direct recipient") ||
        "Recipient",
      run_key: `${isLead ? "lead:" + recipient.lead.id : "direct:" + phone}:${occurrence.scheduledForUtc}:${occurrence.occurrenceIndex || 1}`,
      scheduled_for: occurrence.scheduledForUtc,
      status: "queued",
      attempt_number: 1,
      outcome_metadata: {
        scheduleType: schedule.schedule_type,
        callPurpose: schedule.call_purpose || "",
        targetType: isLead ? "lead" : "direct_number",
        localDate: occurrence.localDate,
        localTime: occurrence.localTime,
        timezone: occurrence.timezone,
        occurrenceIndex: occurrence.occurrenceIndex || null,
        ...(isLead
          ? {}
          : {
              directRecipient: recipient.directRecipient || {
                name: recipient.name,
                phone,
              },
            }),
      },
    });
  }
  return rows;
}

async function insertRunRows(db, organizationId, schedule, rows) {
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

  const inserted = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
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

  if (schedule.metadata?.scheduleConfig || schedule.metadata?.recurrenceRule) {
    let generation = null;
    try {
      generation = generateScheduleOccurrences({
        ...(schedule.metadata?.scheduleConfig || {}),
        scheduleType: schedule.schedule_type,
        timezone: schedule.timezone,
        recipients: recipientInputsFromLoaded({ leads, directRecipients }),
        maxGeneratedRuns: maxGeneratedRuns(),
        minLeadSeconds: 0,
      });
    } catch (error) {
      if (!(error instanceof ScheduleValidationError)) throw error;
      generation = null;
    }
    if (generation) {
      if (replacePending) {
        await db
          .from("lead_outreach_runs")
          .delete()
          .eq("organization_id", organizationId)
          .eq("schedule_id", schedule.id)
          .eq("status", "queued");
      }
      const rows = buildRunRowsFromOccurrences({
        organizationId,
        schedule,
        occurrences: generation.occurrences,
      });
      const { data: existingRows, error: existingError } = await db
        .from("lead_outreach_runs")
        .select("run_key")
        .eq("organization_id", organizationId)
        .eq("schedule_id", schedule.id);
      if (existingError) throw existingError;
      const existingKeys = new Set(
        (existingRows || []).map((row) => row.run_key).filter(Boolean),
      );
      return insertRunRows(
        db,
        organizationId,
        schedule,
        rows.filter((row) => !row.run_key || !existingKeys.has(row.run_key)),
      );
    }
  }

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
  "/rerun-preview",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => previewRerunCampaign(req, res)),
);

router.post(
  "/rerun",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => createRerunCampaign(req, res)),
);

router.post(
  "/schedules/:id/rerun-preview",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) =>
    previewRerunCampaign(req, res, req.params.id),
  ),
);

router.post(
  "/schedules/:id/rerun",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) =>
    createRerunCampaign(req, res, req.params.id),
  ),
);

router.post(
  "/schedules/preview",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const organizationId = req.orgId;
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
    if (!leadIds.length && !directRecipients.length) {
      return res.status(400).json({
        error: {
          code: "RECIPIENTS_REQUIRED",
          message:
            "Provide at least one leadId or one direct recipient phone number.",
        },
      });
    }
    const timezone =
      String(
        body.timezone || req.organization?.timezone || "America/New_York",
      ).trim() || "America/New_York";
    const scheduleType = normalizeScheduleType(
      body.scheduleType || body.schedule_type,
    );
    const leads = await loadLeads(db, organizationId, leadIds);
    if (leads.length !== leadIds.length) {
      return res.status(400).json({
        error: {
          code: "INVALID_LEADS",
          message: "One or more leads were not found for this tenant.",
        },
      });
    }
    let generation;
    try {
      generation = buildOccurrenceGeneration(body, {
        timezone,
        scheduleType,
        leads,
        directRecipients,
      });
    } catch (error) {
      if (error instanceof ScheduleValidationError)
        return scheduleValidationResponse(res, error);
      throw error;
    }
    res.json({
      success: true,
      timezone: generation.timezone,
      scheduleType: generation.scheduleType,
      recipientCount: generation.recipientCount,
      totalRuns: generation.totalRuns,
      preview: generation.preview,
      warnings: generation.warnings || [],
    });
  }),
);

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
    let startAt = resolveStartAt(body, timezone);
    let timesPerDay = normalizeTimesPerDay(
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

    let generation;
    try {
      generation = buildOccurrenceGeneration(body, {
        timezone,
        scheduleType,
        leads,
        directRecipients,
      });
    } catch (error) {
      if (error instanceof ScheduleValidationError)
        return scheduleValidationResponse(res, error);
      throw error;
    }
    startAt = generation.firstRunAt;
    timesPerDay = [
      ...new Set(
        (generation.occurrences || [])
          .map((item) => item.localTime)
          .filter(Boolean),
      ),
    ].sort();

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
        scheduleConfig: scheduleConfigFromBody(body, scheduleType),
        recurrenceRule: {
          type: generation.scheduleType,
          timezone: generation.timezone,
          totalRuns: generation.totalRuns,
          firstRunAt: generation.firstRunAt,
          lastRunAt: generation.lastRunAt,
          preview: generation.preview,
        },
        generation: {
          totalRuns: generation.totalRuns,
          firstRunAt: generation.firstRunAt,
          lastRunAt: generation.lastRunAt,
        },
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

    const generated = await insertRunRows(
      db,
      organizationId,
      schedule,
      buildRunRowsFromOccurrences({
        organizationId,
        schedule,
        occurrences: generation.occurrences,
      }),
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
        : generation.warnings?.[0] || null;
    res.status(201).json({
      success: true,
      schedule: serializeSchedule(schedule),
      generatedRuns: generated.inserted,
      warning,
      preview: {
        firstRunAt: generation.firstRunAt,
        lastRunAt: generation.lastRunAt,
        totalRuns: generation.totalRuns,
      },
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
    else q = q.neq("status", "deleted");
    if (req.query.agentId)
      q = q.eq("voice_agent_id", String(req.query.agentId));
    const { data, error, count } = await q;
    if (error) throw error;
    const schedules = data || [];
    const scheduleIds = schedules
      .map((schedule) => schedule.id)
      .filter(Boolean);
    let runsBySchedule = new Map();
    if (scheduleIds.length) {
      const { data: runs, error: runsError } = await db
        .from("lead_outreach_runs")
        .select("schedule_id,status")
        .eq("organization_id", req.orgId)
        .in("schedule_id", scheduleIds);
      if (runsError) throw runsError;
      for (const run of runs || []) {
        const list = runsBySchedule.get(run.schedule_id) || [];
        list.push(run);
        runsBySchedule.set(run.schedule_id, list);
      }
    }
    const serialized = schedules.map((schedule) => {
      const runs = runsBySchedule.get(schedule.id) || [];
      const derivedStatus = deriveScheduleStatusFromRuns(schedule, runs);
      const progress = buildProgressFromRuns(runs);
      if (derivedStatus !== schedule.status && derivedStatus === "completed") {
        db.from("lead_outreach_schedules")
          .update({
            status: "completed",
            is_active: false,
            progress,
            updated_at: nowIso(),
          })
          .eq("id", schedule.id)
          .eq("organization_id", req.orgId)
          .then(({ error: updateError }) => {
            if (updateError)
              console.warn(
                "[outreach] schedule status update failed",
                updateError.message,
              );
          });
      }
      return serializeSchedule({
        ...schedule,
        status: derivedStatus,
        progress: { ...(schedule.progress || {}), ...progress },
      });
    });
    res.json({
      success: true,
      schedules: serialized,
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

async function deleteScheduleForOrg(db, organizationId, scheduleId) {
  const { data: schedule, error: findError } = await db
    .from("lead_outreach_schedules")
    .select("id")
    .eq("id", scheduleId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (findError) throw findError;
  if (!schedule) return { found: false, hardDeleted: false };

  const { error: runsError } = await db
    .from("lead_outreach_runs")
    .delete()
    .eq("schedule_id", scheduleId)
    .eq("organization_id", organizationId);
  if (runsError) throw runsError;

  const { error: deleteError } = await db
    .from("lead_outreach_schedules")
    .delete()
    .eq("id", scheduleId)
    .eq("organization_id", organizationId);

  if (!deleteError) return { found: true, hardDeleted: true };

  console.warn("[outreach] hard delete failed; marking schedule deleted", {
    scheduleId,
    organizationId,
    error: deleteError.message,
  });

  const { error: softDeleteError } = await db
    .from("lead_outreach_schedules")
    .update({
      status: "deleted",
      is_active: false,
      updated_at: nowIso(),
      metadata: { deletedAt: nowIso(), hardDeleteError: deleteError.message },
    })
    .eq("id", scheduleId)
    .eq("organization_id", organizationId);
  if (softDeleteError) throw softDeleteError;

  return { found: true, hardDeleted: false };
}

router.delete(
  "/schedules/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const scheduleId = req.params.id;
    const result = await deleteScheduleForOrg(db, req.orgId, scheduleId);
    if (!result.found) {
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    }
    res.json({
      success: true,
      deleted: true,
      scheduleId,
      hardDeleted: result.hardDeleted,
    });
  }),
);

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
    else q = q.neq("status", "deleted");
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
    else q = q.neq("status", "deleted");
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
