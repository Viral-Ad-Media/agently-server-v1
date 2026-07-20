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
  ensureWalletCreditOrRespond,
  getWalletCreditStatus,
  creditStatusToTwimlMessage,
} = require("../../lib/billing-credit-enforcement");
const {
  listSupportedCountries,
  searchAvailableNumbers,
  purchasePhoneNumber,
  updateNumberWebhooks,
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
const {
  logTwilioCallUsage,
  logStorageUsage,
  logOpenAIUsage,
  insertUsageEvent,
} = require("../../lib/usage-ledger");
const { mapTwilioError } = require("../../lib/twilio-errors");
const { checkOpenAIRealtimeProvider } = require("../../lib/ai-provider-health");
const voiceBehavior = require("../../lib/voice-behavior");
const { loadVoiceContext } = require("../../lib/context-builder");
const {
  ensureTenantTwilioAccount,
  searchAvailableRecommendedNumbers,
  purchaseIncomingNumber,
  listIncomingNumbers,
  fetchIncomingNumber,
  releaseIncomingNumber,
  configureTwilioIncomingNumber,
  applyVoiceDialingPermissions,
  buildManualSmsGeoInstructions,
  normalizeCountry,
  supportedCountries,
  lowRiskCountries,
  normalizeCountryList,
  evaluateNumberRecommendation,
  isRecommendedForAutomaticPurchase,
  twilioRequest,
  apiBaseUrl,
  masterSid,
} = require("../../lib/twilio-platform");
const {
  getTwilioNumberReadiness,
  persistReadiness,
} = require("../../lib/twilio-number-readiness");

const router = express.Router();

const API_URL = () => (process.env.API_URL || "").trim().replace(/\/+$/, "");

/** WebSocket base URL — defaults to API_URL but can be overridden for separate WS server */
function normalizeWebSocketBase(value) {
  const base = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  return base.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

const WS_URL = () => {
  const explicit = (process.env.TWILIO_WS_URL || "").trim().replace(/\/+$/, "");
  return normalizeWebSocketBase(explicit || API_URL());
};

function callRecordingEnabled() {
  return (
    String(process.env.CALL_RECORDING_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false"
  );
}

function recordingStatusCallbackUrl() {
  const base = API_URL();
  return base ? new URL("/api/twilio/recording-status", base).toString() : "";
}

function recordingStartTwiml() {
  if (!callRecordingEnabled()) return "";
  const callback = recordingStatusCallbackUrl();
  if (!callback) return "";
  return `  <Start>
    <Recording channels="dual" track="both" recordingStatusCallback="${safeXmlText(callback)}" recordingStatusCallbackEvent="in-progress completed absent" />
  </Start>
`;
}

function maybeAddInboundRecording(twiml, direction) {
  if (String(direction || "").toLowerCase() === "outbound") return twiml;
  const recordingXml = recordingStartTwiml();
  if (!recordingXml) return twiml;
  console.log("[recording] started", { direction: direction || "inbound" });
  return String(twiml || "").replace(
    "<Response>\n",
    `<Response>\n${recordingXml}`,
  );
}

function mergeMetadata(existing, patch) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  return { ...base, ...(patch || {}) };
}

async function updateCallRecordMetadataBySid(
  callSid,
  metadataPatch,
  columnsPatch = {},
) {
  if (!callSid) return null;
  const db = getSupabase();
  try {
    const { data: existing } = await db
      .from("call_records")
      .select("id, metadata")
      .eq("twilio_call_sid", callSid)
      .maybeSingle();
    if (!existing?.id) return null;
    const patch = {
      ...columnsPatch,
      metadata: mergeMetadata(existing.metadata, metadataPatch),
    };
    const { data, error } = await db
      .from("call_records")
      .update(patch)
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (error)
      console.warn("[call-record] metadata update failed:", error.message);
    return data || null;
  } catch (err) {
    console.warn(
      "[call-record] metadata update failed:",
      err.message || String(err),
    );
    return null;
  }
}

async function loadCallRecordForRecording(callSid) {
  if (!callSid) return null;
  const db = getSupabase();
  const { data, error } = await db
    .from("call_records")
    .select("id, organization_id, transcript, summary, metadata")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (error) {
    console.warn("[recording] call record lookup failed", {
      callSid,
      error: error.message,
    });
    return null;
  }
  return data || null;
}

function twilioBasicAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return "";
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

async function downloadTwilioRecordingMp3(recordingUrl) {
  if (!recordingUrl) throw new Error("Missing RecordingUrl");
  const mediaUrl = String(recordingUrl).endsWith(".mp3")
    ? String(recordingUrl)
    : `${recordingUrl}.mp3`;
  const auth = twilioBasicAuthHeader();
  if (!auth)
    throw new Error("Missing Twilio credentials for recording download");
  const res = await fetch(mediaUrl, { headers: { Authorization: auth } });
  if (!res.ok)
    throw new Error(`Twilio recording download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mediaUrl,
    mimeType: res.headers.get("content-type") || "audio/mpeg",
  };
}

async function uploadRecordingToSupabase({
  callRecord,
  recordingSid,
  buffer,
  mimeType,
}) {
  const provider = String(
    process.env.CALL_RECORDING_STORAGE_PROVIDER || "supabase",
  ).toLowerCase();
  if (provider !== "supabase") return { skipped: true, provider };
  const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || "call-recordings";
  if (!callRecord?.organization_id || !callRecord?.id || !recordingSid) {
    throw new Error("Missing call record identifiers for recording upload");
  }
  const storagePath = `${callRecord.organization_id}/${callRecord.id}/${recordingSid}.mp3`;
  const db = getSupabase();
  const { error } = await db.storage.from(bucket).upload(storagePath, buffer, {
    contentType: mimeType || "audio/mpeg",
    upsert: true,
  });
  if (error)
    throw new Error(error.message || "Supabase recording upload failed");
  return { provider: "supabase", bucket, storagePath };
}

function transcriptToText(transcript) {
  if (!transcript) return "";
  if (Array.isArray(transcript)) {
    return transcript
      .map(
        (t) =>
          `${t.role || t.speaker || "speaker"}: ${t.text || t.transcript || ""}`,
      )
      .join("\n");
  }
  if (typeof transcript === "string") return transcript;
  return "";
}

async function transcribeRecordingWithOpenAI({
  buffer,
  filename = "call-recording.mp3",
}) {
  if (
    String(process.env.TRANSCRIBE_CALL_RECORDINGS || "false").toLowerCase() !==
    "true"
  ) {
    return { skipped: true, status: "disabled" };
  }
  if (
    String(process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase() !==
    "openai"
  ) {
    return { skipped: true, status: "provider_disabled" };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { skipped: true, status: "missing_openai_key" };
  const maxBytes = Number(
    process.env.OPENAI_TRANSCRIPTION_MAX_BYTES || 24 * 1024 * 1024,
  );
  if (buffer.length > maxBytes)
    return { skipped: true, status: "file_too_large" };
  const model =
    process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([buffer], { type: "audio/mpeg" }), filename);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!res.ok)
    throw new Error(
      data?.error?.message ||
        data?.message ||
        `OpenAI transcription failed: ${res.status}`,
    );
  return {
    skipped: false,
    status: "completed",
    model,
    text: data?.text || "",
    raw: data,
  };
}

function makeShortSummary(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 1200) : "";
}

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function phoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function maskSid(sid) {
  const value = String(sid || "");
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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
  const url = new URL("/api/twilio/media-stream", wsBase);
  const includeQueryParams =
    String(process.env.TWILIO_STREAM_QUERY_PARAMS || "true")
      .trim()
      .toLowerCase() !== "false";
  if (includeQueryParams) {
    // Twilio sends <Parameter> values inside the stream start event, but the
    // realtime server needs the critical IDs before the first audio packet so it
    // can load the correct agent and Knowledge Base without a silent delay.
    const criticalKeys = new Set([
      "orgId",
      "organizationId",
      "agentId",
      "callRecordId",
      "callSid",
      "direction",
      "leadId",
      "scheduleId",
      "recipientName",
      "targetName",
      "callPurpose",
      "openingGreeting",
      "greetingMessage",
      "agentName",
      "organizationName",
      "knowledgeBaseId",
      "knowledgeBaseName",
      "accountSid",
      "twilioAccountSid",
      "fromAccountSid",
      "openAiVoice",
      "selectedVoiceId",
      "selectedVoiceName",
    ]);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (!criticalKeys.has(key)) return;
      if (value === undefined || value === null || value === "") return;
      const clean = String(value);
      url.searchParams.set(
        key,
        clean.length > 900 ? clean.slice(0, 900) : clean,
      );
    });
  }
  return url.toString();
}

function buildRealtimeTwiml({
  agent,
  organization = null,
  callRecordId,
  callSid,
  direction,
  callerPhone,
  recipientPhone,
  recipientName,
  targetName,
  leadId,
  callPurpose,
  customInstructions,
  voiceProviderOverride,
  voiceProviderFallbackReason,
  scheduleId,
  scheduleRunId,
  maxCallSeconds,
  platformTestMode,
  platformTestEventId,
  precomputedOpeningGreeting = "",
  precomputedNormalizedPurpose = "",
  accountSid = "",
}) {
  const normalizedPurpose =
    precomputedNormalizedPurpose ||
    voiceBehavior.humanizeOutboundPurposeForSpeech(callPurpose || "", 220);
  const openingGreeting =
    String(precomputedOpeningGreeting || "").trim() ||
    preparedOpeningGreetingForCall({
      agent,
      organization,
      direction,
      recipientName,
      targetName,
      callPurpose,
    });
  console.log("[context-audit] purpose intent", {
    raw_call_purpose: String(callPurpose || "").slice(0, 240),
    normalized_call_purpose: normalizedPurpose,
    product_intent_explicit:
      voiceBehavior.purposeExplicitlyMentionsProducts?.(callPurpose || "") ||
      false,
    webinar_intent_explicit:
      voiceBehavior.purposeExplicitlyMentionsWebinar?.(callPurpose || "") ||
      false,
  });
  console.log("[outbound-call] opening greeting prepared before answer", {
    callSid: callSid || "",
    agentId: agent?.id || "",
    direction: direction || "inbound",
    hasRecipientName: Boolean(recipientName || targetName),
    greetingChars: openingGreeting.length,
  });
  console.log("[outbound-call] agent voice row", {
    callSid: callSid || "",
    agentId: agent?.id || "",
    voice_provider: agent?.voice_provider || "",
    elevenlabs_voice_id: agent?.elevenlabs_voice_id || "",
    elevenlabs_voice_name: agent?.elevenlabs_voice_name || "",
    voice_id: agent?.voice_id || "",
    voice: agent?.voice || "",
  });
  const agentVoiceProvider = String(agent.voice_provider || "")
    .trim()
    .toLowerCase();
  const hasElevenLabsVoiceId = Boolean(
    String(agent.elevenlabs_voice_id || "").trim(),
  );
  const selectedVoiceProvider =
    agentVoiceProvider === "elevenlabs" || hasElevenLabsVoiceId
      ? "elevenlabs"
      : agentVoiceProvider === "openai"
        ? "openai"
        : "";
  const selectedElevenLabsVoiceId =
    selectedVoiceProvider === "elevenlabs"
      ? String(agent.elevenlabs_voice_id || agent.voice_id || "").trim()
      : "";
  const selectedElevenLabsVoiceName =
    selectedVoiceProvider === "elevenlabs"
      ? String(agent.elevenlabs_voice_name || agent.voice || "").trim()
      : "";
  const selectedOpenAiVoice =
    selectedVoiceProvider === "openai"
      ? String(
          agent.openai_voice ||
            agent.openai_voice_id ||
            agent.voice_id ||
            agent.voice ||
            "",
        ).trim()
      : String(agent.openai_voice || agent.openai_voice_id || "").trim();
  const selectedVoiceProfile =
    selectedVoiceProvider === "elevenlabs"
      ? selectedElevenLabsVoiceName || selectedElevenLabsVoiceId
      : selectedOpenAiVoice || String(agent.voice || "").trim();

  if (
    selectedVoiceProvider === "elevenlabs" &&
    agent.voice &&
    selectedVoiceProfile &&
    agent.voice !== selectedVoiceProfile
  ) {
    console.warn(
      "[voice-provider] legacy voice ignored for ElevenLabs stream",
      {
        callSid: callSid || "",
        agentId: agent?.id || "",
        legacyVoice: agent.voice || "",
        selectedElevenLabsVoiceName,
        selectedElevenLabsVoiceId,
      },
    );
  }

  const streamParams = {
    orgId: agent.organization_id,
    organizationId: agent.organization_id,
    agentId: agent.id,
    callRecordId,
    callSid: callSid || "",
    accountSid: accountSid || "",
    twilioAccountSid: accountSid || "",
    fromAccountSid: accountSid || "",
    direction: direction || "inbound",
    callerPhone: callerPhone || "",
    recipientPhone: recipientPhone || callerPhone || "",
    recipientName: voiceBehavior.cleanRecipientNameForSpeech(
      recipientName || targetName || "",
    ),
    targetName: voiceBehavior.cleanRecipientNameForSpeech(
      targetName || recipientName || "",
    ),
    leadId: leadId || "",
    callPurpose: callPurpose || "",
    customInstructions: customInstructions || "",
    openingGreeting,
    greetingMessage: openingGreeting,
    normalizedPurpose,
    language: agent.language || process.env.DEFAULT_CALL_LANGUAGE || "en",
    agentName: voiceBehavior.cleanAgentNameForSpeech(
      agent.name || agent.agent_name || "",
    ),
    organizationName: voiceBehavior.cleanOrganizationNameForSpeech(
      agent?.knowledge_base_id
        ? agent?.knowledge_base_business_name ||
            agent?.knowledge_base_name ||
            agent?.business_name ||
            organization?.name ||
            organization?.business_name ||
            organization?.company_name ||
            ""
        : organization?.name ||
            organization?.business_name ||
            organization?.company_name ||
            "",
    ),
    knowledgeBaseId: agent?.knowledge_base_id || "",
    knowledgeBaseName:
      agent?.knowledge_base_business_name || agent?.knowledge_base_name || "",
    voiceProviderHint: selectedVoiceProvider || agent.voice_provider || "",
    openAiVoice: selectedOpenAiVoice,
    elevenLabsVoiceId: selectedElevenLabsVoiceId,
    elevenLabsVoiceName: selectedElevenLabsVoiceName,
    voiceProfile: selectedVoiceProfile,
    selectedVoiceProvider: selectedVoiceProvider || agent.voice_provider || "",
    selectedVoiceId: selectedElevenLabsVoiceId || selectedOpenAiVoice || "",
    selectedVoiceName: selectedElevenLabsVoiceName || selectedOpenAiVoice || "",
    voiceProviderOverride: voiceProviderOverride || "",
    voiceProviderFallbackReason: voiceProviderFallbackReason || "",
    scheduleId: scheduleId || "",
    scheduleRunId: scheduleRunId || "",
    maxCallSeconds: maxCallSeconds || "",
    platformTestMode: platformTestMode ? "true" : "",
    platformTestEventId: platformTestEventId || "",
  };
  console.log("[twilio-stream] voice params", {
    callSid: streamParams.callSid || "",
    voiceProviderHint: streamParams.voiceProviderHint || "",
    selectedVoiceProvider: streamParams.selectedVoiceProvider || "",
    selectedVoiceId: streamParams.selectedVoiceId || "",
    selectedVoiceName: streamParams.selectedVoiceName || "",
    openAiVoice: streamParams.openAiVoice || "",
    elevenLabsVoiceId: streamParams.elevenLabsVoiceId || "",
    elevenLabsVoiceName: streamParams.elevenLabsVoiceName || "",
    voiceProfile: streamParams.voiceProfile || "",
  });
  const wsUrl = mediaStreamUrl(streamParams);
  const twiml = buildMediaStreamTwiml({
    wsUrl,
    parameters: streamParams,
  });
  return maybeAddInboundRecording(twiml, streamParams.direction);
}

const DEFAULT_OUTBOUND_TEST_PURPOSE =
  "Follow up with the lead about the business and ask how the business can help.";

function outboundPurposeFromBody(body = {}) {
  const supplied = String(body.callPurpose || body.purpose || "").trim();
  const required =
    String(process.env.OUTBOUND_CALL_PURPOSE_REQUIRED || "").toLowerCase() ===
    "true";
  if (supplied) return { callPurpose: supplied, callPurposeWarning: "" };
  if (required) {
    const err = new Error("callPurpose is required for outbound calls.");
    err.status = 400;
    err.code = "CALL_PURPOSE_REQUIRED";
    throw err;
  }
  return {
    callPurpose: DEFAULT_OUTBOUND_TEST_PURPOSE,
    callPurposeWarning: "No call purpose supplied; using default test purpose.",
  };
}

async function preloadOutboundCallContext({
  db,
  organizationId,
  agent,
  query,
  assignmentContext,
}) {
  const required =
    String(
      process.env.OUTBOUND_CONTEXT_PREFLIGHT_REQUIRED || "true",
    ).toLowerCase() !== "false";
  try {
    const voiceContext = await loadVoiceContext(
      db,
      organizationId,
      { ...agent, direction: "outbound" },
      query || "outbound call",
      { assignmentContext: assignmentContext || "" },
    );
    if (!voiceContext) throw new Error("Voice context was not returned.");
    const selectedKb = voiceContext.selectedKnowledgeBase || null;
    return {
      ok: true,
      required,
      agent: selectedKb
        ? {
            ...agent,
            knowledge_base_id:
              voiceContext.selectedKnowledgeBaseId ||
              agent.knowledge_base_id ||
              null,
            knowledge_base_name:
              selectedKb.name || agent.knowledge_base_name || "",
            knowledge_base_business_name:
              selectedKb.business_name ||
              selectedKb.name ||
              agent.knowledge_base_business_name ||
              "",
          }
        : agent,
      summary: {
        knowledgeBaseId: voiceContext.selectedKnowledgeBaseId || null,
        knowledgeBaseName: selectedKb?.name || null,
        faqCount: Array.isArray(voiceContext.faqs)
          ? voiceContext.faqs.length
          : 0,
        chunkCount: Array.isArray(voiceContext.relevantChunks)
          ? voiceContext.relevantChunks.length
          : 0,
        systemPromptChars: String(voiceContext.systemPrompt || "").length,
      },
    };
  } catch (err) {
    const error = err?.message || String(err);
    if (required) {
      const failure = new Error(
        "Call context could not be prepared before dialing.",
      );
      failure.status = 503;
      failure.code = "CALL_CONTEXT_NOT_READY";
      failure.detail = error;
      throw failure;
    }
    console.warn("[outbound-call] context preflight warning", {
      organizationId,
      agentId: agent?.id || "",
      error,
    });
    return { ok: false, required, agent, summary: { error } };
  }
}

function encodeOutboundTwiMlUrl(base, params = {}) {
  const url = new URL("/api/twilio/outbound-twiml", base);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function mediaStreamUrlPreview(params = {}) {
  return mediaStreamUrl(params);
}

function preparedOpeningGreetingForCall({
  agent = {},
  organization = null,
  direction = "inbound",
  recipientName = "",
  targetName = "",
  callPurpose = "",
} = {}) {
  const agentName = voiceBehavior.cleanAgentNameForSpeech(
    agent.name || agent.agent_name || "",
  );
  const organizationName = voiceBehavior.cleanOrganizationNameForSpeech(
    agent?.knowledge_base_id
      ? agent?.knowledge_base_business_name ||
          agent?.business_name ||
          organization?.business_name ||
          organization?.company_name ||
          organization?.name ||
          agent?.knowledge_base_name ||
          ""
      : organization?.business_name ||
          organization?.company_name ||
          organization?.name ||
          "",
  );
  const cleanRecipientName = voiceBehavior.cleanRecipientNameForSpeech(
    recipientName || targetName || "",
  );
  const outbound = String(direction || "").toLowerCase() === "outbound";
  const rawGreeting = outbound
    ? voiceBehavior.buildOutboundGreeting({
        recipientName: cleanRecipientName,
        agentName,
        organizationName,
        callPurpose,
      })
    : voiceBehavior.buildInboundGreeting({ agentName, organizationName });
  const safeGreeting = outbound
    ? voiceBehavior.repairOutboundAssistantText(rawGreeting, {
        direction: "outbound",
        recipientName: cleanRecipientName,
        targetName: cleanRecipientName,
        agentName,
        organizationName,
        callPurpose,
      })
    : rawGreeting;
  return String(safeGreeting || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

// ─────────────────────────────────────────────────────────────
// Helper: many-to-many outbound phone number assignments
// Phase 3: phone numbers are reusable tenant resources. A number can be
// available to multiple outbound agents while inbound default routing remains
// controlled by twilio_phone_numbers.assigned_voice_agent_id.
// ─────────────────────────────────────────────────────────────
function normalizeAssignmentDirection(value, fallback = "outbound") {
  const raw = String(value || fallback || "outbound")
    .trim()
    .toLowerCase();
  return ["outbound", "inbound", "both"].includes(raw) ? raw : "outbound";
}

function assignmentAllowsOutbound(direction) {
  const normalized = normalizeAssignmentDirection(direction, "outbound");
  return normalized === "outbound" || normalized === "both";
}

async function loadTenantNumberByIdOrSid(db, organizationId, numberId) {
  const id = String(numberId || "").trim();
  if (!id) return null;
  const { data, error } = await db
    .from("twilio_phone_numbers")
    .select("*")
    .eq("organization_id", organizationId)
    .or(`id.eq.${id},phone_sid.eq.${id}`)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadOutboundAssignmentsByNumber(db, organizationId, numberIds) {
  const ids = [...new Set((numberIds || []).filter(Boolean))];
  const assignmentsByNumberId = new Map();
  if (!ids.length) return assignmentsByNumberId;

  try {
    const { data, error } = await db
      .from("agent_phone_number_assignments")
      .select(
        "id, organization_id, agent_id, phone_number_id, phone_number, phone_sid, direction, is_default_for_agent, is_default_for_number, created_at, voice_agents:agent_id(id,name,direction,is_active)",
      )
      .eq("organization_id", organizationId)
      .in("phone_number_id", ids)
      .in("direction", ["outbound", "both"])
      .order("is_default_for_agent", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw error;

    for (const assignment of data || []) {
      if (!assignmentAllowsOutbound(assignment.direction)) continue;
      const list = assignmentsByNumberId.get(assignment.phone_number_id) || [];
      list.push(assignment);
      assignmentsByNumberId.set(assignment.phone_number_id, list);
    }
  } catch (err) {
    console.warn(
      "[twilio/numbers] assignment table unavailable; falling back to legacy single-agent mapping:",
      err.message || String(err),
    );
  }

  return assignmentsByNumberId;
}

async function findDefaultOutboundNumberForAgent(db, organizationId, agentId) {
  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedAgentId) return null;

  try {
    const { data: assignment, error } = await db
      .from("agent_phone_number_assignments")
      .select(
        "id, phone_number_id, phone_number, phone_sid, direction, is_default_for_agent",
      )
      .eq("organization_id", organizationId)
      .eq("agent_id", normalizedAgentId)
      .in("direction", ["outbound", "both"])
      .order("is_default_for_agent", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!error && assignment?.phone_number_id) {
      const { data: number } = await db
        .from("twilio_phone_numbers")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("id", assignment.phone_number_id)
        .maybeSingle();
      if (number) return { number, assignment };
    }
    if (error) throw error;
  } catch (err) {
    console.warn(
      "[outbound-call] assignment lookup unavailable; using legacy agent-number lookup:",
      err.message || String(err),
    );
  }

  const { data: legacyNumber } = await db
    .from("twilio_phone_numbers")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("assigned_voice_agent_id", normalizedAgentId)
    .maybeSingle();
  return legacyNumber ? { number: legacyNumber, assignment: null } : null;
}

async function upsertOutboundNumberAssignment({
  db,
  organizationId,
  number,
  agent,
  direction = "outbound",
  isDefaultForAgent = true,
}) {
  const normalizedDirection = normalizeAssignmentDirection(
    direction,
    "outbound",
  );
  const defaultFlag = isDefaultForAgent !== false;

  if (defaultFlag && assignmentAllowsOutbound(normalizedDirection)) {
    await db
      .from("agent_phone_number_assignments")
      .update({
        is_default_for_agent: false,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("agent_id", agent.id)
      .in("direction", ["outbound", "both"]);
  }

  const payload = {
    organization_id: organizationId,
    agent_id: agent.id,
    phone_number_id: number.id,
    phone_number: number.phone_number,
    phone_sid: number.phone_sid,
    direction: normalizedDirection,
    is_default_for_agent: defaultFlag,
    is_default_for_number: false,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("agent_phone_number_assignments")
    .upsert(payload, {
      onConflict: "organization_id,agent_id,phone_number_id,direction",
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
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

    const creditStatus = await getWalletCreditStatus({
      organizationId: agent.organization_id,
      action: "inbound_call",
    });
    const creditBlockMessage = creditStatusToTwimlMessage(creditStatus);
    if (creditBlockMessage) {
      res.setHeader("Content-Type", "text/xml");
      return res.send(hangupTwiml(creditBlockMessage));
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
router.post("/voice", handleInboundVoice);
router.get("/voice", handleInboundVoice);
router.post("/inbound", handleInboundVoice);
router.get("/inbound", handleInboundVoice);
router.post("/inbound-call", handleInboundVoice);
router.get("/inbound-call", handleInboundVoice);

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Outbound TwiML ───────────────────────────────────
// Twilio fetches this when we initiate an outbound call.
// The call SID + orgId + agentId are passed as query params.
// ─────────────────────────────────────────────────────────────
async function handleOutboundTwiMl(req, res) {
  const callSid = req.body?.CallSid || req.query?.CallSid || "";
  const toPhone = req.body?.To || req.query?.To || "";
  const fromPhone = req.body?.From || req.query?.From || "";
  const agentId = req.query?.agentId || req.body?.agentId || "";
  const callRecordIdFromQuery =
    req.query?.callRecordId || req.body?.callRecordId || "";
  let accountSid = String(
    req.query?.accountSid ||
      req.body?.accountSid ||
      req.query?.twilioAccountSid ||
      req.body?.twilioAccountSid ||
      req.query?.fromAccountSid ||
      req.body?.fromAccountSid ||
      "",
  ).trim();
  const leadId = req.query?.leadId || req.body?.leadId || "";
  const callPurpose = req.query?.callPurpose || req.body?.callPurpose || "";
  const precomputedOpeningGreeting = String(
    req.query?.openingGreeting || req.body?.openingGreeting || "",
  ).trim();
  const precomputedNormalizedPurpose = String(
    req.query?.normalizedPurpose || req.body?.normalizedPurpose || "",
  ).trim();
  const customInstructions =
    req.query?.customInstructions || req.body?.customInstructions || "";
  const voiceProviderOverride =
    req.query?.voiceProviderOverride || req.body?.voiceProviderOverride || "";
  const voiceProviderFallbackReason =
    req.query?.voiceProviderFallbackReason ||
    req.body?.voiceProviderFallbackReason ||
    "";
  const scheduleId = req.query?.scheduleId || req.body?.scheduleId || "";
  const scheduleRunId =
    req.query?.scheduleRunId || req.body?.scheduleRunId || "";
  const maxCallSeconds =
    req.query?.maxCallSeconds ||
    req.body?.maxCallSeconds ||
    req.query?.max_call_seconds ||
    req.body?.max_call_seconds ||
    "";
  const platformTestMode =
    req.query?.platformTestMode === "true" ||
    req.body?.platformTestMode === true ||
    req.body?.platform_test_mode === true;
  const platformTestEventId =
    req.query?.platformTestEventId ||
    req.body?.platformTestEventId ||
    req.query?.platform_test_event_id ||
    req.body?.platform_test_event_id ||
    "";
  let recipientPhone =
    req.query?.recipientPhone || req.body?.recipientPhone || toPhone;
  let recipientName = String(
    req.query?.recipientName ||
      req.body?.recipientName ||
      req.query?.targetName ||
      req.body?.targetName ||
      req.query?.customerName ||
      req.body?.customerName ||
      "",
  ).trim();
  let targetName = String(
    req.query?.targetName || req.body?.targetName || recipientName || "",
  ).trim();

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

  let organization = null;
  if (agent?.organization_id) {
    try {
      const { data } = await db
        .from("organizations")
        .select("id,name,business_name,company_name,timezone,business_hours")
        .eq("id", agent.organization_id)
        .maybeSingle();
      organization = data || null;
    } catch (err) {
      console.warn("[outbound-twiml] organization lookup skipped", {
        organizationId: agent.organization_id,
        error: err.message || String(err),
      });
    }
  }

  if (scheduleRunId && (!recipientName || !recipientPhone)) {
    try {
      const { data: run } = await db
        .from("lead_outreach_runs")
        .select("target_name,target_phone,destination_phone,outcome_metadata")
        .eq("id", scheduleRunId)
        .maybeSingle();
      recipientName =
        recipientName ||
        String(
          run?.target_name || run?.outcome_metadata?.recipientName || "",
        ).trim();
      targetName = targetName || recipientName;
      recipientPhone =
        recipientPhone ||
        run?.destination_phone ||
        run?.target_phone ||
        toPhone;
    } catch (err) {
      console.warn("[outbound-twiml] schedule run recipient lookup skipped", {
        scheduleRunId,
        error: err.message || String(err),
      });
    }
  }

  if (leadId && !recipientName) {
    try {
      const { data: lead } = await db
        .from("leads")
        .select("name,phone,email")
        .eq("id", leadId)
        .maybeSingle();
      recipientName = String(lead?.name || "").trim();
      targetName = targetName || recipientName;
      recipientPhone = recipientPhone || lead?.phone || toPhone;
    } catch (err) {
      console.warn("[outbound-twiml] lead recipient lookup skipped", {
        leadId,
        error: err.message || String(err),
      });
    }
  }

  if (!accountSid && agent?.organization_id && fromPhone) {
    try {
      const { data: numberRow } = await db
        .from("twilio_phone_numbers")
        .select("account_sid")
        .eq("organization_id", agent.organization_id)
        .eq("phone_number", fromPhone)
        .maybeSingle();
      accountSid = String(numberRow?.account_sid || "").trim();
    } catch (err) {
      console.warn("[outbound-twiml] number account lookup skipped", {
        organizationId: agent.organization_id,
        fromPhone,
        error: err.message || String(err),
      });
    }
  }

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
      metadata: {
        twilioTo: toPhone,
        twilioFrom: fromPhone,
        accountSid: accountSid || null,
        account_sid_last4: accountSid ? accountSid.slice(-4) : null,
        leadId: leadId || null,
        recipientName: recipientName || null,
        targetName: targetName || recipientName || null,
        callPurpose: callPurpose || null,
        customInstructions: customInstructions || null,
        maxCallSeconds: maxCallSeconds || null,
        platformTestMode: platformTestMode || false,
        platformTestEventId: platformTestEventId || null,
      },
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
    organization,
    callRecordId,
    callSid,
    direction: "outbound",
    callerPhone: fromPhone,
    recipientPhone,
    recipientName,
    targetName,
    leadId,
    callPurpose,
    customInstructions,
    voiceProviderOverride,
    voiceProviderFallbackReason,
    scheduleId,
    scheduleRunId,
    maxCallSeconds,
    platformTestMode,
    platformTestEventId,
    precomputedOpeningGreeting,
    precomputedNormalizedPurpose,
    accountSid,
  });
  res.setHeader("Content-Type", "text/xml");
  res.send(twiml);
}

router.post("/outbound-twiml", asyncHandler(handleOutboundTwiMl));
router.get("/outbound-twiml", asyncHandler(handleOutboundTwiMl));

function normalizeTwilioCallOutcome(callStatus, answeredBy, duration) {
  const status = String(callStatus || "").toLowerCase();
  const machine = /machine|fax/.test(String(answeredBy || "").toLowerCase());
  const seconds = Number(duration || 0) || 0;
  if (machine) return "voicemail";
  if (status === "busy") return "busy";
  if (status === "no-answer") return "no_answer";
  if (["failed", "canceled", "cancelled"].includes(status)) return "failed";
  if (status === "completed" && seconds > 0) return "answered";
  if (status === "completed") return "completed";
  if (status === "ringing") return "ringing";
  if (status === "answered" || status === "in-progress") return "answered";
  return status || "initiated";
}

function dbRunStatusFromOutcome(outcome, callStatus) {
  if (["answered", "completed", "voicemail"].includes(outcome))
    return "completed";
  if (
    ["busy", "no_answer", "failed", "canceled", "cancelled"].includes(outcome)
  )
    return "failed";
  if (
    ["ringing", "initiated", "in-progress", "answered"].includes(
      String(callStatus || "").toLowerCase(),
    )
  )
    return "initiated";
  return "initiated";
}

// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Async AMD Status Callback ────────────────────────
// Twilio sends AnsweredBy here when AsyncAmd=true. Keep this separate from
// normal call-status so calls can connect immediately without AMD blocking.
// ─────────────────────────────────────────────────────────────
router.post(
  "/amd-status",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const callSid = body.CallSid || body.callSid || body.CallSID || "";
    const answeredBy = String(
      body.AnsweredBy || body.answeredBy || body.Answeredby || "",
    ).trim();
    const machineDetected = /machine|fax|unknown/i.test(answeredBy);
    if (callSid) {
      console.log("[latency] async_amd_status_callback", {
        callSid,
        answeredBy,
        machineDetected,
        eventReceivedAt: new Date().toISOString(),
      });
      const columnsPatch = {
        answered_by: answeredBy || undefined,
        voicemail_detected: machineDetected || undefined,
        ...(machineDetected
          ? {
              call_category: "voicemail",
              disposition: "async_amd_machine_detected",
            }
          : answeredBy
            ? {
                call_category: "answered_human",
                disposition: "async_amd_human_detected",
              }
            : {}),
      };
      await updateCallRecordMetadataBySid(
        callSid,
        {
          answered_by: answeredBy,
          machine_detection_result: answeredBy,
          voicemail_detected: machineDetected,
          async_amd: {
            answeredBy,
            machineDetected,
            raw: body,
            receivedAt: new Date().toISOString(),
          },
        },
        columnsPatch,
      );

      try {
        const db = getSupabase();
        const { data: scheduledRecord } = await db
          .from("call_records")
          .select("id, metadata")
          .eq("twilio_call_sid", callSid)
          .maybeSingle();
        const scheduleRunId =
          scheduledRecord?.metadata?.scheduleRunId ||
          scheduledRecord?.metadata?.billing?.run_id ||
          null;
        if (scheduleRunId) {
          const { data: existingRun } = await db
            .from("lead_outreach_runs")
            .select("id,outcome_metadata")
            .eq("id", scheduleRunId)
            .maybeSingle();
          const existingMeta =
            existingRun?.outcome_metadata &&
            typeof existingRun.outcome_metadata === "object"
              ? existingRun.outcome_metadata
              : {};
          await db
            .from("lead_outreach_runs")
            .update({
              outcome_metadata: {
                ...existingMeta,
                answeredBy,
                machineDetectionResult: answeredBy,
                voicemailDetected: machineDetected,
                asyncAmd: {
                  answeredBy,
                  machineDetected,
                  raw: body,
                  receivedAt: new Date().toISOString(),
                },
                outcome: machineDetected ? "voicemail" : existingMeta.outcome,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", scheduleRunId);
        }
      } catch (err) {
        console.warn("[Twilio async-amd] scheduled run update skipped", {
          callSid,
          error: err.message || String(err),
        });
      }
    }
    res.status(204).send();
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
    const { CallSid, CallStatus, CallDuration, To, AnsweredBy } =
      req.body || {};
    if (CallSid) {
      console.log("[latency] twilio_call_status_callback", {
        callSid: CallSid,
        callStatus: CallStatus || "",
        answeredBy: AnsweredBy || "",
        eventReceivedAt: new Date().toISOString(),
      });
      const answeredBy = String(
        AnsweredBy || req.body?.AnsweredBy || "",
      ).trim();
      if (answeredBy) {
        const voicemailDetected = /machine|fax|unknown/i.test(answeredBy);
        console.log("[outbound-call] answeredBy=" + answeredBy, {
          callSid: CallSid,
          voicemailDetected,
        });
        await updateCallRecordMetadataBySid(
          CallSid,
          {
            answered_by: answeredBy,
            machine_detection_result: answeredBy,
            voicemail_detected: voicemailDetected,
          },
          { status: CallStatus || undefined },
        );
      }
    }
    if (CallSid && CallStatus) {
      try {
        const normalizedStatus = String(CallStatus || "").toLowerCase();
        const directionRaw = String(req.body?.Direction || "").toLowerCase();
        const direction = directionRaw.startsWith("outbound")
          ? "outbound"
          : directionRaw.startsWith("inbound")
            ? "inbound"
            : undefined;
        const durationSeconds =
          Number(CallDuration || req.body?.Duration || 0) || 0;
        const terminalStatuses = new Set([
          "completed",
          "failed",
          "busy",
          "no-answer",
          "canceled",
          "cancelled",
        ]);
        const statusOutcome = normalizeTwilioCallOutcome(
          CallStatus,
          AnsweredBy,
          durationSeconds,
        );
        const generalColumnsPatch = {
          status: CallStatus || undefined,
          call_category:
            statusOutcome === "answered" ? "answered_human" : statusOutcome,
          disposition: statusOutcome,
          answered_by: AnsweredBy || undefined,
          voicemail_detected: statusOutcome === "voicemail" || undefined,
          ...(direction ? { direction } : {}),
          ...(durationSeconds > 0 ? { duration: durationSeconds } : {}),
          ...(terminalStatuses.has(normalizedStatus)
            ? {
                ended_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
              }
            : {}),
        };
        await updateCallRecordMetadataBySid(
          CallSid,
          {
            twilioStatusCallback: {
              callStatus: CallStatus,
              direction: req.body?.Direction || "",
              durationSeconds,
              answeredBy: AnsweredBy || "",
              to: To || req.body?.To || "",
              from: req.body?.From || "",
              updatedAt: new Date().toISOString(),
            },
          },
          generalColumnsPatch,
        );

        if (terminalStatuses.has(normalizedStatus)) {
          try {
            const db = getSupabase();
            const { data: usageRecord } = await db
              .from("call_records")
              .select("id, organization_id, voice_agent_id")
              .eq("twilio_call_sid", CallSid)
              .maybeSingle();
            await logTwilioCallUsage({
              organizationId: usageRecord?.organization_id || null,
              callId: usageRecord?.id || null,
              voiceAgentId: usageRecord?.voice_agent_id || null,
              accountSid: req.body?.AccountSid || req.body?.accountSid || "",
              callSid: CallSid,
              direction: req.body?.Direction || direction || "",
              status: CallStatus,
              durationSeconds,
              price: req.body?.Price,
              priceUnit: req.body?.PriceUnit,
              from: req.body?.From || "",
              to: To || req.body?.To || "",
              metadata: { raw_status_callback: req.body || {} },
            });
          } catch (usageErr) {
            console.warn("[usage-ledger] Twilio call usage log skipped", {
              callSid: CallSid,
              error: usageErr.message || String(usageErr),
            });
          }
        }
      } catch (err) {
        console.warn(
          "[Twilio call-status] general call record update skipped",
          {
            callSid: CallSid,
            error: err.message || String(err),
          },
        );
      }
    }

    if (CallSid && CallStatus) {
      try {
        const db = getSupabase();
        const { data: scheduledRecord } = await db
          .from("call_records")
          .select("id, metadata")
          .eq("twilio_call_sid", CallSid)
          .maybeSingle();
        const scheduleRunId =
          scheduledRecord?.metadata?.scheduleRunId ||
          scheduledRecord?.metadata?.billing?.run_id ||
          null;
        const platformTestEventId =
          scheduledRecord?.metadata?.platformTestEventId || null;
        if (platformTestEventId) {
          await db
            .from("tenant_test_call_events")
            .update({
              status: CallStatus || "updated",
              twilio_call_sid: CallSid,
              call_record_id: scheduledRecord?.id || null,
              raw_response: req.body || {},
              updated_at: new Date().toISOString(),
            })
            .eq("id", platformTestEventId);
        }
        if (scheduleRunId) {
          const terminalStatuses = new Set([
            "completed",
            "failed",
            "busy",
            "no-answer",
            "canceled",
            "cancelled",
          ]);
          const durationSeconds = Number(CallDuration || 0) || 0;
          const outcome = normalizeTwilioCallOutcome(
            CallStatus,
            AnsweredBy,
            durationSeconds,
          );
          let runStatus = dbRunStatusFromOutcome(outcome, CallStatus);
          const { data: existingRun } = await db
            .from("lead_outreach_runs")
            .select(
              "id,status,outcome_metadata,schedule_id,lead_id,voice_agent_id,from_number_id,destination_phone,target_phone,target_name,attempt_number,scheduled_for",
            )
            .eq("id", scheduleRunId)
            .maybeSingle();
          const existingMeta =
            existingRun?.outcome_metadata &&
            typeof existingRun.outcome_metadata === "object"
              ? existingRun.outcome_metadata
              : {};
          const voicemailDetected = outcome === "voicemail";
          const patch = {
            status: runStatus,
            twilio_call_sid: CallSid,
            call_record_id: scheduledRecord.id,
            outcome_metadata: {
              ...existingMeta,
              twilioCallStatus: CallStatus,
              callStatus: CallStatus,
              answeredBy: AnsweredBy || "",
              callDuration: durationSeconds,
              durationSeconds,
              outcome,
              outcomeSummary:
                outcome === "answered"
                  ? "Recipient answered the scheduled call."
                  : outcome === "no_answer"
                    ? "Recipient did not answer."
                    : outcome === "voicemail"
                      ? "Voicemail or machine detected."
                      : outcome === "busy"
                        ? "Recipient line was busy."
                        : outcome === "failed"
                          ? "Twilio reported the call failed."
                          : `Twilio status: ${CallStatus || "unknown"}`,
              voicemailDetected,
              machineDetectionResult: AnsweredBy || "",
              raw: req.body || {},
            },
            updated_at: new Date().toISOString(),
          };
          if (
            terminalStatuses.has(String(CallStatus || "").toLowerCase()) ||
            ["completed", "failed", "busy", "no_answer", "voicemail"].includes(
              outcome,
            )
          ) {
            patch.completed_at = new Date().toISOString();
          }
          if (
            String(CallStatus || "").toLowerCase() === "busy" &&
            existingRun
          ) {
            const retryDelayMinutes = Number(
              process.env.SCHEDULED_CALL_BUSY_RETRY_DELAY_MINUTES || 60,
            );
            patch.scheduled_for = new Date(
              Date.now() + retryDelayMinutes * 60_000,
            ).toISOString();
            patch.status = "queued";
            patch.completed_at = null;
            patch.error_code = "BUSY_RETRY_SCHEDULED";
            patch.error_message = `Busy; retry scheduled in ${retryDelayMinutes} minutes.`;
            patch.outcome_metadata = {
              ...patch.outcome_metadata,
              outcome: "retry_scheduled",
              retryAt: patch.scheduled_for,
            };
          }
          await db
            .from("lead_outreach_runs")
            .update(patch)
            .eq("id", scheduleRunId);
          await db
            .from("call_records")
            .update({
              status: CallStatus || undefined,
              duration: durationSeconds || undefined,
              outcome: outcome || undefined,
              metadata: {
                ...(scheduledRecord.metadata || {}),
                scheduledOutcome: patch.outcome_metadata,
              },
            })
            .eq("id", scheduledRecord.id);
        }
      } catch (err) {
        console.warn("[scheduled-outreach] run status update skipped", {
          callSid: CallSid,
          error: err.message || String(err),
        });
      }
    }

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
            try {
              await db.rpc("increment_usage", {
                org_id: agent.organization_id,
                calls_inc: 1,
                minutes_inc: mins,
              });
            } catch (_) {
              // Usage RPC may not exist in older deployments; keep callback non-blocking.
            }
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
// ─────────────────────────────────────────────────────────────
// ── PUBLIC: Recording Status Callback ────────────────────────
// Twilio sends this when a recording changes status. We persist
// recording metadata on call_records without exposing the raw URL
// through any tenant-facing endpoint yet.
// ─────────────────────────────────────────────────────────────
router.post(
  "/recording-status",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const {
      CallSid,
      RecordingSid,
      RecordingUrl,
      RecordingStatus,
      RecordingDuration,
      RecordingChannels,
      RecordingSource,
      RecordingTrack,
      RecordingStartTime,
    } = body;
    console.log("[recording] status callback", {
      callSid: CallSid,
      recordingSid: RecordingSid,
      status: RecordingStatus,
    });

    if (!CallSid)
      return res.json({ received: true, ignored: "missing_call_sid" });

    const recordingUrl = RecordingUrl ? `${RecordingUrl}.mp3` : "";
    const callRecord = await loadCallRecordForRecording(CallSid);
    const baseRecordingMeta = {
      recording: {
        call_sid: CallSid,
        recording_sid: RecordingSid || "",
        recording_url: recordingUrl,
        recording_status: RecordingStatus || "",
        recording_duration: RecordingDuration
          ? Number(RecordingDuration) || 0
          : null,
        recording_channels: RecordingChannels || "",
        recording_source: RecordingSource || "",
        recording_track: RecordingTrack || "",
        recording_start_time: RecordingStartTime || "",
        raw: body,
      },
    };

    const baseColumns = {
      recording_sid: RecordingSid || null,
      recording_url: recordingUrl || null,
      recording_status: RecordingStatus || null,
      recording_duration: RecordingDuration
        ? Number(RecordingDuration) || 0
        : null,
      recording_channels: RecordingChannels || null,
      recording_source: RecordingSource || null,
      recording_available: RecordingStatus === "completed",
      recording_error: RecordingStatus === "absent" ? "Recording absent" : null,
    };

    if (RecordingStatus !== "completed") {
      await updateCallRecordMetadataBySid(
        CallSid,
        baseRecordingMeta,
        baseColumns,
      );
      if (RecordingStatus === "absent")
        console.warn("[recording] absent/error", {
          callSid: CallSid,
          recordingSid: RecordingSid,
        });
      return res.json({ received: true });
    }

    let columnsPatch = { ...baseColumns };
    let metadataPatch = { ...baseRecordingMeta };

    try {
      if (callRecord?.id && RecordingSid && RecordingUrl) {
        const downloaded = await downloadTwilioRecordingMp3(RecordingUrl);
        const upload = await uploadRecordingToSupabase({
          callRecord,
          recordingSid: RecordingSid,
          buffer: downloaded.buffer,
          mimeType: downloaded.mimeType,
        });
        if (!upload?.skipped) {
          columnsPatch = {
            ...columnsPatch,
            recording_storage_provider: upload.provider,
            recording_storage_path: upload.storagePath,
            recording_mime_type: downloaded.mimeType,
            recording_file_size: downloaded.buffer.length,
            recording_archived_at: new Date().toISOString(),
          };
          metadataPatch.recording = {
            ...metadataPatch.recording,
            storage_provider: upload.provider,
            storage_path: upload.storagePath,
          };
          console.log("[recording] archived to Supabase", {
            callSid: CallSid,
            recordingSid: RecordingSid,
            storagePath: upload.storagePath,
          });

          try {
            await logStorageUsage({
              organizationId: callRecord.organization_id,
              service: "call_recording",
              bytes: downloaded.buffer.length,
              metadata: {
                bucket: upload.bucket,
                storage_path: upload.storagePath,
                call_record_id: callRecord.id,
                call_sid: CallSid,
                recording_sid: RecordingSid,
                mime_type: downloaded.mimeType,
              },
            });
          } catch (usageErr) {
            console.warn("[usage-ledger] recording storage log skipped", {
              callSid: CallSid,
              recordingSid: RecordingSid,
              error: usageErr.message || String(usageErr),
            });
          }

          try {
            const tx = await transcribeRecordingWithOpenAI({
              buffer: downloaded.buffer,
              filename: `${RecordingSid}.mp3`,
            });
            columnsPatch.transcription_provider = "openai";
            columnsPatch.transcription_status =
              tx.status || (tx.skipped ? "skipped" : "completed");
            metadataPatch.transcription = {
              provider: "openai",
              model:
                tx.model ||
                process.env.OPENAI_TRANSCRIPTION_MODEL ||
                "gpt-4o-mini-transcribe",
              status: tx.status || "unknown",
              completed_at: new Date().toISOString(),
              skipped: Boolean(tx.skipped),
            };
            try {
              await logOpenAIUsage({
                organizationId: callRecord.organization_id,
                service: "call_transcription",
                eventType: "openai_transcription",
                model:
                  tx.model ||
                  process.env.OPENAI_TRANSCRIPTION_MODEL ||
                  "gpt-4o-mini-transcribe",
                callId: callRecord.id,
                inputTokens: 0,
                outputTokens: 0,
                metadata: {
                  call_sid: CallSid,
                  recording_sid: RecordingSid,
                  note: "Transcription models may not expose token usage. Reconcile against OpenAI exports if exact usage is required.",
                },
              });
            } catch (usageErr) {
              console.warn("[usage-ledger] transcription usage log skipped", {
                callSid: CallSid,
                recordingSid: RecordingSid,
                error: usageErr.message || String(usageErr),
              });
            }
            if (tx.text) {
              const existingTranscript = transcriptToText(
                callRecord.transcript,
              );
              if (!existingTranscript)
                columnsPatch.transcript = [
                  {
                    role: "transcription",
                    text: tx.text,
                    ts: new Date().toISOString(),
                  },
                ];
              if (!callRecord.summary)
                columnsPatch.summary = makeShortSummary(tx.text);
            }
          } catch (txErr) {
            columnsPatch.transcription_provider = "openai";
            columnsPatch.transcription_status = "failed";
            columnsPatch.transcription_error = txErr.message || String(txErr);
            metadataPatch.transcription = {
              provider: "openai",
              status: "failed",
              error: columnsPatch.transcription_error,
              completed_at: new Date().toISOString(),
            };
            console.warn("[recording] transcription failed", {
              callSid: CallSid,
              error: columnsPatch.transcription_error,
            });
          }
        }
      }
      await updateCallRecordMetadataBySid(CallSid, metadataPatch, columnsPatch);
      console.log("[recording] saved recordingSid=" + (RecordingSid || ""), {
        callSid: CallSid,
        status: RecordingStatus,
      });
    } catch (err) {
      console.warn("[recording] absent/error", {
        callSid: CallSid,
        recordingSid: RecordingSid,
        error: err.message || String(err),
      });
      await updateCallRecordMetadataBySid(
        CallSid,
        {
          ...metadataPatch,
          recording: {
            ...(metadataPatch.recording || {}),
            error: err.message || String(err),
          },
        },
        {
          ...columnsPatch,
          recording_error: err.message || String(err),
          recording_available: Boolean(
            columnsPatch.recording_storage_path || recordingUrl,
          ),
        },
      );
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
        try {
          await db.from("whatsapp_messages").insert({
            organization_id: agent.organization_id,
            voice_agent_id: agent.id,
            from_number: From,
            to_number: To,
            body: Body || "",
            direction: "inbound",
            created_at: new Date().toISOString(),
          });
        } catch (_) {
          // Table may not exist yet; silently ignore.
        }
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

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function strictNumberReadinessEnabled() {
  return envBool("OUTBOUND_STRICT_NUMBER_READINESS", false);
}

function defaultOutboundVoiceCountries(country) {
  const raw =
    process.env.TWILIO_LOW_RISK_VOICE_COUNTRIES ||
    process.env.DEFAULT_OUTBOUND_VOICE_COUNTRIES ||
    "US";
  return [
    ...new Set(
      [country, ...String(raw).split(",")]
        .map(normalizeCountry)
        .filter(Boolean),
    ),
  ];
}

function voiceCountriesForNumber(number, destinationCountry) {
  return new Set(
    [
      ...jsonArray(number?.selected_outbound_voice_countries),
      normalizeCountry(number?.iso_country),
      normalizeCountry(destinationCountry),
      ...defaultOutboundVoiceCountries(number?.iso_country),
    ]
      .map(normalizeCountry)
      .filter(Boolean),
  );
}

async function saveNumberRecord(db, payload) {
  const now = new Date().toISOString();

  const { data: existing } = await db
    .from("twilio_phone_numbers")
    .select("*")
    .eq("organization_id", payload.organizationId)
    .eq("phone_sid", payload.phoneSid)
    .maybeSingle();

  const capabilities = payload.capabilities || existing?.capabilities || {};
  const supportsVoice =
    capabilities.voice === true ||
    capabilities.voice === "true" ||
    capabilities.Voice === true ||
    capabilities.Voice === "true";
  const incomingSelectedCountries =
    payload.selectedOutboundVoiceCountries &&
    Array.isArray(payload.selectedOutboundVoiceCountries) &&
    payload.selectedOutboundVoiceCountries.length
      ? payload.selectedOutboundVoiceCountries
      : null;
  const existingSelectedCountries = jsonArray(
    existing?.selected_outbound_voice_countries,
  );
  const selectedOutboundVoiceCountries = incomingSelectedCountries
    ? [
        ...new Set(
          incomingSelectedCountries.map(normalizeCountry).filter(Boolean),
        ),
      ]
    : existingSelectedCountries.length
      ? existingSelectedCountries
      : supportsVoice
        ? defaultOutboundVoiceCountries(payload.isoCountry || payload.country)
        : [];
  const isSafeSyncImportDowngrade =
    existing?.id &&
    payload.source === "existing_twilio_number" &&
    payload.configurationStatus === "needs_configuration";
  const assignedAgentId =
    payload.agentId || existing?.assigned_voice_agent_id || null;

  const row = {
    organization_id: payload.organizationId,
    twilio_account_id:
      payload.twilioAccountId || existing?.twilio_account_id || null,
    phone_number: payload.phoneNumber || existing?.phone_number,
    phone_sid: payload.phoneSid || existing?.phone_sid,
    account_sid: payload.accountSid || existing?.account_sid,
    iso_country: normalizeCountry(
      payload.isoCountry || payload.country || existing?.iso_country || "",
    ),
    number_type: payload.numberType || existing?.number_type || "unknown",
    capabilities,
    address_requirements:
      payload.addressRequirements || existing?.address_requirements || "none",
    regulatory_status:
      payload.regulatoryStatus || existing?.regulatory_status || "unknown",
    bundle_sid: payload.bundleSid || existing?.bundle_sid || null,
    address_sid: payload.addressSid || existing?.address_sid || null,
    regulation_sid: payload.regulationSid || existing?.regulation_sid || null,
    regulatory_next_action:
      payload.regulatoryNextAction || existing?.regulatory_next_action || null,
    voice_url: payload.voiceUrl || existing?.voice_url || "",
    voice_fallback_url:
      payload.voiceFallbackUrl || existing?.voice_fallback_url || "",
    status_callback_url:
      payload.statusCallback || existing?.status_callback_url || "",
    sms_url: payload.smsUrl || existing?.sms_url || "",
    sms_fallback_url:
      payload.smsFallbackUrl || existing?.sms_fallback_url || "",
    assigned_voice_agent_id: assignedAgentId,
    source: payload.source || existing?.source || "purchased",
    purchase_origin:
      payload.purchaseOrigin || existing?.purchase_origin || "in_app_purchase",
    verification_method:
      payload.verificationMethod ||
      existing?.verification_method ||
      "api_ownership",
    verification_status:
      payload.verificationStatus || existing?.verification_status || "verified",
    selected_outbound_voice_countries: selectedOutboundVoiceCountries,
    selected_sms_countries:
      payload.selectedSmsCountries ||
      jsonArray(existing?.selected_sms_countries),
    configuration_status: isSafeSyncImportDowngrade
      ? existing?.configuration_status || "configured"
      : payload.configurationStatus ||
        existing?.configuration_status ||
        "needs_configuration",
    overall_status:
      payload.overallStatus ||
      existing?.overall_status ||
      (supportsVoice ? "ready" : "needs_configuration"),
    outbound_voice_status:
      payload.outboundVoiceStatus ||
      existing?.outbound_voice_status ||
      (supportsVoice ? "ready" : "not_supported"),
    inbound_voice_status:
      payload.inboundVoiceStatus ||
      existing?.inbound_voice_status ||
      (supportsVoice ? "ready" : "not_supported"),
    assigned_agent_status:
      payload.assignedAgentStatus ||
      existing?.assigned_agent_status ||
      (assignedAgentId ? "ready" : "needs_configuration"),
    updated_at: now,
  };

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
    let existingResult;
    try {
      existingResult = await db
        .from("twilio_geo_permissions")
        .select("id")
        .eq("organization_id", row.organization_id)
        .eq("channel", row.channel)
        .eq("iso_country", row.iso_country)
        .maybeSingle();
    } catch (err) {
      existingResult = { data: null, error: err };
    }
    const existing = existingResult?.data || null;
    try {
      if (existing?.id)
        await db
          .from("twilio_geo_permissions")
          .update(row)
          .eq("id", existing.id);
      else
        await db
          .from("twilio_geo_permissions")
          .insert({ ...row, created_at: now });
    } catch (_) {
      // Keep voice permission persistence best-effort.
    }
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
  try {
    await db.from("audit_logs").insert({
      organization_id: organizationId || null,
      user_id: userId || null,
      action,
      entity_type: entityType || null,
      entity_id: entityId || null,
      metadata: metadata || {},
    });
  } catch (_) {
    // Audit logging is best-effort and should not block Twilio operations.
  }
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

async function rollbackPurchasedNumberAfterBillingFailure({
  db,
  organizationId,
  accountSid,
  savedNumber,
  billingError,
}) {
  const releasedAt = new Date().toISOString();
  let providerReleased = false;
  let providerReleaseError = null;

  try {
    await releaseIncomingNumber({
      accountSid,
      phoneSid: savedNumber.phone_sid,
    });
    providerReleased = true;
  } catch (error) {
    if (Number(error?.status || 0) === 404) {
      providerReleased = true;
    } else {
      providerReleaseError = error?.message || String(error);
    }
  }

  await db
    .from("voice_agents")
    .update({
      twilio_phone_number: "",
      twilio_phone_sid: "",
      updated_at: releasedAt,
    })
    .eq("organization_id", organizationId)
    .eq("twilio_phone_sid", savedNumber.phone_sid);

  try {
    await db
      .from("agent_phone_number_assignments")
      .delete()
      .eq("organization_id", organizationId)
      .eq("phone_sid", savedNumber.phone_sid);
    if (savedNumber.id) {
      await db
        .from("agent_phone_number_assignments")
        .delete()
        .eq("organization_id", organizationId)
        .eq("phone_number_id", savedNumber.id);
    }
  } catch (_) {
    // Older schemas may not have the assignment table yet.
  }

  const lifecycle = providerReleased ? "released" : "release_pending";
  const updatePayload = {
    lifecycle_status: lifecycle,
    released_at: providerReleased ? releasedAt : null,
    release_reason: "billing_wallet_post_failed",
    assigned_voice_agent_id: null,
    provider_release_error: providerReleaseError,
    updated_at: releasedAt,
  };
  const { error: lifecycleError } = await db
    .from("twilio_phone_numbers")
    .update(updatePayload)
    .eq("id", savedNumber.id)
    .eq("organization_id", organizationId);

  if (lifecycleError) {
    await db
      .from("twilio_phone_numbers")
      .delete()
      .eq("id", savedNumber.id)
      .eq("organization_id", organizationId);
  }

  return {
    providerReleased,
    providerReleaseError,
    billingError: billingError?.message || String(billingError),
  };
}

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
        [
          ...defaultOutboundVoiceCountries(country),
          ...(req.body?.selectedOutboundVoiceCountries || []),
        ]
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

    const creditAllowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId,
      action: "number_purchase",
      minimumUsd: Number(
        process.env.BILLING_MIN_NUMBER_PURCHASE_CREDIT_USD || 3.84,
      ),
    });
    if (creditAllowed !== true) return;

    const db = getSupabase();
    try {
      const account = await ensureTenantTwilioAccount({
        organizationId,
        organizationName: req.organization?.name,
        createIfMissing: true,
      });

      const purchaseType = req.body?.type || req.body?.numberType || "Local";
      const exactDigits = phoneDigits(phoneNumber);
      const candidateDigits = exactDigits.slice(-7) || exactDigits;
      const safeCandidates = await searchAvailableRecommendedNumbers({
        accountSid: account.account_sid,
        country,
        contains: candidateDigits || undefined,
        requiresVoice: true,
        requiresSms: false,
        showAdvancedRestrictedNumbers: false,
        limit: 40,
        type: purchaseType,
      });
      const selectedCandidate = safeCandidates.find(
        (candidate) => phoneDigits(candidate.phoneNumber) === exactDigits,
      );
      if (!selectedCandidate) {
        return res.status(400).json({
          error: {
            code: "NUMBER_NOT_SAFE_FOR_AUTOMATIC_ACTIVATION",
            message:
              "That number is no longer available or does not pass Agently's automatic voice-readiness rules. Search again and choose a recommended voice number.",
          },
        });
      }

      const purchased = await purchaseIncomingNumber({
        accountSid: account.account_sid,
        phoneNumber,
        friendlyName: `${req.organization?.name || "Agently"} ${phoneNumber}`,
        agentId,
      });

      let configured = purchased;
      try {
        configured = await configureTwilioIncomingNumber(purchased.sid, {
          accountSid: account.account_sid,
          supportsSms: !!(
            purchased.capabilities?.SMS ||
            purchased.capabilities?.sms ||
            selectedCandidate.capabilities?.sms
          ),
        });
      } catch (configureErr) {
        let released = false;
        try {
          await releaseIncomingNumber({
            accountSid: account.account_sid,
            phoneSid: purchased.sid,
          });
          released = true;
        } catch (releaseErr) {
          console.error(
            "[twilio-number-purchase] configuration rollback failed",
            {
              organizationId,
              phoneSid: purchased.sid,
              accountSid: maskSid(account.account_sid),
              configureError: configureErr?.message || String(configureErr),
              releaseError: releaseErr?.message || String(releaseErr),
            },
          );
        }
        const mapped = mapTwilioError(
          configureErr,
          "The number was purchased but could not be configured for Agently calls.",
        );
        return res.status(502).json({
          error: {
            ...mapped,
            code: "NUMBER_CONFIGURATION_FAILED",
            released,
            message: released
              ? "Agently could not activate this number, so the purchase was reversed and the number was not retained. Search again and choose another recommended number."
              : "Agently could not activate this number and could not release it automatically. Please contact support before using this number.",
          },
        });
      }

      const normalized = {
        phoneSid: configured.sid || purchased.sid,
        phoneNumber:
          configured.phone_number || purchased.phone_number || phoneNumber,
        accountSid:
          configured.account_sid ||
          purchased.account_sid ||
          account.account_sid,
        country: configured.iso_country || purchased.iso_country || country,
        capabilities: {
          voice: !!(
            configured.capabilities?.voice || purchased.capabilities?.voice
          ),
          sms: !!(
            configured.capabilities?.SMS ||
            configured.capabilities?.sms ||
            purchased.capabilities?.SMS ||
            purchased.capabilities?.sms
          ),
          mms: !!(
            configured.capabilities?.MMS ||
            configured.capabilities?.mms ||
            purchased.capabilities?.MMS ||
            purchased.capabilities?.mms
          ),
        },
        addressRequirements:
          configured.address_requirements ||
          purchased.address_requirements ||
          "none",
        voiceUrl:
          configured.voice_url ||
          purchased.voice_url ||
          `${apiBaseUrl()}/api/twilio/voice-inbound`,
        voiceFallbackUrl:
          configured.voice_fallback_url ||
          purchased.voice_fallback_url ||
          `${apiBaseUrl()}/api/twilio/voice-inbound`,
        statusCallback:
          configured.status_callback ||
          purchased.status_callback ||
          `${apiBaseUrl()}/api/twilio/call-status`,
        smsUrl:
          configured.sms_url ||
          purchased.sms_url ||
          `${apiBaseUrl()}/api/twilio/sms-inbound`,
        smsFallbackUrl:
          configured.sms_fallback_url ||
          purchased.sms_fallback_url ||
          `${apiBaseUrl()}/api/twilio/sms-inbound`,
        bundleSid: configured.bundle_sid || purchased.bundle_sid || null,
        addressSid: configured.address_sid || purchased.address_sid || null,
      };

      const finalRecommendation = isRecommendedForAutomaticPurchase(
        normalized,
        {
          country,
          requiresVoice: true,
          requiresSms: false,
        },
      );
      if (!finalRecommendation.safeForAutomaticPurchase) {
        let released = false;
        try {
          await releaseIncomingNumber({
            accountSid: account.account_sid,
            phoneSid: normalized.phoneSid,
          });
          released = true;
        } catch (releaseErr) {
          console.error(
            "[twilio-number-purchase] restricted-number release failed",
            {
              organizationId,
              phoneSid: normalized.phoneSid,
              accountSid: maskSid(account.account_sid),
              recommendation: finalRecommendation,
              releaseError: releaseErr?.message || String(releaseErr),
            },
          );
        }
        return res.status(400).json({
          error: {
            code: "NUMBER_NOT_SAFE_FOR_AUTOMATIC_ACTIVATION",
            message: released
              ? "Agently rejected and released this number because it did not pass automatic voice-readiness checks. Search again and choose another recommended number."
              : "Agently rejected this number because it did not pass automatic voice-readiness checks, but could not release it automatically. Please contact support before using it.",
            recommendation: finalRecommendation,
            released,
          },
        });
      }
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
      let billingEvent = null;
      try {
        billingEvent = await insertUsageEvent({
          organizationId,
          userId: req.user?.id || null,
          provider: "twilio",
          service: "phone_number",
          eventType: "number_purchase",
          source: "twilio_number_purchase_route",
          externalId: saved.phone_sid || saved.phone_number,
          voiceAgentId: agentId || null,
          unit: "number",
          quantity: 1,
          metadata: {
            phone_number: saved.phone_number,
            phone_sid: saved.phone_sid,
            account_sid: account.account_sid,
            country,
            purchase_origin: "in_app_purchase",
          },
        });
      } catch (billingErr) {
        const rollback = await rollbackPurchasedNumberAfterBillingFailure({
          db,
          organizationId,
          accountSid: account.account_sid,
          savedNumber: saved,
          billingError: billingErr,
        });
        const error = new Error(
          rollback.providerReleased
            ? "The number purchase was reversed because the required wallet deduction could not be posted. No number was retained."
            : "The wallet deduction failed and the number could not be released automatically. Agently marked it for urgent cleanup.",
        );
        error.code = "NUMBER_PURCHASE_BILLING_FAILED";
        error.status = 503;
        error.details = rollback;
        throw error;
      }
      res.json({
        success: true,
        phoneNumber: saved.phone_number,
        phoneSid: saved.phone_sid,
        agentId,
        number: saved,
        readiness,
        voicePermissionResult,
        billing: billingEvent?.billing || null,
      });
    } catch (err) {
      if (err.code === "NUMBER_PURCHASE_BILLING_FAILED") {
        return res.status(err.status || 503).json({
          error: {
            code: err.code,
            message: err.message,
            details: err.details || null,
          },
        });
      }
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
          ...defaultOutboundVoiceCountries(number.iso_country),
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
    const countries = normalizeCountryList(req.body?.countries || []);
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
        lowRiskCountriesConfigured:
          result.lowRiskCountriesConfigured || lowRiskCountries(),
        requestedCountriesNormalized:
          result.requestedCountriesNormalized || countries,
        countriesAllowedAfterLowRiskFilter:
          result.countriesAllowedAfterLowRiskFilter || [],
        result,
        readiness,
      });
    } catch (err) {
      const mapped = mapTwilioError(
        err,
        "Could not update voice dialing permissions.",
      );
      res.status(400).json({
        error: mapped,
        lowRiskCountriesConfigured: lowRiskCountries(),
        requestedCountriesNormalized: countries,
        countriesAllowedAfterLowRiskFilter: [],
      });
    }
  }),
);

router.post(
  "/numbers/:id/sms-countries",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = bodyOrg(req);
    const countries = normalizeCountryList(req.body?.countries || []);
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
    const fromNumber = normalizePhone(
      req.body?.fromNumber || req.body?.from || "",
    );
    const agentId = req.body?.agentId || req.body?.voiceAgentId || null;
    const leadId = req.body?.leadId || null;
    let recipientName = voiceBehavior.cleanRecipientNameForSpeech(
      req.body?.recipientName ||
        req.body?.targetName ||
        req.body?.customerName ||
        "",
    );
    let targetName = voiceBehavior.cleanRecipientNameForSpeech(
      req.body?.targetName || recipientName || "",
    );
    const customInstructions = String(
      req.body?.customInstructions || "",
    ).trim();
    const maxCallSeconds = Number(
      req.body?.maxCallSeconds || req.body?.max_call_seconds || 0,
    );
    const platformTestMode =
      req.body?.platformTestMode === true ||
      req.body?.platform_test_mode === true;
    const platformTestEventId = String(
      req.body?.platformTestEventId || req.body?.platform_test_event_id || "",
    ).trim();
    let purpose;
    try {
      purpose = outboundPurposeFromBody(req.body || {});
    } catch (err) {
      return res.status(err.status || 400).json({
        error: {
          code: err.code || "CALL_PURPOSE_REQUIRED",
          message: err.message,
        },
      });
    }
    const { callPurpose, callPurposeWarning } = purpose;

    const creditAllowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId,
      action: "outbound_call",
    });
    if (creditAllowed !== true) return;

    if (!isE164(toPhone))
      return res.status(400).json({
        error: {
          code: "INVALID_PHONE_NUMBER",
          message: "Destination must be an E.164 number like +14155551234.",
        },
      });

    const db = getSupabase();
    const requestedAgentId = agentId || req.organization?.active_voice_agent_id;
    let number = null;
    let selectedAssignment = null;

    if (fromNumberId || fromNumber) {
      let q = db
        .from("twilio_phone_numbers")
        .select("*")
        .eq("organization_id", organizationId);
      if (fromNumberId) q = q.eq("id", fromNumberId);
      else if (fromNumber) q = q.eq("phone_number", fromNumber);
      const result = await q.maybeSingle();
      number = result.data || null;
    } else {
      const resolved = await findDefaultOutboundNumberForAgent(
        db,
        organizationId,
        requestedAgentId,
      );
      number = resolved?.number || null;
      selectedAssignment = resolved?.assignment || null;
    }

    if (!number)
      return res.status(404).json({
        error: {
          code: "NUMBER_NOT_OWNED",
          message:
            "No configured from-number was found for this tenant/agent. Assign a business number to this agent first.",
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
      requestedAgentId ||
      selectedAssignment?.agent_id ||
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
    if (readiness.outbound_voice?.status !== "ready") {
      console.warn("[outbound-call] non-ready outbound voice status", {
        numberId: number.id,
        phoneNumber: number.phone_number,
        status: readiness.outbound_voice?.status,
        strict: strictNumberReadinessEnabled(),
      });
      if (strictNumberReadinessEnabled()) {
        return res.status(400).json({
          error: {
            code: "OUTBOUND_VOICE_NOT_READY",
            message: "This number is not ready for outbound voice calls.",
            readiness,
          },
        });
      }
    }
    // In Phase 3, outbound readiness can be satisfied by the many-to-many
    // assignment table, even if the number's inbound/default agent field is
    // empty. The actual agent is loaded and verified below.
    if (
      !actualAgentId &&
      readiness.assigned_agent?.status &&
      readiness.assigned_agent.status !== "ready"
    ) {
      return res.status(400).json({
        error: {
          code: "AGENT_NOT_READY",
          message:
            "The selected number is not assigned to an active voice agent.",
          readiness,
        },
      });
    }

    const destinationCountry = guessCountryFromE164(toPhone);
    console.log("[outbound-call] destinationCountry", destinationCountry);
    const selected = voiceCountriesForNumber(number, destinationCountry);
    if (!selected.has(destinationCountry) && destinationCountry !== "UNKNOWN") {
      return res.status(400).json({
        error: {
          code: "COUNTRY_NOT_ENABLED",
          message: `Outbound calls to ${destinationCountry} are not selected/enabled for this number.`,
          destinationCountry,
          enabledCountries: [...selected],
        },
      });
    }

    const { data: agentRow } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", actualAgentId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .maybeSingle();
    let agent = agentRow || null;
    if (!agent)
      return res.status(404).json({
        error: {
          code: "VOICE_AGENT_NOT_FOUND",
          message: "Active voice agent not found.",
        },
      });

    // Lightweight context readiness check: Railway will load the full prompt, but
    // the outbound API verifies that the tenant/agent rows are readable first.
    const { data: organization } = await db
      .from("organizations")
      .select("id,name")
      .eq("id", organizationId)
      .maybeSingle();
    if (!organization)
      return res.status(404).json({
        error: {
          code: "ORGANIZATION_NOT_FOUND",
          message: "Organization context could not be loaded.",
        },
      });

    if (leadId && !recipientName) {
      try {
        const { data: lead } = await db
          .from("leads")
          .select("name,phone,email")
          .eq("id", leadId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        recipientName = voiceBehavior.cleanRecipientNameForSpeech(
          lead?.name || "",
        );
        targetName = targetName || recipientName;
        console.log("[outbound-call] recipient name resolved from lead", {
          leadId,
          hasRecipientName: Boolean(recipientName),
        });
      } catch (err) {
        console.warn("[outbound-call] lead recipient lookup skipped", {
          leadId,
          error: err.message || String(err),
        });
      }
    }

    console.log("[outbound-call] validation passed", {
      organizationId,
      agentId: agent.id,
      fromNumber: number.phone_number,
      to: toPhone,
    });
    console.log("[outbound-call] callPurpose", callPurpose);

    const preflightContext = await preloadOutboundCallContext({
      db,
      organizationId,
      agent,
      query: [callPurpose, recipientName, targetName, toPhone]
        .filter(Boolean)
        .join(" "),
      assignmentContext: customInstructions,
    });
    agent = preflightContext.agent || agent;

    const aiProvider = await checkOpenAIRealtimeProvider();
    if (!aiProvider.success) {
      console.warn(
        "[outbound-call] AI provider preflight warning; continuing",
        {
          reason: aiProvider?.error?.reason || "unknown",
        },
      );
      if (
        String(
          process.env.AI_PROVIDER_PREFLIGHT_ENFORCE || "false",
        ).toLowerCase() === "true"
      ) {
        return res.status(503).json(aiProvider);
      }
    }

    const record = await createCallRecord({
      organizationId,
      voiceAgentId: agent.id,
      callerName: recipientName || "Outbound Recipient",
      callerPhone: toPhone,
      leadId,
      direction: "outbound",
      status: "queued",
      metadata: {
        initiatedBy: req.user?.id || null,
        fromNumberId: number.id,
        fromNumber: number.phone_number,
        fromAccountSid: number.account_sid || account.account_sid || null,
        toPhone,
        leadId,
        recipientName,
        targetName,
        callPurpose,
        customInstructions,
        callPurposeWarning: callPurposeWarning || null,
        maxCallSeconds: maxCallSeconds || null,
        platformTestMode,
        platformTestEventId: platformTestEventId || null,
        preflightContext: preflightContext.summary || null,
      },
    });

    const preparedOpeningGreeting = preparedOpeningGreetingForCall({
      agent,
      organization,
      direction: "outbound",
      recipientName,
      targetName,
      callPurpose,
    });
    const normalizedPurpose = voiceBehavior.humanizeOutboundPurposeForSpeech(
      callPurpose || "",
      220,
    );
    console.log("[context-audit] purpose intent", {
      raw_call_purpose: String(callPurpose || "").slice(0, 240),
      normalized_call_purpose: normalizedPurpose,
      product_intent_explicit:
        voiceBehavior.purposeExplicitlyMentionsProducts?.(callPurpose || "") ||
        false,
      webinar_intent_explicit:
        voiceBehavior.purposeExplicitlyMentionsWebinar?.(callPurpose || "") ||
        false,
    });
    console.log("[outbound-call] opening greeting prepared before answer", {
      callRecordId: record.id,
      agentId: agent.id,
      hasRecipientName: Boolean(recipientName || targetName),
      greetingChars: preparedOpeningGreeting.length,
    });

    const base = API_URL();
    const twimlUrl = encodeOutboundTwiMlUrl(base, {
      orgId: organizationId,
      agentId: agent.id,
      callRecordId: record.id,
      direction: "outbound",
      recipientPhone: toPhone,
      recipientName,
      targetName,
      callerPhone: number.phone_number,
      accountSid: number.account_sid || account.account_sid || undefined,
      leadId,
      callPurpose,
      normalizedPurpose,
      openingGreeting: preparedOpeningGreeting,
      customInstructions,
      maxCallSeconds: maxCallSeconds || undefined,
      platformTestMode: platformTestMode ? "true" : undefined,
      platformTestEventId: platformTestEventId || undefined,
    });
    const mediaStreamUrl = mediaStreamUrlPreview({
      orgId: organizationId,
      agentId: agent.id,
      callRecordId: record.id,
      direction: "outbound",
      recipientPhone: toPhone,
      recipientName,
      targetName,
      callerPhone: number.phone_number,
      accountSid: number.account_sid || account.account_sid || undefined,
      leadId,
      callPurpose,
      normalizedPurpose,
      openingGreeting: preparedOpeningGreeting,
      customInstructions,
      maxCallSeconds: maxCallSeconds || undefined,
      platformTestMode: platformTestMode ? "true" : undefined,
      platformTestEventId: platformTestEventId || undefined,
    });
    console.log("[outbound-call] twimlUrl", twimlUrl);
    console.log("[outbound-call] mediaStreamUrl", mediaStreamUrl);
    try {
      const result = await makeOutboundCall({
        from: number.phone_number,
        to: toPhone,
        accountSid: number.account_sid || account.account_sid,
        twimlUrl,
        statusCallbackUrl: `${base}/api/twilio/call-status`,
        machineDetection: process.env.OUTBOUND_MACHINE_DETECTION ?? "",
        record: callRecordingEnabled(),
      });
      console.log("[outbound-call] machineDetection enabled", {
        value: process.env.OUTBOUND_MACHINE_DETECTION ?? "disabled",
        asyncAmd:
          String(process.env.OUTBOUND_ASYNC_AMD || "true").toLowerCase() !==
          "false",
      });
      console.log("[outbound-call] callSid", result.callSid);
      await updateCallRecordById(record.id, {
        twilio_call_sid: result.callSid,
        status: result.status || "initiated",
      });
      res.json({
        success: true,
        callSid: result.callSid,
        callRecordId: record.id,
        status: result.status,
        destinationCountry,
        callPurpose,
        callPurposeWarning: callPurposeWarning || undefined,
        twimlUrl,
        mediaStreamUrl,
      });
    } catch (err) {
      const mapped = mapTwilioError(err, "Could not start outbound call.");
      console.error("[outbound-call] Twilio call creation failed", {
        organizationId,
        callRecordId: record.id,
        fromNumber: number.phone_number,
        fromAccountSid: maskSid(number.account_sid || account.account_sid),
        to: toPhone,
        error: mapped,
      });
      try {
        await updateCallRecordById(record.id, {
          status: "failed",
          metadata: {
            error: mapped,
            failureStage: "twilio_call_create",
            fromNumber: number.phone_number,
            fromAccountSid: maskSid(number.account_sid || account.account_sid),
            toPhone,
          },
        });
      } catch (_) {}
      res.status(400).json({
        error: mapped,
        callPurposeWarning: callPurposeWarning || undefined,
      });
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
    try {
      await getSupabase()
        .from("twilio_import_challenges")
        .insert({
          organization_id: req.orgId,
          phone_number: phoneNumber,
          challenge_token: token,
          status: "pending",
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
    } catch (_) {
      // Challenge persistence is best-effort for deployments before the migration is applied.
    }
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
    let challengeResult;
    try {
      challengeResult = await db
        .from("twilio_import_challenges")
        .select("*")
        .eq("challenge_token", token)
        .maybeSingle();
    } catch (err) {
      challengeResult = { data: null, error: err };
    }
    const challenge = challengeResult?.data || null;
    if (challenge) {
      try {
        await db
          .from("twilio_import_challenges")
          .update({
            status: "verified",
            verified_at: new Date().toISOString(),
            twilio_to: calledNumber,
          })
          .eq("id", challenge.id);
      } catch (_) {
        // Keep challenge callback response non-blocking.
      }
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

// Search available tenant-purchasable numbers.
// Keep this GET route for older frontend builds, but use the same strict
// recommendation filter as the POST route. Never expose restricted/manual-setup
// numbers to tenant purchases by default.
router.get(
  "/numbers/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const organizationId = req.orgId;
    const country = normalizeCountry(req.query?.country || "US");
    const requiresSms = String(req.query?.requiresSms || "false") === "true";
    const requiresVoice =
      String(req.query?.requiresVoice || "true") !== "false";

    if (!supportedCountries().includes(country)) {
      return res.status(400).json({
        error: {
          code: "UNSUPPORTED_COUNTRY",
          message: `Agently is not currently configured to sell numbers in ${country}.`,
          supportedCountries: supportedCountries(),
        },
      });
    }

    try {
      const account = await ensureTenantTwilioAccount({
        organizationId,
        organizationName: req.organization?.name,
        createIfMissing: false,
      });
      const numbers = await searchAvailableRecommendedNumbers({
        accountSid: account.account_sid,
        country,
        areaCode: req.query?.areaCode,
        contains: req.query?.contains,
        requiresSms,
        requiresVoice,
        showAdvancedRestrictedNumbers: false,
        limit: Number(req.query?.limit || 20),
        type: req.query?.type || req.query?.numberType || "Local",
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
        if (
          String(row.lifecycle_status || "active").toLowerCase() === "released"
        ) {
          continue;
        }
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

    const { data: agent } = await db
      .from("voice_agents")
      .select("id,name")
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId)
      .maybeSingle();

    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: phoneNumber,
        twilio_phone_sid: phoneSid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId);

    // Phase 3 compatibility: legacy assignment calls should also create the
    // non-exclusive outbound assignment row when the number exists in the
    // tenant phone-number table.
    if (agent?.id) {
      try {
        const { data: numberRow } = await db
          .from("twilio_phone_numbers")
          .select("*")
          .eq("organization_id", req.orgId)
          .eq("phone_sid", phoneSid)
          .maybeSingle();
        if (numberRow?.id) {
          await upsertOutboundNumberAssignment({
            db,
            organizationId: req.orgId,
            number: numberRow,
            agent,
            direction: "outbound",
            isDefaultForAgent: true,
          });
        }
      } catch (err) {
        console.warn(
          "[numbers/assign] assignment mirror skipped:",
          err.message || String(err),
        );
      }
    }

    res.json({ success: true });
  }),
);

// ─────────────────────────────────────────────────────────────
// Tenant-scoped number list used by the Agently Phone Numbers UI.
// IMPORTANT: this must NEVER list all Twilio/master-account numbers.
// It returns only rows in twilio_phone_numbers for the authenticated org.
// ─────────────────────────────────────────────────────────────
router.get(
  "/numbers",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const organizationId = req.orgId;

    const { data: rows, error } = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[twilio/numbers] tenant query failed:", error.message);
      return res.status(500).json({
        error: { message: "Failed to load this tenant's phone numbers." },
      });
    }

    const visibleRows = (rows || []).filter(
      (row) =>
        String(row?.lifecycle_status || "active").toLowerCase() !==
          "released" &&
        row?.is_platform_test_number !== true &&
        String(row?.source || row?.number_type || "") !== "platform_test" &&
        String(row?.purchase_origin || "") !== "platform_beta_test_pool",
    );

    const assignmentsByNumberId = await loadOutboundAssignmentsByNumber(
      db,
      organizationId,
      visibleRows.map((row) => row.id),
    );

    const assignmentAgentIds = [];
    for (const list of assignmentsByNumberId.values()) {
      for (const assignment of list) {
        if (assignment.agent_id) assignmentAgentIds.push(assignment.agent_id);
      }
    }

    const agentIds = [
      ...new Set([
        ...visibleRows.map((n) => n.assigned_voice_agent_id).filter(Boolean),
        ...assignmentAgentIds,
      ]),
    ];
    let agentsById = new Map();
    if (agentIds.length) {
      const { data: agents } = await db
        .from("voice_agents")
        .select(
          "id,name,direction,twilio_phone_number,twilio_phone_sid,is_active",
        )
        .eq("organization_id", organizationId)
        .in("id", agentIds);
      agentsById = new Map((agents || []).map((a) => [a.id, a]));
    }

    const now = new Date().toISOString();
    const normalized = [];

    for (const row of visibleRows) {
      const caps = row.capabilities || {};
      const voiceCapable = caps.voice !== false;
      const isNorthAmerica =
        row.iso_country === "US" ||
        row.iso_country === "CA" ||
        /^\+1/.test(row.phone_number || "");
      const shouldMarkReady = isNorthAmerica && voiceCapable;
      let current = row;

      const outboundAssignments = assignmentsByNumberId.get(row.id) || [];
      const hasOutboundAssignments = outboundAssignments.length > 0;

      if (shouldMarkReady) {
        const readinessPatch = {
          configuration_status: "ready",
          overall_status: "ready",
          inbound_voice_status: "ready",
          outbound_voice_status: "ready",
          regulatory_readiness_status: "verified",
          assigned_agent_status:
            row.assigned_voice_agent_id || hasOutboundAssignments
              ? "ready"
              : "needs_assignment",
          last_error: null,
          updated_at: now,
        };
        const { data: updated } = await db
          .from("twilio_phone_numbers")
          .update(readinessPatch)
          .eq("id", row.id)
          .eq("organization_id", organizationId)
          .select("*")
          .maybeSingle();
        current = updated || { ...row, ...readinessPatch };
      }

      const inboundAgent = current.assigned_voice_agent_id
        ? agentsById.get(current.assigned_voice_agent_id) || null
        : null;

      const outboundAssignedAgents = outboundAssignments
        .map((assignment) => {
          const relationshipAgent =
            assignment.voice_agents &&
            typeof assignment.voice_agents === "object"
              ? assignment.voice_agents
              : null;
          const agent =
            agentsById.get(assignment.agent_id) || relationshipAgent;
          if (!agent) return null;
          return {
            ...agent,
            assignmentId: assignment.id,
            assignmentDirection: assignment.direction,
            isDefaultForAgent: assignment.is_default_for_agent === true,
          };
        })
        .filter(Boolean);

      const legacyAssignedAgent = inboundAgent;
      const effectiveOutboundAgents = outboundAssignedAgents.length
        ? outboundAssignedAgents
        : legacyAssignedAgent
          ? [
              {
                ...legacyAssignedAgent,
                assignmentDirection: "legacy",
                isDefaultForAgent: true,
              },
            ]
          : [];

      normalized.push({
        ...current,
        organizationId: current.organization_id,
        phoneNumber: current.phone_number,
        phoneSid: current.phone_sid,
        accountSid: current.account_sid,
        isoCountry: current.iso_country,
        numberType: current.number_type,
        assignedVoiceAgentId: current.assigned_voice_agent_id,
        voiceAgentId: current.assigned_voice_agent_id,
        agentId: current.assigned_voice_agent_id,
        assignedAgent: inboundAgent,
        inboundAgent,
        outboundAssignedAgents: effectiveOutboundAgents,
        assignedAgents: effectiveOutboundAgents,
        assignmentCount: effectiveOutboundAgents.length,
        configurationStatus: current.configuration_status,
        overallStatus: current.overall_status,
        inboundVoiceStatus: current.inbound_voice_status,
        outboundVoiceStatus: current.outbound_voice_status,
        assignedAgentStatus: current.assigned_agent_status,
      });
    }

    return res.json({
      success: true,
      organizationId,
      count: normalized.length,
      numbers: normalized,
    });
  }),
);

// Compatibility alias for older frontend builds.
router.get(
  "/owned-numbers",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: rows, error } = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false });

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to load phone numbers." } });
    }
    return res.json({
      success: true,
      organizationId: req.orgId,
      numbers: (rows || []).filter(
        (row) =>
          row?.is_platform_test_number !== true &&
          String(row?.source || row?.number_type || "") !== "platform_test" &&
          String(row?.purchase_origin || "") !== "platform_beta_test_pool",
      ),
    });
  }),
);

// Compatibility alias for older frontend builds that used GET /available-numbers.
router.get(
  "/available-numbers",
  requireAuth,
  asyncHandler(async (req, res) => {
    const organizationId = req.orgId;
    const country = normalizeCountry(req.query?.country || "US");
    const requiresSms = String(req.query?.requiresSms || "false") === "true";
    const requiresVoice =
      String(req.query?.requiresVoice || "true") !== "false";

    if (!supportedCountries().includes(country)) {
      return res.status(400).json({
        error: {
          code: "UNSUPPORTED_COUNTRY",
          message: `Agently is not currently configured to sell numbers in ${country}.`,
          supportedCountries: supportedCountries(),
        },
      });
    }

    try {
      const account = await ensureTenantTwilioAccount({
        organizationId,
        organizationName: req.organization?.name,
        createIfMissing: false,
      });
      const numbers = await searchAvailableRecommendedNumbers({
        accountSid: account.account_sid,
        country,
        areaCode: req.query?.areaCode,
        contains: req.query?.contains,
        requiresSms,
        requiresVoice,
        showAdvancedRestrictedNumbers: false,
        limit: Number(req.query?.limit || 20),
        type: req.query?.type || req.query?.numberType || "Local",
      });
      return res.json({
        success: true,
        numbers,
        supportedCountries: supportedCountries(),
      });
    } catch (err) {
      const mapped = mapTwilioError(err, "Could not search Twilio numbers.");
      return res.status(400).json({ error: mapped });
    }
  }),
);

// Compatibility alias for older frontend builds that used POST /purchase-number.
router.post("/purchase-number", requireAuth, requireAdmin, (req, res, next) => {
  req.url = "/numbers/purchase";
  return router.handle(req, res, next);
});

// Assign one tenant-owned number to one tenant-owned agent for outbound use.
// Phase 3 change: this no longer enforces one-number-one-agent. A single
// tenant-owned number can now be attached to multiple outbound agents.
router.post(
  "/numbers/:id/assign-agent",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const organizationId = req.orgId;
    const numberId = req.params.id;
    const agentId = req.body?.agentId || req.body?.voiceAgentId;
    const direction = normalizeAssignmentDirection(
      req.body?.direction,
      "outbound",
    );
    const makeInboundDefault =
      req.body?.makeInboundDefault === true ||
      req.body?.inboundDefault === true;

    if (!agentId) {
      return res
        .status(400)
        .json({ error: { message: "agentId is required." } });
    }

    const number = await loadTenantNumberByIdOrSid(
      db,
      organizationId,
      numberId,
    );

    if (!number) {
      return res.status(404).json({
        error: { message: "Phone number not found for this organization." },
      });
    }

    const { data: agent } = await db
      .from("voice_agents")
      .select("id,name,twilio_phone_number,twilio_phone_sid")
      .eq("id", agentId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (!agent) {
      return res.status(404).json({
        error: { message: "Voice agent not found for this organization." },
      });
    }

    let assignment;
    try {
      assignment = await upsertOutboundNumberAssignment({
        db,
        organizationId,
        number,
        agent,
        direction,
        isDefaultForAgent: req.body?.isDefaultForAgent !== false,
      });
    } catch (err) {
      return res.status(500).json({
        error: {
          code: "ASSIGNMENT_TABLE_NOT_READY",
          message:
            "Number assignment could not be saved. Run the Phase 3 agent phone-number assignments migration first.",
          details: err.message || String(err),
        },
      });
    }

    const patch = {
      assigned_agent_status: "ready",
      configuration_status: "ready",
      overall_status: "ready",
      inbound_voice_status: "ready",
      outbound_voice_status: "ready",
      regulatory_readiness_status: "verified",
      last_error: null,
      updated_at: new Date().toISOString(),
    };

    // Keep inbound/default routing explicit. For backward compatibility, if the
    // number had no default agent yet, the first assignment becomes the default.
    if (!number.assigned_voice_agent_id || makeInboundDefault) {
      patch.assigned_voice_agent_id = agentId;
    }

    const { data: updatedNumber, error: updateErr } = await db
      .from("twilio_phone_numbers")
      .update(patch)
      .eq("id", number.id)
      .eq("organization_id", organizationId)
      .select("*")
      .single();

    if (updateErr) {
      return res.status(500).json({ error: { message: updateErr.message } });
    }

    // Legacy compatibility: older outbound paths still read the default number
    // from voice_agents. This does not make the number exclusive to this agent.
    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: number.phone_number,
        twilio_phone_sid: number.phone_sid,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", agentId)
      .eq("organization_id", organizationId);

    return res.json({
      success: true,
      number: updatedNumber,
      assignment,
      agentId,
      message: `${number.phone_number || "Number"} is now available to ${agent.name || "this agent"} for outbound calls.`,
    });
  }),
);

// Remove one outbound agent from one tenant-owned number without releasing the
// number and without clearing other agents that use the same number.
router.delete(
  "/numbers/:id/assignments/:agentId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const organizationId = req.orgId;
    const number = await loadTenantNumberByIdOrSid(
      db,
      organizationId,
      req.params.id,
    );
    const agentId = String(req.params.agentId || "").trim();

    if (!number) {
      return res.status(404).json({
        error: { message: "Phone number not found for this organization." },
      });
    }
    if (!agentId) {
      return res
        .status(400)
        .json({ error: { message: "agentId is required." } });
    }

    try {
      await db
        .from("agent_phone_number_assignments")
        .delete()
        .eq("organization_id", organizationId)
        .eq("phone_number_id", number.id)
        .eq("agent_id", agentId)
        .in("direction", ["outbound", "both"]);
    } catch (err) {
      return res.status(500).json({
        error: {
          code: "ASSIGNMENT_TABLE_NOT_READY",
          message:
            "Number assignment could not be removed. Run the Phase 3 assignment migration first.",
          details: err.message || String(err),
        },
      });
    }

    // If this agent no longer has any outbound number assignment, clear the
    // legacy fields so older UI paths do not show a stale number.
    const { data: remainingAssignments } = await db
      .from("agent_phone_number_assignments")
      .select("phone_number, phone_sid")
      .eq("organization_id", organizationId)
      .eq("agent_id", agentId)
      .in("direction", ["outbound", "both"])
      .order("is_default_for_agent", { ascending: false })
      .limit(1);

    const nextAssignment = remainingAssignments?.[0];
    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: nextAssignment?.phone_number || "",
        twilio_phone_sid: nextAssignment?.phone_sid || "",
        updated_at: new Date().toISOString(),
      })
      .eq("id", agentId)
      .eq("organization_id", organizationId);

    return res.json({
      success: true,
      numberId: number.id,
      agentId,
      remainingDefaultNumber: nextAssignment?.phone_number || null,
    });
  }),
);

// Unassign a number from its current agent without releasing it from Twilio.
router.patch(
  "/numbers/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (
      !req.body?.unassign &&
      req.body?.agentId !== null &&
      req.body?.voiceAgentId !== null
    ) {
      return res.status(400).json({
        error: {
          message: "Only unassign updates are supported by this route.",
        },
      });
    }

    const db = getSupabase();
    const organizationId = req.orgId;
    const numberId = req.params.id;

    const { data: number } = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("organization_id", organizationId)
      .or(`id.eq.${numberId},phone_sid.eq.${numberId}`)
      .maybeSingle();

    if (!number) {
      return res.status(404).json({
        error: { message: "Phone number not found for this organization." },
      });
    }

    const oldAgentId = number.assigned_voice_agent_id;

    let assignmentAgentIds = [];
    try {
      const { data: assignments } = await db
        .from("agent_phone_number_assignments")
        .select("agent_id")
        .eq("organization_id", organizationId)
        .eq("phone_number_id", number.id);
      assignmentAgentIds = (assignments || [])
        .map((row) => row.agent_id)
        .filter(Boolean);

      await db
        .from("agent_phone_number_assignments")
        .delete()
        .eq("organization_id", organizationId)
        .eq("phone_number_id", number.id);
    } catch (err) {
      console.warn(
        "[twilio/numbers] assignment cleanup skipped:",
        err.message || String(err),
      );
    }

    const { data: updatedNumber, error: updateErr } = await db
      .from("twilio_phone_numbers")
      .update({
        assigned_voice_agent_id: null,
        assigned_agent_status: "needs_assignment",
        updated_at: new Date().toISOString(),
      })
      .eq("id", number.id)
      .eq("organization_id", organizationId)
      .select("*")
      .single();

    if (updateErr) {
      return res.status(500).json({ error: { message: updateErr.message } });
    }

    const agentIdsToClear = [
      ...new Set([oldAgentId, ...assignmentAgentIds].filter(Boolean)),
    ];
    if (agentIdsToClear.length) {
      await db
        .from("voice_agents")
        .update({
          twilio_phone_number: "",
          twilio_phone_sid: "",
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", organizationId)
        .in("id", agentIdsToClear);
    }

    return res.json({ success: true, number: updatedNumber });
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

    const { data: numberRow, error: numberLookupError } = await db
      .from("twilio_phone_numbers")
      .select("id,organization_id,phone_sid,phone_number,account_sid")
      .eq("organization_id", req.orgId)
      .eq("phone_sid", sid)
      .maybeSingle();

    if (numberLookupError && numberLookupError.code !== "PGRST116") {
      return res.status(500).json({
        error: { message: "Unable to load this business number." },
      });
    }

    try {
      await releaseIncomingNumber({
        accountSid: numberRow?.account_sid || masterSid(),
        phoneSid: sid,
      });
    } catch (releaseError) {
      if (Number(releaseError?.status || 0) !== 404) {
        const mapped = mapTwilioError(
          releaseError,
          "Could not release this business number.",
        );
        return res.status(400).json({ error: mapped });
      }
    }

    const releasedAt = new Date().toISOString();

    await db
      .from("voice_agents")
      .update({
        twilio_phone_number: "",
        twilio_phone_sid: "",
        updated_at: releasedAt,
      })
      .eq("twilio_phone_sid", sid)
      .eq("organization_id", req.orgId);

    try {
      await db
        .from("agent_phone_number_assignments")
        .delete()
        .eq("organization_id", req.orgId)
        .eq("phone_sid", sid);
      if (numberRow?.id) {
        await db
          .from("agent_phone_number_assignments")
          .delete()
          .eq("organization_id", req.orgId)
          .eq("phone_number_id", numberRow.id);
      }
    } catch (assignmentError) {
      console.warn(
        "[numbers/delete] assignment cleanup skipped:",
        assignmentError?.message || String(assignmentError),
      );
    }

    if (numberRow?.id) {
      const { error: lifecycleError } = await db
        .from("twilio_phone_numbers")
        .update({
          lifecycle_status: "released",
          released_at: releasedAt,
          release_reason: "customer_requested",
          assigned_voice_agent_id: null,
          provider_release_error: null,
          updated_at: releasedAt,
        })
        .eq("id", numberRow.id)
        .eq("organization_id", req.orgId);

      if (lifecycleError) {
        // Compatibility fallback for environments where the lifecycle migration
        // has not yet been applied. The provider release has already succeeded.
        await db
          .from("twilio_phone_numbers")
          .delete()
          .eq("id", numberRow.id)
          .eq("organization_id", req.orgId);
      }
    }

    res.json({ success: true, releasedAt });
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
// Called by the Vercel Cron job configured in vercel.json.
// Vercel Cron sends a GET request with `Authorization: Bearer
// <CRON_SECRET>` — it does NOT send a custom header and does NOT POST.
// This also still accepts POST + `x-cron-secret` so it can be triggered
// manually or from an external scheduler if you ever move off Vercel Cron.
// ─────────────────────────────────────────────────────────────
function verifyCronRequest(req) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const authHeader = String(req.headers.authorization || "").trim();
  const bearerMatch = authHeader === `Bearer ${secret}`;
  const legacyHeaderMatch =
    String(req.headers["x-cron-secret"] || "").trim() === secret;
  return bearerMatch || legacyHeaderMatch;
}

async function runBillingSyncCron(req, res) {
  if (!verifyCronRequest(req)) {
    return res.status(401).json({ error: { message: "Unauthorized" } });
  }
  try {
    const tracker = require("../../lib/billing-tracker");
    void tracker.runOnce();
    return res.json({ success: true, triggered: new Date().toISOString() });
  } catch (err) {
    console.error("[billing-sync cron] error:", err && err.message);
    return res.status(500).json({ error: { message: "Billing sync failed." } });
  }
}

router.get("/_internal/billing-sync", asyncHandler(runBillingSyncCron));
router.post("/_internal/billing-sync", asyncHandler(runBillingSyncCron));

// ─────────────────────────────────────────────────────────────
// ── PROTECTED: Initiate Outbound Call ────────────────────────
// ─────────────────────────────────────────────────────────────
router.post(
  "/outbound",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const toPhone = normalizePhone(req.body?.toPhone || req.body?.to || "");
    let recipientName = voiceBehavior.cleanRecipientNameForSpeech(
      req.body?.recipientName ||
        req.body?.targetName ||
        req.body?.customerName ||
        "",
    );
    let targetName = voiceBehavior.cleanRecipientNameForSpeech(
      req.body?.targetName || recipientName || "",
    );
    const customerName = recipientName || "Outbound Recipient";
    const voiceAgentId = req.body?.voiceAgentId || req.body?.agentId || null;
    const leadId = req.body?.leadId || null;
    const customInstructions = String(
      req.body?.customInstructions || "",
    ).trim();
    const maxCallSeconds = Number(
      req.body?.maxCallSeconds || req.body?.max_call_seconds || 0,
    );
    const platformTestMode =
      req.body?.platformTestMode === true ||
      req.body?.platform_test_mode === true;
    const platformTestEventId = String(
      req.body?.platformTestEventId || req.body?.platform_test_event_id || "",
    ).trim();
    let purpose;
    try {
      purpose = outboundPurposeFromBody(req.body || {});
    } catch (err) {
      return res.status(err.status || 400).json({
        error: {
          code: err.code || "CALL_PURPOSE_REQUIRED",
          message: err.message,
        },
      });
    }
    const { callPurpose, callPurposeWarning } = purpose;

    const creditAllowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: req.orgId,
      action: "outbound_call",
    });
    if (creditAllowed !== true) return;

    if (!toPhone)
      return res
        .status(400)
        .json({ error: { message: "toPhone is required." } });
    if (!isE164(toPhone))
      return res.status(400).json({
        error: {
          code: "INVALID_PHONE_NUMBER",
          message: "Destination must be an E.164 number like +14155551234.",
        },
      });

    const db = getSupabase();
    const targetAgentId =
      voiceAgentId || req.organization.active_voice_agent_id;
    const { data: agentRow } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", targetAgentId)
      .eq("organization_id", req.orgId)
      .eq("is_active", true)
      .single();
    let agent = agentRow || null;

    let outboundFromNumber = normalizePhone(
      req.body?.fromNumber ||
        req.body?.from ||
        agent?.twilio_phone_number ||
        "",
    );
    const outboundFromNumberId =
      req.body?.fromNumberId || req.body?.numberId || null;
    let number = null;

    if (outboundFromNumberId || outboundFromNumber) {
      let q = db
        .from("twilio_phone_numbers")
        .select("*")
        .eq("organization_id", req.orgId);
      if (outboundFromNumberId) q = q.eq("id", outboundFromNumberId);
      else q = q.eq("phone_number", outboundFromNumber);
      const result = await q.maybeSingle();
      number = result.data || null;
    }

    if (!number?.id) {
      const resolved = await findDefaultOutboundNumberForAgent(
        db,
        req.orgId,
        agent.id,
      );
      number = resolved?.number || null;
      outboundFromNumber = normalizePhone(
        number?.phone_number || outboundFromNumber,
      );
    }

    if (!outboundFromNumber && number?.phone_number) {
      outboundFromNumber = normalizePhone(number.phone_number);
    }

    if (!outboundFromNumber) {
      return res.status(400).json({
        error: {
          message:
            "This agent has no business number assigned. Connect or assign a number first.",
        },
      });
    }

    const destinationCountry = guessCountryFromE164(toPhone);
    console.log("[outbound-call] destinationCountry", destinationCountry);
    if (number?.id) {
      const readiness = await refreshAndPersistReadiness(number.id, req.orgId);
      if (readiness.outbound_voice?.status !== "ready") {
        console.warn("[outbound-call] non-ready outbound voice status", {
          numberId: number.id,
          phoneNumber: number.phone_number,
          status: readiness.outbound_voice?.status,
          strict: strictNumberReadinessEnabled(),
        });
        if (strictNumberReadinessEnabled()) {
          return res.status(400).json({
            error: {
              code: "OUTBOUND_VOICE_NOT_READY",
              message: "This number is not ready for outbound voice calls.",
              readiness,
            },
          });
        }
      }
      const selected = voiceCountriesForNumber(number, destinationCountry);
      if (
        !selected.has(destinationCountry) &&
        destinationCountry !== "UNKNOWN"
      ) {
        return res.status(400).json({
          error: {
            code: "COUNTRY_NOT_ENABLED",
            message: `Outbound calls to ${destinationCountry} are not selected/enabled for this number.`,
            destinationCountry,
            enabledCountries: [...selected],
          },
        });
      }
    }

    console.log("[outbound-call] validation passed", {
      organizationId: req.orgId,
      agentId: agent.id,
      fromNumber: outboundFromNumber,
      to: toPhone,
    });
    console.log("[outbound-call] callPurpose", callPurpose);

    const aiProvider = await checkOpenAIRealtimeProvider();
    if (!aiProvider.success) {
      console.warn(
        "[outbound-call] AI provider preflight warning; continuing",
        {
          reason: aiProvider?.error?.reason || "unknown",
        },
      );
      if (
        String(
          process.env.AI_PROVIDER_PREFLIGHT_ENFORCE || "false",
        ).toLowerCase() === "true"
      ) {
        return res.status(503).json(aiProvider);
      }
    }

    const preflightContext = await preloadOutboundCallContext({
      db,
      organizationId: req.orgId,
      agent,
      query: [callPurpose, recipientName, targetName, toPhone]
        .filter(Boolean)
        .join(" "),
      assignmentContext: customInstructions,
    });
    agent = preflightContext.agent || agent;

    const record = await createCallRecord({
      organizationId: req.orgId,
      voiceAgentId: agent.id,
      callerName: customerName,
      callerPhone: toPhone,
      leadId: leadId || null,
      direction: "outbound",
      status: "queued",
      metadata: {
        initiatedBy: req.user?.id || null,
        fromNumberId: number?.id || null,
        fromNumber: outboundFromNumber,
        fromAccountSid: number?.account_sid || null,
        leadId,
        recipientName,
        targetName,
        callPurpose,
        customInstructions,
        callPurposeWarning: callPurposeWarning || null,
        maxCallSeconds: maxCallSeconds || null,
        platformTestMode,
        platformTestEventId: platformTestEventId || null,
        preflightContext: preflightContext.summary || null,
      },
    });

    const preparedOpeningGreeting = preparedOpeningGreetingForCall({
      agent,
      organization: req.organization || null,
      direction: "outbound",
      recipientName,
      targetName,
      callPurpose,
    });
    const normalizedPurpose = voiceBehavior.humanizeOutboundPurposeForSpeech(
      callPurpose || "",
      220,
    );
    console.log("[outbound-call] opening greeting prepared before answer", {
      callRecordId: record.id,
      agentId: agent.id,
      hasRecipientName: Boolean(recipientName || targetName),
      greetingChars: preparedOpeningGreeting.length,
    });

    const apiBase = API_URL();
    const twimlUrl = encodeOutboundTwiMlUrl(apiBase, {
      orgId: req.orgId,
      agentId: agent.id,
      callRecordId: record.id,
      direction: "outbound",
      recipientPhone: toPhone,
      recipientName,
      targetName,
      callerPhone: outboundFromNumber,
      accountSid: number?.account_sid || undefined,
      leadId,
      callPurpose,
      normalizedPurpose,
      openingGreeting: preparedOpeningGreeting,
      customInstructions,
      maxCallSeconds: maxCallSeconds || undefined,
      platformTestMode: platformTestMode ? "true" : undefined,
      platformTestEventId: platformTestEventId || undefined,
    });
    const mediaStreamUrl = mediaStreamUrlPreview({
      orgId: req.orgId,
      agentId: agent.id,
      callRecordId: record.id,
      direction: "outbound",
      recipientPhone: toPhone,
      recipientName,
      targetName,
      callerPhone: outboundFromNumber,
      accountSid: number?.account_sid || undefined,
      leadId,
      callPurpose,
      normalizedPurpose,
      openingGreeting: preparedOpeningGreeting,
      customInstructions,
      maxCallSeconds: maxCallSeconds || undefined,
      platformTestMode: platformTestMode ? "true" : undefined,
      platformTestEventId: platformTestEventId || undefined,
    });
    console.log("[outbound-call] twimlUrl", twimlUrl);
    console.log("[outbound-call] mediaStreamUrl", mediaStreamUrl);

    try {
      const result = await makeOutboundCall({
        from: outboundFromNumber,
        to: toPhone,
        accountSid: number?.account_sid || undefined,
        twimlUrl,
        statusCallbackUrl: `${apiBase}/api/twilio/call-status`,
        machineDetection: process.env.OUTBOUND_MACHINE_DETECTION ?? "",
        record: callRecordingEnabled(),
      });
      console.log("[outbound-call] machineDetection enabled", {
        value: process.env.OUTBOUND_MACHINE_DETECTION ?? "disabled",
      });
      console.log("[outbound-call] callSid", result.callSid);

      await updateCallRecordById(record.id, {
        twilio_call_sid: result.callSid,
        status: result.status || "initiated",
      });

      res.json({
        success: true,
        callSid: result.callSid,
        callRecordId: record.id,
        status: result.status,
        destinationCountry,
        callPurpose,
        callPurposeWarning: callPurposeWarning || undefined,
        twimlUrl,
        mediaStreamUrl,
      });
    } catch (err) {
      const mapped = mapTwilioError(err, "Could not start outbound call.");
      console.error("[outbound-call] Twilio call creation failed", {
        organizationId: req.orgId,
        callRecordId: record.id,
        fromNumber: outboundFromNumber,
        fromAccountSid: maskSid(number?.account_sid || ""),
        to: toPhone,
        error: mapped,
      });
      try {
        await updateCallRecordById(record.id, {
          status: "failed",
          metadata: {
            error: mapped,
            failureStage: "twilio_call_create",
            fromNumber: outboundFromNumber,
            fromAccountSid: maskSid(number?.account_sid || ""),
            toPhone,
          },
        });
      } catch (_) {}
      res.status(400).json({
        error: mapped,
        callPurposeWarning: callPurposeWarning || undefined,
      });
    }
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
