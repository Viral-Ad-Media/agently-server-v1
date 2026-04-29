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
const { mapTwilioError } = require("../../lib/twilio-errors");
const {
  ensureTenantTwilioAccount,
  searchAvailableRecommendedNumbers,
  purchaseIncomingNumber,
  listIncomingNumbers,
  fetchIncomingNumber,
  configureTwilioIncomingNumber,
  applyVoiceDialingPermissions,
  buildManualSmsGeoInstructions,
  normalizeCountry,
  supportedCountries,
  lowRiskCountries,
  evaluateNumberRecommendation,
  twilioRequest,
  apiBaseUrl,
  masterSid,
} = require("../../lib/twilio-platform");
const {
  getTwilioNumberReadiness,
  persistReadiness,
} = require("../../lib/twilio-number-readiness");

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
  const normalized = normalizePhone(toPhone);

  // New source of truth: dedicated Twilio number records. This keeps
  // recovered/unassigned/configured numbers separate from agent rows.
  try {
    const { data: numberRow, error } = await db
      .from("twilio_phone_numbers")
      .select("*, voice_agents:assigned_voice_agent_id(*)")
      .eq("phone_number", normalized)
      .maybeSingle();

    if (!error && numberRow?.voice_agents?.is_active) {
      return {
        ...numberRow.voice_agents,
        organization_id: numberRow.organization_id,
        twilio_number_id: numberRow.id,
        twilio_phone_number: numberRow.phone_number,
        twilio_phone_sid: numberRow.phone_sid,
      };
    }
  } catch (_) {
    // Migration may not be applied yet; safely fall back to legacy lookup.
  }

  const { data: agent } = await db
    .from("voice_agents")
    .select("*, organizations(id, name)")
    .eq("twilio_phone_number", normalized)
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

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Tenant Twilio account + readiness helpers ─────
// ─────────────────────────────────────────────────────────────
function bodyOrg(req) {
  const requested =
    req.body?.organizationId || req.query?.organizationId || req.orgId;
  if (
    requested &&
    requested !== req.orgId &&
    !["Owner", "Admin"].includes(req.user?.role)
  ) {
    const err = new Error(
      "You cannot access another organization's Twilio resources.",
    );
    err.status = 403;
    throw err;
  }
  return req.orgId;
}

function isE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(String(phone || ""));
}

function guessCountryFromE164(phone) {
  const value = String(phone || "");
  if (value.startsWith("+1")) return "US";
  if (value.startsWith("+44")) return "GB";
  if (value.startsWith("+234")) return "NG";
  if (value.startsWith("+61")) return "AU";
  if (value.startsWith("+353")) return "IE";
  if (value.startsWith("+64")) return "NZ";
  return "UNKNOWN";
}

async function saveNumberRecord(db, payload) {
  const now = new Date().toISOString();
  const row = {
    organization_id: payload.organizationId,
    twilio_account_id: payload.twilioAccountId || null,
    phone_number: payload.phoneNumber,
    phone_sid: payload.phoneSid,
    account_sid: payload.accountSid,
    iso_country: normalizeCountry(payload.isoCountry || payload.country || ""),
    number_type: payload.numberType || "unknown",
    capabilities: payload.capabilities || {},
    address_requirements: payload.addressRequirements || "none",
    regulatory_status: payload.regulatoryStatus || "unknown",
    bundle_sid: payload.bundleSid || null,
    address_sid: payload.addressSid || null,
    regulation_sid: payload.regulationSid || null,
    regulatory_next_action: payload.regulatoryNextAction || null,
    voice_url: payload.voiceUrl || "",
    voice_fallback_url: payload.voiceFallbackUrl || "",
    status_callback_url: payload.statusCallback || "",
    sms_url: payload.smsUrl || "",
    sms_fallback_url: payload.smsFallbackUrl || "",
    assigned_voice_agent_id: payload.agentId || null,
    source: payload.source || "purchased",
    purchase_origin: payload.purchaseOrigin || "in_app_purchase",
    verification_method: payload.verificationMethod || "api_ownership",
    verification_status: payload.verificationStatus || "verified",
    selected_outbound_voice_countries:
      payload.selectedOutboundVoiceCountries || [],
    selected_sms_countries: payload.selectedSmsCountries || [],
    configuration_status: payload.configurationStatus || "needs_configuration",
    updated_at: now,
  };

  const { data: existing } = await db
    .from("twilio_phone_numbers")
    .select("id")
    .eq("organization_id", payload.organizationId)
    .eq("phone_sid", payload.phoneSid)
    .maybeSingle();

  if (existing?.id) {
    const { data, error } = await db
      .from("twilio_phone_numbers")
      .update(row)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from("twilio_phone_numbers")
    .insert({ ...row, created_at: now })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateLegacyAgentNumber(
  db,
  { organizationId, agentId, phoneNumber, phoneSid, source },
) {
  if (!agentId) return;
  await db
    .from("voice_agents")
    .update({
      twilio_phone_number: phoneNumber,
      twilio_phone_sid: phoneSid,
      number_source: source || "purchased",
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
    .eq("organization_id", organizationId);
}

async function storeVoicePermissionResults(
  db,
  { organizationId, twilioAccountId, countries, result },
) {
  const now = new Date().toISOString();
  const rows = (countries || []).map((country) => ({
    organization_id: organizationId,
    twilio_account_id: twilioAccountId || null,
    channel: "voice",
    iso_country: normalizeCountry(country),
    low_risk_voice_enabled: !!result?.success,
    high_risk_special_numbers_enabled: false,
    high_risk_tollfraud_numbers_enabled: false,
    status: result?.success ? "enabled" : "failed",
    last_error: result?.success
      ? null
      : result?.message || "Could not enable voice dialing permission.",
    raw_result: result || {},
    updated_at: now,
  }));
  for (const row of rows) {
    const { data: existing } = await db
      .from("twilio_geo_permissions")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("channel", row.channel)
      .eq("iso_country", row.iso_country)
      .maybeSingle()
      .catch(() => ({ data: null }));
    if (existing?.id)
      await db
        .from("twilio_geo_permissions")
        .update(row)
        .eq("id", existing.id)
        .catch(() => {});
    else
      await db
        .from("twilio_geo_permissions")
        .insert({ ...row, created_at: now })
        .catch(() => {});
  }
}

async function refreshAndPersistReadiness(numberId, organizationId) {
  const readiness = await getTwilioNumberReadiness(numberId, {
    organizationId,
  });
  await persistReadiness(numberId, readiness);
  return readiness;
}

async function writeAudit(
  db,
  { organizationId, userId, action, entityType, entityId, metadata },
) {
  await db
    .from("audit_logs")
    .insert({
      organization_id: organizationId || null,
      user_id: userId || null,
      action,
      entity_type: entityType || null,
      entity_id: entityId || null,
      metadata: metadata || {},
    })
    .catch(() => {});
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value.countries)) return value.countries;
  return [];
}
function isPlatformAdminUser(req) {
  const identifiers = [req.user?.id, req.user?.email]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const configured = (
    process.env.PLATFORM_ADMIN_USER_IDS ||
    process.env.PLATFORM_ADMIN_EMAILS ||
    ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.length) {
    return identifiers.some((value) => configured.includes(value));
  }

  // Compatibility fallback for single-owner deployments. In multi-tenant
  // production, set PLATFORM_ADMIN_USER_IDS/EMAILS and leave this unset.
  return (
    process.env.ALLOW_OWNER_MASTER_TWILIO_SYNC === "true" &&
    req.user?.role === "Owner"
  );
}

function normalizeStringList(value) {
  if (Array.isArray(value))
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberSourceLabel(source, twilioFound = true) {
  if (source === "purchased")
    return twilioFound
      ? "Purchased via Agently"
      : "Purchased (not found on Twilio)";
  if (source === "existing_twilio_number") return "Existing Twilio number";
  if (source === "external_twilio_account") return "External Twilio account";
  if (source === "imported") return "Imported (voice verified)";
  if (source === "sms_verified") return "Imported (SMS verified)";
  if (source === "legacy_voice_agent") return "Legacy assigned number";
  return source || "Twilio number";
}

function numberCapabilitiesFrom(row, latest) {
  const raw = latest?.capabilities || row?.capabilities || {};
  return {
    voice:
      raw.voice === true ||
      raw.voice === "true" ||
      raw.voice === "True" ||
      raw.voice === "1",
    sms:
      raw.sms === true ||
      raw.SMS === true ||
      raw.sms === "true" ||
      raw.SMS === "true" ||
      raw.sms === "True" ||
      raw.SMS === "True" ||
      raw.sms === "1" ||
      raw.SMS === "1",
    mms:
      raw.mms === true ||
      raw.MMS === true ||
      raw.mms === "true" ||
      raw.MMS === "true" ||
      raw.mms === "True" ||
      raw.MMS === "True" ||
      raw.mms === "1" ||
      raw.MMS === "1",
  };
}

function ownedNumberResponse(row, latest = null, agent = null, warning = null) {
  const sid = latest?.sid || row.phone_sid || row.twilio_phone_sid;
  const phoneNumber =
    latest?.phoneNumber ||
    latest?.phone_number ||
    row.phone_number ||
    row.twilio_phone_number;
  const source = row.source || row.number_source || "purchased";
  const agentId =
    row.assigned_voice_agent_id || agent?.id || row.agent_id || null;
  const agentName = agent?.name || row.agent_name || row.name || null;
  const twilioFound = !warning;

  return {
    sid,
    phoneSid: sid,
    phoneNumber,
    friendlyName:
      latest?.friendlyName || latest?.friendly_name || agentName || phoneNumber,
    voiceUrl: latest?.voiceUrl || latest?.voice_url || row.voice_url || "",
    smsUrl: latest?.smsUrl || latest?.sms_url || row.sms_url || "",
    dateCreated:
      latest?.dateCreated || latest?.date_created || row.created_at || null,
    capabilities: numberCapabilitiesFrom(row, latest),
    agentId,
    agentName,
    assignedAgent: agentId ? { id: agentId, name: agentName } : null,
    source,
    sourceLabel: numberSourceLabel(source, twilioFound),
    accountSid:
      row.account_sid || latest?.accountSid || latest?.account_sid || null,
    twilioNumberId: row.twilio_number_id || row.id || null,
    overallStatus: row.overall_status || row.configuration_status || null,
    readinessStatus: row.overall_status || row.configuration_status || null,
    warning: warning || undefined,
  };
}

async function fetchLatestOwnedNumber(row) {
  const phoneSid = row.phone_sid || row.twilio_phone_sid;
  const accountSid = row.account_sid || masterSid();
  if (!phoneSid) return null;
  if (phoneSid.startsWith("SMS_VERIFIED_")) return null;

  if (phoneSid.startsWith("PN")) {
    return fetchIncomingNumber({ accountSid, phoneSid });
  }

  if (phoneSid.startsWith("CA")) {
    const data = await twilioRequest({
      method: "GET",
      accountSid,
      path: `/OutgoingCallerIds/${phoneSid}.json`,
    });
    return {
      sid: data.sid,
      phoneNumber:
        data.phone_number || row.phone_number || row.twilio_phone_number,
      friendlyName: data.friendly_name || row.agent_name || row.name,
      dateCreated: data.date_created,
      capabilities: { voice: true, sms: false, mms: false },
    };
  }

  return null;
}

router.post(
  "/accounts/ensure-subaccount",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    try {
      const account = await ensureTenantTwilioAccount({
        organizationId: bodyOrg(req),
        organizationName: req.organization?.name,
        createIfMissing: true,
      });
      res.json({
        success: true,
        account: {
          id: account.id,
          accountSid: account.account_sid,
          status: account.status,
          authMode: account.auth_mode,
        },
      });
    } catch (err) {
      const mapped = mapTwilioError(
        err,
        "Could not create or load this tenant's Twilio subaccount.",
      );
      res
        .status(err.code === "MIGRATION_REQUIRED" ? 500 : 400)
        .json({ error: mapped });
    }
  }),
);

router.get(
  "/accounts/current",
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await ensureTenantTwilioAccount({
      organizationId: req.orgId,
      organizationName: req.organization?.name,
      createIfMissing: false,
    });
    res.json({
      account: {
        id: account.id || null,
        accountSid: account.account_sid,
        status: account.status || "active",
        isFallbackMaster: !!account.isFallbackMaster,
      },
    });
  }),
);

// New POST contract. The legacy GET /numbers/search route below is kept for compatibility.
router.post(
  "/numbers/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const showAdvancedRestrictedNumbers =
      !!req.body?.showAdvancedRestrictedNumbers &&
      ["Owner", "Admin"].includes(req.user?.role);
    const requiresSms = !!req.body?.requiresSms;
    const requiresVoice = req.body?.requiresVoice !== false;
    const country = normalizeCountry(req.body?.country || "US");

    if (!supportedCountries().includes(country)) {
      return res.status(400).json({
        error: {
          code: "UNSUPPORTED_COUNTRY",
          message: `Agently is not currently configured to sell numbers in ${country}.`,
          supportedCountries: supportedCountries(),
        },
      });
    }

    const account = await ensureTenantTwilioAccount({
      organizationId,
      organizationName: req.organization?.name,
      createIfMissing: false,
    });

    try {
      const numbers = await searchAvailableRecommendedNumbers({
        accountSid: account.account_sid,
        country,
        areaCode: req.body?.areaCode,
        contains: req.body?.contains,
        requiresSms,
        requiresVoice,
        showAdvancedRestrictedNumbers,
        limit: req.body?.limit || 40,
        type: req.body?.type || req.body?.numberType || "Local",
      });
      res.json({
        numbers,
        supportedCountries: supportedCountries(),
        lowRiskVoiceCountries: lowRiskCountries(),
      });
    } catch (err) {
      const mapped = mapTwilioError(err, "Could not search Twilio numbers.");
      res.status(400).json({ error: mapped });
    }
  }),
);

router.post(
  "/numbers/purchase",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const phoneNumber = normalizePhone(
      req.body?.phoneNumber || req.body?.selectedPhoneNumber || "",
    );
    const country = normalizeCountry(
      req.body?.country || req.body?.selectedCountry || "US",
    );
    const agentId =
      req.body?.agentId ||
      req.body?.voiceAgentId ||
      req.organization?.active_voice_agent_id ||
      null;
    const selectedOutboundVoiceCountries = [
      ...new Set(
        [country, ...(req.body?.selectedOutboundVoiceCountries || [])]
          .map(normalizeCountry)
          .filter(Boolean),
      ),
    ];

    if (!phoneNumber)
      return res
        .status(400)
        .json({ error: { message: "phoneNumber is required." } });
    if (agentId) {
      const { data: agent } = await getSupabase()
        .from("voice_agents")
        .select("id,name")
        .eq("id", agentId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!agent)
        return res.status(404).json({
          error: { message: "Voice agent not found for this organization." },
        });
    }

    const db = getSupabase();
    try {
      const account = await ensureTenantTwilioAccount({
        organizationId,
        organizationName: req.organization?.name,
        createIfMissing: true,
      });
      const purchased = await purchaseIncomingNumber({
        accountSid: account.account_sid,
        phoneNumber,
        friendlyName: `${req.organization?.name || "Agently"} ${phoneNumber}`,
        agentId,
      });
      const normalized = {
        phoneSid: purchased.sid,
        phoneNumber: purchased.phone_number || phoneNumber,
        accountSid: purchased.account_sid || account.account_sid,
        country: purchased.iso_country || country,
        capabilities: {
          voice: !!purchased.capabilities?.voice,
          sms: !!(purchased.capabilities?.SMS || purchased.capabilities?.sms),
          mms: !!(purchased.capabilities?.MMS || purchased.capabilities?.mms),
        },
        addressRequirements: purchased.address_requirements || "none",
        voiceUrl:
          purchased.voice_url || `${apiBaseUrl()}/api/twilio/voice-inbound`,
        voiceFallbackUrl:
          purchased.voice_fallback_url ||
          `${apiBaseUrl()}/api/twilio/voice-inbound`,
        statusCallback:
          purchased.status_callback || `${apiBaseUrl()}/api/twilio/call-status`,
        smsUrl: purchased.sms_url || `${apiBaseUrl()}/api/twilio/sms-inbound`,
        smsFallbackUrl:
          purchased.sms_fallback_url ||
          `${apiBaseUrl()}/api/twilio/sms-inbound`,
        bundleSid: purchased.bundle_sid || null,
        addressSid: purchased.address_sid || null,
      };
      const saved = await saveNumberRecord(db, {
        organizationId,
        twilioAccountId: account.id || null,
        ...normalized,
        agentId,
        source: "purchased",
        purchaseOrigin: "in_app_purchase",
        selectedOutboundVoiceCountries,
        configurationStatus: "configured",
      });
      await updateLegacyAgentNumber(db, {
        organizationId,
        agentId,
        phoneNumber: saved.phone_number,
        phoneSid: saved.phone_sid,
        source: "purchased",
      });

      let voicePermissionResult = null;
      try {
        voicePermissionResult = await applyVoiceDialingPermissions({
          accountSid: account.account_sid,
          countries: selectedOutboundVoiceCountries,
        });
        await storeVoicePermissionResults(db, {
          organizationId,
          twilioAccountId: account.id,
          countries: selectedOutboundVoiceCountries,
          result: voicePermissionResult,
        });
      } catch (err) {
        voicePermissionResult = {
          success: false,
          error: mapTwilioError(
            err,
            "Could not update voice dialing permissions.",
          ),
        };
        await storeVoicePermissionResults(db, {
          organizationId,
          twilioAccountId: account.id,
          countries: selectedOutboundVoiceCountries,
          result: voicePermissionResult,
        });
      }

      const readiness = await refreshAndPersistReadiness(
        saved.id,
        organizationId,
      );
      await writeAudit(db, {
        organizationId,
        userId: req.user?.id,
        action: "twilio_number_purchased",
        entityType: "twilio_phone_number",
        entityId: saved.id,
        metadata: {
          phoneNumber: saved.phone_number,
          phoneSid: saved.phone_sid,
        },
      });
      res.json({
        success: true,
        phoneNumber: saved.phone_number,
        phoneSid: saved.phone_sid,
        agentId,
        number: saved,
        readiness,
        voicePermissionResult,
      });
    } catch (err) {
      const mapped = mapTwilioError(
        err,
        "Could not purchase and configure this Twilio number.",
      );
      res
        .status(err.code === "MIGRATION_REQUIRED" ? 500 : 400)
        .json({ error: mapped });
    }
  }),
);

router.post(
  "/numbers/sync-owned",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const db = getSupabase();
    const explicitPhoneNumbers = normalizeStringList(
      req.body?.phoneNumbers || req.body?.phoneNumber,
    );
    const explicitPhoneSids = normalizeStringList(
      req.body?.phoneSids || req.body?.phoneSid,
    );
    const explicitRequested =
      explicitPhoneNumbers.length > 0 || explicitPhoneSids.length > 0;
    const includeMasterAccount = !!(
      req.body?.includeMasterAccount ||
      req.body?.syncMasterAccount ||
      req.body?.accountScope === "master"
    );

    try {
      const tenantAccount = await ensureTenantTwilioAccount({
        organizationId,
        organizationName: req.organization?.name,
        createIfMissing: false,
      });

      const accountsToQuery = [];
      const tenantHasDedicatedSubaccount =
        tenantAccount?.account_sid &&
        !tenantAccount.isFallbackMaster &&
        tenantAccount.account_sid !== masterSid();

      if (tenantHasDedicatedSubaccount && !includeMasterAccount) {
        accountsToQuery.push({
          accountSid: tenantAccount.account_sid,
          twilioAccountId: tenantAccount.id || null,
          scope: "tenant_subaccount",
        });
      } else {
        if (!isPlatformAdminUser(req)) {
          return res.status(403).json({
            error: {
              code: "PLATFORM_ADMIN_REQUIRED",
              message:
                "Master-account number sync requires platform admin permission. Configure a tenant subaccount, or ask a platform admin to sync explicitly selected numbers.",
            },
          });
        }
        if (!explicitRequested) {
          return res.status(400).json({
            error: {
              code: "EXPLICIT_MASTER_NUMBER_SELECTION_REQUIRED",
              message:
                "For safety, master-account sync requires explicit phoneNumbers or phoneSids. Unrestricted master-account sync is blocked.",
            },
          });
        }
        accountsToQuery.push({
          accountSid: masterSid(),
          twilioAccountId: null,
          scope: "master_explicit",
        });
        if (tenantHasDedicatedSubaccount && includeMasterAccount) {
          accountsToQuery.push({
            accountSid: tenantAccount.account_sid,
            twilioAccountId: tenantAccount.id || null,
            scope: "tenant_subaccount",
          });
        }
      }

      const imported = [];
      const seen = new Set();
      for (const account of accountsToQuery) {
        if (!account.accountSid) continue;
        let numbers = await listIncomingNumbers({
          accountSid: account.accountSid,
        });
        if (account.scope === "master_explicit") {
          numbers = numbers.filter(
            (n) =>
              explicitPhoneNumbers.includes(n.phoneNumber) ||
              explicitPhoneSids.includes(n.sid),
          );
        }
        for (const n of numbers) {
          if (seen.has(n.sid)) continue;
          seen.add(n.sid);
          const saved = await saveNumberRecord(db, {
            organizationId,
            twilioAccountId: account.twilioAccountId,
            phoneNumber: n.phoneNumber,
            phoneSid: n.sid,
            accountSid: n.accountSid || account.accountSid,
            country: n.country,
            capabilities: n.capabilities,
            addressRequirements: n.addressRequirements,
            voiceUrl: n.voiceUrl,
            voiceFallbackUrl: n.voiceFallbackUrl,
            statusCallback: n.statusCallback,
            smsUrl: n.smsUrl,
            smsFallbackUrl: n.smsFallbackUrl,
            bundleSid: n.bundleSid,
            addressSid: n.addressSid,
            source: "existing_twilio_number",
            purchaseOrigin: "previously_purchased",
            configurationStatus: "needs_configuration",
          });
          const readiness = await refreshAndPersistReadiness(
            saved.id,
            organizationId,
          );
          imported.push({ ...saved, readiness, syncScope: account.scope });
        }
      }

      await writeAudit(db, {
        organizationId,
        userId: req.user?.id,
        action: "twilio_numbers_synced",
        entityType: "twilio_phone_number",
        metadata: {
          count: imported.length,
          scopes: accountsToQuery.map((a) => a.scope),
          explicitPhoneNumbers,
          explicitPhoneSids,
        },
      });
      res.json({ success: true, numbers: imported });
    } catch (err) {
      const mapped = mapTwilioError(
        err,
        "Could not sync owned Twilio numbers.",
      );
      res
        .status(err.code === "MIGRATION_REQUIRED" ? 500 : 400)
        .json({ error: mapped });
    }
  }),
);

router.post(
  "/numbers/:id/configure-existing",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const numberId = req.params.id;
    const agentId =
      req.body?.agentId ||
      req.body?.voiceAgentId ||
      req.organization?.active_voice_agent_id;
    const overwrite = !!req.body?.overwriteExistingWebhooks;
    const db = getSupabase();

    const { data: number, error } = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("id", numberId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!number)
      return res.status(404).json({
        error: { message: "Number not found for this organization." },
      });

    const latest = await fetchIncomingNumber({
      accountSid: number.account_sid,
      phoneSid: number.phone_sid,
    });
    const existingVoiceExternal =
      latest.voiceUrl && !latest.voiceUrl.includes("/api/twilio/voice-inbound");
    const existingSmsExternal =
      latest.smsUrl && !latest.smsUrl.includes("/api/twilio/sms-inbound");
    if (!overwrite && (existingVoiceExternal || existingSmsExternal)) {
      return res.status(409).json({
        warning: true,
        code: "WEBHOOK_OVERWRITE_CONFIRMATION_REQUIRED",
        message:
          "This number already has webhook URLs that do not point to Agently. Confirm overwriteExistingWebhooks=true before changing them.",
        currentWebhooks: { voiceUrl: latest.voiceUrl, smsUrl: latest.smsUrl },
      });
    }

    const configured = await configureTwilioIncomingNumber(number.phone_sid, {
      accountSid: number.account_sid,
      supportsSms: latest.capabilities?.sms,
      addressSid: number.address_sid || latest.addressSid,
      bundleSid: number.bundle_sid || latest.bundleSid,
    });
    const selectedOutboundVoiceCountries = [
      ...new Set(
        [
          normalizeCountry(number.iso_country),
          ...(req.body?.selectedOutboundVoiceCountries || []),
        ].filter(Boolean),
      ),
    ];
    await saveNumberRecord(db, {
      organizationId,
      twilioAccountId: number.twilio_account_id,
      phoneNumber: configured.phone_number || number.phone_number,
      phoneSid: configured.sid || number.phone_sid,
      accountSid: configured.account_sid || number.account_sid,
      country: configured.iso_country || number.iso_country,
      capabilities: {
        voice: !!configured.capabilities?.voice,
        sms: !!(configured.capabilities?.SMS || configured.capabilities?.sms),
        mms: !!(configured.capabilities?.MMS || configured.capabilities?.mms),
      },
      addressRequirements:
        configured.address_requirements || number.address_requirements,
      voiceUrl: configured.voice_url,
      voiceFallbackUrl: configured.voice_fallback_url,
      statusCallback: configured.status_callback,
      smsUrl: configured.sms_url,
      smsFallbackUrl: configured.sms_fallback_url,
      bundleSid: configured.bundle_sid || number.bundle_sid,
      addressSid: configured.address_sid || number.address_sid,
      agentId,
      source: number.source || "existing_twilio_number",
      purchaseOrigin: number.purchase_origin || "previously_purchased",
      selectedOutboundVoiceCountries,
      configurationStatus: "configured",
    });
    await updateLegacyAgentNumber(db, {
      organizationId,
      agentId,
      phoneNumber: number.phone_number,
      phoneSid: number.phone_sid,
      source: number.source || "existing_twilio_number",
    });

    let voicePermissionResult = null;
    try {
      voicePermissionResult = await applyVoiceDialingPermissions({
        accountSid: number.account_sid,
        countries: selectedOutboundVoiceCountries,
      });
      await storeVoicePermissionResults(db, {
        organizationId,
        twilioAccountId: number.twilio_account_id,
        countries: selectedOutboundVoiceCountries,
        result: voicePermissionResult,
      });
    } catch (err) {
      voicePermissionResult = {
        success: false,
        error: mapTwilioError(
          err,
          "Could not update voice dialing permissions.",
        ),
      };
    }

    const readiness = await refreshAndPersistReadiness(
      numberId,
      organizationId,
    );
    await writeAudit(db, {
      organizationId,
      userId: req.user?.id,
      action: "twilio_number_configured",
      entityType: "twilio_phone_number",
      entityId: numberId,
      metadata: { overwriteExistingWebhooks: overwrite },
    });
    res.json({
      success: true,
      readiness,
      configuredNumber: configured,
      voicePermissionResult,
    });
  }),
);

router.post(
  "/numbers/:id/voice-countries",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const countries = (req.body?.countries || [])
      .map(normalizeCountry)
      .filter(Boolean);
    const allowHighRiskSpecialNumbers =
      !!req.body?.allowHighRiskSpecialNumbers && req.user?.role === "Owner";
    const allowHighRiskTollFraudNumbers =
      !!req.body?.allowHighRiskTollFraudNumbers && req.user?.role === "Owner";
    const db = getSupabase();
    const { data: number } = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!number)
      return res.status(404).json({ error: { message: "Number not found." } });

    try {
      const result = await applyVoiceDialingPermissions({
        accountSid: number.account_sid,
        countries,
        allowHighRiskSpecialNumbers,
        allowHighRiskTollFraudNumbers,
      });
      await storeVoicePermissionResults(db, {
        organizationId,
        twilioAccountId: number.twilio_account_id,
        countries,
        result,
      });
      await db
        .from("twilio_phone_numbers")
        .update({
          selected_outbound_voice_countries: countries,
          updated_at: new Date().toISOString(),
        })
        .eq("id", number.id);
      const readiness = await refreshAndPersistReadiness(
        number.id,
        organizationId,
      );
      res.json({
        success: !!result.success,
        message: result.success
          ? "Voice dialing permissions updated or requested."
          : result.message,
        result,
        readiness,
      });
    } catch (err) {
      const mapped = mapTwilioError(
        err,
        "Could not update voice dialing permissions.",
      );
      res.status(400).json({ error: mapped });
    }
  }),
);

router.post(
  "/numbers/:id/sms-countries",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const countries = (req.body?.countries || [])
      .map(normalizeCountry)
      .filter(Boolean);
    const db = getSupabase();
    const { data: number } = await db
      .from("twilio_phone_numbers")
      .select("id,capabilities")
      .eq("id", req.params.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!number)
      return res.status(404).json({ error: { message: "Number not found." } });
    await db
      .from("twilio_phone_numbers")
      .update({
        selected_sms_countries: countries,
        outbound_sms_status: "pending_manual_action",
        sms_geo_permission_confirmed_by_user: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", number.id);
    const readiness = await refreshAndPersistReadiness(
      number.id,
      organizationId,
    );
    res.json({
      success: true,
      status: "pending_manual_action",
      manualInstructions: buildManualSmsGeoInstructions(countries),
      readiness,
    });
  }),
);

router.post(
  "/numbers/:id/confirm-sms-geo",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const db = getSupabase();
    const { data: number } = await db
      .from("twilio_phone_numbers")
      .select("id")
      .eq("id", req.params.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!number)
      return res.status(404).json({ error: { message: "Number not found." } });
    await db
      .from("twilio_phone_numbers")
      .update({
        sms_geo_permission_confirmed_by_user: true,
        outbound_sms_status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", number.id);
    const readiness = await refreshAndPersistReadiness(
      number.id,
      organizationId,
    );
    res.json({ success: true, readiness });
  }),
);

router.get(
  "/numbers/:id/readiness",
  requireAuth,
  asyncHandler(async (req, res) => {
    const readiness = await refreshAndPersistReadiness(
      req.params.id,
      req.orgId,
    );
    res.json({ readiness });
  }),
);

router.post(
  "/calls/outbound",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const toPhone = normalizePhone(req.body?.toPhone || req.body?.to || "");
    const fromNumberId = req.body?.fromNumberId || req.body?.numberId || null;
    const agentId = req.body?.agentId || req.body?.voiceAgentId || null;
    if (!isE164(toPhone))
      return res.status(400).json({
        error: {
          code: "INVALID_PHONE_NUMBER",
          message: "Destination must be an E.164 number like +14155551234.",
        },
      });

    const db = getSupabase();
    let q = db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("organization_id", organizationId);
    if (fromNumberId) q = q.eq("id", fromNumberId);
    else
      q = q.eq(
        "assigned_voice_agent_id",
        agentId || req.organization?.active_voice_agent_id,
      );
    const { data: number } = await q.maybeSingle();
    if (!number)
      return res.status(404).json({
        error: {
          code: "NUMBER_NOT_OWNED",
          message: "No configured from-number was found for this tenant/agent.",
        },
      });

    const capabilities =
      typeof number.capabilities === "string"
        ? JSON.parse(number.capabilities || "{}")
        : number.capabilities || {};
    if (!capabilities.voice)
      return res.status(400).json({
        error: {
          code: "UNSUPPORTED_CAPABILITY",
          message: "The selected from-number does not support voice.",
        },
      });
    const actualAgentId =
      agentId ||
      number.assigned_voice_agent_id ||
      req.organization?.active_voice_agent_id;
    if (!actualAgentId)
      return res.status(400).json({
        error: {
          code: "AGENT_NOT_ASSIGNED",
          message: "Assign an AI agent before placing outbound calls.",
        },
      });

    const readiness = await refreshAndPersistReadiness(
      number.id,
      organizationId,
    );
    if (
      !["ready", "pending_manual_action"].includes(readiness.overall_status) ||
      readiness.inbound_voice.status !== "ready"
    ) {
      return res.status(400).json({
        error: {
          code: "NUMBER_NOT_READY",
          message:
            "This number is not configured for the Agently voice flow yet.",
          readiness,
        },
      });
    }
    const destinationCountry = guessCountryFromE164(toPhone);
    const selected = new Set(
      [
        ...jsonArray(number.selected_outbound_voice_countries),
        normalizeCountry(number.iso_country),
      ].map(normalizeCountry),
    );
    if (!selected.has(destinationCountry) && destinationCountry !== "UNKNOWN") {
      return res.status(400).json({
        error: {
          code: "COUNTRY_NOT_ENABLED",
          message: `Outbound calls to ${destinationCountry} are not selected/enabled for this number.`,
        },
      });
    }

    const { data: agent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", actualAgentId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!agent)
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });

    const record = await createCallRecord({
      organizationId,
      voiceAgentId: agent.id,
      callerName: req.body?.customerName || "Outbound Lead",
      callerPhone: toPhone,
      leadId: req.body?.leadId || null,
      direction: "outbound",
      status: "queued",
      metadata: { initiatedBy: req.user?.id || null, fromNumberId: number.id },
    });

    const base = API_URL();
    const twimlUrl = `${base}/api/twilio/outbound-twiml?agentId=${encodeURIComponent(agent.id)}&callRecordId=${encodeURIComponent(record.id)}`;
    try {
      const result = await makeOutboundCall({
        from: number.phone_number,
        to: toPhone,
        twimlUrl,
        statusCallbackUrl: `${base}/api/twilio/call-status`,
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
    } catch (err) {
      const mapped = mapTwilioError(err, "Could not start outbound call.");
      await updateCallRecordById(record.id, {
        status: "failed",
        metadata: { error: mapped },
      }).catch(() => {});
      res.status(400).json({ error: mapped });
    }
  }),
);

router.post(
  "/import/verify-api",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const accountSid = String(req.body?.accountSid || "").trim();
    const authToken = String(req.body?.authToken || "").trim();
    const phoneNumber = normalizePhone(req.body?.phoneNumber || "");
    if (!accountSid || !authToken || !phoneNumber)
      return res.status(400).json({
        error: {
          message: "accountSid, authToken and phoneNumber are required.",
        },
      });
    try {
      const data = await twilioRequest({
        method: "GET",
        accountSid,
        authSid: accountSid,
        authToken,
        path: "/IncomingPhoneNumbers.json",
        params: { PhoneNumber: phoneNumber, PageSize: "20" },
      });
      const found = (data?.incoming_phone_numbers || [])[0];
      if (!found)
        return res.status(404).json({
          error: {
            code: "NUMBER_NOT_OWNED",
            message:
              "That number was not found in the supplied Twilio account.",
          },
        });
      const n = {
        phoneNumber: found.phone_number,
        phoneSid: found.sid,
        accountSid: found.account_sid || accountSid,
        country: found.iso_country,
        capabilities: {
          voice: !!found.capabilities?.voice,
          sms: !!(found.capabilities?.SMS || found.capabilities?.sms),
          mms: !!(found.capabilities?.MMS || found.capabilities?.mms),
        },
        addressRequirements: found.address_requirements || "none",
        voiceUrl: found.voice_url || "",
        smsUrl: found.sms_url || "",
        bundleSid: found.bundle_sid || null,
        addressSid: found.address_sid || null,
      };
      const saved = await saveNumberRecord(getSupabase(), {
        organizationId,
        ...n,
        source: "external_twilio_account",
        purchaseOrigin: "external",
        verificationMethod: "api_ownership",
        verificationStatus: "verified",
        configurationStatus: "needs_configuration",
      });
      const readiness = await refreshAndPersistReadiness(
        saved.id,
        organizationId,
      );
      res.json({
        success: true,
        number: saved,
        readiness,
        warning:
          "Agently did not store the supplied Auth Token. Reconnect if you need to refresh this external account later.",
      });
    } catch (err) {
      res.status(400).json({
        error: mapTwilioError(
          err,
          "Could not verify API ownership for this Twilio number.",
        ),
      });
    }
  }),
);

router.post(
  "/import/start-webhook-challenge",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const token = require("crypto").randomBytes(16).toString("hex");
    const phoneNumber = normalizePhone(req.body?.phoneNumber || "");
    const callbackUrl = `${apiBaseUrl()}/api/twilio/import/challenge-callback?token=${encodeURIComponent(token)}`;
    await getSupabase()
      .from("twilio_import_challenges")
      .insert({
        organization_id: req.orgId,
        phone_number: phoneNumber,
        challenge_token: token,
        status: "pending",
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      .catch(() => {});
    res.json({
      success: true,
      token,
      challengeUrl: callbackUrl,
      instructions:
        "Paste this URL into the Twilio number VoiceUrl or SmsUrl temporarily. Twilio must call it before the challenge expires.",
    });
  }),
);

router.all(
  "/import/challenge-callback",
  asyncHandler(async (req, res) => {
    const token = req.query?.token || req.body?.token;
    const calledNumber = normalizePhone(req.body?.To || req.query?.To || "");
    const db = getSupabase();
    const { data: challenge } = await db
      .from("twilio_import_challenges")
      .select("*")
      .eq("challenge_token", token)
      .maybeSingle()
      .catch(() => ({ data: null }));
    if (challenge) {
      await db
        .from("twilio_import_challenges")
        .update({
          status: "verified",
          verified_at: new Date().toISOString(),
          twilio_to: calledNumber,
        })
        .eq("id", challenge.id)
        .catch(() => {});
    }
    res.setHeader("Content-Type", "text/xml");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Agently verification successful. You may return to the dashboard.</Say></Response>`,
    );
  }),
);

router.post(
  "/import/attach",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const token = req.body?.token;
    const numberId = req.body?.numberId;
    const agentId =
      req.body?.agentId || req.organization?.active_voice_agent_id;
    const db = getSupabase();
    let number = null;
    if (numberId) {
      const { data } = await db
        .from("twilio_phone_numbers")
        .select("*")
        .eq("id", numberId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      number = data;
    } else if (token) {
      const { data: challenge } = await db
        .from("twilio_import_challenges")
        .select("*")
        .eq("challenge_token", token)
        .eq("organization_id", organizationId)
        .eq("status", "verified")
        .maybeSingle();
      if (challenge) {
        const { data } = await db
          .from("twilio_phone_numbers")
          .select("*")
          .eq("phone_number", challenge.phone_number || challenge.twilio_to)
          .eq("organization_id", organizationId)
          .maybeSingle();
        number = data;
      }
    }
    if (!number)
      return res.status(404).json({
        error: {
          message:
            "Verified/imported number not found. Run API verification or webhook challenge first.",
        },
      });
    await db
      .from("twilio_phone_numbers")
      .update({
        assigned_voice_agent_id: agentId,
        verification_status: "verified",
        updated_at: new Date().toISOString(),
      })
      .eq("id", number.id);
    await updateLegacyAgentNumber(db, {
      organizationId,
      agentId,
      phoneNumber: number.phone_number,
      phoneSid: number.phone_sid,
      source: number.source || "external_twilio_account",
    });
    const readiness = await refreshAndPersistReadiness(
      number.id,
      organizationId,
    );
    res.json({ success: true, readiness });
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
    const numbers = [];
    const seenSids = new Set();

    // STEP 1: New source of truth. These rows include account_sid, so
    // subaccount-purchased numbers are fetched from the correct Twilio account.
    try {
      const { data: numberRows, error: numberErr } = await db
        .from("twilio_phone_numbers")
        .select("*, voice_agents:assigned_voice_agent_id(id,name)")
        .eq("organization_id", req.orgId)
        .order("created_at", { ascending: false });

      if (numberErr && !["42P01", "PGRST205"].includes(numberErr.code)) {
        console.warn(
          "[twilio/numbers/owned] twilio_phone_numbers query failed:",
          numberErr.message,
        );
      }

      for (const row of numberRows || []) {
        const agent = row.voice_agents || null;
        const sid = row.phone_sid;
        if (sid) seenSids.add(sid);
        try {
          const latest = await fetchLatestOwnedNumber(row);
          numbers.push(ownedNumberResponse(row, latest, agent));
        } catch (fetchErr) {
          numbers.push(
            ownedNumberResponse(
              row,
              null,
              agent,
              "This number could not be confirmed on Twilio. It may have been released, moved, or its account credentials may need review.",
            ),
          );
          console.warn(
            `[twilio/numbers/owned] fetch failed for SID ${sid}:`,
            fetchErr.message,
          );
        }
      }
    } catch (err) {
      // Migration may not be applied yet. Fall through to legacy voice_agents.
      console.warn(
        "[twilio/numbers/owned] new table unavailable, using legacy lookup:",
        err.message,
      );
    }

    // STEP 2: Legacy compatibility fallback. Include any legacy agent number
    // not already represented by twilio_phone_numbers.
    const { data: agents, error: agentsErr } = await db
      .from("voice_agents")
      .select("id, name, twilio_phone_number, twilio_phone_sid, number_source")
      .eq("organization_id", req.orgId)
      .neq("twilio_phone_sid", "")
      .not("twilio_phone_sid", "is", null);

    if (agentsErr) {
      console.error("[twilio/numbers/owned] DB error:", agentsErr.message);
      if (!numbers.length)
        return res
          .status(500)
          .json({ error: { message: "Failed to load numbers." } });
    }

    for (const agent of agents || []) {
      if (!agent.twilio_phone_sid || seenSids.has(agent.twilio_phone_sid))
        continue;
      const legacyRow = {
        id: null,
        twilio_number_id: null,
        organization_id: req.orgId,
        phone_sid: agent.twilio_phone_sid,
        phone_number: agent.twilio_phone_number,
        account_sid: masterSid(),
        capabilities: agent.twilio_phone_sid.startsWith("SMS_VERIFIED_")
          ? { voice: false, sms: true, mms: false }
          : { voice: true, sms: false, mms: false },
        source: agent.number_source || "legacy_voice_agent",
        assigned_voice_agent_id: agent.id,
        agent_name: agent.name,
      };

      try {
        const latest = await fetchLatestOwnedNumber(legacyRow);
        numbers.push(ownedNumberResponse(legacyRow, latest, agent));
      } catch (fetchErr) {
        numbers.push(
          ownedNumberResponse(
            legacyRow,
            null,
            agent,
            "This legacy number could not be confirmed on Twilio. It may have been released externally.",
          ),
        );
        console.warn(
          `[twilio/numbers/owned] legacy fetch failed for SID ${agent.twilio_phone_sid}:`,
          fetchErr.message,
        );
      }
    }

    return res.json({ numbers });
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
// ── PROTECTED: Billing compatibility route ───────────────────
// Returns an org-scoped placeholder only. It intentionally does
// not expose master Twilio billing totals.
// ─────────────────────────────────────────────────────────────
router.get(
  "/billing",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    return res.json({
      billing: {
        periodStart,
        voice: { count: "0", minutes: "0", cost: "0.00", currency: "USD" },
        sms: { count: "0", cost: "0.00", currency: "USD" },
        implemented: false,
        orgScoped: true,
        message:
          "Org-scoped billing is not implemented yet. Master Twilio billing is intentionally not exposed.",
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────
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
