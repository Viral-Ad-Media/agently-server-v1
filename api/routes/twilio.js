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
  // listOwnedNumbers intentionally REMOVED — returns ALL master-account numbers
  // (data leak across all orgs). Number isolation is handled in the route directly.
  // DO NOT re-add listOwnedNumbers to routes. See /numbers/owned route for details.
  verifyCallerIdStart,
  verifyCallerIdCheck,
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

// ─────────────────────────────────────────────────────────────
// ██████████████████████████████████████████████████████████████
//  DO NOT TOUCH — CRITICAL NUMBER ISOLATION
//  This endpoint returns ONLY numbers belonging to THIS org.
//  It queries the org's voice_agents rows (which store twilio_phone_sid
//  after purchase) and fetches each number's details from Twilio by SID.
//  NEVER call listOwnedNumbers() here — that returns ALL master account
//  numbers across ALL orgs, which is a data leak. This is intentional.
//  This is a SaaS — users must never see each other's numbers.
// ██████████████████████████████████████████████████████████████
// ─────────────────────────────────────────────────────────────
router.get(
  "/numbers/owned",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();

    // ── STEP 1: Get only the phone SIDs that belong to THIS org ──
    const { data: agents, error: agentsErr } = await db
      .from("voice_agents")
      .select("id, name, twilio_phone_number, twilio_phone_sid")
      .eq("organization_id", req.orgId)
      .neq("twilio_phone_sid", "")
      .not("twilio_phone_sid", "is", null);

    if (agentsErr) {
      console.error("[twilio/numbers/owned] DB error:", agentsErr.message);
      return res
        .status(500)
        .json({ error: { message: "Failed to load numbers." } });
    }

    if (!agents || agents.length === 0) {
      return res.json({ numbers: [] });
    }

    // ── STEP 2: Fetch details for each org-owned SID from Twilio ──
    const numbers = [];
    for (const agent of agents) {
      if (!agent.twilio_phone_sid) continue;
      try {
        const { twilioRequest } = require("../../lib/twilio");
        const data = await twilioRequest(
          "GET",
          `/IncomingPhoneNumbers/${agent.twilio_phone_sid}.json`,
        );
        if (data && data.phone_number) {
          numbers.push({
            sid: data.sid,
            phoneNumber: data.phone_number,
            friendlyName: data.friendly_name || agent.name,
            voiceUrl: data.voice_url || "",
            dateCreated: data.date_created,
            capabilities: {
              voice: data.capabilities?.voice ?? true,
              sms: data.capabilities?.SMS ?? false,
            },
            // Link back to the agent so the UI can show which agent uses this number
            agentId: agent.id,
            agentName: agent.name,
          });
        }
      } catch (twilioErr) {
        // If a SID no longer exists on Twilio (released externally), skip it
        // rather than failing the whole list.
        console.warn(
          `[twilio/numbers/owned] SID ${agent.twilio_phone_sid} not found on Twilio:`,
          twilioErr.message,
        );
      }
    }

    return res.json({ numbers });
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
// ── PROTECTED: Verify an Existing (User-Owned) Phone Number ──
//
// Flow:
//   POST /api/twilio/numbers/verify-start
//     → Calls verifyCallerIdStart() from lib/twilio.js
//     → Twilio places a call to the number, reads a 6-digit code
//     → Returns { validationCode, callSid, phoneNumber, instructions }
//
//   POST /api/twilio/numbers/verify-complete
//     → Calls verifyCallerIdCheck() from lib/twilio.js
//     → Confirms the number is now in Twilio's OutgoingCallerIds list
//     → Saves it to the org's voice agent row in DB
//     → Returns { success, phoneNumber, callerIdSid, agentId }
//
// Error taxonomy → user-friendly messages:
//   "not verified yet"         → Number not answered / code not entered
//   "not voice capable"        → VoIP/data-only number, cannot be used by agent
//   "geographic restrictions"  → Twilio cannot call this number/country
//   "invalid number"           → Malformed E.164 or non-existent number
// ─────────────────────────────────────────────────────────────

// STEP 1: Start caller-ID verification via Twilio
router.post(
  "/numbers/verify-start",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "Please enter a phone number." } });
    }

    // Normalise: if user entered a local format (e.g. 09084467821 for Nigeria),
    // they should have included the + prefix. We advise E.164 in the UI, but
    // be lenient — if it starts with 0, we note this in the error.
    const normalised = phoneNumber.trim();
    if (!normalised.startsWith("+")) {
      return res.status(400).json({
        error: {
          message: `Phone number must include your country code and start with +. For example, a Nigerian number 09084467821 should be entered as +2349084467821.`,
        },
      });
    }

    try {
      const result = await verifyCallerIdStart(
        normalised,
        `Agently – ${req.organization.name}`,
      );

      return res.json({
        validationCode: result.validationCode,
        callSid: result.callSid,
        phoneNumber: result.phoneNumber,
        instructions:
          `Twilio is calling ${result.phoneNumber} right now. ` +
          `Answer the call and listen — Twilio will read your 6-digit code out loud. ` +
          `Once you have heard the code and the call ends, click "I've verified" below.`,
      });
    } catch (err) {
      const raw = (err && err.message) || String(err);
      console.error("[verify-start] Twilio error:", raw);

      // Translate Twilio error codes into plain English
      let userMessage =
        "Verification could not be started. Please check the number and try again.";
      if (
        raw.includes("not a valid") ||
        raw.includes("Invalid") ||
        raw.includes("21211")
      ) {
        userMessage =
          "That does not look like a valid phone number. Please double-check and use the international format (e.g. +2349084467821).";
      } else if (raw.includes("21612") || raw.includes("geographic")) {
        userMessage =
          "Twilio is unable to reach that number — it may be in a region where verification calls are not supported.";
      } else if (raw.includes("21614") || raw.includes("not reachable")) {
        userMessage =
          "That number could not be reached. Make sure it can receive calls and try again.";
      } else if (
        raw.includes("trial") ||
        raw.includes("unverified") ||
        raw.includes("21219")
      ) {
        userMessage =
          "On a trial Twilio account, you can only verify numbers that you have pre-approved in the Twilio console.";
      }

      return res.status(400).json({ error: { message: userMessage } });
    }
  }),
);

// STEP 2: Complete verification and save the number to the org
router.post(
  "/numbers/verify-complete",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber, voiceAgentId } = req.body || {};
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "phoneNumber is required." } });
    }

    const normalised = phoneNumber.trim();
    const db = getSupabase();

    // ── Check Twilio: is the number now verified? ──
    let checkResult;
    try {
      checkResult = await verifyCallerIdCheck(normalised);
    } catch (err) {
      const raw = (err && err.message) || String(err);
      console.error("[verify-complete] Twilio check error:", raw);
      return res.status(400).json({
        error: {
          message:
            "We could not confirm the verification. Please try again — make sure you answered the call and heard the code.",
        },
      });
    }

    if (!checkResult.verified) {
      return res.status(400).json({
        error: {
          message:
            "This number has not been verified yet. " +
            "Please answer the Twilio verification call first — Twilio reads a code to you on the call. " +
            'If the call has not arrived, click "Start over" and try again.',
          code: "NOT_VERIFIED_YET",
        },
      });
    }

    // ── Number is verified — check if it can actually be used as a caller ID ──
    // Twilio OutgoingCallerIds are usable as caller ID on outbound calls.
    // They cannot receive inbound calls unless they are IncomingPhoneNumbers.
    // We store them so the agent can use this number as its outbound caller ID.

    const callerIdSid = checkResult.callerIdSid;

    // ── Resolve target agent ──
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;

    if (targetAgentId) {
      const { data: agent } = await db
        .from("voice_agents")
        .select("id, name")
        .eq("id", targetAgentId)
        .eq("organization_id", req.orgId)
        .single();

      if (!agent) {
        return res.status(404).json({
          error: {
            message:
              "The selected voice agent was not found. Please select an agent and try again.",
          },
        });
      }

      // Save to DB — use callerIdSid as the phone_sid.
      // The /numbers/owned route reads by twilio_phone_sid, so this number
      // will now appear in the org's owned list correctly.
      const { error: updateErr } = await db
        .from("voice_agents")
        .update({
          twilio_phone_number: normalised,
          twilio_phone_sid: callerIdSid,
          updated_at: new Date().toISOString(),
        })
        .eq("id", targetAgentId)
        .eq("organization_id", req.orgId);

      if (updateErr) {
        console.error("[verify-complete] DB update error:", updateErr.message);
        return res.status(500).json({
          error: {
            message:
              "Number verified but could not be saved. Please try assigning it manually from the Owned tab.",
          },
        });
      }
    }

    return res.json({
      success: true,
      phoneNumber: normalised,
      callerIdSid,
      agentId: targetAgentId || null,
      message: `${normalised} has been verified and added to your owned numbers. You can now use it on outbound calls.`,
      // Note for the frontend: this is a CallerID, not an IncomingPhoneNumber.
      // It can be used as the From number on outbound calls but cannot receive inbound calls.
      canReceiveInbound: false,
    });
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
