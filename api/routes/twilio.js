"use strict";

/**
 * /api/routes/twilio.js
 *
 * Routes served to Twilio webhooks and dashboard APIs.
 *
 * PUBLIC (no JWT, Twilio signs these):
 *   POST /api/twilio/voice-inbound        – Twilio calls this on inbound call, returns TwiML
 *   GET  /api/twilio/voice-inbound        – same (Twilio uses GET or POST)
 *   GET  /api/twilio/ws                   – WebSocket upgrade for ConversationRelay
 *   POST /api/twilio/call-status          – Twilio call status callbacks
 *   POST /api/twilio/recording-status     – Twilio recording status callbacks
 *   POST /api/twilio/sms-inbound          – Inbound SMS / WhatsApp
 *   GET  /api/twilio/outbound-twiml       – TwiML for outbound calls (queried by Twilio)
 *
 * PROTECTED (require JWT):
 *   GET  /api/twilio/numbers/search       – Search available Twilio numbers
 *   GET  /api/twilio/numbers/countries    – List supported countries
 *   GET  /api/twilio/numbers/owned        – List numbers on master account
 *   POST /api/twilio/numbers/purchase     – Purchase a number and assign to agent
 *   DELETE /api/twilio/numbers/:sid       – Release a number
 *   GET  /api/twilio/calls               – Fetch Twilio call log for this org
 *   GET  /api/twilio/billing             – Fetch Twilio billing data for this org
 *   POST /api/twilio/outbound            – Initiate an outbound call
 *   GET  /api/twilio/voice-test          – Generate test TwiML for browser preview
 */

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
  sendWhatsAppMessage,
} = require("../../lib/twilio");

const router = express.Router();

const API_URL = () => (process.env.API_URL || "").replace(/\/$/, "");

/** WebSocket base URL — defaults to API_URL but can be overridden for separate WS server */
const WS_URL = () => {
  const explicit = (process.env.TWILIO_WS_URL || "").replace(/\/$/, "");
  if (explicit) return explicit;
  // Derive from API_URL: https://x.vercel.app → wss://x.vercel.app
  return API_URL().replace(/^https?:\/\//, "wss://");
};

// ─────────────────────────────────────────────────────────────
// Helper: lookup org + agent from a Twilio phone number
// ─────────────────────────────────────────────────────────────
async function lookupAgentByPhone(toPhone) {
  const db = getSupabase();
  // Strip +, spaces, dashes for comparison flexibility
  const { data: agent } = await db
    .from("voice_agents")
    .select("*, organizations(id, name)")
    .eq("twilio_phone_number", toPhone)
    .eq("is_active", true)
    .maybeSingle();

  return agent;
}

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Inbound Voice Webhook ────────────────────────────
// Twilio hits this when someone calls a number we manage.
// We respond with TwiML that connects to ConversationRelay.
// ─────────────────────────────────────────────────────────────
async function handleInboundVoice(req, res) {
  const toPhone = req.body?.To || req.query?.To || "";
  const fromPhone = req.body?.From || req.query?.From || "";
  const callSid = req.body?.CallSid || req.query?.CallSid || "";

  try {
    const agent = await lookupAgentByPhone(toPhone);

    if (!agent) {
      // No agent configured — just say a message and hang up
      res.setHeader("Content-Type", "text/xml");
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, this number is not currently configured. Goodbye.</Say>
</Response>`);
    }

    const orgId = agent.organization_id;
    const agentId = agent.id;

    // WebSocket URL for ConversationRelay
    // NOTE: Twilio requires a WSS URL in production
    const wsBase = WS_URL();
    const wsUrl = `${wsBase}/api/twilio/ws?orgId=${orgId}&agentId=${agentId}&callSid=${callSid}&callerPhone=${encodeURIComponent(fromPhone)}`;

    const twiml = buildConversationRelayTwiml({
      agentRow: agent,
      wsUrl,
      greeting: agent.greeting,
    });

    res.setHeader("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (err) {
    console.error("[Twilio inbound] Error:", err.message);
    res.setHeader("Content-Type", "text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We are experiencing technical difficulties. Please try again later.</Say>
</Response>`);
  }
}

router.post("/voice-inbound", handleInboundVoice);
router.get("/voice-inbound", handleInboundVoice);

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Outbound TwiML ───────────────────────────────────
// Twilio fetches this when we initiate an outbound call.
// The call SID + orgId + agentId are passed as query params.
// ─────────────────────────────────────────────────────────────
router.post(
  "/outbound-twiml",
  asyncHandler(async (req, res) => {
    const callSid = req.body?.CallSid || "";
    const toPhone = req.body?.To || "";
    const fromPhone = req.body?.From || "";

    // Look up agent by the from number
    const agent = await lookupAgentByPhone(fromPhone);
    if (!agent) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      );
    }

    const wsBase = WS_URL();
    const wsUrl = `${wsBase}/api/twilio/ws?orgId=${agent.organization_id}&agentId=${agent.id}&callSid=${callSid}&callerPhone=${encodeURIComponent(toPhone)}`;

    const twiml = buildOutboundTwiml({ agentRow: agent, wsUrl });
    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  }),
);

router.get(
  "/outbound-twiml",
  asyncHandler(async (req, res) => {
    res.setHeader("Content-Type", "text/xml");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Call Status Callback ─────────────────────────────
// Twilio sends call lifecycle events here.
// We update usage on 'completed' if we somehow missed the WS 'end' event.
// ─────────────────────────────────────────────────────────────
router.post(
  "/call-status",
  asyncHandler(async (req, res) => {
    const { CallSid, CallStatus, CallDuration, To } = req.body || {};
    if (CallStatus === "completed" && CallDuration && To) {
      try {
        const db = getSupabase();
        const agent = await lookupAgentByPhone(To);
        if (agent) {
          // Check if already recorded
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
      } catch (e) {
        console.error("[Twilio call-status] error:", e.message);
      }
    }
    res.json({ received: true });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Recording Status Callback ────────────────────────
// Twilio sends this when a recording is ready.
// We update the call record with the recording URL.
// ─────────────────────────────────────────────────────────────
router.post(
  "/recording-status",
  asyncHandler(async (req, res) => {
    const { CallSid, RecordingUrl, RecordingStatus } = req.body || {};
    if (RecordingStatus === "completed" && CallSid && RecordingUrl) {
      try {
        const db = getSupabase();
        await db
          .from("call_records")
          .update({ recording_url: RecordingUrl + ".mp3" })
          .eq("vapi_call_id", CallSid);
      } catch (e) {
        console.error("[Twilio recording-status] error:", e.message);
      }
    }
    res.json({ received: true });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Inbound SMS / WhatsApp ───────────────────────────
// ─────────────────────────────────────────────────────────────
router.post(
  "/sms-inbound",
  asyncHandler(async (req, res) => {
    const { From, To, Body } = req.body || {};
    const isWhatsApp = From?.startsWith("whatsapp:");

    try {
      const db = getSupabase();
      const agent = await lookupAgentByPhone(
        isWhatsApp ? To?.replace("whatsapp:", "") : To,
      );

      if (agent) {
        // Store the inbound message for WhatsApp chat history
        await db
          .from("whatsapp_messages")
          .insert({
            organization_id: agent.organization_id,
            voice_agent_id: agent.id,
            from_number: From,
            to_number: To,
            body: Body || "",
            direction: "inbound",
            created_at: new Date().toISOString(),
          })
          .catch(() => {}); // Table may not exist yet; silently ignore
      }

      // Auto-respond with a short AI reply using the agent's knowledge
      if (isWhatsApp && agent && Body) {
        const { generateChatResponse } = require("../lib/openai");
        const { buildSystemPrompt } = require("../lib/twilio");

        const [faqRes] = await Promise.allSettled([
          db
            .from("faqs")
            .select("question,answer")
            .eq("voice_agent_id", agent.id)
            .limit(30),
        ]);
        const faqs =
          faqRes.status === "fulfilled" ? faqRes.value.data || [] : [];
        const sysPrompt = buildSystemPrompt(agent, faqs, []);

        const reply = await generateChatResponse(Body, [], sysPrompt);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`;
        res.setHeader("Content-Type", "text/xml");
        return res.send(twiml);
      }
    } catch (e) {
      console.error("[Twilio sms-inbound] error:", e.message);
    }

    res.setHeader("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Number Management ─────────────────────────────
// ─────────────────────────────────────────────────────────────

// List supported countries
router.get(
  "/numbers/countries",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const countries = await listSupportedCountries();
    res.json({ countries });
  }),
);

// Search available numbers
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

// List all numbers owned on master account
router.get(
  "/numbers/owned",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const numbers = await listOwnedNumbers();
    res.json({ numbers });
  }),
);

// Purchase a number and assign it to a voice agent
router.post(
  "/numbers/purchase",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber, voiceAgentId } = req.body;
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "phoneNumber is required." } });
    }

    const db = getSupabase();

    // Resolve agent
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId)
      .single();

    if (!agent) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    // Purchase from master Twilio account
    const purchased = await purchasePhoneNumber({
      phoneNumber,
      friendlyName: `${req.organization.name} – ${agent.name}`,
    });

    // Save to DB
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

// Assign an already-owned number to a voice agent (no purchase)
router.post(
  "/numbers/assign",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneSid, phoneNumber, voiceAgentId } = req.body;
    if (!phoneSid || !phoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "phoneSid and phoneNumber are required." } });
    }

    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;

    // Update webhooks to point to this server
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

// Release a number
router.delete(
  "/numbers/:sid",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { sid } = req.params;

    const db = getSupabase();

    // Clear from voice agents first
    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: "",
        twilio_phone_sid: "",
        updated_at: new Date().toISOString(),
      })
      .eq("twilio_phone_sid", sid)
      .eq("organization_id", req.orgId);

    await releasePhoneNumber(sid);
    res.json({ success: true });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Call Logs from Twilio ─────────────────────────
// Returns Twilio's own call logs for numbers assigned to this org.
// These supplement our own call_records table.
// ─────────────────────────────────────────────────────────────
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

    if (!numbers.length) {
      return res.json({ calls: [] });
    }

    // Fetch for the first active number (keep costs low; extend if needed)
    const calls = await fetchCallLogs({
      to: numbers[0],
      limit: parseInt(req.query.limit || "50", 10),
      startTime: req.query.startTime,
    });

    res.json({ calls });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Billing from Twilio ───────────────────────────
// ─────────────────────────────────────────────────────────────
router.get(
  "/billing",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const billing = await fetchMonthlyBilling();
    res.json({ billing });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Initiate Outbound Call ────────────────────────
// ─────────────────────────────────────────────────────────────
router.post(
  "/outbound",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { toPhone, customerName, voiceAgentId } = req.body;
    if (!toPhone)
      return res
        .status(400)
        .json({ error: { message: "toPhone is required." } });

    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId)
      .single();

    if (!agent?.twilio_phone_number) {
      return res.status(400).json({
        error: {
          message:
            "This agent has no Twilio number assigned. Purchase one first.",
        },
      });
    }

    const result = await makeOutboundCall({
      from: agent.twilio_phone_number,
      to: toPhone,
    });

    res.json({ success: true, callSid: result.callSid, status: result.status });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: In-Browser Test TwiML ─────────────────────────
// Returns TwiML you can use with Twilio Client SDK for browser-based test
// ─────────────────────────────────────────────────────────────
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

    if (!agent) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    const wsBase = WS_URL();
    const wsUrl = `${wsBase}/api/twilio/ws?orgId=${req.orgId}&agentId=${agentId}&callSid=test-${Date.now()}&callerPhone=browser-test`;

    const twiml = buildConversationRelayTwiml({ agentRow: agent, wsUrl });
    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  }),
);

module.exports = router;
