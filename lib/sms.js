"use strict";

/*
 * Outbound SMS from a tenant's own Agently number, charged to their prepaid
 * credit. Gated by the "sms" feature switch (lib/feature-flags.js), which is
 * OFF in production until the Super Admin turns it on.
 *
 *   1. pick an SMS-capable number the organization owns (their Twilio subaccount)
 *   2. pre-check the wallet (402 INSUFFICIENT_CREDIT, same as calls)
 *   3. record the message (sms_messages), send it through Twilio
 *   4. log a usage event: the usage ledger prices it with the customer rate
 *      card / platform margin and debits the wallet, exactly like call minutes
 *
 * BEFORE TURNING IT ON IN PRODUCTION: US carriers block SMS from 10DLC numbers
 * that are not A2P-registered (brand + campaign), and toll-free numbers need
 * toll-free verification. That registration is a Twilio Console / Trust Hub
 * process per business, not code. Until a number is registered, Twilio accepts
 * the request and the carrier drops or rejects the message (error 30034).
 */

const { getSupabase } = require("./supabase");
const { twilioRequest } = require("./twilio");
const { insertUsageEvent } = require("./usage-ledger");
const { getBackendBaseUrl } = require("./backend-url");

const MAX_BODY_CHARS = 1600;
// Twilio US list price per segment plus typical carrier pass-through fees.
// Override per market with SMS_VENDOR_COST_PER_SEGMENT_USD.
const vendorCostPerSegment = () => {
  const value = Number(process.env.SMS_VENDOR_COST_PER_SEGMENT_USD);
  return Number.isFinite(value) && value > 0 ? value : 0.0115;
};

// GSM-7 basic + extension characters. Anything else forces UCS-2 encoding.
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

function countSegments(body) {
  const text = String(body || "");
  let gsmUnits = 0;
  let isGsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) gsmUnits += 1;
    else if (GSM7_EXT.includes(ch)) gsmUnits += 2;
    else {
      isGsm = false;
      break;
    }
  }
  if (isGsm) {
    if (gsmUnits <= 160) return { segments: gsmUnits ? 1 : 0, encoding: "GSM-7" };
    return { segments: Math.ceil(gsmUnits / 153), encoding: "GSM-7" };
  }
  // UCS-2 counts UTF-16 code units.
  const units = text.length;
  if (units <= 70) return { segments: 1, encoding: "UCS-2" };
  return { segments: Math.ceil(units / 67), encoding: "UCS-2" };
}

function normalizeE164(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function smsError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function twilioErrorMessage(code, fallback) {
  switch (Number(code)) {
    case 21610:
      return "This person has replied STOP to your number, so carriers won't deliver texts to them.";
    case 21408:
      return "SMS to this country isn't enabled on your number yet.";
    case 21211:
    case 21614:
      return "That phone number can't receive text messages.";
    case 21606:
    case 21659:
      return "Your number can't send SMS yet. It needs carrier registration first.";
    default:
      return fallback || "The text could not be sent.";
  }
}

/** SMS-capable numbers the organization owns. */
async function listSmsNumbers(db, organizationId) {
  const { data, error } = await db
    .from("twilio_phone_numbers")
    .select("id,phone_number,account_sid,capabilities,outbound_sms_status")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return (data || []).filter((row) => {
    const caps = row.capabilities || {};
    return caps.sms === true || caps.SMS === true || caps.sms === "true";
  });
}

/**
 * Send one SMS. Throws errors carrying { status, code } for the route.
 * The caller is responsible for the wallet pre-check.
 */
async function sendSms({
  organizationId,
  userId = null,
  to,
  body,
  leadId = null,
  fromNumberId = null,
}) {
  const db = getSupabase();
  const text = String(body || "").trim();
  if (!text) throw smsError(400, "SMS_EMPTY", "Write a message first.");
  if (text.length > MAX_BODY_CHARS) {
    throw smsError(400, "SMS_TOO_LONG", `Keep the message under ${MAX_BODY_CHARS} characters.`);
  }
  const toNumber = normalizeE164(to);
  if (!toNumber) throw smsError(400, "SMS_BAD_NUMBER", "That doesn't look like a valid phone number.");

  const numbers = await listSmsNumbers(db, organizationId);
  const from =
    (fromNumberId && numbers.find((row) => row.id === fromNumberId)) || numbers[0] || null;
  if (!from) {
    throw smsError(
      409,
      "SMS_NO_NUMBER",
      "You don't have an SMS-capable Agently number yet. Get one under Phone Numbers.",
    );
  }

  const { segments, encoding } = countSegments(text);
  const estimatedCostUsd = Number((segments * vendorCostPerSegment()).toFixed(6));
  const now = new Date().toISOString();

  const { data: record, error: insertError } = await db
    .from("sms_messages")
    .insert({
      organization_id: organizationId,
      lead_id: leadId,
      phone_number_id: from.id,
      from_number: from.phone_number,
      to_number: toNumber,
      body: text,
      segments,
      encoding,
      direction: "outbound",
      status: "sending",
      estimated_cost_usd: estimatedCostUsd,
      sent_by: userId,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();
  if (insertError || !record) {
    throw smsError(
      503,
      "SMS_STORAGE_MISSING",
      "SMS storage isn't set up yet (apply migrations/20261124_sms_messages.sql).",
    );
  }

  const apiBase = getBackendBaseUrl();
  let message;
  try {
    message = await twilioRequest(
      "POST",
      "/Messages.json",
      {
        From: from.phone_number,
        To: toNumber,
        Body: text,
        ...(apiBase ? { StatusCallback: `${apiBase}/api/sms/status` } : {}),
      },
      false,
      from.account_sid || null,
    );
  } catch (err) {
    const code = err?.twilioCode || null;
    await db
      .from("sms_messages")
      .update({
        status: "failed",
        error_code: code ? String(code) : null,
        error_message: String(err?.message || "").slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", record.id);
    throw smsError(502, "SMS_SEND_FAILED", twilioErrorMessage(code, err?.message));
  }

  await db
    .from("sms_messages")
    .update({
      status: message?.status || "queued",
      twilio_sid: message?.sid || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id);

  // Charge: the ledger applies the customer price and debits the wallet.
  try {
    await insertUsageEvent({
      organizationId,
      userId,
      provider: "twilio",
      service: "sms",
      eventType: "sms_outbound",
      externalId: message?.sid || record.id,
      unit: "segment",
      quantity: segments,
      estimatedCostUsd,
      billable: true,
      metadata: {
        sms_message_id: record.id,
        lead_id: leadId,
        encoding,
        to_country_prefix: toNumber.slice(0, 3),
      },
    });
  } catch (err) {
    console.error("[sms] usage event failed:", err?.message || err);
  }

  return {
    id: record.id,
    sid: message?.sid || null,
    status: message?.status || "queued",
    from: from.phone_number,
    to: toNumber,
    segments,
    encoding,
  };
}

module.exports = { sendSms, listSmsNumbers, countSegments, normalizeE164, vendorCostPerSegment };
