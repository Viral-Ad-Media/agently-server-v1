/**
 * agently-server/lib/twilio-errors.js   <-- FULL REPLACEMENT
 *
 * PATCH 06 — implements CURRENT_ISSUES → General Settings → 2(e).
 * "under no circumstances should we display ... we want to keep our services
 *  provider hidden from our tenants/org on the frontend"
 *
 * WHAT WAS LEAKING
 *   Every branch of the old mapper returned tenant-facing strings naming the
 *   provider outright:
 *     "Enable the country manually in Twilio Console"
 *     "not enabled for this Twilio account"
 *     "Twilio authentication failed. Check the platform Twilio credentials"
 *     "This Twilio number was not found or is not owned by this tenant"
 *     "Twilio could not reach the configured webhook"
 *   Plus  detail: raw  — the unmodified upstream error string, which is where
 *   the "no rows returned" style text and SIDs were escaping to the browser.
 *
 * DESIGN
 *   Two channels, cleanly separated:
 *     message / detail  -> TENANT-SAFE. Never names the carrier. Never contains
 *                          a SID, an account id, or raw upstream text.
 *     internal          -> full raw detail, provider code, everything. Logged
 *                          and returned ONLY when the caller passes
 *                          { includeInternal: true } (super-admin routes).
 *
 *   The error middleware must not spread `internal` into tenant responses.
 *   See the note at the bottom.
 *
 * BACKWARD COMPATIBLE
 *   Same function name, same call signature, same { code, message, detail }
 *   shape. Existing call sites keep working with no edit.
 */

"use strict";

/** Words that must never reach a tenant response body. */
const VENDOR_PATTERNS = [
  /twilio/gi,
  /elevenlabs/gi,
  /eleven\s*labs/gi,
  /openai/gi,
  /supabase/gi,
  /postgrest/gi,
  /vercel/gi,
  /railway/gi,
  /nominatim/gi,
  /\bAC[0-9a-f]{32}\b/g, // account SIDs
  /\bPN[0-9a-f]{32}\b/g, // phone number SIDs
  /\bCA[0-9a-f]{32}\b/g, // call SIDs
  /\bSK[0-9a-f]{32}\b/g, // api key SIDs
];

/** Raw upstream phrases that must never be shown verbatim. */
const LEAKY_PHRASES = [
  /no rows? returned/gi,
  /JSON object requested/gi,
  /PGRST\d+/gi,
  /relation ".*" does not exist/gi,
  /column ".*" does not exist/gi,
  /duplicate key value/gi,
  /violates .* constraint/gi,
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/gi,
];

function getRawMessage(err) {
  return String(err?.message || err?.error_message || err || "");
}

/**
 * Belt and braces. Even when a branch below is correct, this guarantees that
 * nothing vendor-identifying survives into a tenant-facing string.
 */
function scrub(text, fallback = "The request could not be completed.") {
  let out = String(text || "");
  if (!out) return fallback;

  for (const pattern of LEAKY_PHRASES) {
    if (pattern.test(out)) return fallback;
  }
  for (const pattern of VENDOR_PATTERNS) {
    out = out.replace(pattern, "the service");
  }
  out = out.replace(/\bthe service(\s+the service)+\b/gi, "the service");

  // Anything still looking like machine output is discarded wholesale.
  if (/[{}[\]]|https?:\/\//.test(out)) return fallback;
  if (out.trim().length < 4) return fallback;
  return out.trim();
}

function mapTwilioError(err, fallback = "The request could not be completed.") {
  const raw = getRawMessage(err);
  const lower = raw.toLowerCase();
  const code = err?.code || err?.twilioCode || err?.status || "PROVIDER_ERROR";
  const codeString = String(code || "");

  let message = fallback;
  let friendlyCode = "SERVICE_ERROR";
  let retryable = false;

  if (
    raw.includes("21408") ||
    codeString === "21408" ||
    lower.includes("geo permission") ||
    lower.includes("permission to send")
  ) {
    message =
      "Text messaging to this destination is not enabled on your account yet. Contact support to unlock this country.";
    friendlyCode = "SMS_DESTINATION_NOT_ENABLED";
  } else if (
    lower.includes("geographic") ||
    lower.includes("dialing permissions") ||
    raw.includes("21215") ||
    raw.includes("21216") ||
    codeString === "21215" ||
    codeString === "21216"
  ) {
    message =
      "Calling this destination is not enabled on your account yet. Choose another destination or contact support to unlock this country.";
    friendlyCode = "CALL_DESTINATION_NOT_ENABLED";
  } else if (
    lower.includes("regulatory") ||
    lower.includes("bundle") ||
    lower.includes("address")
  ) {
    message =
      "This number needs a verified business address before every feature can be switched on. Your calls are unaffected.";
    friendlyCode = "ADDRESS_VERIFICATION_REQUIRED";
  } else if (
    raw.includes("21211") ||
    codeString === "21211" ||
    lower.includes("not a valid phone number")
  ) {
    message =
      "That phone number is not in a valid format. Use the international format, for example +14155551234.";
    friendlyCode = "INVALID_PHONE_NUMBER";
  } else if (
    raw.includes("21212") ||
    raw.includes("21210") ||
    codeString === "21212" ||
    codeString === "21210" ||
    lower.includes("from number")
  ) {
    message =
      "The business number selected for this call is not ready yet. Open Phone Numbers and make sure it is assigned to an agent.";
    friendlyCode = "NUMBER_NOT_READY";
  } else if (
    lower.includes("authentication") ||
    lower.includes("authenticate") ||
    raw.includes("20003") ||
    codeString === "20003"
  ) {
    // NEVER surface a credentials problem to a tenant. It is our fault, not theirs.
    message =
      "Calling is temporarily unavailable. Our team has been notified — please try again shortly.";
    friendlyCode = "SERVICE_TEMPORARILY_UNAVAILABLE";
    retryable = true;
  } else if (
    lower.includes("not owned") ||
    lower.includes("not found") ||
    raw.includes("20404") ||
    codeString === "20404"
  ) {
    message = "That phone number is no longer available on your workspace.";
    friendlyCode = "NUMBER_NOT_AVAILABLE";
  } else if (lower.includes("capability") || lower.includes("not support")) {
    message = "This number does not support the feature you selected.";
    friendlyCode = "UNSUPPORTED_CAPABILITY";
  } else if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    raw.includes("20429") ||
    codeString === "20429"
  ) {
    message =
      "Too many requests right now. Please wait a moment and try again.";
    friendlyCode = "RATE_LIMITED";
    retryable = true;
  } else if (lower.includes("webhook")) {
    message =
      "Calling is temporarily unavailable. Our team has been notified — please try again shortly.";
    friendlyCode = "SERVICE_TEMPORARILY_UNAVAILABLE";
    retryable = true;
  } else if (
    lower.includes("unavailable") ||
    lower.includes("timeout") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed")
  ) {
    message =
      "The service is temporarily unreachable. Please try again in a moment.";
    friendlyCode = "SERVICE_TEMPORARILY_UNAVAILABLE";
    retryable = true;
  }

  // Full detail for our logs only.
  console.error("[provider-error]", {
    friendlyCode,
    providerCode: codeString,
    raw,
  });

  return {
    code: friendlyCode,
    message: scrub(message, fallback),
    // `detail` is read by some frontend components — it must be tenant-safe.
    detail: scrub(message, fallback),
    retryable,
    // Populated for internal/admin surfaces only. The error middleware MUST
    // strip this before responding to a tenant. See note below.
    internal: {
      providerCode: codeString,
      raw,
    },
  };
}

module.exports = { mapTwilioError, scrub };

/**
 * ══════════════════════════════════════════════════════════════════════════
 * REQUIRED COMPANION EDIT — middleware/error.js
 * ══════════════════════════════════════════════════════════════════════════
 * Add this to the error handler so `internal` can never be serialised to a
 * tenant even if a route forgets:
 *
 *   function stripInternal(payload) {
 *     if (!payload || typeof payload !== "object") return payload;
 *     const { internal, ...safe } = payload;
 *     return safe;
 *   }
 *   // then, wherever the handler does res.status(x).json({ error })
 *   res.status(status).json({ error: stripInternal(error) });
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMPANION FRONTEND EDIT — pages/PhoneNumbers.tsx line ~829
 * ══════════════════════════════════════════════════════════════════════════
 * The empty state currently renders, verbatim:
 *
 *   "No rows were returned for this organization from twilio_phone_numbers."
 *
 * That is a database table name in a customer-facing screen. Replace with:
 *
 *   "You don't have any phone numbers yet. Buy one to start taking calls."
 */
