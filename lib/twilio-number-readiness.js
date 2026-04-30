"use strict";

const { getSupabase } = require("./supabase");
const { apiBaseUrl, normalizeCountry } = require("./twilio-platform");

function ok(status) {
  return status === "ready";
}
function asCapabilities(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}
function hasOurUrl(value, suffix) {
  const base = apiBaseUrl();
  if (!value) return false;
  if (!base) return String(value).includes(suffix);
  return String(value).startsWith(base) && String(value).includes(suffix);
}
function check(status, message, extra = {}) {
  return { status, message, ...extra };
}

async function getTwilioNumberReadiness(numberId, options = {}) {
  const db = getSupabase();
  const organizationId = options.organizationId;

  let query = db.from("twilio_phone_numbers").select("*").eq("id", numberId);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data: number, error } = await query.maybeSingle();
  if (error) throw error;
  if (!number) {
    return {
      overall_status: "failed",
      inbound_voice: check("failed", "Number record was not found."),
      outbound_voice: check("failed", "Number record was not found."),
      inbound_sms: check("failed", "Number record was not found."),
      outbound_sms: check("failed", "Number record was not found."),
      regulatory: check("failed", "Number record was not found."),
      assigned_agent: check("failed", "Number record was not found."),
      tests: {},
      next_actions: ["Import or purchase this Twilio number first."],
    };
  }

  const capabilities = asCapabilities(number.capabilities);
  const supportsVoice =
    capabilities.voice === true || capabilities.voice === "true";
  const supportsSms =
    capabilities.sms === true ||
    capabilities.SMS === true ||
    capabilities.sms === "true";
  const next_actions = [];

  const assignedAgentId =
    number.assigned_voice_agent_id || number.voice_agent_id || null;
  let agent = null;
  if (assignedAgentId) {
    const { data } = await db
      .from("voice_agents")
      .select("id,name,is_active,organization_id")
      .eq("id", assignedAgentId)
      .eq("organization_id", number.organization_id)
      .maybeSingle();
    agent = data || null;
  }

  const assigned_agent = agent
    ? check(
        agent.is_active === false ? "needs_configuration" : "ready",
        agent.is_active === false
          ? "Assigned agent is inactive."
          : "Number is assigned to an active AI agent.",
        { agentId: agent.id, agentName: agent.name },
      )
    : check("needs_configuration", "Assign this number to an AI agent.");
  if (!agent) next_actions.push("Assign this number to an AI agent.");

  const inbound_voice = !supportsVoice
    ? check("not_supported", "This number does not support voice.")
    : hasOurUrl(number.voice_url, "/api/twilio/voice-inbound")
      ? check("ready", "Inbound voice webhook points to Agently.")
      : check(
          "needs_configuration",
          "VoiceUrl must point to Agently inbound webhook.",
          { currentVoiceUrl: number.voice_url || "" },
        );
  if (inbound_voice.status === "needs_configuration")
    next_actions.push("Configure VoiceUrl for Agently.");

  const regulatoryStatus = String(
    number.regulatory_status || "unknown",
  ).toLowerCase();
  const addressReq = String(
    number.address_requirements || "none",
  ).toLowerCase();
  const regulatoryBlocked =
    ["pending", "required", "rejected", "blocked"].includes(regulatoryStatus) ||
    (!["none", "not required", "unknown", ""].includes(addressReq) &&
      !number.address_sid &&
      !number.bundle_sid);
  const regulatory = regulatoryBlocked
    ? check(
        "blocked_by_regulatory_requirement",
        "Regulatory/address information is required before this number is fully ready.",
        { regulatoryStatus, addressRequirements: addressReq },
      )
    : check("ready", "No blocking regulatory requirement is known.", {
        regulatoryStatus,
        addressRequirements: addressReq,
      });
  if (regulatory.status !== "ready")
    next_actions.push(
      "Complete Twilio regulatory/address requirements for this number.",
    );

  const selectedVoiceCountries = Array.isArray(
    number.selected_outbound_voice_countries,
  )
    ? number.selected_outbound_voice_countries
    : (number.selected_outbound_voice_countries || []).countries || [];
  const homeCountry = normalizeCountry(
    number.iso_country || number.country || "",
  );
  const voiceCountries = [
    ...new Set(
      [homeCountry, ...selectedVoiceCountries.map(normalizeCountry)].filter(
        Boolean,
      ),
    ),
  ];

  let permissionsResult;
  try {
    permissionsResult = await db
      .from("twilio_geo_permissions")
      .select("iso_country,low_risk_voice_enabled,status")
      .eq("organization_id", number.organization_id)
      .eq("channel", "voice")
      .in("iso_country", voiceCountries.length ? voiceCountries : ["__none__"]);
  } catch (err) {
    permissionsResult = { data: [], error: err };
  }
  const permissions = permissionsResult?.data || [];
  const enabled = new Set(
    (permissions || [])
      .filter((p) => p.low_risk_voice_enabled || p.status === "enabled")
      .map((p) => normalizeCountry(p.iso_country)),
  );
  const missingVoice = voiceCountries.filter((c) => !enabled.has(c));

  const outbound_voice = !supportsVoice
    ? check("not_supported", "This number does not support outbound voice.")
    : missingVoice.length
      ? check(
          "pending_manual_action",
          "One or more selected outbound voice countries are not confirmed enabled.",
          { missingCountries: missingVoice },
        )
      : check("ready", "Outbound voice countries are enabled or confirmed.", {
          countries: voiceCountries,
        });
  if (outbound_voice.status === "pending_manual_action")
    next_actions.push(
      `Enable/confirm outbound voice permissions for: ${missingVoice.join(", ")}.`,
    );

  const inbound_sms = !supportsSms
    ? check("not_supported", "This number does not support SMS.")
    : hasOurUrl(number.sms_url, "/api/twilio/sms-inbound")
      ? check("ready", "Inbound SMS webhook points to Agently.")
      : check(
          "needs_configuration",
          "SmsUrl must point to Agently inbound SMS webhook.",
          { currentSmsUrl: number.sms_url || "" },
        );
  if (inbound_sms.status === "needs_configuration")
    next_actions.push("Configure SmsUrl for Agently.");

  const selectedSmsCountries = Array.isArray(number.selected_sms_countries)
    ? number.selected_sms_countries
    : (number.selected_sms_countries || []).countries || [];
  const smsConfirmed =
    !!number.sms_geo_permission_confirmed_by_user ||
    number.outbound_sms_status === "ready";
  const outbound_sms = !supportsSms
    ? check("not_supported", "This number does not support outbound SMS.")
    : !selectedSmsCountries.length
      ? check("needs_configuration", "Select SMS destination countries.")
      : smsConfirmed
        ? check("ready", "SMS Geo Permissions have been manually confirmed.", {
            countries: selectedSmsCountries,
          })
        : check(
            "pending_manual_action",
            "SMS Geo Permissions must be enabled manually in Twilio Console.",
            { countries: selectedSmsCountries },
          );
  if (outbound_sms.status === "needs_configuration")
    next_actions.push(
      "Select SMS destination countries if you need outbound SMS.",
    );
  if (outbound_sms.status === "pending_manual_action")
    next_actions.push(
      "Enable SMS Geo Permissions manually in Twilio Console, then confirm in Agently.",
    );

  const tests = {
    inbound_voice: number.inbound_voice_test_status || "not_run",
    outbound_voice: number.outbound_voice_test_status || "not_run",
    inbound_sms: number.inbound_sms_test_status || "not_run",
    outbound_sms: number.outbound_sms_test_status || "not_run",
  };

  let overall_status = "ready";
  const requiredChecks = [
    assigned_agent,
    inbound_voice,
    outbound_voice,
    regulatory,
  ];
  if (requiredChecks.some((c) => c.status === "failed"))
    overall_status = "failed";
  else if (regulatory.status === "blocked_by_regulatory_requirement")
    overall_status = "blocked_by_regulatory_requirement";
  else if (
    requiredChecks.some((c) =>
      ["needs_configuration", "pending_manual_action"].includes(c.status),
    )
  )
    overall_status = "needs_configuration";
  else if (
    supportsSms &&
    [inbound_sms, outbound_sms].some((c) =>
      ["needs_configuration", "pending_manual_action"].includes(c.status),
    )
  )
    overall_status = "pending_manual_action";

  return {
    number_id: number.id,
    phone_number: number.phone_number,
    phone_sid: number.phone_sid,
    overall_status,
    inbound_voice,
    outbound_voice,
    inbound_sms,
    outbound_sms,
    regulatory,
    assigned_agent,
    tests,
    next_actions: [...new Set(next_actions)],
  };
}

async function persistReadiness(numberId, readiness) {
  const db = getSupabase();
  const update = {
    overall_status: readiness.overall_status,
    inbound_voice_status: readiness.inbound_voice?.status,
    outbound_voice_status: readiness.outbound_voice?.status,
    inbound_sms_status: readiness.inbound_sms?.status,
    outbound_sms_status: readiness.outbound_sms?.status,
    regulatory_readiness_status: readiness.regulatory?.status,
    assigned_agent_status: readiness.assigned_agent?.status,
    last_readiness_check_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  try {
    await db.from("twilio_phone_numbers").update(update).eq("id", numberId);
  } catch (_) {
    // Readiness persistence is best-effort so callers can still receive the computed result.
  }
  return readiness;
}

module.exports = { getTwilioNumberReadiness, persistReadiness };
