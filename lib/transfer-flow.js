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

function isBridged(body = {}) {
  const status = String(body.DialCallStatus || "").trim().toLowerCase();
  return String(body.DialBridged || "").toLowerCase() === "true" || status === "completed";
}

/** "hangup" | "retry" | "resume" */
function nextTransferStep({ bridged, attempt, maxAttempts }) {
  if (bridged) return "hangup";
  return clampAttempts(attempt, 1) < clampAttempts(maxAttempts) ? "retry" : "resume";
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

function buildRetryTwiml(number, actionUrl) {
  const action = actionUrl ? ` action="${escapeXml(actionUrl)}" method="POST"` : "";
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    "<Say>I'm still trying to reach someone for you. Please hold.</Say>" +
    `<Dial answerOnBridge="true" timeout="${DIAL_TIMEOUT_SECONDS}"${action}><Number>${escapeXml(number)}</Number></Dial>` +
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
  nextTransferStep,
  nextAttemptActionUrl,
  buildRetryTwiml,
  UNAVAILABLE_TWIML,
  HANGUP_TWIML,
};
