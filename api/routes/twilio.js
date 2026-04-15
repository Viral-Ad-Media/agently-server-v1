"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  listSupportedCountries,
  searchAvailableNumbers,
  purchasePhoneNumber,
  updateNumberWebhooks,
  releasePhoneNumber,
  listOwnedNumbers,
  buildConversationRelayTwiml,
  buildOutboundTwiml,
  fetchCallLogs,
  fetchMonthlyBilling,
  makeOutboundCall,
} = require("../../lib/twilio");

const router = express.Router();

const API_URL = () => (process.env.API_URL || "").replace(/\/$/, "");
const WS_URL = () => {
  const explicit = (process.env.TWILIO_WS_URL || "").replace(/\/$/, "");
  if (explicit) return explicit;
  return API_URL().replace(/^https?:\/\//, "wss://");
};

async function lookupAgentByPhone(toPhone) {
  const db = getSupabase();
  const { data: agent } = await db
    .from("voice_agents")
    .select("*, organizations(id, name)")
    .eq("twilio_phone_number", toPhone)
    .eq("is_active", true)
    .maybeSingle();
  return agent;
}

// ── PUBLIC: Inbound Voice ───────────────────────────────────────
async function handleInboundVoice(req, res) {
  const toPhone = req.body?.To || req.query?.To || "";
  const fromPhone = req.body?.From || req.query?.From || "";
  const callSid = req.body?.CallSid || req.query?.CallSid || "";

  try {
    const agent = await lookupAgentByPhone(toPhone);
    if (!agent) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna">Sorry, this number is not configured. Goodbye.</Say></Response>`);
    }

    const wsUrl = `${WS_URL()}/api/twilio/ws?orgId=${agent.organization_id}&agentId=${agent.id}&callSid=${callSid}&callerPhone=${encodeURIComponent(fromPhone)}`;
    const twiml = buildConversationRelayTwiml({
      agentRow: agent,
      wsUrl,
      greeting: agent.greeting,
    });

    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("[Twilio inbound]", err.message);
    res.setHeader("Content-Type", "text/xml");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Technical difficulties. Try again later.</Say></Response>`,
    );
  }
}

router.post("/voice-inbound", handleInboundVoice);
router.get("/voice-inbound", handleInboundVoice);

// ── PUBLIC: Outbound TwiML ──────────────────────────────────────
router.post(
  "/outbound-twiml",
  asyncHandler(async (req, res) => {
    const fromPhone = req.body?.From || "";
    const agent = await lookupAgentByPhone(fromPhone);
    if (!agent) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      );
    }
    const wsUrl = `${WS_URL()}/api/twilio/ws?orgId=${agent.organization_id}&agentId=${agent.id}&callSid=${req.body?.CallSid || ""}&callerPhone=${encodeURIComponent(req.body?.To || "")}`;
    const twiml = buildOutboundTwiml({ agentRow: agent, wsUrl });
    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  }),
);

router.get("/outbound-twiml", (_req, res) => {
  res.setHeader("Content-Type", "text/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
  );
});

// ── PUBLIC: Call Status / Recording Callbacks ───────────────────
router.post(
  "/call-status",
  asyncHandler(async (req, res) => {
    const { CallSid, CallStatus, CallDuration, To } = req.body || {};
    if (CallStatus === "completed" && CallDuration && To) {
      try {
        const db = getSupabase();
        const agent = await lookupAgentByPhone(To);
        if (agent) {
          const { data: existing } = await db
            .from("call_records")
            .select("id")
            .eq("vapi_call_id", CallSid)
            .maybeSingle();
          if (!existing) {
            const duration = parseInt(CallDuration, 10) || 0;
            const mins = Math.max(1, Math.ceil(duration / 60));
            await db.from("call_records").insert({
              organization_id: agent.organization_id,
              voice_agent_id: agent.id,
              caller_name: "Unknown Caller",
              caller_phone: req.body.From || "",
              duration,
              outcome: "FAQ Answered",
              summary: "Call completed (status callback).",
              transcript: [],
              vapi_call_id: CallSid,
              timestamp: new Date().toISOString(),
            });
            await db
              .rpc("increment_usage", {
                org_id: agent.organization_id,
                calls_inc: 1,
                minutes_inc: mins,
              })
              .catch(() => {});
          }
        }
      } catch (e) {}
    }
    res.json({ received: true });
  }),
);

router.post(
  "/recording-status",
  asyncHandler(async (req, res) => {
    const { CallSid, RecordingUrl, RecordingStatus } = req.body || {};
    if (RecordingStatus === "completed" && CallSid && RecordingUrl) {
      const db = getSupabase();
      await db
        .from("call_records")
        .update({ recording_url: RecordingUrl + ".mp3" })
        .eq("vapi_call_id", CallSid);
    }
    res.json({ received: true });
  }),
);

// ── PUBLIC: SMS / WhatsApp (foundation) ─────────────────────────
router.post(
  "/sms-inbound",
  asyncHandler(async (req, res) => {
    const { From, To, Body } = req.body || {};
    try {
      const db = getSupabase();
      const agent = await lookupAgentByPhone(To?.replace("whatsapp:", ""));
      if (agent && Body) {
        await db
          .from("whatsapp_messages")
          .insert({
            organization_id: agent.organization_id,
            voice_agent_id: agent.id,
            from_number: From,
            to_number: To,
            body: Body,
            direction: "inbound",
          })
          .catch(() => {});

        const { generateChatResponse } = require("../../lib/openai");
        const { buildSystemPrompt } = require("../../lib/twilio");
        const { data: faqs } = await db
          .from("faqs")
          .select("question,answer")
          .eq("voice_agent_id", agent.id)
          .limit(30);
        const sysPrompt = buildSystemPrompt(agent, faqs || [], []);
        const reply = await generateChatResponse(Body, [], sysPrompt);
        res.setHeader("Content-Type", "text/xml");
        return res.send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`,
        );
      }
    } catch (e) {}
    res.setHeader("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }),
);

// ── PROTECTED: Number Management ────────────────────────────────
router.get(
  "/numbers/countries",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const countries = await listSupportedCountries();
    res.json({ countries });
  }),
);

router.get(
  "/numbers/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      country = "US",
      type = "Local",
      areaCode,
      contains,
      limit,
    } = req.query;
    const numbers = await searchAvailableNumbers({
      country: country.toUpperCase(),
      type:
        type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() ===
        "tollfree"
          ? "TollFree"
          : type,
      areaCode,
      contains,
      limit: parseInt(limit || "20", 10),
    });
    res.json({ numbers });
  }),
);

router.get(
  "/numbers/owned",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const numbers = await listOwnedNumbers();
    res.json({ numbers });
  }),
);

router.post(
  "/numbers/purchase",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber, voiceAgentId } = req.body;
    if (!phoneNumber)
      return res
        .status(400)
        .json({ error: { message: "phoneNumber required" } });

    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId)
      .single();
    if (!agent)
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found" } });

    const purchased = await purchasePhoneNumber({
      phoneNumber,
      friendlyName: `${req.organization.name} – ${agent.name}`,
    });

    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: phoneNumber,
        twilio_phone_sid: purchased.sid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetAgentId);

    res.json({
      success: true,
      phoneNumber,
      phoneSid: purchased.sid,
      agentId: targetAgentId,
    });
  }),
);

router.post(
  "/numbers/assign",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneSid, phoneNumber, voiceAgentId } = req.body;
    if (!phoneSid || !phoneNumber)
      return res
        .status(400)
        .json({ error: { message: "phoneSid and phoneNumber required" } });

    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;
    await updateNumberWebhooks({ phoneSid });
    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: phoneNumber,
        twilio_phone_sid: phoneSid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId);

    res.json({ success: true });
  }),
);

router.delete(
  "/numbers/:sid",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { sid } = req.params;
    const db = getSupabase();
    await db
      .from("voice_agents")
      .update({ twilio_phone_number: "", twilio_phone_sid: "" })
      .eq("twilio_phone_sid", sid)
      .eq("organization_id", req.orgId);
    await releasePhoneNumber(sid);
    res.json({ success: true });
  }),
);

// ── PROTECTED: Call Logs & Billing ──────────────────────────────
router.get(
  "/calls",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: agents } = await db
      .from("voice_agents")
      .select("twilio_phone_number")
      .eq("organization_id", req.orgId)
      .neq("twilio_phone_number", "");
    const numbers = (agents || [])
      .map((a) => a.twilio_phone_number)
      .filter(Boolean);
    if (!numbers.length) return res.json({ calls: [] });
    const calls = await fetchCallLogs({
      to: numbers[0],
      limit: parseInt(req.query.limit || "50", 10),
      startTime: req.query.startTime,
    });
    res.json({ calls });
  }),
);

router.get(
  "/billing",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const billing = await fetchMonthlyBilling();
    res.json({ billing });
  }),
);

// ── PROTECTED: Outbound Call ────────────────────────────────────
router.post(
  "/outbound",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { toPhone, voiceAgentId } = req.body;
    if (!toPhone)
      return res.status(400).json({ error: { message: "toPhone required" } });

    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId)
      .single();
    if (!agent?.twilio_phone_number)
      return res
        .status(400)
        .json({ error: { message: "Agent has no Twilio number" } });

    const result = await makeOutboundCall({
      from: agent.twilio_phone_number,
      to: toPhone,
    });
    res.json({ success: true, callSid: result.callSid, status: result.status });
  }),
);

// ── PROTECTED: Test TwiML for browser preview ───────────────────
router.get(
  "/voice-test",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agentId = req.query.agentId || req.organization.active_voice_agent_id;
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", agentId)
      .eq("organization_id", req.orgId)
      .single();
    if (!agent)
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found" } });
    const wsUrl = `${WS_URL()}/api/twilio/ws?orgId=${req.orgId}&agentId=${agentId}&callSid=test-${Date.now()}&callerPhone=browser-test`;
    const twiml = buildConversationRelayTwiml({ agentRow: agent, wsUrl });
    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  }),
);

module.exports = router;
