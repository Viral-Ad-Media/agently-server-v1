"use strict";

/**
 * /api/routes/twilio.js
 *
 * Routes served to Twilio webhooks and dashboard APIs.
 *
 * PUBLIC (no JWT, Twilio signs these):
 *   POST /api/twilio/voice-inbound        – Twilio calls this on inbound call, returns TwiML
 *   GET  /api/twilio/voice-inbound        – same (Twilio uses GET or POST)
 *   GET  /api/twilio/media-stream         – WebSocket upgrade for Twilio Media Streams
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
 *   GET  /api/twilio/voice-token         – Generate Twilio Voice SDK access token
 *   POST /api/twilio/voice-app           – TwiML App entry for browser calls
 *   GET  /api/twilio/voice-test          – Generate test Media Streams TwiML preview
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
  buildMediaStreamTwiml,
  createVoiceAccessToken,
  fetchCallLogs,
  // fetchMonthlyBilling intentionally removed — it returns master account totals
  // and must never be exposed to users. Per-number costs are tracked internally
  // by lib/billing-tracker.js. See the billing-sync route below.
  makeOutboundCall,
  sendWhatsAppMessage,
} = require("../../lib/twilio");
const {
  createCallRecord,
  updateCallRecordBySid,
  updateCallRecordById,
  finalizeUsage,
} = require("../../lib/call-records");

const router = express.Router();

const API_URL = () => (process.env.API_URL || "").replace(/\/$/, "");

/** WebSocket base URL — defaults to API_URL but can be overridden for separate WS server */
const WS_URL = () => {
  const explicit = (process.env.TWILIO_WS_URL || "").replace(/\/$/, "");
  if (explicit) return explicit;
  // Derive from API_URL: https://x.vercel.app → wss://x.vercel.app
  return API_URL().replace(/^https?:\/\//, "wss://");
};

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function safeXmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hangupTwiml(
  message = "Sorry, this number is not currently configured. Goodbye.",
) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${safeXmlText(message)}</Say>
  <Hangup/>
</Response>`;
}

function mediaStreamUrl(params) {
  const wsBase = WS_URL();
  const query = new URLSearchParams(params);
  return `${wsBase}/api/twilio/media-stream?${query.toString()}`;
}

function buildRealtimeTwiml({
  agent,
  callRecordId,
  callSid,
  direction,
  callerPhone,
}) {
  const wsUrl = mediaStreamUrl({
    orgId: agent.organization_id,
    agentId: agent.id,
    callRecordId,
    callSid: callSid || "",
    direction: direction || "inbound",
    callerPhone: callerPhone || "",
  });
  return buildMediaStreamTwiml({
    wsUrl,
    parameters: {
      organizationId: agent.organization_id,
      agentId: agent.id,
      callRecordId,
      callSid: callSid || "",
      direction: direction || "inbound",
      callerPhone: callerPhone || "",
    },
  });
}

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
// We respond with TwiML that connects Twilio Media Streams to OpenAI Realtime.
// ─────────────────────────────────────────────────────────────
async function handleInboundVoice(req, res) {
  const toPhone = normalizePhone(req.body?.To || req.query?.To || "");
  const fromPhone = normalizePhone(req.body?.From || req.query?.From || "");
  const callSid = normalizePhone(req.body?.CallSid || req.query?.CallSid || "");

  try {
    const agent = await lookupAgentByPhone(toPhone);

    if (!agent) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(hangupTwiml());
    }

    const record = await createCallRecord({
      organizationId: agent.organization_id,
      voiceAgentId: agent.id,
      callerPhone: fromPhone,
      direction: "inbound",
      status: "queued",
      twilioCallSid: callSid,
      metadata: { twilioTo: toPhone, twilioFrom: fromPhone },
    });

    const twiml = buildRealtimeTwiml({
      agent,
      callRecordId: record.id,
      callSid,
      direction: "inbound",
      callerPhone: fromPhone,
    });

    res.setHeader("Content-Type", "text/xml");
    return res.send(twiml);
  } catch (err) {
    console.error("[Twilio inbound] Error:", err.message);
    res.setHeader("Content-Type", "text/xml");
    return res.send(
      hangupTwiml(
        "We are experiencing technical difficulties. Please try again later.",
      ),
    );
  }
}

router.post("/voice-inbound", handleInboundVoice);
router.get("/voice-inbound", handleInboundVoice);
router.post("/incoming-call", handleInboundVoice);
router.get("/incoming-call", handleInboundVoice);

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Outbound TwiML ───────────────────────────────────
// Twilio fetches this when we initiate an outbound call.
// The call SID + orgId + agentId are passed as query params.
// ─────────────────────────────────────────────────────────────
router.post(
  "/outbound-twiml",
  asyncHandler(async (req, res) => {
    const callSid = req.body?.CallSid || req.query?.CallSid || "";
    const toPhone = req.body?.To || req.query?.To || "";
    const fromPhone = req.body?.From || req.query?.From || "";
    const agentId = req.query?.agentId || req.body?.agentId || "";
    const callRecordIdFromQuery =
      req.query?.callRecordId || req.body?.callRecordId || "";

    const db = getSupabase();
    let agent = null;
    if (agentId) {
      const { data } = await db
        .from("voice_agents")
        .select("*")
        .eq("id", agentId)
        .maybeSingle();
      agent = data || null;
    }
    if (!agent) agent = await lookupAgentByPhone(fromPhone);

    if (!agent) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      );
    }

    let callRecordId = callRecordIdFromQuery;
    if (!callRecordId) {
      const record = await createCallRecord({
        organizationId: agent.organization_id,
        voiceAgentId: agent.id,
        callerPhone: toPhone,
        direction: "outbound",
        status: "queued",
        twilioCallSid: callSid,
        metadata: { twilioTo: toPhone, twilioFrom: fromPhone },
      });
      callRecordId = record.id;
    } else if (callSid) {
      await updateCallRecordById(callRecordId, {
        twilio_call_sid: callSid,
        status: "in-progress",
      });
    }

    const twiml = buildRealtimeTwiml({
      agent,
      callRecordId,
      callSid,
      direction: "outbound",
      callerPhone: toPhone,
    });
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
            .eq("twilio_call_sid", CallSid)
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
              twilio_call_sid: CallSid,
              provider: "twilio",
              direction: req.body.Direction || "inbound",
              status: CallStatus || "completed",
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
          .eq("twilio_call_sid", CallSid);
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
      .select("id, name, twilio_phone_number, twilio_phone_sid, number_source")
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

    // ── STEP 2: Fetch details for each org-owned number ────────────────
    // IncomingPhoneNumbers (PN...) → fetch from /IncomingPhoneNumbers/{sid}
    // OutgoingCallerIds (CA...)    → fetch from /OutgoingCallerIds/{sid}
    // SMS_VERIFIED_*               → number is external; show directly from DB
    const numbers = [];

    // Lazy-load the raw Twilio helper (same fetch pattern used in billing-tracker)
    const sid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
    const token = (process.env.TWILIO_AUTH_TOKEN || "").trim();
    const TWILIO_BASE = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
    const basicAuth =
      "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

    async function twilioFetch(path) {
      const res = await fetch(`${TWILIO_BASE}${path}`, {
        headers: { Authorization: basicAuth },
      });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return res.json();
    }

    for (const agent of agents) {
      if (!agent.twilio_phone_sid) continue;

      const source =
        agent.number_source ||
        (agent.twilio_phone_sid.startsWith("PN")
          ? "purchased"
          : agent.twilio_phone_sid.startsWith("CA")
            ? "imported"
            : "sms_verified");

      // SMS_VERIFIED numbers are not on Twilio — show from DB directly
      if (agent.twilio_phone_sid.startsWith("SMS_VERIFIED_")) {
        numbers.push({
          sid: agent.twilio_phone_sid,
          phoneNumber: agent.twilio_phone_number,
          friendlyName: agent.name,
          voiceUrl: "",
          dateCreated: null,
          capabilities: { voice: false, sms: true },
          agentId: agent.id,
          agentName: agent.name,
          source, // 'sms_verified'
          sourceLabel: "Imported (SMS verified)",
        });
        continue;
      }

      try {
        let data = null;

        if (agent.twilio_phone_sid.startsWith("PN")) {
          // Purchased Twilio number
          data = await twilioFetch(
            `/IncomingPhoneNumbers/${agent.twilio_phone_sid}.json`,
          );
        } else if (agent.twilio_phone_sid.startsWith("CA")) {
          // Imported / CallerID verified number
          data = await twilioFetch(
            `/OutgoingCallerIds/${agent.twilio_phone_sid}.json`,
          );
          if (data) {
            // OutgoingCallerIds response has different shape — normalise it
            data = {
              sid: data.sid,
              phone_number: data.phone_number || agent.twilio_phone_number,
              friendly_name: data.friendly_name || agent.name,
              voice_url: "",
              date_created: data.date_created,
              capabilities: { voice: true, SMS: false },
            };
          }
        }

        if (data && (data.phone_number || agent.twilio_phone_number)) {
          numbers.push({
            sid: data.sid || agent.twilio_phone_sid,
            phoneNumber: data.phone_number || agent.twilio_phone_number,
            friendlyName: data.friendly_name || agent.name,
            voiceUrl: data.voice_url || "",
            dateCreated: data.date_created || null,
            capabilities: {
              voice: data.capabilities?.voice ?? true,
              sms: data.capabilities?.SMS ?? false,
            },
            agentId: agent.id,
            agentName: agent.name,
            // ── NUMBER SOURCE LABEL ────────────────────────────────────
            // 'purchased' = bought through Agently from master Twilio account
            // 'imported'  = user's own number verified via voice CallerID
            // DO NOT use this to show billing details — see twilio_billing_usd
            source,
            sourceLabel:
              source === "purchased"
                ? "Purchased via Agently"
                : source === "imported"
                  ? "Imported (voice verified)"
                  : "Imported (SMS verified)",
          });
        } else if (!data) {
          // SID not found on Twilio (released externally) — show from DB with warning
          numbers.push({
            sid: agent.twilio_phone_sid,
            phoneNumber: agent.twilio_phone_number,
            friendlyName: agent.name,
            voiceUrl: "",
            dateCreated: null,
            capabilities: { voice: true, sms: false },
            agentId: agent.id,
            agentName: agent.name,
            source,
            sourceLabel:
              source === "purchased"
                ? "Purchased (not found on Twilio)"
                : "Imported",
            warning:
              "This number could not be confirmed on Twilio. It may have been released.",
          });
        }
      } catch (fetchErr) {
        console.warn(
          `[twilio/numbers/owned] fetch failed for SID ${agent.twilio_phone_sid}:`,
          fetchErr.message,
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

    // Save to DB — mark as 'purchased' (came through Agently master account)
    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: phoneNumber,
        twilio_phone_sid: purchased.sid,
        number_source: "purchased",
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
// Supports 3 verification paths:
//
//  PATH A — Voice call (physical SIMs, landlines, Twilio numbers)
//    POST /api/twilio/numbers/verify-start
//      → Twilio calls the number, reads a 6-digit code
//      → StatusCallback fires at verify-callback when call ends
//      → Frontend polls GET /verify-status?callSid=xxx every 3s
//
//  PATH B — SMS OTP (virtual numbers, Google Voice, TextNow, VoIP)
//    POST /api/twilio/numbers/verify-sms-start
//      → Twilio sends a 6-digit OTP via SMS
//      → User types the OTP into the UI
//    POST /api/twilio/numbers/verify-sms-confirm
//      → Validates OTP against Twilio Verify API
//
//  BOTH paths support retry (up to 3 attempts).
//  On 3 consecutive failures, the UI clears and shows a purchase link.
//
// StatusCallback (called by Twilio, NOT the user):
//    POST /api/twilio/numbers/verify-callback  (no auth — public webhook)
//      → Receives VerificationStatus from Twilio
//      → Updates phone_verifications row in DB
//      → Polling endpoint picks this up
//
// Polling:
//    GET /api/twilio/numbers/verify-status?callSid=xxx
//      → Returns { status, phoneNumber, callSid }
//      → status: 'pending' | 'success' | 'failed' | 'no-answer' | 'busy'
// ─────────────────────────────────────────────────────────────

// ── PATH A, STEP 1: Start voice call verification ─────────────
router.post(
  "/numbers/verify-start",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber, voiceAgentId, retryAttempt = 1 } = req.body || {};
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "Please enter a phone number." } });
    }

    const normalised = phoneNumber.trim();
    if (!normalised.startsWith("+")) {
      return res.status(400).json({
        error: {
          message:
            `Phone number must start with + and include your country code. ` +
            `For example, a Nigerian number 09084467821 should be entered as +2349084467821.`,
          code: "INVALID_FORMAT",
        },
      });
    }

    // Cap retries at 3
    if (parseInt(retryAttempt, 10) > 3) {
      return res.status(400).json({
        error: {
          message:
            "Maximum verification attempts reached. This number could not be reached via voice call.",
          code: "MAX_RETRIES_EXCEEDED",
        },
      });
    }

    const apiUrl = (process.env.API_URL || "").trim().replace(/\/$/, "");
    const callbackUrl = apiUrl
      ? `${apiUrl}/api/twilio/numbers/verify-callback`
      : undefined;

    let result;
    try {
      result = await verifyCallerIdStart(
        normalised,
        `Agently – ${req.organization.name}`,
        callbackUrl,
      );
    } catch (err) {
      const raw = (err && err.message) || String(err);
      console.error("[verify-start] Twilio error:", raw);

      let userMessage =
        "Verification could not be started. Please check the number and try again.";
      let code = "TWILIO_ERROR";

      if (
        raw.includes("21211") ||
        raw.includes("not a valid") ||
        raw.includes("Invalid")
      ) {
        userMessage =
          "That does not look like a valid phone number. Please double-check the format (e.g. +2349084467821).";
        code = "INVALID_NUMBER";
      } else if (
        raw.includes("21612") ||
        raw.includes("geographic") ||
        raw.includes("Permission")
      ) {
        userMessage =
          "Calls to this country are not enabled on this account. Contact support.";
        code = "GEO_BLOCKED";
      } else if (raw.includes("21614") || raw.includes("not reachable")) {
        userMessage =
          "That number could not be reached. Make sure it can receive voice calls.";
        code = "NOT_REACHABLE";
      } else if (raw.includes("trial") || raw.includes("21219")) {
        userMessage =
          "On a trial Twilio account, only pre-approved numbers can be verified.";
        code = "TRIAL_RESTRICTION";
      }

      return res.status(400).json({ error: { message: userMessage, code } });
    }

    // Store verification attempt in DB so the callback can update it
    const db = getSupabase();
    await db.from("phone_verifications").insert({
      organization_id: req.orgId,
      phone_number: normalised,
      call_sid: result.callSid,
      validation_code: result.validationCode,
      status: "pending",
      attempts: parseInt(retryAttempt, 10),
      voice_agent_id:
        voiceAgentId || req.organization.active_voice_agent_id || null,
    });

    return res.json({
      callSid: result.callSid,
      validationCode: result.validationCode,
      phoneNumber: result.phoneNumber,
      attempt: parseInt(retryAttempt, 10),
      instructions:
        `Twilio is calling ${result.phoneNumber} right now. ` +
        `Answer the call — Twilio will read your 6-digit code out loud. ` +
        `You do not need to enter the code anywhere. The page will update automatically once the call is complete.`,
    });
  }),
);

// ── PATH A, STEP 2: StatusCallback — called by Twilio (NOT the user) ─
// This endpoint is PUBLIC (no requireAuth) because Twilio calls it.
// Twilio sends VerificationStatus=success/failed and the call outcome.
router.post(
  "/numbers/verify-callback",
  asyncHandler(async (req, res) => {
    // Twilio posts form-encoded, not JSON
    const callSid = req.body.CallSid || req.body.call_sid || "";
    const verificationStatus = req.body.VerificationStatus || ""; // success | failed
    const callStatus = req.body.CallStatus || ""; // completed | no-answer | busy | failed

    if (!callSid) {
      return res.status(400).send("Missing CallSid");
    }

    // Map to our internal status
    let status = "failed";
    if (verificationStatus === "success" || callStatus === "completed") {
      status = "success";
    } else if (callStatus === "no-answer") {
      status = "no-answer";
    } else if (callStatus === "busy") {
      status = "busy";
    }

    const db = getSupabase();
    await db
      .from("phone_verifications")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("call_sid", callSid);

    console.log(
      `[verify-callback] callSid=${callSid} status=${status} callStatus=${callStatus}`,
    );

    // If verified, also add to OutgoingCallerIds and save to DB
    if (status === "success") {
      const { data: verification } = await db
        .from("phone_verifications")
        .select("*")
        .eq("call_sid", callSid)
        .single();

      if (verification && verification.voice_agent_id) {
        try {
          const checkResult = await verifyCallerIdCheck(
            verification.phone_number,
          );
          if (checkResult.verified) {
            await db
              .from("voice_agents")
              .update({
                twilio_phone_number: verification.phone_number,
                twilio_phone_sid: checkResult.callerIdSid,
                number_source: "imported", // user's own number verified via CallerID call
                updated_at: new Date().toISOString(),
              })
              .eq("id", verification.voice_agent_id)
              .eq("organization_id", verification.organization_id);
          }
        } catch (e) {
          console.warn(
            "[verify-callback] post-verification DB update failed:",
            e.message,
          );
        }
      }
    }

    // Twilio expects a 200 response (any body is fine)
    return res.status(200).send("OK");
  }),
);

// ── PATH A, STEP 3: Poll verification status ──────────────────
// Frontend polls this every 3 seconds while waiting.
router.get(
  "/numbers/verify-status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { callSid } = req.query;
    if (!callSid) {
      return res
        .status(400)
        .json({ error: { message: "callSid is required." } });
    }

    const db = getSupabase();
    const { data: verification } = await db
      .from("phone_verifications")
      .select("status, phone_number, call_sid, attempts, voice_agent_id")
      .eq("call_sid", callSid)
      .eq("organization_id", req.orgId)
      .single();

    if (!verification) {
      return res
        .status(404)
        .json({ error: { message: "Verification not found." } });
    }

    // If success, also return the agent assignment info
    let agentId = null;
    if (verification.status === "success" && verification.voice_agent_id) {
      agentId = verification.voice_agent_id;
    }

    return res.json({
      status: verification.status, // 'pending' | 'success' | 'failed' | 'no-answer' | 'busy'
      phoneNumber: verification.phone_number,
      callSid: verification.call_sid,
      attempts: verification.attempts,
      agentId,
      canReceiveInbound: false,
      message:
        verification.status === "success"
          ? `${verification.phone_number} verified and added to your owned numbers.`
          : null,
    });
  }),
);

// ── PATH B, STEP 1: Start SMS OTP verification ────────────────
// For virtual numbers (Google Voice, TextNow, VoIP) that can
// receive SMS but not voice calls.
// Uses Twilio Verify API (requires TWILIO_VERIFY_SERVICE_SID env var).
router.post(
  "/numbers/verify-sms-start",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ error: { message: "phoneNumber is required." } });
    }

    const normalised = phoneNumber.trim();
    if (!normalised.startsWith("+")) {
      return res.status(400).json({
        error: {
          message: "Phone number must start with + and include country code.",
          code: "INVALID_FORMAT",
        },
      });
    }

    const verifySid = (process.env.TWILIO_VERIFY_SERVICE_SID || "").trim();
    if (!verifySid) {
      return res.status(503).json({
        error: {
          message:
            "SMS verification is not configured for this service. Please use voice verification or contact support.",
          code: "SMS_VERIFY_NOT_CONFIGURED",
        },
      });
    }

    const sid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
    const token = (process.env.TWILIO_AUTH_TOKEN || "").trim();
    const url = `https://verify.twilio.com/v2/Services/${verifySid}/Verifications`;
    const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: normalised,
          Channel: "sms",
        }).toString(),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err.message || `Twilio Verify error ${response.status}`;
        console.error("[verify-sms-start] error:", msg);
        throw new Error(msg);
      }

      return res.json({
        success: true,
        phoneNumber: normalised,
        message: `A 6-digit verification code has been sent to ${normalised} via SMS.`,
      });
    } catch (err) {
      const raw = (err && err.message) || String(err);
      let userMessage =
        "Could not send SMS verification. Please try voice verification instead.";
      if (raw.includes("60200") || raw.includes("Invalid")) {
        userMessage =
          "That phone number format is not valid. Please use international format (e.g. +2349084467821).";
      } else if (raw.includes("not reachable") || raw.includes("60205")) {
        userMessage =
          "This number cannot receive SMS messages. Please try voice verification instead.";
      }
      return res
        .status(400)
        .json({ error: { message: userMessage, code: "SMS_SEND_FAILED" } });
    }
  }),
);

// ── PATH B, STEP 2: Confirm SMS OTP ──────────────────────────
router.post(
  "/numbers/verify-sms-confirm",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phoneNumber, otp, voiceAgentId } = req.body || {};
    if (!phoneNumber || !otp) {
      return res
        .status(400)
        .json({ error: { message: "phoneNumber and otp are required." } });
    }

    const verifySid = (process.env.TWILIO_VERIFY_SERVICE_SID || "").trim();
    if (!verifySid) {
      return res.status(503).json({
        error: {
          message: "SMS verification is not configured.",
          code: "SMS_VERIFY_NOT_CONFIGURED",
        },
      });
    }

    const normalised = phoneNumber.trim();
    const sid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
    const token = (process.env.TWILIO_AUTH_TOKEN || "").trim();
    const url = `https://verify.twilio.com/v2/Services/${verifySid}/VerificationCheck`;
    const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

    let verifyStatus = "pending";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: normalised,
          Code: otp.trim(),
        }).toString(),
      });

      const data = await response.json().catch(() => ({}));
      verifyStatus = data.status || "pending";

      if (verifyStatus !== "approved") {
        const userMsg =
          data.message && data.message.toLowerCase().includes("invalid")
            ? "That code is incorrect. Please check and try again."
            : `Verification did not succeed (status: ${verifyStatus}). Please try again.`;
        return res
          .status(400)
          .json({ error: { message: userMsg, code: "OTP_INVALID" } });
      }
    } catch (err) {
      console.error("[verify-sms-confirm] error:", err && err.message);
      return res.status(500).json({
        error: {
          message: "Could not confirm OTP. Please try again.",
          code: "OTP_CHECK_FAILED",
        },
      });
    }

    // OTP approved — save to DB
    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;

    if (targetAgentId) {
      const { data: agent } = await db
        .from("voice_agents")
        .select("id")
        .eq("id", targetAgentId)
        .eq("organization_id", req.orgId)
        .single();

      if (!agent) {
        return res
          .status(404)
          .json({ error: { message: "Voice agent not found." } });
      }

      // For SMS-verified numbers, we use a placeholder SID since they are NOT
      // Twilio OutgoingCallerIds — they're numbers the user controls via SMS.
      // We prefix with "SMS_" so the billing tracker skips them correctly.
      await db
        .from("voice_agents")
        .update({
          twilio_phone_number: normalised,
          twilio_phone_sid: `SMS_VERIFIED_${normalised.replace(/\+/g, "")}`,
          number_source: "sms_verified",
          updated_at: new Date().toISOString(),
        })
        .eq("id", targetAgentId)
        .eq("organization_id", req.orgId);
    }

    return res.json({
      success: true,
      phoneNumber: normalised,
      agentId: targetAgentId || null,
      canReceiveInbound: false,
      message: `${normalised} verified via SMS and added to your owned numbers.`,
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
// ── BILLING ROUTE INTENTIONALLY REMOVED ──────────────────────
//
// GET /api/twilio/billing previously returned master account
// billing totals — this leaked the app owner's full Twilio
// spend to any authenticated user. It is removed permanently.
//
// Per-number costs are now tracked silently in the backend by
// lib/billing-tracker.js and stored in voice_agents.twilio_billing_usd.
// They are NEVER exposed via any API route.
//
// ── INTERNAL: Vercel Cron billing sync trigger ────────────────
// Called only by the Vercel Cron job configured in vercel.json.
// Protected by a shared secret (CRON_SECRET env var).
// ─────────────────────────────────────────────────────────────
router.post(
  "/_internal/billing-sync",
  asyncHandler(async (req, res) => {
    const secret = (process.env.CRON_SECRET || "").trim();
    const provided = (req.headers["x-cron-secret"] || "").trim();
    if (!secret || provided !== secret) {
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }
    try {
      const tracker = require("../../lib/billing-tracker");
      void tracker.runOnce();
      return res.json({ success: true, triggered: new Date().toISOString() });
    } catch (err) {
      console.error("[billing-sync cron] error:", err && err.message);
      return res
        .status(500)
        .json({ error: { message: "Billing sync failed." } });
    }
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
    const { toPhone, customerName, voiceAgentId, leadId } = req.body;
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

    const record = await createCallRecord({
      organizationId: req.orgId,
      voiceAgentId: agent.id,
      callerName: customerName || "Outbound Lead",
      callerPhone: toPhone,
      leadId: leadId || null,
      direction: "outbound",
      status: "queued",
      metadata: { initiatedBy: req.user?.id || null },
    });

    const apiBase = API_URL();
    const twimlUrl = `${apiBase}/api/twilio/outbound-twiml?agentId=${encodeURIComponent(agent.id)}&callRecordId=${encodeURIComponent(record.id)}`;
    const result = await makeOutboundCall({
      from: agent.twilio_phone_number,
      to: toPhone,
      twimlUrl,
      statusCallbackUrl: `${apiBase}/api/twilio/call-status`,
    });

    await updateCallRecordById(record.id, {
      twilio_call_sid: result.callSid,
      status: result.status || "initiated",
    });

    res.json({
      success: true,
      callSid: result.callSid,
      callRecordId: record.id,
      status: result.status,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Twilio Voice SDK token / Browser call TwiML ───
// ─────────────────────────────────────────────────────────────
router.get(
  "/voice-token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const identity = `org-${req.orgId}-user-${req.user?.id || "unknown"}`;
    const token = createVoiceAccessToken({ identity });
    res.json({ success: true, token, identity });
  }),
);

router.post(
  "/voice-app",
  asyncHandler(async (req, res) => {
    const agentId = req.body?.agentId || req.query?.agentId || "";
    const callerName =
      req.body?.callerName || req.query?.callerName || "Browser Caller";
    const callerPhone =
      req.body?.callerPhone || req.query?.callerPhone || "browser-test";
    const callSid =
      req.body?.CallSid || req.query?.CallSid || `web-${Date.now()}`;

    const db = getSupabase();
    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(hangupTwiml("Voice agent not found."));
    }

    const record = await createCallRecord({
      organizationId: agent.organization_id,
      voiceAgentId: agent.id,
      callerName,
      callerPhone,
      direction: "web",
      status: "queued",
      twilioCallSid: callSid,
      metadata: { source: "twilio-voice-sdk" },
    });

    const twiml = buildRealtimeTwiml({
      agent,
      callRecordId: record.id,
      callSid,
      direction: "web",
      callerPhone,
    });
    res.setHeader("Content-Type", "text/xml");
    return res.send(twiml);
  }),
);

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: In-Browser Test TwiML// ─────────────────────────────────────────────────────────────
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

    const twiml = buildRealtimeTwiml({
      agent,
      callRecordId: `preview-${Date.now()}`,
      callSid: `test-${Date.now()}`,
      direction: "web",
      callerPhone: "browser-test",
    });
    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  }),
);

module.exports = router;
