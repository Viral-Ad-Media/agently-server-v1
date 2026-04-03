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

module.exports = router;
