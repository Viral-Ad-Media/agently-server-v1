"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateCallSummary } = require("../../lib/openai");
const { serializeCall, serializeLead } = require("../../lib/serializers");

const router = express.Router();

// ── POST /api/calls/simulate ─────────────────────────────────
router.post(
  "/simulate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      transcript,
      duration,
      outcome,
      callerName,
      callerPhone,
      lead: leadPayload,
    } = req.body;

    if (!transcript) {
      return res
        .status(400)
        .json({ error: { message: "Transcript is required." } });
    }

    const db = getSupabase();
    const orgId = req.orgId;

    // Generate AI summary
    let summary = "Call completed successfully.";
    try {
      summary = await generateCallSummary(transcript, outcome);
    } catch (e) {
      console.warn("Summary generation failed:", e.message);
    }

    // Normalize transcript to array format
    let transcriptArray = [];
    if (typeof transcript === "string") {
      transcriptArray = transcript
        .split("\n")
        .map((line) => {
          const colonIdx = line.indexOf(":");
          if (colonIdx > -1) {
            return {
              speaker: line.slice(0, colonIdx).trim(),
              text: line.slice(colonIdx + 1).trim(),
            };
          }
          return { speaker: "Unknown", text: line.trim() };
        })
        .filter((l) => l.text);
    } else if (Array.isArray(transcript)) {
      transcriptArray = transcript;
    }

    // Determine final outcome
    const validOutcomes = [
      "Lead Captured",
      "Appointment Booked",
      "FAQ Answered",
      "Escalated",
      "Voicemail",
    ];
    const finalOutcome = validOutcomes.includes(outcome)
      ? outcome
      : "Lead Captured";

    // Create lead if payload provided
    let createdLead = null;
    if (leadPayload && leadPayload.name) {
      const { data: lead } = await db
        .from("leads")
        .insert({
          organization_id: orgId,
          name: leadPayload.name || callerName || "Unknown",
          phone: leadPayload.phone || callerPhone || "",
          email: leadPayload.email || "",
          reason: leadPayload.reason || "",
          status: "new",
          source: "call",
        })
        .select()
        .single();

      createdLead = lead;
    }

    // Create call record
    const { data: call, error } = await db
      .from("call_records")
      .insert({
        organization_id: orgId,
        voice_agent_id: req.organization.active_voice_agent_id || null,
        caller_name: callerName || "Unknown Caller",
        caller_phone: callerPhone || "",
        duration: Math.max(duration || 60, 1),
        outcome: finalOutcome,
        summary,
        transcript: transcriptArray,
        lead_id: createdLead?.id || null,
        timestamp: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error("Call record creation error:", error);
      return res
        .status(500)
        .json({ error: { message: "Failed to save call record." } });
    }

    // Update usage counters
    const durationMinutes = Math.ceil((duration || 60) / 60);
    await db
      .from("organizations")
      .update({
        usage_calls: (req.organization.usage_calls || 0) + 1,
        usage_minutes: (req.organization.usage_minutes || 0) + durationMinutes,
      })
      .eq("id", orgId);

    res.json({
      call: serializeCall(call),
      lead: createdLead ? serializeLead(createdLead) : null,
    });
  }),
);

function durationSeconds(row = {}) {
  const direct = Number(
    row.duration || row.duration_seconds || row.recording_duration || 0,
  );
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const detail = Number(
    row.metadata?.call_end_details?.duration || row.metadata?.duration || 0,
  );
  if (Number.isFinite(detail) && detail > 0) return Math.round(detail);
  const start = row.started_at || row.answered_at || null;
  const end = row.ended_at || row.completed_at || null;
  if (start && end) {
    const seconds = Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 1000,
    );
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return 0;
}

function derivedStatus(row = {}) {
  const raw = String(row.status || "").toLowerCase();
  const outcome = String(row.outcome || "").toLowerCase();
  if (
    ["failed", "busy", "no-answer", "no_answer", "canceled", "cancelled"].some(
      (v) => raw.includes(v) || outcome.includes(v),
    )
  ) {
    return raw.includes("cancel") ? "cancelled" : "failed";
  }
  if (
    row.completed_at ||
    row.ended_at ||
    durationSeconds(row) > 0 ||
    raw === "completed"
  )
    return "completed";
  return raw || "queued";
}

function derivedDirection(row = {}, outboundRunIds = new Set()) {
  const explicit = String(row.direction || "").toLowerCase();
  if (explicit === "outbound" || explicit === "inbound") {
    if (explicit === "inbound" && outboundRunIds.has(row.id)) return "outbound";
    const metadataText = JSON.stringify(row.metadata || {}).toLowerCase();
    if (
      explicit === "inbound" &&
      (metadataText.includes("outbound") ||
        metadataText.includes("callpurpose") ||
        metadataText.includes("schedule"))
    )
      return "outbound";
    return explicit;
  }
  const metadataText = JSON.stringify(row.metadata || {}).toLowerCase();
  if (
    outboundRunIds.has(row.id) ||
    metadataText.includes("outbound") ||
    metadataText.includes("callpurpose") ||
    metadataText.includes("schedule")
  )
    return "outbound";
  return "inbound";
}

function serializeCallForLogs(row, outboundRunIds = new Set()) {
  const duration = durationSeconds(row);
  const direction = derivedDirection(row, outboundRunIds);
  const status = derivedStatus(row);
  const isOutbound = direction === "outbound";
  const metadata = row.metadata || {};
  const callerName =
    row.caller_name ||
    metadata.targetName ||
    metadata.recipient?.name ||
    metadata.directRecipient?.name ||
    "Unknown Caller";
  const callerPhone =
    row.caller_phone ||
    metadata.targetPhone ||
    metadata.toPhone ||
    metadata.destination_phone ||
    metadata.recipient?.phone ||
    "";
  return {
    id: row.id,
    organization_id: row.organization_id,
    voice_agent_id: row.voice_agent_id,
    callerName,
    caller_name: callerName,
    callerPhone,
    caller_phone: callerPhone,
    direction,
    status,
    duration,
    duration_seconds: duration,
    timestamp: row.timestamp || row.started_at || row.created_at,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    ended_at: row.ended_at,
    outcome: row.outcome || (status === "completed" ? "Completed" : status),
    summary: row.summary || "",
    transcript: row.transcript || [],
    recording_available: Boolean(
      row.recording_available ||
      row.recording_public_url ||
      row.recording_storage_path ||
      row.recording_url,
    ),
    recordingAvailable: Boolean(
      row.recording_available ||
      row.recording_public_url ||
      row.recording_storage_path ||
      row.recording_url,
    ),
    recording_url: row.recording_public_url || row.recording_url || "",
    recordingUrl: row.recording_public_url || row.recording_url || "",
    from: isOutbound
      ? metadata.fromNumber ||
        metadata.twilioFrom ||
        row.twilio_phone_number ||
        ""
      : metadata.twilioFrom || row.caller_phone || "",
    to: isOutbound
      ? metadata.toPhone || metadata.destination_phone || row.caller_phone || ""
      : metadata.twilioTo || "",
  };
}

function redactCallMetadata(metadata = {}) {
  const safe =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...metadata }
      : {};
  if (safe.recording?.recording_url) delete safe.recording.recording_url;
  if (safe.recording?.raw) safe.recording.raw = "[redacted]";
  return safe;
}

// ── GET /api/calls/:id ──────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const { data: call, error } = await db
      .from("call_records")
      .select("*")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error || !call) {
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    }

    let lead = null;
    const leadId =
      call.metadata?.inbound_call_message?.lead_id ||
      call.lead_id ||
      call.metadata?.leadId ||
      null;
    if (leadId) {
      const { data: leadRow } = await db
        .from("leads")
        .select(
          "id, name, phone, email, reason, status, source, created_at, voice_agent_id",
        )
        .eq("id", leadId)
        .eq("organization_id", req.orgId)
        .maybeSingle();
      lead = leadRow || null;
    }

    res.json({
      call: {
        id: call.id,
        organization_id: call.organization_id,
        voice_agent_id: call.voice_agent_id,
        direction: derivedDirection(call),
        status: derivedStatus(call),
        from:
          call.metadata?.fromNumber ||
          call.metadata?.twilioFrom ||
          call.caller_phone ||
          "",
        to: call.metadata?.toPhone || call.metadata?.twilioTo || "",
        duration: durationSeconds(call),
        summary: call.summary || "",
        transcript: call.transcript || [],
        recording_available: Boolean(call.recording_available),
        recording_status: call.recording_status || null,
        recording_sid: call.recording_sid || null,
        recording_storage_provider: call.recording_storage_provider || null,
        recording_storage_path: call.recording_storage_path || null,
        metadata: redactCallMetadata({
          voicemail_detected: call.metadata?.voicemail_detected,
          answered_by: call.metadata?.answered_by,
          machine_detection_result: call.metadata?.machine_detection_result,
          hangup_reason:
            call.metadata?.hangup_reason ||
            call.metadata?.call_end_details?.reason,
        }),
        lead,
      },
    });
  }),
);

// ── GET /api/calls/:id/recording ────────────────────────────
router.get(
  "/:id/recording",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const { data: call, error } = await db
      .from("call_records")
      .select(
        "id, organization_id, recording_available, recording_status, recording_storage_provider, recording_storage_path, recording_mime_type",
      )
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error || !call)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    if (!call.recording_available || !call.recording_storage_path) {
      return res
        .status(404)
        .json({ error: { message: "Recording is not available yet." } });
    }
    const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || "call-recordings";
    const expiresIn = Number(
      process.env.RECORDING_SIGNED_URL_TTL_SECONDS || 300,
    );
    const { data, error: signedError } = await db.storage
      .from(bucket)
      .createSignedUrl(call.recording_storage_path, expiresIn);
    if (signedError || !data?.signedUrl) {
      return res.status(500).json({
        error: { message: "Failed to create recording playback URL." },
      });
    }
    return res.json({
      recording: {
        call_id: call.id,
        recording_status: call.recording_status,
        mime_type: call.recording_mime_type || "audio/mpeg",
        expires_in: expiresIn,
        signed_url: data.signedUrl,
      },
    });
  }),
);

// ── GET /api/calls/:id/report ────────────────────────────────
router.get(
  "/:id/report",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: call, error } = await db
      .from("call_records")
      .select("*")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (error || !call) {
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    }

    const transcriptLines = (call.transcript || [])
      .map((l) => `${l.speaker}: ${l.text}`)
      .join("\n");

    const report = `AGENTLY CALL REPORT
====================
Call ID:      ${call.id}
Date:         ${new Date(call.timestamp || call.created_at).toLocaleString()}
Caller:       ${call.caller_name || "Unknown"}
Phone:        ${call.caller_phone || "N/A"}
Duration:     ${Math.floor((call.duration || 0) / 60)}m ${(call.duration || 0) % 60}s
Outcome:      ${call.outcome || "Unknown"}

SUMMARY
-------
${call.summary || "No summary available."}

TRANSCRIPT
----------
${transcriptLines || "No transcript available."}
`;

    res.setHeader("Content-Type", "text/plain");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${id}-report.txt"`,
    );
    res.send(report);
  }),
);

// ── GET /api/calls ──────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const page = Math.max(1, Number(req.query.page || 1));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    let query = db
      .from("call_records")
      .select("*", { count: "exact" })
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (req.query.status) query = query.eq("status", String(req.query.status));
    const { data, error, count } = await query;
    if (error) throw error;

    const callIds = (data || []).map((row) => row.id).filter(Boolean);
    let outboundRunIds = new Set();
    if (callIds.length) {
      const { data: runs, error: runsError } = await db
        .from("lead_outreach_runs")
        .select("call_record_id")
        .eq("organization_id", req.orgId)
        .in("call_record_id", callIds);
      if (!runsError)
        outboundRunIds = new Set(
          (runs || []).map((run) => run.call_record_id).filter(Boolean),
        );
    }

    let calls = (data || []).map((row) =>
      serializeCallForLogs(row, outboundRunIds),
    );
    if (req.query.direction) {
      const requestedDirection = String(req.query.direction).toLowerCase();
      calls = calls.filter((call) => call.direction === requestedDirection);
    }

    const { data: metricRows, error: metricError } = await db
      .from("call_records")
      .select(
        "id,status,outcome,duration,recording_duration,started_at,answered_at,ended_at,completed_at,metadata",
      )
      .eq("organization_id", req.orgId)
      .limit(1000);
    if (metricError) throw metricError;
    const metrics = (metricRows || []).reduce(
      (acc, row) => {
        const status = derivedStatus(row);
        const duration = durationSeconds(row);
        acc.totalCalls += 1;
        if (status === "completed") acc.completed += 1;
        if (status === "failed" || status === "cancelled") acc.failed += 1;
        acc.durationSum += duration;
        return acc;
      },
      { totalCalls: 0, completed: 0, failed: 0, durationSum: 0 },
    );
    const avgDuration = metrics.totalCalls
      ? Math.round(metrics.durationSum / metrics.totalCalls)
      : 0;

    res.json({
      success: true,
      calls,
      page,
      limit,
      total: count || 0,
      metrics: {
        totalCalls: metrics.totalCalls,
        completed: metrics.completed,
        failed: metrics.failed,
        avgDuration,
      },
    });
  }),
);

// ── GET /api/calls/:id/messages ─────────────────────────────
router.get(
  "/:id/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: call, error } = await db
      .from("call_records")
      .select("id,transcript")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error || !call)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    res.json({
      success: true,
      callId: call.id,
      messages: call.transcript || [],
    });
  }),
);

// ── GET /api/calls/:id/transcript ───────────────────────────
router.get(
  "/:id/transcript",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: call, error } = await db
      .from("call_records")
      .select("id,transcript,summary,outcome")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error || !call)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    res.json({
      success: true,
      callId: call.id,
      transcript: call.transcript || [],
      summary: call.summary || "",
      outcome: call.outcome || "",
    });
  }),
);

// ── POST /api/calls/:id/summarize ───────────────────────────
router.post(
  "/:id/summarize",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: call, error } = await db
      .from("call_records")
      .select("id,transcript,outcome")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error || !call)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    const transcriptText = (call.transcript || [])
      .map(
        (l) =>
          `${l.speaker || l.role || "speaker"}: ${l.text || l.transcript || ""}`,
      )
      .join("\n");
    const summary = await generateCallSummary(
      transcriptText,
      call.outcome || "completed",
    );
    await db
      .from("call_records")
      .update({ summary, updated_at: new Date().toISOString() })
      .eq("id", call.id)
      .eq("organization_id", req.orgId);
    res.json({ success: true, callId: call.id, summary });
  }),
);

// ── GET /api/calls/:id/unanswered-questions ─────────────────
router.get(
  "/:id/unanswered-questions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: call, error: callError } = await db
      .from("call_records")
      .select("id")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (callError || !call)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    const { data, error } = await db
      .from("unanswered_questions")
      .select("*")
      .eq("organization_id", req.orgId)
      .eq("call_record_id", call.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({
      success: true,
      callId: call.id,
      unansweredQuestions: data || [],
    });
  }),
);

// ── POST /api/calls/:id/end ─────────────────────────────────
router.post(
  "/:id/end",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("call_records")
      .update({
        status: "completed",
        ended_at: new Date().toISOString(),
        end_reason: req.body?.reason || "ended_by_user",
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (error || !data)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    res.json({ success: true, call: serializeCall(data) });
  }),
);

// ── POST /api/calls/:id/transfer ────────────────────────────
router.post(
  "/:id/transfer",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const transferNumber = String(
      req.body?.to || req.body?.number || "",
    ).trim();
    if (!transferNumber)
      return res
        .status(400)
        .json({ error: { message: "Transfer number is required." } });
    const { data, error } = await db
      .from("call_records")
      .update({
        outcome: "Escalated",
        end_reason: "transfer_requested",
        metadata: { transferRequested: true, transferNumber },
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (error || !data)
      return res
        .status(404)
        .json({ error: { message: "Call record not found." } });
    res.json({
      success: true,
      message:
        "Transfer request recorded. Active-call transfer is handled by the websocket/Twilio relay when available.",
      call: serializeCall(data),
    });
  }),
);

module.exports = router;
