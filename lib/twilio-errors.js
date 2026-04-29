"use strict";

function getRawMessage(err) {
  return String(err?.message || err?.error_message || err || "");
}

function mapTwilioError(err, fallback = "Twilio request failed.") {
  const raw = getRawMessage(err);
  const lower = raw.toLowerCase();
  const code = err?.code || err?.twilioCode || err?.status || "TWILIO_ERROR";

  let message = fallback;
  let friendlyCode = "TWILIO_ERROR";

  if (raw.includes("21408") || lower.includes("geo permission") || lower.includes("permission to send")) {
    message = "SMS to this destination is blocked because SMS Geo Permissions are not enabled in Twilio Console. Enable the country manually, then confirm it in Agently.";
    friendlyCode = "SMS_GEO_PERMISSION_DISABLED";
  } else if (lower.includes("geographic") || lower.includes("dialing permissions") || raw.includes("21215") || raw.includes("21216")) {
    message = "Outbound voice calling to this destination is not enabled for this Twilio account. Enable low-risk voice dialing permissions for the destination country or choose another destination.";
    friendlyCode = "VOICE_GEO_PERMISSION_DISABLED";
  } else if (lower.includes("regulatory") || lower.includes("bundle") || lower.includes("address")) {
    message = "This number requires regulatory information before all features can be activated.";
    friendlyCode = "REGULATORY_REQUIREMENT";
  } else if (raw.includes("21211") || lower.includes("not a valid phone number")) {
    message = "The destination number is not a valid E.164 phone number. Use a format like +14155551234.";
    friendlyCode = "INVALID_PHONE_NUMBER";
  } else if (raw.includes("21212") || lower.includes("from number")) {
    message = "The selected from-number is invalid, not owned by this tenant, or not verified for outbound calls.";
    friendlyCode = "INVALID_FROM_NUMBER";
  } else if (lower.includes("authentication") || lower.includes("authenticate") || raw.includes("20003")) {
    message = "Twilio authentication failed. Check the platform Twilio credentials and subaccount configuration.";
    friendlyCode = "TWILIO_AUTH_FAILED";
  } else if (lower.includes("not owned") || lower.includes("not found") || raw.includes("20404")) {
    message = "This Twilio number was not found or is not owned by this tenant.";
    friendlyCode = "NUMBER_NOT_OWNED";
  } else if (lower.includes("capability") || lower.includes("not support")) {
    message = "The selected number does not support the required capability.";
    friendlyCode = "UNSUPPORTED_CAPABILITY";
  } else if (lower.includes("quota") || lower.includes("rate limit") || raw.includes("20429")) {
    message = "This request could not be completed because of a quota or rate limit. Please try again later.";
    friendlyCode = "QUOTA_OR_RATE_LIMIT";
  } else if (lower.includes("webhook")) {
    message = "Twilio could not reach the configured webhook. Check API_URL and public HTTPS routing.";
    friendlyCode = "WEBHOOK_CONFIGURATION_ERROR";
  }

  return {
    code: friendlyCode,
    twilioCode: code,
    message,
    detail: raw,
  };
}

module.exports = { mapTwilioError };
