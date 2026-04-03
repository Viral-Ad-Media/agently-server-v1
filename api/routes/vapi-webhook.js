"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const {
  parseWebhookEvent,
  determineOutcome,
  makeOutboundCall,
  importTwilioNumber,
} = require("../../lib/vapi");
const { generateCallSummary } = require("../../lib/openai");

const router = express.Router();

// ── POST /api/vapi/webhook ────────────────────────────────────
// Vapi calls this after every real call ends. No JWT auth — verified by secret.
router.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    // Verify shared secret if configured
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (secret) {
      const incoming = req.headers["x-vapi-secret"] || "";
      if (incoming !== secret) {
        console.warn("Vapi webhook: wrong secret from", req.ip);
        // Still return 200 so Vapi doesn't keep retrying with wrong secret
        return res.json({ received: false, reason: "invalid_secret" });
      }
    }

    // Acknowledge IMMEDIATELY — Vapi has a short timeout
    res.json({ received: true });

    // Process the event asynchronously so we never block the response
    setImmediate(() => {
      processCallEvent(req.body).catch((err) =>
        console.error("Vapi webhook processing error:", err.message, err.stack),
      );
    });
  }),
);

async function processCallEvent(body) {
  const event = parseWebhookEvent(body);
  console.log("[Vapi webhook]", event.event, event.callId || "");

  if (event.event !== "call-ended") return;

  const {
    orgId,
    agentId,
    callerPhone,
    callerName,
    duration,
    transcript,
    summary: vapiSummary,
    endedReason,
    structuredData,
    callId,
  } = event;

  if (!orgId) {
    console.warn(
      "[Vapi webhook] No organizationId in metadata — call not saved. " +
        "Ensure your Vapi assistant has metadata.organizationId set.",
    );
    return;
  }

  const db = getSupabase();

  // Deduplicate — don't process the same call twice
  if (callId) {
    const { data: existing } = await db
      .from("call_records")
      .select("id")
      .eq("vapi_call_id", callId)
      .maybeSingle();
    if (existing) {
      console.log("[Vapi webhook] Already processed callId", callId);
      return;
    }
  }

  // Generate summary if Vapi didn't provide one
  let summary = vapiSummary;
  if (!summary && transcript.length > 0) {
    const transcriptStr = transcript
      .map((m) => `${m.speaker}: ${m.text}`)
      .join("\n");
    try {
      summary = await generateCallSummary(transcriptStr, endedReason);
    } catch {
      summary = "Call completed.";
    }
  }

  const outcome = determineOutcome(endedReason, transcript, structuredData);

  // Capture lead if data was extracted
  let leadId = null;
  if (outcome === "Lead Captured" || outcome === "Appointment Booked") {
    const sd = structuredData || {};
    const { data: lead } = await db
      .from("leads")
      .insert({
        organization_id: orgId,
        name: sd.name || callerName || "Unknown",
        phone: sd.phone || callerPhone || "",
        email: sd.email || "",
        reason:
          sd.reason ||
          transcript.find((m) => m.speaker === "Caller")?.text ||
          "",
        status: "new",
        source: "call",
      })
      .select()
      .single();
    leadId = lead?.id || null;
  }

  // INSERT triggers Supabase Realtime → frontend dashboard updates live
  await db.from("call_records").insert({
    organization_id: orgId,
    voice_agent_id: agentId || null,
    caller_name: callerName || "Unknown Caller",
    caller_phone: callerPhone || "",
    duration: duration || 0,
    outcome,
    summary: summary || "Call completed.",
    transcript,
    lead_id: leadId,
    vapi_call_id: callId || "",
    timestamp: new Date().toISOString(),
  });

  // Atomic usage increment via RPC (created in supabase-schema.sql)
  const mins = Math.max(1, Math.ceil((duration || 0) / 60));
  await db
    .rpc("increment_usage", { org_id: orgId, calls_inc: 1, minutes_inc: mins })
    .catch(async () => {
      // Fallback if RPC not available
      const { data: org } = await db
        .from("organizations")
        .select("usage_calls, usage_minutes")
        .eq("id", orgId)
        .single();
      if (org) {
        await db
          .from("organizations")
          .update({
            usage_calls: (org.usage_calls || 0) + 1,
            usage_minutes: (org.usage_minutes || 0) + mins,
          })
          .eq("id", orgId);
      }
    });

  console.log(
    `[Vapi webhook] ✅ Saved call ${callId} | ${outcome} | org ${orgId}`,
  );
}

// ── POST /api/vapi/outbound ───────────────────────────────────
// Start a real outbound call from the dashboard
router.post(
  "/outbound",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { toPhone, customerName } = req.body;
    if (!toPhone)
      return res
        .status(400)
        .json({ error: { message: "toPhone is required." } });

    const db = getSupabase();
    const agentId = req.organization.active_voice_agent_id;
    if (!agentId)
      return res
        .status(400)
        .json({ error: { message: "No active voice agent." } });

    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", agentId)
      .single();
    if (!agent?.vapi_assistant_id) {
      return res
        .status(400)
        .json({
          error: {
            message: 'Agent not synced to Vapi. Click "Restart Agent" first.',
          },
        });
    }
    if (!agent?.vapi_phone_number_id) {
      return res
        .status(400)
        .json({
          error: {
            message:
              "No Vapi phone number on this agent. Import a Twilio number first.",
          },
        });
    }

    const call = await makeOutboundCall({
      toPhone,
      vapiAssistantId: agent.vapi_assistant_id,
      vapiPhoneNumberId: agent.vapi_phone_number_id,
      customerName: customerName || "",
    });

    res.json({ success: true, callId: call.id, status: call.status });
  }),
);

// ── POST /api/vapi/import-phone ───────────────────────────────
// Import a Twilio number into Vapi and attach it to the active agent
router.post(
  "/import-phone",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { twilioPhoneNumber, voiceAgentId } = req.body;
    if (!twilioPhoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "twilioPhoneNumber is required." } });
    }

    const db = getSupabase();
    const org = req.organization;

    if (!org.twilio_account_sid || !org.twilio_auth_token_encrypted) {
      return res
        .status(400)
        .json({
          error: { message: "Configure Twilio credentials in Settings first." },
        });
    }

    const targetId = voiceAgentId || org.active_voice_agent_id;
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", targetId)
      .single();
    if (!agent)
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });

    const phoneRecord = await importTwilioNumber({
      twilioPhoneNumber,
      twilioAccountSid: org.twilio_account_sid,
      twilioAuthToken: org.twilio_auth_token_encrypted,
      vapiAssistantId: agent.vapi_assistant_id || undefined,
    });

    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: twilioPhoneNumber,
        vapi_phone_number_id: phoneRecord.id,
      })
      .eq("id", targetId);

    res.json({
      success: true,
      vapiPhoneNumberId: phoneRecord.id,
      phoneNumber: twilioPhoneNumber,
    });
  }),
);

module.exports = router;
