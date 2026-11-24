"use strict";

/*
 * Live transfer to a person, after the call server has redirected the call to
 * <Dial> the agent's escalation number. Twilio posts the dial outcome to
 * /api/twilio/transfer-status (the <Dial action>); these helpers decide what
 * happens next:
 *   - bridged:              the person answered and the call is over -> hang up
 *   - unanswered, retries:  ring the number again
 *   - unanswered, no more:  reconnect the caller to the agent, which apologises
 *                           and offers to take a message or a callback
 */

const DEFAULT_ATTEMPTS = 2;
const MAX_ATTEMPTS = 3;
const DIAL_TIMEOUT_SECONDS = 20;

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Same rules as the call server: dashboard values like "(254) 268-8827".
function normalizeTransferNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  let e164 = "";
  if (raw.startsWith("+")) e164 = `+${digits}`;
  else if (raw.startsWith("00")) e164 = `+${digits.slice(2)}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : "";
}

function transferNumberForAgent(agent = {}) {
  if (!agent) return "";
  return (
    normalizeTransferNumber(agent.call_transfer_number) ||
    normalizeTransferNumber(agent.escalation_phone)
  );
}

function clampAttempts(value, fallback = DEFAULT_ATTEMPTS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(n)));
}

// Twilio sends DialBridged=true only when the two legs were connected. With
// the manager brief (<Number url>), "completed" alone also covers a manager
// who declined, never answered the prompt, or whose voicemail picked up, so
// DialBridged decides whenever Twilio sends it.
function isBridged(body = {}) {
  const status = String(body.DialCallStatus || "").trim().toLowerCase();
  const bridged = String(body.DialBridged ?? "").trim().toLowerCase();
  if (bridged) return bridged === "true";
  return status === "completed";
}

/** The manager's phone answered but the caller was not connected. */
function answeredButNotBridged(body = {}) {
  const status = String(body.DialCallStatus || "").trim().toLowerCase();
  const bridged = String(body.DialBridged ?? "").trim().toLowerCase();
  return status === "completed" && bridged !== "" && bridged !== "true";
}

/** "hangup" | "retry" | "resume" */
function nextTransferStep({ bridged, attempt, maxAttempts, declined = false }) {
  if (bridged) return "hangup";
  // A decline (or voicemail) is an answer: go straight back to the caller
  // instead of ringing the same person again.
  if (declined) return "resume";
  return clampAttempts(attempt, 1) < clampAttempts(maxAttempts) ? "retry" : "resume";
}

/** The manager-brief URL for a retry, built from the same callback query. */
function transferWhisperUrl(actionUrl, { brief = "", businessName = "", parentCallSid = "" } = {}) {
  const action = String(actionUrl || "").trim();
  if (!/^https:\/\//i.test(action)) return "";
  const url = new URL("/api/twilio/transfer-whisper", action);
  if (brief) url.searchParams.set("brief", String(brief).slice(0, 300));
  if (businessName) url.searchParams.set("biz", String(businessName).slice(0, 120));
  if (parentCallSid) url.searchParams.set("parentCallSid", String(parentCallSid));
  return url.toString();
}

const WHISPER_VOICE = "Polly.Joanna-Neural";

function cleanSpoken(value, max = 300) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** What the manager hears before the caller is connected. */
function buildWhisperTwiml({ brief = "", businessName = "", resultUrl = "" } = {}) {
  const intro = cleanSpoken(businessName, 120)
    ? `Hi, this is the Agently assistant for ${cleanSpoken(businessName, 120)}.`
    : "Hi, this is your Agently assistant.";
  const summary = cleanSpoken(brief) || "A caller would like to speak to someone.";
  const action = resultUrl ? ` action="${escapeXml(resultUrl)}" method="POST"` : "";
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" hints="yes, no, sure, okay, not now"${action}>` +
    `<Say voice="${WHISPER_VOICE}">${escapeXml(intro)} ${escapeXml(summary)} Are you available to take this call? Say yes or press 1 to connect, or say no or press 2.</Say>` +
    "</Gather>" +
    `<Say voice="${WHISPER_VOICE}">No problem, I'll let them know you're unavailable. Goodbye.</Say><Hangup/>` +
    "</Response>"
  );
}

/** True when the manager said yes or pressed 1. */
function managerAccepted(body = {}) {
  const digits = String(body.Digits || "").trim();
  if (digits) return digits === "1";
  const speech = String(body.SpeechResult || "").toLowerCase();
  if (/\b(?:no|not now|can't|cannot|busy|unavailable|later)\b/.test(speech)) return false;
  return /\b(?:yes|yeah|yep|sure|okay|ok|go ahead|connect|put (?:them|her|him) through|i'll take it|available)\b/.test(speech);
}

/** Accepted: an empty response ends the brief and Twilio connects the call. */
function buildWhisperResultTwiml(accepted) {
  return accepted
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${WHISPER_VOICE}">Connecting you now.</Say></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${WHISPER_VOICE}">Okay, I'll let them know. Goodbye.</Say><Hangup/></Response>`;
}

/** The same callback URL with the attempt counter moved on. */
function nextAttemptActionUrl(apiBase, query = {}, attempt) {
  const base = String(apiBase || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) return "";
  const url = new URL(`${base}/api/twilio/transfer-status`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("attempt", String(attempt));
  return url.toString();
}

function buildRetryTwiml(number, actionUrl, whisperUrl = "") {
  const action = actionUrl ? ` action="${escapeXml(actionUrl)}" method="POST"` : "";
  const recording = actionUrl && String(process.env.CALL_RECORDING_ENABLED || "true").toLowerCase() !== "false"
    ? ` record="record-from-answer-dual" recordingStatusCallback="${escapeXml(new URL("/api/twilio/recording-status", actionUrl).toString())}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed absent"`
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    "<Say>I'm still trying to reach someone for you. Please hold.</Say>" +
    `<Dial answerOnBridge="true" timeout="${DIAL_TIMEOUT_SECONDS}"${action}${recording}><Number${whisperUrl ? ` url="${escapeXml(whisperUrl)}" method="POST"` : ""}>${escapeXml(number)}</Number></Dial>` +
    "</Response>"
  );
}

const UNAVAILABLE_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, I wasn\'t able to get anyone on the line right now. Please call back later.</Say><Hangup/></Response>';
const HANGUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

module.exports = {
  DEFAULT_ATTEMPTS,
  MAX_ATTEMPTS,
  normalizeTransferNumber,
  transferNumberForAgent,
  clampAttempts,
  isBridged,
  answeredButNotBridged,
  nextTransferStep,
  transferWhisperUrl,
  buildWhisperTwiml,
  managerAccepted,
  buildWhisperResultTwiml,
  nextAttemptActionUrl,
  buildRetryTwiml,
  UNAVAILABLE_TWIML,
  HANGUP_TWIML,
};
