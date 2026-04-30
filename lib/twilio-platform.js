"use strict";

const { getSupabase } = require("./supabase");
const { mapTwilioError } = require("./twilio-errors");

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";
const VOICE_BASE = "https://voice.twilio.com/v1";

const DEFAULT_SUPPORTED_COUNTRIES = ["US", "CA", "GB", "AU", "IE", "NZ"];
const DEFAULT_LOW_RISK_COUNTRIES = ["US", "CA", "GB", "AU", "IE", "NZ"];

function masterSid() {
  return (process.env.TWILIO_ACCOUNT_SID || "").trim();
}
function masterToken() {
  return (process.env.TWILIO_AUTH_TOKEN || "").trim();
}
function apiBaseUrl() {
  return (process.env.API_URL || "").trim().replace(/\/$/, "");
}
function appName() {
  return (process.env.APP_NAME || "Agently").trim();
}
function supportedCountries() {
  return (
    process.env.TWILIO_SUPPORTED_COUNTRIES ||
    DEFAULT_SUPPORTED_COUNTRIES.join(",")
  )
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}
function normalizeEnvCountryToken(value) {
  return String(value || "")
    .trim()
    .replace(/^[\'"`]+|[\'"`]+$/g, "")
    .trim()
    .toUpperCase();
}
function parseCountryEnvList(value, fallback) {
  const raw = String(value || "").trim();
  const source = raw ? raw : fallback.join(",");
  const parsed = source
    .split(",")
    .map(normalizeEnvCountryToken)
    .filter(Boolean);
  return parsed.length ? [...new Set(parsed)] : fallback.slice();
}
function lowRiskCountries() {
  return parseCountryEnvList(
    process.env.TWILIO_LOW_RISK_VOICE_COUNTRIES,
    DEFAULT_LOW_RISK_COUNTRIES,
  );
}
function isTableMissing(error) {
  return error && ["42P01", "PGRST205"].includes(error.code);
}
function clean(obj) {
  return Object.fromEntries(
    Object.entries(obj || {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    ),
  );
}
function normalizeCountry(country) {
  const value = String(country || "US")
    .trim()
    .toUpperCase();
  if (value === "UK") return "GB";
  return value || "US";
}
function normalizeNumberType(type) {
  const raw = String(type || "Local")
    .trim()
    .toLowerCase();
  if (raw === "tollfree" || raw === "toll_free" || raw === "toll-free")
    return "TollFree";
  if (raw === "mobile") return "Mobile";
  return "Local";
}
function toBoolCapability(value) {
  return (
    value === true || value === "true" || value === "True" || value === "1"
  );
}

async function twilioRequest({
  method = "GET",
  accountSid,
  path,
  params,
  fullUrl,
  authSid,
  authToken,
}) {
  const sid = authSid || masterSid();
  const token = authToken || masterToken();
  const targetAccountSid = accountSid || masterSid();
  if (!sid || !token) {
    throw Object.assign(
      new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required."),
      { code: "TWILIO_AUTH_MISSING" },
    );
  }

  const baseUrl =
    fullUrl || `${TWILIO_BASE}/Accounts/${targetAccountSid}${path}`;
  let url = baseUrl;
  const headers = {
    Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let body;
  if (params && method === "GET") {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  } else if (params && ["POST", "PUT", "PATCH"].includes(method)) {
    body = new URLSearchParams(clean(params)).toString();
  }

  const response = await fetch(url, { method, headers, body });
  if (response.status === 204) return null;
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const err = new Error(
      data?.message || data?.error_message || `Twilio ${response.status}`,
    );
    err.status = response.status;
    err.twilioCode = data?.code;
    err.details = data;
    throw err;
  }
  return data;
}

function normalizeIncomingNumber(n) {
  const capabilities = n?.capabilities || {};
  return {
    sid: n.sid,
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name || n.phone_number,
    accountSid: n.account_sid,
    country: n.iso_country || n.origin || "",
    region: n.region || "",
    locality: n.locality || "",
    postalCode: n.postal_code || "",
    capabilities: {
      voice: toBoolCapability(capabilities.voice),
      sms: toBoolCapability(capabilities.SMS ?? capabilities.sms),
      mms: toBoolCapability(capabilities.MMS ?? capabilities.mms),
    },
    addressRequirements: n.address_requirements || "none",
    voiceUrl: n.voice_url || "",
    voiceFallbackUrl: n.voice_fallback_url || "",
    statusCallback: n.status_callback || "",
    smsUrl: n.sms_url || "",
    smsFallbackUrl: n.sms_fallback_url || "",
    bundleSid: n.bundle_sid || null,
    addressSid: n.address_sid || null,
    dateCreated: n.date_created || null,
  };
}

function evaluateNumberRecommendation(
  number,
  { requiresSms = false, requiresVoice = true, country } = {},
) {
  const supported = supportedCountries();
  const restrictionReasons = [];
  const iso = normalizeCountry(number.isoCountry || number.country || country);
  const address = String(
    number.addressRequirements || number.addressRequired || "none",
  ).toLowerCase();
  const capabilities = number.capabilities || {};

  if (!supported.includes(iso))
    restrictionReasons.push(`Country ${iso} is not enabled for this app.`);
  if (requiresVoice && !capabilities.voice)
    restrictionReasons.push("Voice is not supported.");
  if (requiresSms && !capabilities.sms)
    restrictionReasons.push("SMS is required but not supported.");
  if (["any", "local", "foreign", "foreign_or_local"].includes(address))
    restrictionReasons.push(`Address/regulatory requirement: ${address}.`);
  if (process.env.TWILIO_HIGH_RISK_COUNTRIES) {
    const highRisk = process.env.TWILIO_HIGH_RISK_COUNTRIES.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (highRisk.includes(iso))
      restrictionReasons.push(
        "Country is configured as high-risk for this app.",
      );
  }

  let restrictionLevel = "low";
  let recommendationStatus = "recommended";
  let estimatedSetupComplexity = "easy";
  let userFacingSetupMessage =
    "Recommended: this number should support the selected Agently voice flow with minimal setup.";

  if (restrictionReasons.length) {
    const severe = restrictionReasons.some(
      (r) =>
        r.includes("not enabled") ||
        r.includes("not supported") ||
        r.includes("high-risk"),
    );
    restrictionLevel = severe ? "high" : "medium";
    recommendationStatus = severe ? "not_recommended" : "needs_manual_setup";
    estimatedSetupComplexity = severe ? "hard" : "manual_review";
    userFacingSetupMessage = severe
      ? "Not recommended: this number may not work reliably in-app without manual Twilio setup or support review."
      : "Needs manual setup: this number can be considered, but regulatory/address review may be required.";
  } else if (capabilities.voice && !capabilities.sms) {
    restrictionLevel = requiresSms ? "high" : "low";
    recommendationStatus = requiresSms ? "not_recommended" : "recommended";
    estimatedSetupComplexity = requiresSms ? "hard" : "easy_voice_only";
    userFacingSetupMessage = requiresSms
      ? "Not recommended because SMS was requested but this number is voice-only."
      : "Recommended for voice. SMS is not supported on this number.";
  }

  return {
    restrictionLevel,
    recommendationStatus,
    restrictionReasons,
    estimatedSetupComplexity,
    userFacingSetupMessage,
  };
}

async function ensureTenantTwilioAccount({
  organizationId,
  organizationName,
  createIfMissing = true,
}) {
  const db = getSupabase();
  const { data: existing, error } = await db
    .from("twilio_accounts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_primary", true)
    .maybeSingle();

  if (existing)
    return {
      ...existing,
      account_sid: existing.account_sid,
      isFallbackMaster: false,
    };
  if (error && !isTableMissing(error) && error.code !== "PGRST116") throw error;

  if (!createIfMissing) {
    return {
      account_sid: masterSid(),
      parent_account_sid: masterSid(),
      isFallbackMaster: true,
      migrationRequired: !!error,
    };
  }

  if (error && isTableMissing(error)) {
    throw Object.assign(
      new Error(
        "Supabase migration missing: twilio_accounts table does not exist.",
      ),
      { code: "MIGRATION_REQUIRED" },
    );
  }

  let account;
  try {
    account = await twilioRequest({
      method: "POST",
      fullUrl: `${TWILIO_BASE}/Accounts.json`,
      params: {
        FriendlyName:
          `${appName()} - ${organizationName || organizationId}`.slice(0, 64),
      },
    });
  } catch (err) {
    const mapped = mapTwilioError(
      err,
      "Could not create a Twilio subaccount for this tenant.",
    );
    throw Object.assign(new Error(mapped.message), {
      code: mapped.code,
      detail: mapped.detail,
    });
  }

  const row = {
    organization_id: organizationId,
    account_sid: account.sid,
    parent_account_sid: masterSid(),
    auth_mode: "platform_subaccount",
    friendly_name:
      account.friendly_name ||
      `${appName()} - ${organizationName || organizationId}`,
    status: account.status || "active",
    is_primary: true,
    raw_response: account,
  };
  const { data: saved, error: saveError } = await db
    .from("twilio_accounts")
    .insert(row)
    .select()
    .single();
  if (saveError) throw saveError;
  return { ...saved, account_sid: saved.account_sid, isFallbackMaster: false };
}

async function searchAvailableRecommendedNumbers(options = {}) {
  const country = normalizeCountry(options.country);
  const type = normalizeNumberType(options.type || options.numberType);
  const params = {
    PageSize: String(Math.min(parseInt(options.limit || 40, 10), 40)),
  };
  if (options.requiresVoice !== false) params.VoiceEnabled = "true";
  if (options.requiresSms) params.SmsEnabled = "true";
  if (options.areaCode) params.AreaCode = String(options.areaCode);
  if (options.contains) params.Contains = String(options.contains);

  const accountSid = options.accountSid || masterSid();
  const data = await twilioRequest({
    method: "GET",
    accountSid,
    fullUrl: `${TWILIO_BASE}/Accounts/${accountSid}/AvailablePhoneNumbers/${country}/${type}.json`,
    params,
  });

  const mapped = (data?.available_phone_numbers || []).map((n) => {
    const base = {
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name || n.phone_number,
      country: n.iso_country || country,
      isoCountry: n.iso_country || country,
      region: n.region || "",
      locality: n.locality || "",
      postalCode: n.postal_code || "",
      capabilities: {
        voice: toBoolCapability(n.capabilities?.voice),
        sms: toBoolCapability(n.capabilities?.SMS ?? n.capabilities?.sms),
        mms: toBoolCapability(n.capabilities?.MMS ?? n.capabilities?.mms),
      },
      addressRequirements: n.address_requirements || "none",
    };
    return { ...base, ...evaluateNumberRecommendation(base, options) };
  });

  return options.showAdvancedRestrictedNumbers
    ? mapped
    : mapped.filter((n) => n.recommendationStatus === "recommended");
}

async function purchaseIncomingNumber({
  accountSid,
  phoneNumber,
  friendlyName,
  agentId,
  supportsSms = true,
}) {
  const base = apiBaseUrl();
  const params = {
    PhoneNumber: phoneNumber,
    FriendlyName: friendlyName || phoneNumber,
    VoiceUrl: `${base}/api/twilio/voice-inbound`,
    VoiceMethod: "POST",
    VoiceFallbackUrl: `${base}/api/twilio/voice-inbound`,
    VoiceFallbackMethod: "POST",
    StatusCallback: `${base}/api/twilio/call-status`,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: "initiated ringing answered completed",
  };
  if (supportsSms) {
    params.SmsUrl = `${base}/api/twilio/sms-inbound`;
    params.SmsMethod = "POST";
    params.SmsFallbackUrl = `${base}/api/twilio/sms-inbound`;
    params.SmsFallbackMethod = "POST";
  }
  if (agentId)
    params.FriendlyName = `${params.FriendlyName} - ${agentId}`.slice(0, 64);
  return twilioRequest({
    method: "POST",
    accountSid,
    path: "/IncomingPhoneNumbers.json",
    params,
  });
}

async function fetchIncomingNumber({ accountSid, phoneSid }) {
  const data = await twilioRequest({
    method: "GET",
    accountSid,
    path: `/IncomingPhoneNumbers/${phoneSid}.json`,
  });
  return normalizeIncomingNumber(data);
}

async function listIncomingNumbers({ accountSid, pageSize = 100 } = {}) {
  const data = await twilioRequest({
    method: "GET",
    accountSid: accountSid || masterSid(),
    path: "/IncomingPhoneNumbers.json",
    params: { PageSize: String(pageSize) },
  });
  return (data?.incoming_phone_numbers || []).map(normalizeIncomingNumber);
}

async function configureTwilioIncomingNumber(numberSid, options = {}) {
  const base = apiBaseUrl();
  const supportsSms = options.supportsSms !== false;
  const params = {
    VoiceUrl: options.voiceUrl || `${base}/api/twilio/voice-inbound`,
    VoiceMethod: options.voiceMethod || "POST",
    VoiceFallbackUrl:
      options.voiceFallbackUrl || `${base}/api/twilio/voice-inbound`,
    VoiceFallbackMethod: options.voiceFallbackMethod || "POST",
    StatusCallback: options.statusCallback || `${base}/api/twilio/call-status`,
    StatusCallbackMethod: options.statusCallbackMethod || "POST",
    StatusCallbackEvent:
      options.statusCallbackEvent || "initiated ringing answered completed",
    AddressSid: options.addressSid,
    BundleSid: options.bundleSid,
  };
  if (supportsSms) {
    params.SmsUrl = options.smsUrl || `${base}/api/twilio/sms-inbound`;
    params.SmsMethod = options.smsMethod || "POST";
    params.SmsFallbackUrl =
      options.smsFallbackUrl || `${base}/api/twilio/sms-inbound`;
    params.SmsFallbackMethod = options.smsFallbackMethod || "POST";
  }
  return twilioRequest({
    method: "POST",
    accountSid: options.accountSid,
    path: `/IncomingPhoneNumbers/${numberSid}.json`,
    params,
  });
}

async function applyVoiceDialingPermissions({
  accountSid,
  countries = [],
  allowHighRiskSpecialNumbers = false,
  allowHighRiskTollFraudNumbers = false,
}) {
  const normalized = [
    ...new Set((countries || []).map(normalizeCountry).filter(Boolean)),
  ];
  const lowRisk = lowRiskCountries();
  const updates = normalized.map((isoCountry) => ({
    iso_code: isoCountry,
    low_risk_numbers_enabled: true,
    high_risk_special_numbers_enabled: !!allowHighRiskSpecialNumbers,
    high_risk_tollfraud_numbers_enabled: !!allowHighRiskTollFraudNumbers,
    blocked:
      !lowRisk.includes(isoCountry) &&
      !allowHighRiskSpecialNumbers &&
      !allowHighRiskTollFraudNumbers,
  }));
  const safeUpdates = updates.filter((u) => !u.blocked);
  if (!safeUpdates.length) {
    return {
      success: false,
      results: updates,
      message:
        "No countries were enabled because all requested countries are outside the configured low-risk list.",
    };
  }
  const data = await twilioRequest({
    method: "POST",
    accountSid,
    fullUrl: `${VOICE_BASE}/DialingPermissions/BulkCountryUpdates`,
    params: { UpdateRequest: JSON.stringify(safeUpdates) },
  });
  return { success: true, update: data, results: updates };
}

function buildManualSmsGeoInstructions(countries = []) {
  const list =
    countries.map(normalizeCountry).join(", ") ||
    "the selected destination countries";
  return [
    `Twilio does not allow Agently to enable SMS Geo Permissions through the public API.`,
    `Open Twilio Console > Messaging > Settings > Geo Permissions.`,
    `Enable SMS/MMS sending for: ${list}.`,
    `Return to Agently and click “Confirm SMS Geo Enabled”.`,
    `If Twilio returns Error 21408, the destination country is still disabled or has additional messaging requirements.`,
  ];
}

module.exports = {
  TWILIO_BASE,
  VOICE_BASE,
  apiBaseUrl,
  masterSid,
  masterToken,
  supportedCountries,
  lowRiskCountries,
  normalizeCountry,
  normalizeNumberType,
  normalizeIncomingNumber,
  evaluateNumberRecommendation,
  ensureTenantTwilioAccount,
  searchAvailableRecommendedNumbers,
  purchaseIncomingNumber,
  fetchIncomingNumber,
  listIncomingNumbers,
  configureTwilioIncomingNumber,
  applyVoiceDialingPermissions,
  buildManualSmsGeoInstructions,
  twilioRequest,
  isTableMissing,
};
