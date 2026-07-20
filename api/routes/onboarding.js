"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateFaqsFromWebsite } = require("../../lib/openai");
const { serializeAgent } = require("../../lib/serializers");
const {
  ensureDefaultKnowledgeBaseForOrg,
  assignVoiceAgentKnowledgeBase,
  assignChatbotKnowledgeBase,
  findOrCreateKnowledgeSource,
} = require("../../lib/knowledge-bases");

const router = express.Router();

function queueOnboardingKnowledgeSync({
  organizationId,
  knowledgeBaseId,
  knowledgeSourceId,
  url,
}) {
  if (!organizationId || !knowledgeBaseId || !knowledgeSourceId || !url) return;
  const run = async () => {
    try {
      const { scrapeAndStore } = require("../../lib/scraper.service");
      await scrapeAndStore({
        url,
        organizationId,
        knowledgeBaseId,
        knowledgeSourceId,
        voiceAgentId: null,
        chatbotId: null,
      });
    } catch (error) {
      console.error(
        "[onboarding] background website scrape failed:",
        error?.message || error,
      );
    }
  };
  if (typeof setImmediate === "function") setImmediate(run);
  else setTimeout(run, 0);
}

// Voice name migration for onboarding (legacy names → Twilio names)
const VOICE_MIGRATE = {
  Zephyr: "Domi",
  Puck: "Josh",
  Charon: "Arnold",
  Kore: "Bella",
  Fenrir: "Domi",
};
const VALID_VOICES = [
  "Domi",
  "Bella",
  "Josh",
  "Arnold",
  "Wavenet-F",
  "Wavenet-D",
  "Polly-Joanna",
  "Polly-Matthew",
];

function normalizeVoice(v) {
  if (VOICE_MIGRATE[v]) return VOICE_MIGRATE[v];
  if (VALID_VOICES.includes(v)) return v;
  return process.env.DEFAULT_AGENT_VOICE || VALID_VOICES[0] || "Domi";
}

const LOCATION_TIMEZONE_RULES = [
  {
    match: /\b(houston|texas|dallas|austin|san antonio|fort worth)\b/i,
    timezone: "America/Chicago",
  },
  {
    match:
      /\b(new york|brooklyn|queens|manhattan|new jersey|florida|miami|atlanta|georgia|boston|massachusetts|washington,?\s*dc|philadelphia|pennsylvania)\b/i,
    timezone: "America/New_York",
  },
  {
    match:
      /\b(chicago|illinois|wisconsin|minnesota|louisiana|oklahoma|kansas|missouri|tennessee)\b/i,
    timezone: "America/Chicago",
  },
  {
    match: /\b(denver|colorado|utah|wyoming|montana|new mexico)\b/i,
    timezone: "America/Denver",
  },
  {
    match:
      /\b(los angeles|california|san francisco|seattle|washington|oregon|portland|las vegas|nevada)\b/i,
    timezone: "America/Los_Angeles",
  },
  { match: /\b(phoenix|arizona)\b/i, timezone: "America/Phoenix" },
  { match: /\b(lagos|nigeria)\b/i, timezone: "Africa/Lagos" },
  { match: /\b(accra|ghana)\b/i, timezone: "Africa/Accra" },
  { match: /\b(london|united kingdom|england)\b/i, timezone: "Europe/London" },
];

function isValidTimezone(timezone) {
  try {
    if (!timezone || typeof timezone !== "string") return false;
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function inferTimezoneFromLocation(location) {
  const text = String(location || "").trim();
  if (!text) return null;
  const rule = LOCATION_TIMEZONE_RULES.find((item) => item.match.test(text));
  return rule?.timezone || null;
}

function resolveOnboardingTimezone(profile = {}) {
  const locationTimezone = inferTimezoneFromLocation(profile.location);
  const submittedTimezone = String(profile.timezone || "").trim();

  // A selected business location is more reliable than the browser/device timezone.
  // This prevents a Nigerian admin creating a Houston workspace from storing Africa/Lagos.
  if (locationTimezone) return locationTimezone;
  if (isValidTimezone(submittedTimezone)) return submittedTimezone;
  return "America/Chicago";
}

function buildCoreAgentPayload(payload) {
  return {
    organization_id: payload.organization_id,
    name: payload.name || "Maya",
    direction: payload.direction || "inbound",
    voice: payload.voice || "Zephyr",
    language: payload.language || "English",
    greeting:
      payload.greeting ||
      "Hello, thank you for calling. How can I help you today?",
    tone: payload.tone || "Professional",
    business_hours: payload.business_hours || "9am-5pm Monday-Friday",
    escalation_phone: payload.escalation_phone || "",
    voicemail_fallback: payload.voicemail_fallback ?? true,
    data_capture_fields: payload.data_capture_fields || [
      "name",
      "phone",
      "email",
      "reason",
    ],
    rules: payload.rules || {
      autoBook: false,
      autoEscalate: true,
      captureAllLeads: true,
    },
    is_active: payload.is_active ?? true,
  };
}

async function updateVoiceAgentOptionalFieldsSafely(db, agentId, updates) {
  let current = { ...updates };
  const warnings = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!Object.keys(current).length) return warnings;
    const { error } = await db
      .from("voice_agents")
      .update(current)
      .eq("id", agentId);
    if (!error) return warnings;
    const missingColumn = extractMissingColumn(error);
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(current, missingColumn)
    ) {
      delete current[missingColumn];
      warnings.push(
        `Skipped unsupported voice_agents.${missingColumn} during optional onboarding update.`,
      );
      continue;
    }
    warnings.push(
      `Optional voice agent update skipped: ${error?.message || String(error)}`,
    );
    return warnings;
  }
  return warnings;
}

const LEGACY_VOICE_FALLBACK = {
  Domi: "Zephyr",
  Bella: "Kore",
  Josh: "Puck",
  Arnold: "Charon",
  "Wavenet-F": "Kore",
  "Wavenet-D": "Puck",
  "Polly-Joanna": "Kore",
  "Polly-Matthew": "Puck",
};

function extractMissingColumn(error) {
  const message = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  const quoted = message.match(/['"]([a-zA-Z0-9_]+)['"]\s+column/i);
  if (quoted?.[1]) return quoted[1];
  const direct = message.match(
    /column\s+["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i,
  );
  if (direct?.[1]) return direct[1];
  const pgrst = message.match(
    /Could not find the ['"]([a-zA-Z0-9_]+)['"] column/i,
  );
  if (pgrst?.[1]) return pgrst[1];
  return null;
}

function isVoiceConstraintError(error) {
  const message =
    `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return (
    message.includes("voice") &&
    (message.includes("check") ||
      message.includes("constraint") ||
      message.includes("violates"))
  );
}

function buildMinimalAgentPayload(payload) {
  return {
    organization_id: payload.organization_id,
    name: payload.name || "Maya",
    direction: payload.direction || "inbound",
    voice: payload.voice || "Zephyr",
    language: payload.language || "English",
    greeting:
      payload.greeting ||
      "Hello, thank you for calling. How can I help you today?",
    tone: payload.tone || "Professional",
    business_hours: payload.business_hours || "9am-5pm Monday-Friday",
    escalation_phone: payload.escalation_phone || "",
    voicemail_fallback: payload.voicemail_fallback ?? true,
    data_capture_fields: payload.data_capture_fields || [
      "name",
      "phone",
      "email",
      "reason",
    ],
    rules: payload.rules || {
      autoBook: false,
      autoEscalate: true,
      captureAllLeads: true,
    },
    is_active: payload.is_active ?? true,
  };
}

async function insertVoiceAgentSafely(db, payload) {
  let current = buildCoreAgentPayload(payload);
  const warnings = [
    "Started onboarding agent creation with core schema payload to avoid live DB drift.",
  ];

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const { data, error } = await db
      .from("voice_agents")
      .insert(current)
      .select()
      .single();

    if (!error && data) return { data, warnings };

    if (isVoiceConstraintError(error) && current.voice !== "Zephyr") {
      const previousVoice = current.voice;
      current.voice = LEGACY_VOICE_FALLBACK[previousVoice] || "Zephyr";
      warnings.push(
        `Voice ${previousVoice} was not accepted by the current DB constraint. Retried with ${current.voice}.`,
      );
      continue;
    }

    const missingColumn = extractMissingColumn(error);
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(current, missingColumn)
    ) {
      delete current[missingColumn];
      warnings.push(
        `Removed unsupported voice_agents.${missingColumn} during onboarding retry.`,
      );
      continue;
    }

    const minimal = buildMinimalAgentPayload(payload);
    if (
      JSON.stringify(Object.keys(current).sort()) !==
      JSON.stringify(Object.keys(minimal).sort())
    ) {
      current = minimal;
      warnings.push(
        "Retried voice agent creation with the core schema payload.",
      );
      continue;
    }

    throw error;
  }

  throw new Error("Unable to create voice agent after schema-safe retries.");
}

async function insertFaqsSafely(db, rows) {
  if (!rows.length) return [];
  let currentRows = rows.map((row) => ({ ...row }));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await db.from("faqs").insert(currentRows).select();
    if (!error) return data || [];

    const missingColumn = extractMissingColumn(error);
    if (missingColumn) {
      currentRows = currentRows.map((row) => {
        const next = { ...row };
        delete next[missingColumn];
        return next;
      });
      continue;
    }

    console.warn("FAQ insert warning (non-fatal):", error?.message || error);
    return [];
  }

  return [];
}

// ── POST /api/onboarding/faqs ────────────────────────────────
router.post(
  "/faqs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { website } = req.body;
    if (!website) {
      return res
        .status(400)
        .json({ error: { message: "Website URL is required." } });
    }
    const faqs = await generateFaqsFromWebsite(website);
    res.json({ website, faqs });
  }),
);

// ── POST /api/onboarding/complete ────────────────────────────
router.post(
  "/complete",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { profile, agent: agentConfig } = req.body;

    if (!profile || !agentConfig) {
      return res
        .status(400)
        .json({ error: { message: "Profile and agent config are required." } });
    }

    const db = getSupabase();
    const orgId = req.orgId;

    const resolvedTimezone = resolveOnboardingTimezone(profile);

    // Update org profile
    await db
      .from("organizations")
      .update({
        name: profile.name || "My Business",
        industry: profile.industry || "",
        website: profile.website || "",
        location: profile.location || "",
        timezone: resolvedTimezone,
        onboarded: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId);

    const onboardingOrg = {
      id: orgId,
      name: profile.name || "My Business",
      industry: profile.industry || "",
      website: profile.website || "",
      location: profile.location || "",
      timezone: resolvedTimezone,
    };
    const knowledgeBase = await ensureDefaultKnowledgeBaseForOrg(
      db,
      onboardingOrg,
    );
    const primaryKnowledgeSource =
      knowledgeBase?.id && onboardingOrg.website
        ? await findOrCreateKnowledgeSource(db, {
            organizationId: orgId,
            knowledgeBaseId: knowledgeBase.id,
            url: onboardingOrg.website,
            title: `${onboardingOrg.name} Website`,
            isPrimary: true,
          })
        : null;

    if (
      knowledgeBase?.id &&
      primaryKnowledgeSource?.id &&
      onboardingOrg.website
    ) {
      await db
        .from("knowledge_sources")
        .update({
          scrape_status: "scraping",
          last_error: null,
          metadata: {
            ...(primaryKnowledgeSource.metadata || {}),
            scrapeProgress: {
              phase: "queued",
              currentUrl: onboardingOrg.website,
              pagesDetected: 1,
              pagesCompleted: 0,
              pagesFailed: 0,
              overallPercent: 0,
              pages: [
                {
                  url: onboardingOrg.website,
                  title: `${onboardingOrg.name} Website`,
                  status: "queued",
                  percent: 0,
                  error: "",
                },
              ],
              updatedAt: new Date().toISOString(),
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", primaryKnowledgeSource.id)
        .eq("organization_id", orgId);
      await db
        .from("knowledge_bases")
        .update({
          primary_url: onboardingOrg.website,
          sync_status: "scraping",
          updated_at: new Date().toISOString(),
        })
        .eq("id", knowledgeBase.id)
        .eq("organization_id", orgId);
      queueOnboardingKnowledgeSync({
        organizationId: orgId,
        knowledgeBaseId: knowledgeBase.id,
        knowledgeSourceId: primaryKnowledgeSource.id,
        url: onboardingOrg.website,
      });
    }

    // Determine greeting — use provided or build from agent name + business name
    const agentName = agentConfig.name || "Maya";
    const businessName = profile.name || "our business";
    const greeting =
      agentConfig.greeting && agentConfig.greeting.trim()
        ? agentConfig.greeting
        : `Hello, thank you for calling ${businessName}! This is ${agentName}. How can I help you today?`;

    // Create voice agent using Twilio/OpenAI realtime pipeline
    const agentPayload = {
      organization_id: orgId,
      name: agentName,
      direction: agentConfig.direction || "inbound",
      voice: normalizeVoice(
        agentConfig.voice || process.env.DEFAULT_AGENT_VOICE || "Domi",
      ),
      language: agentConfig.language || "English",
      greeting,
      tone: agentConfig.tone || "Professional",
      business_hours: agentConfig.businessHours || "9am-5pm Monday-Friday",
      escalation_phone: agentConfig.escalationPhone || "",
      voicemail_fallback: agentConfig.voicemailFallback ?? true,
      voicemail_behavior:
        agentConfig.voicemailBehavior ||
        agentConfig.voicemailSettings?.action ||
        "hangup",
      voicemail_message:
        agentConfig.voicemailMessage ||
        agentConfig.voicemailSettings?.message ||
        "",
      voicemail_callback_delay_minutes: Number(
        agentConfig.voicemailCallbackDelayMinutes ||
          agentConfig.voicemailSettings?.callbackDelayMinutes ||
          60,
      ),
      voicemail_max_redial_attempts: Number(
        agentConfig.voicemailMaxRedialAttempts ||
          agentConfig.voicemailSettings?.maxRedialAttempts ||
          1,
      ),
      voicemail_settings: agentConfig.voicemailSettings || {},
      call_screening_enabled: agentConfig.callScreeningEnabled !== false,
      call_screening_message: agentConfig.callScreeningMessage || "",
      call_screening_settings: agentConfig.callScreeningSettings || {},
      data_capture_fields: agentConfig.dataCaptureFields || [
        "name",
        "phone",
        "email",
        "reason",
      ],
      rules: agentConfig.rules || {
        autoBook: false,
        autoEscalate: true,
        captureAllLeads: true,
      },
      is_active: true,
    };
    if (knowledgeBase?.id) agentPayload.knowledge_base_id = knowledgeBase.id;

    let agentRow;
    let agentCreateWarnings = [];
    try {
      const result = await insertVoiceAgentSafely(db, agentPayload);
      agentRow = result.data;
      agentCreateWarnings = result.warnings || [];
      const optionalWarnings = await updateVoiceAgentOptionalFieldsSafely(
        db,
        agentRow.id,
        {
          voicemail_behavior: agentPayload.voicemail_behavior,
          voicemail_message: agentPayload.voicemail_message,
          voicemail_callback_delay_minutes:
            agentPayload.voicemail_callback_delay_minutes,
          voicemail_max_redial_attempts:
            agentPayload.voicemail_max_redial_attempts,
          voicemail_settings: agentPayload.voicemail_settings,
          call_screening_enabled: agentPayload.call_screening_enabled,
          call_screening_message: agentPayload.call_screening_message,
          call_screening_settings: agentPayload.call_screening_settings,
          ...(knowledgeBase?.id ? { knowledge_base_id: knowledgeBase.id } : {}),
        },
      );
      agentCreateWarnings = [...agentCreateWarnings, ...optionalWarnings];
      if (agentCreateWarnings.length) {
        console.warn(
          "[onboarding] voice agent created with schema-safe compatibility warnings:",
          agentCreateWarnings,
        );
      }
    } catch (agentErr) {
      console.error("Voice agent creation error:", agentErr);
      return res.status(500).json({
        error: {
          message:
            "We could not create your first agent because the live database schema rejected the agent record. Please apply the latest voice_agents migration or contact support.",
          details:
            process.env.NODE_ENV !== "production"
              ? agentErr?.message || String(agentErr)
              : undefined,
        },
      });
    }

    if (knowledgeBase?.id) {
      try {
        await assignVoiceAgentKnowledgeBase(db, {
          organizationId: orgId,
          agentId: agentRow.id,
          knowledgeBaseId: knowledgeBase.id,
        });
        agentRow.knowledge_base_id = knowledgeBase.id;
      } catch (kbAssignErr) {
        console.warn(
          "[onboarding] Knowledge Base assignment skipped:",
          kbAssignErr?.message || kbAssignErr,
        );
      }
    }

    // Insert FAQs
    const faqs = agentConfig.faqs || [];
    let insertedFaqs = [];
    if (faqs.length > 0) {
      insertedFaqs = await insertFaqsSafely(
        db,
        faqs.map((f) => {
          const row = {
            organization_id: orgId,
            voice_agent_id: agentRow.id,
            question: f.question,
            answer: f.answer,
            source_type: "onboarding",
          };
          if (knowledgeBase?.id) row.knowledge_base_id = knowledgeBase.id;
          if (primaryKnowledgeSource?.id)
            row.knowledge_source_id = primaryKnowledgeSource.id;
          return row;
        }),
      );
    }

    // Set as active agent and mark onboarding complete only after the agent exists.
    await db
      .from("organizations")
      .update({
        active_voice_agent_id: agentRow.id,
        onboarded: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId);

    // Create default chatbot (non-blocking — don't fail onboarding if this fails)
    try {
      const chatbotName = `${businessName} Chat Agent`;
      const { data: chatbotRow } = await db
        .from("chatbots")
        .insert({
          organization_id: orgId,
          voice_agent_id: agentRow.id,
          name: chatbotName,
          header_title: businessName,
          welcome_message: `Hello! Welcome to ${businessName}. How can I help you today?`,
          faqs: faqs.map((f) => ({ question: f.question, answer: f.answer })),
          is_active: true,
          ...(knowledgeBase?.id ? { knowledge_base_id: knowledgeBase.id } : {}),
        })
        .select()
        .single();

      if (chatbotRow) {
        if (knowledgeBase?.id) {
          await assignChatbotKnowledgeBase(db, {
            organizationId: orgId,
            chatbotId: chatbotRow.id,
            knowledgeBaseId: knowledgeBase.id,
          });
        }
        const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
        const embedScript = `<!-- Agently Chat Widget -->\n<iframe id="agently-widget-${chatbotRow.id}" src="${apiUrl}/chatbot-widget/${chatbotRow.id}" style="position:fixed;bottom:20px;right:20px;width:420px;height:700px;max-width:90vw;max-height:90vh;border:none;background:transparent;z-index:1000000;overflow:hidden;" scrolling="no" frameborder="0" allow="microphone" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>`;
        await db
          .from("chatbots")
          .update({ embed_script: embedScript })
          .eq("id", chatbotRow.id);
        await db
          .from("organizations")
          .update({ active_chatbot_id: chatbotRow.id })
          .eq("id", orgId);
      }
    } catch (chatbotErr) {
      console.warn("Chatbot creation warning (non-fatal):", chatbotErr.message);
    }

    // Return updated org
    const { data: updatedOrg } = await db
      .from("organizations")
      .select("*")
      .eq("id", orgId)
      .single();
    res.json({
      ...updatedOrg,
      onboardingAgentCreated: true,
      onboardingWarnings: agentCreateWarnings,
      onboardingFaqsCreated: insertedFaqs.length,
      onboardingKnowledgeSyncStarted: Boolean(primaryKnowledgeSource?.id),
    });
  }),
);

module.exports = router;
