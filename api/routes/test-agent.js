"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const twilioRoutes = require("./twilio");
const outreachRoutes = require("./outreach");
const { serializeAgent } = require("../../lib/serializers");

const router = express.Router();

const ALLOWED_TEST_VOICES = [
  { id: "alloy", name: "Alloy", tone: "Balanced and neutral" },
  { id: "ash", name: "Ash", tone: "Calm and steady" },
  { id: "coral", name: "Coral", tone: "Bright and friendly" },
  { id: "echo", name: "Echo", tone: "Clear and professional" },
  { id: "sage", name: "Sage", tone: "Measured and helpful" },
];

function intEnv(name, fallback, min = 0) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function normalizePhone(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[\s().-]/g, "");
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function isE164(value = "") {
  return /^\+[1-9]\d{7,14}$/.test(String(value || ""));
}

function platformNumberConfig() {
  const number = normalizePhone(
    process.env.PLATFORM_TEST_PHONE_NUMBER ||
      process.env.AGENTLY_TEST_PHONE_NUMBER ||
      process.env.COMPANY_TEST_PHONE_NUMBER ||
      "",
  );
  return {
    number,
    sid: String(
      process.env.PLATFORM_TEST_PHONE_SID ||
        process.env.AGENTLY_TEST_PHONE_SID ||
        "",
    ).trim(),
    configured: Boolean(number),
  };
}

function limits() {
  return {
    maxCalls: intEnv("PLATFORM_TEST_MAX_CALLS", 3, 1),
    maxRecipientsPerRequest: intEnv("PLATFORM_TEST_MAX_RECIPIENTS", 3, 1),
    maxCallSeconds: intEnv("PLATFORM_TEST_MAX_CALL_SECONDS", 300, 30),
  };
}

function clampText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeAllowedVoice(voiceId) {
  const normalized = String(voiceId || "").trim().toLowerCase();
  return ALLOWED_TEST_VOICES.some((voice) => voice.id === normalized)
    ? normalized
    : ALLOWED_TEST_VOICES[0].id;
}

function serializeUsage(row, limitConfig) {
  const usedCalls = Math.max(0, Number(row?.calls_used || 0));
  const maxCalls = limitConfig.maxCalls;
  return {
    usedCalls,
    remainingCalls: Math.max(0, maxCalls - usedCalls),
    maxCalls,
    maxRecipientsPerRequest: limitConfig.maxRecipientsPerRequest,
    maxCallSeconds: limitConfig.maxCallSeconds,
  };
}

async function getOrCreateUsage(db, organizationId) {
  const { data: existing, error: readError } = await db
    .from("tenant_test_agent_usage")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing) return existing;

  const { data, error } = await db
    .from("tenant_test_agent_usage")
    .insert({
      organization_id: organizationId,
      agent_name: "Test Agent",
      voice_provider: "openai",
      voice_id: ALLOWED_TEST_VOICES[0].id,
      greeting:
        "Hello, this is your Agently test agent. How can I help you today?",
      calls_used: 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function getUsage(db, organizationId) {
  return getOrCreateUsage(db, organizationId);
}

async function updateUsageConfig(db, usageId, body = {}) {
  const voiceId = normalizeAllowedVoice(body.voiceId || body.voice_id);
  const payload = {
    agent_name: clampText(body.agentName || body.agent_name || "Test Agent", 80),
    voice_provider: "openai",
    voice_id: voiceId,
    voice_name:
      ALLOWED_TEST_VOICES.find((voice) => voice.id === voiceId)?.name || "Alloy",
    greeting: clampText(
      body.greeting ||
        "Hello, this is your Agently test agent. How can I help you today?",
      420,
    ),
    default_call_purpose: clampText(
      body.defaultCallPurpose || body.default_call_purpose || "",
      1000,
    ),
    default_custom_instructions: clampText(
      body.defaultCustomInstructions || body.default_custom_instructions || "",
      1200,
    ),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("tenant_test_agent_usage")
    .update(payload)
    .eq("id", usageId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function ensureHiddenTestAgent(db, req, usageRow) {
  const platform = platformNumberConfig();
  if (!platform.configured || !isE164(platform.number)) {
    const err = new Error(
      "Platform test phone number is not configured. Set PLATFORM_TEST_PHONE_NUMBER to an E.164 number.",
    );
    err.status = 503;
    err.code = "PLATFORM_TEST_NUMBER_NOT_CONFIGURED";
    throw err;
  }

  let agent = null;
  if (usageRow.test_voice_agent_id) {
    const { data } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", usageRow.test_voice_agent_id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    agent = data || null;
  }

  if (!agent) {
    const { data } = await db
      .from("voice_agents")
      .select("*")
      .eq("organization_id", req.orgId)
      .eq("is_platform_test_agent", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    agent = data || null;
  }

  const voiceId = normalizeAllowedVoice(usageRow.voice_id);
  const common = {
    name: usageRow.agent_name || "Test Agent",
    direction: "outbound",
    twilio_phone_number: platform.number,
    twilio_phone_sid: platform.sid || "platform-test-number",
    voice: voiceId,
    voice_provider: "openai",
    voice_id: voiceId,
    language: "English",
    greeting:
      usageRow.greeting ||
      "Hello, this is your Agently test agent. How can I help you today?",
    tone: "Friendly",
    business_hours: "Platform beta test mode",
    escalation_phone: "",
    voicemail_fallback: false,
    data_capture_fields: ["name", "phone", "email", "reason"],
    rules: { autoBook: false, autoEscalate: false, captureAllLeads: true },
    is_active: true,
    is_platform_test_agent: true,
    number_source: "platform_test",
    updated_at: new Date().toISOString(),
  };

  if (agent?.id) {
    const { data, error } = await db
      .from("voice_agents")
      .update(common)
      .eq("id", agent.id)
      .eq("organization_id", req.orgId)
      .select("*")
      .single();
    if (error) throw error;
    agent = data;
  } else {
    const { data, error } = await db
      .from("voice_agents")
      .insert({ organization_id: req.orgId, ...common })
      .select("*")
      .single();
    if (error) throw error;
    agent = data;
  }

  if (usageRow.test_voice_agent_id !== agent.id) {
    await db
      .from("tenant_test_agent_usage")
      .update({ test_voice_agent_id: agent.id, updated_at: new Date().toISOString() })
      .eq("id", usageRow.id);
  }

  return agent;
}

async function ensureHiddenTestNumber(db, req, agent) {
  const platform = platformNumberConfig();
  const phoneSid = platform.sid || `platform-test-${req.orgId}`;

  const { data: existing } = await db
    .from("twilio_phone_numbers")
    .select("*")
    .eq("organization_id", req.orgId)
    .eq("phone_number", platform.number)
    .maybeSingle();

  const row = {
    organization_id: req.orgId,
    phone_number: platform.number,
    phone_sid: phoneSid,
    account_sid: process.env.TWILIO_ACCOUNT_SID || null,
    iso_country: "US",
    number_type: "platform_test",
    capabilities: { voice: true, sms: false, mms: false },
    address_requirements: "none",
    regulatory_status: "verified",
    assigned_voice_agent_id: agent.id,
    source: "platform_test",
    purchase_origin: "platform_beta_test_pool",
    verification_method: "platform_owned",
    verification_status: "verified",
    configuration_status: "configured",
    overall_status: "ready",
    outbound_voice_status: "ready",
    inbound_voice_status: "ready",
    assigned_agent_status: "ready",
    is_platform_test_number: true,
    selected_outbound_voice_countries: ["US", "CA"],
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data, error } = await db
      .from("twilio_phone_numbers")
      .update(row)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from("twilio_phone_numbers")
    .insert({ ...row, created_at: new Date().toISOString() })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function consumeTrials(db, organizationId, count) {
  const limitConfig = limits();
  const usage = await getUsage(db, organizationId);
  const used = Math.max(0, Number(usage.calls_used || 0));
  const requested = Math.max(1, Number(count || 1));
  if (used + requested > limitConfig.maxCalls) {
    const err = new Error(
      `Your free test limit is ${limitConfig.maxCalls} calls. You have ${Math.max(0, limitConfig.maxCalls - used)} test call(s) remaining.`,
    );
    err.status = 403;
    err.code = "TEST_CALL_LIMIT_REACHED";
    err.details = serializeUsage(usage, limitConfig);
    throw err;
  }
  const { data, error } = await db
    .from("tenant_test_agent_usage")
    .update({
      calls_used: used + requested,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", usage.id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function refundTrials(db, usageId, count) {
  if (!usageId) return;
  const { data: usage } = await db
    .from("tenant_test_agent_usage")
    .select("calls_used")
    .eq("id", usageId)
    .maybeSingle();
  if (!usage) return;
  const used = Math.max(0, Number(usage.calls_used || 0));
  await db
    .from("tenant_test_agent_usage")
    .update({
      calls_used: Math.max(0, used - Math.max(1, Number(count || 1))),
      updated_at: new Date().toISOString(),
    })
    .eq("id", usageId);
}

function sanitizeRecipients(input) {
  const rawList = Array.isArray(input) ? input : input ? [input] : [];
  const output = [];
  for (const item of rawList) {
    const record = item && typeof item === "object" ? item : { phone: item };
    const phone = normalizePhone(record.phone || record.toPhone || record.to || "");
    if (!isE164(phone)) continue;
    output.push({
      name: clampText(record.name || record.recipientName || "Test Recipient", 80),
      phone,
    });
  }
  const seen = new Set();
  return output.filter((recipient) => {
    if (seen.has(recipient.phone)) return false;
    seen.add(recipient.phone);
    return true;
  });
}

function getPurpose(body, usage) {
  return clampText(
    body.callPurpose || body.purpose || usage.default_call_purpose || "Test this Agently voice agent with a short beta trial call.",
    1200,
  );
}

function getInstructions(body, usage, maxCallSeconds) {
  const userInstructions = clampText(
    body.customInstructions || usage.default_custom_instructions || "",
    1200,
  );
  return [
    userInstructions,
    `Platform beta test mode: this call is limited to ${Math.ceil(maxCallSeconds / 60)} minutes. Keep the conversation focused, helpful, and concise.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sendThroughRouter(routerInstance, targetUrl, req, res, next, beforeSend) {
  const originalUrl = req.url;
  const originalJson = res.json.bind(res);
  req.url = targetUrl;
  res.json = function patchedJson(payload) {
    Promise.resolve(beforeSend ? beforeSend(payload) : undefined)
      .catch((err) => console.warn("[test-agent] response side-effect failed:", err.message))
      .finally(() => originalJson(payload));
    return res;
  };
  routerInstance.handle(req, res, (err) => {
    req.url = originalUrl;
    res.json = originalJson;
    if (err) {
      Promise.resolve(beforeSend ? beforeSend({ success: false, error: { message: err.message, code: err.code || err.status } }) : undefined)
        .catch((sideEffectError) =>
          console.warn("[test-agent] error side-effect failed:", sideEffectError.message),
        )
        .finally(() => next(err));
      return;
    }
    if (!res.headersSent) return next();
  });
}

router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const usage = await getUsage(db, req.orgId);
    const limitConfig = limits();
    const platform = platformNumberConfig();
    let testAgent = null;
    if (usage.test_voice_agent_id) {
      const { data } = await db
        .from("voice_agents")
        .select("*")
        .eq("id", usage.test_voice_agent_id)
        .eq("organization_id", req.orgId)
        .maybeSingle();
      testAgent = data || null;
    }
    res.json({
      configured: platform.configured && isE164(platform.number),
      platformNumber: platform.number || "",
      usage: serializeUsage(usage, limitConfig),
      allowedVoices: ALLOWED_TEST_VOICES,
      testAgent: testAgent ? serializeAgent(testAgent, []) : {
        id: usage.test_voice_agent_id || "",
        name: usage.agent_name || "Test Agent",
        direction: "outbound",
        twilioPhoneNumber: platform.number || "",
        twilioPhoneSid: platform.sid || "",
        voice: usage.voice_id || ALLOWED_TEST_VOICES[0].id,
        voiceProvider: "openai",
        voiceId: usage.voice_id || ALLOWED_TEST_VOICES[0].id,
        language: "English",
        greeting: usage.greeting || "Hello, this is your Agently test agent. How can I help you today?",
        tone: "Friendly",
        businessHours: "Platform beta test mode",
        faqs: [],
        escalationPhone: "",
        voicemailFallback: false,
        dataCaptureFields: ["name", "phone", "email", "reason"],
        rules: { autoBook: false, autoEscalate: false, captureAllLeads: true },
        isActive: true,
      },
      defaults: {
        defaultCallPurpose: usage.default_call_purpose || "",
        defaultCustomInstructions: usage.default_custom_instructions || "",
      },
    });
  }),
);

router.patch(
  "/config",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const usage = await getUsage(db, req.orgId);
    const updated = await updateUsageConfig(db, usage.id, req.body || {});
    const agent = await ensureHiddenTestAgent(db, req, updated);
    res.json({ success: true, testAgent: serializeAgent(agent, []), usage: serializeUsage(updated, limits()) });
  }),
);

router.post(
  "/call-now",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res, next) => {
    const db = getSupabase();
    const usage = await getUsage(db, req.orgId);
    const limitConfig = limits();
    const recipients = sanitizeRecipients(req.body?.recipients || req.body?.recipient || [{ name: req.body?.recipientName, phone: req.body?.toPhone || req.body?.to }]);
    if (!recipients.length) {
      return res.status(400).json({ error: { code: "RECIPIENT_REQUIRED", message: "Add one valid E.164 recipient phone number." } });
    }
    if (recipients.length > 1) {
      return res.status(400).json({ error: { code: "ONE_CALL_NOW_RECIPIENT", message: "Call Now supports one test recipient at a time. Use Schedule Test Call for multiple recipients." } });
    }
    const consumed = await consumeTrials(db, req.orgId, 1);
    try {
      const agent = await ensureHiddenTestAgent(db, req, consumed);
      await ensureHiddenTestNumber(db, req, agent);
      const recipient = recipients[0];
      const eventInsert = await db.from("tenant_test_call_events").insert({
        organization_id: req.orgId,
        usage_id: consumed.id,
        test_voice_agent_id: agent.id,
        type: "call_now",
        status: "initiated",
        recipient_name: recipient.name,
        recipient_phone: recipient.phone,
        call_purpose: getPurpose(req.body || {}, consumed),
        custom_instructions: getInstructions(req.body || {}, consumed, limitConfig.maxCallSeconds),
        max_call_seconds: limitConfig.maxCallSeconds,
        created_by: req.user?.id || null,
      }).select("*").single();
      if (eventInsert.error) throw eventInsert.error;
      const event = eventInsert.data;

      req.body = {
        ...req.body,
        toPhone: recipient.phone,
        recipientName: recipient.name,
        targetName: recipient.name,
        voiceAgentId: agent.id,
        agentId: agent.id,
        callPurpose: event.call_purpose,
        customInstructions: event.custom_instructions,
        maxCallSeconds: limitConfig.maxCallSeconds,
        platformTestEventId: event.id,
        platformTestMode: true,
      };

      return sendThroughRouter(twilioRoutes, "/outbound", req, res, next, async (payload) => {
        if (payload?.success) {
          await db.from("tenant_test_call_events").update({
            status: payload.status || "initiated",
            twilio_call_sid: payload.callSid || null,
            call_record_id: payload.callRecordId || null,
            raw_response: payload,
            updated_at: new Date().toISOString(),
          }).eq("id", event.id);
        } else {
          await db.from("tenant_test_call_events").update({ status: "failed", raw_response: payload, updated_at: new Date().toISOString() }).eq("id", event.id);
          await refundTrials(db, consumed.id, 1);
        }
      });
    } catch (error) {
      await refundTrials(db, consumed.id, 1);
      throw error;
    }
  }),
);

router.post(
  "/schedule",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res, next) => {
    const db = getSupabase();
    const usage = await getUsage(db, req.orgId);
    const limitConfig = limits();
    const recipients = sanitizeRecipients(req.body?.recipients || req.body?.directRecipients || []);
    if (!recipients.length) {
      return res.status(400).json({ error: { code: "RECIPIENTS_REQUIRED", message: "Add at least one valid E.164 recipient." } });
    }
    if (recipients.length > limitConfig.maxRecipientsPerRequest) {
      return res.status(400).json({ error: { code: "TOO_MANY_TEST_RECIPIENTS", message: `A test schedule can include at most ${limitConfig.maxRecipientsPerRequest} recipients.` } });
    }
    const consumed = await consumeTrials(db, req.orgId, recipients.length);
    try {
      const agent = await ensureHiddenTestAgent(db, req, consumed);
      const number = await ensureHiddenTestNumber(db, req, agent);
      const callPurpose = getPurpose(req.body || {}, consumed);
      const customInstructions = getInstructions(req.body || {}, consumed, limitConfig.maxCallSeconds);
      const { data: event, error: eventError } = await db.from("tenant_test_call_events").insert({
        organization_id: req.orgId,
        usage_id: consumed.id,
        test_voice_agent_id: agent.id,
        type: "schedule",
        status: "queued",
        recipient_name: recipients.map((recipient) => recipient.name).join(", "),
        recipient_phone: recipients.map((recipient) => recipient.phone).join(","),
        call_purpose: callPurpose,
        custom_instructions: customInstructions,
        max_call_seconds: limitConfig.maxCallSeconds,
        scheduled_for: null,
        created_by: req.user?.id || null,
      }).select("*").single();
      if (eventError) throw eventError;

      req.body = {
        ...req.body,
        name: clampText(req.body?.name || "Platform test call", 120),
        scheduleType: req.body?.scheduleType || req.body?.schedule_type || "one_time_batch",
        voiceAgentId: agent.id,
        voice_agent_id: agent.id,
        fromNumberId: number.id,
        from_number_id: number.id,
        fromNumber: number.phone_number,
        from_number: number.phone_number,
        directRecipients: recipients,
        direct_recipients: recipients,
        leadIds: [],
        callPurpose,
        customInstructions,
        status: "active",
        limits: {
          maxConcurrentCalls: 1,
          maxOutboundCallsPerMinute: 1,
          maxDailyOutboundCalls: limitConfig.maxCalls,
          maxCallsPerDay: limitConfig.maxCalls,
        },
        metadata: {
          ...(req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}),
          platformTestMode: true,
          platformTestEventId: event.id,
          maxCallSeconds: limitConfig.maxCallSeconds,
        },
      };

      return sendThroughRouter(outreachRoutes, "/schedules", req, res, next, async (payload) => {
        if (payload?.success) {
          await db.from("tenant_test_call_events").update({
            status: "queued",
            schedule_id: payload.schedule?.id || payload.schedule?.scheduleId || null,
            raw_response: payload,
            updated_at: new Date().toISOString(),
          }).eq("id", event.id);
        } else {
          await db.from("tenant_test_call_events").update({ status: "failed", raw_response: payload, updated_at: new Date().toISOString() }).eq("id", event.id);
          await refundTrials(db, consumed.id, recipients.length);
        }
      });
    } catch (error) {
      await refundTrials(db, consumed.id, recipients.length);
      throw error;
    }
  }),
);

router.get(
  "/events",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("tenant_test_call_events")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    res.json({ events: data || [] });
  }),
);

module.exports = router;
