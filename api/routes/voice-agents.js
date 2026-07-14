"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeAgent } = require("../../lib/serializers");
const { updateNumberWebhooks } = require("../../lib/twilio");
const {
  ensureDefaultKnowledgeBaseForOrg,
  assignVoiceAgentKnowledgeBase,
  verifyKnowledgeBase,
  getAssignedKnowledgeBaseIdsForVoiceAgent,
  findOrCreateKnowledgeSource,
} = require("../../lib/knowledge-bases");

const router = express.Router();

const LEGACY_VOICE_FALLBACK = {
  Domi: "Zephyr",
  Bella: "Kore",
  Josh: "Puck",
  Arnold: "Charon",
  "Wavenet-F": "Kore",
  "Wavenet-D": "Puck",
  "Polly-Joanna": "Kore",
  "Polly-Matthew": "Puck",
  alloy: "Zephyr",
  ash: "Puck",
  ballad: "Charon",
  coral: "Kore",
  echo: "Puck",
  fable: "Kore",
  nova: "Kore",
  onyx: "Charon",
  sage: "Zephyr",
  shimmer: "Kore",
  verse: "Puck",
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

function buildVoiceAgentCorePayload({ body, organizationId }) {
  return {
    organization_id: organizationId,
    name: body.name || "New AI Agent",
    direction: body.direction || "inbound",
    // Keep the requested voice first. If the live DB still has the old
    // Zephyr/Puck/Charon/Kore/Fenrir check constraint, insertVoiceAgentSafely
    // retries with the compatible legacy value instead of failing the create.
    voice: body.voice || process.env.DEFAULT_AGENT_VOICE || "Domi",
    language: body.language || "English",
    greeting:
      body.greeting ||
      "Hello, thank you for calling. How can I help you today?",
    tone: body.tone || "Professional",
    business_hours: body.businessHours || "9am-5pm Monday-Friday",
    escalation_phone: body.escalationPhone || "",
    voicemail_fallback: body.voicemailFallback ?? true,
    data_capture_fields: body.dataCaptureFields || [
      "name",
      "phone",
      "email",
      "reason",
    ],
    rules: body.rules || {
      autoBook: false,
      autoEscalate: true,
      captureAllLeads: true,
    },
    is_active: true,
  };
}

function normalizeVoiceProvider(value) {
  const provider = String(value || "")
    .trim()
    .toLowerCase();
  return provider === "openai" || provider === "elevenlabs" ? provider : null;
}

function buildVoiceAgentOptionalPayload({ body, knowledgeBaseId }) {
  const optional = {
    voice_provider: normalizeVoiceProvider(
      body.voiceProvider ||
        body.voice_provider ||
        process.env.VOICE_PROVIDER_DEFAULT,
    ),
    voice_id: body.voiceId || body.voice_id || null,
    voice_catalog_id: body.voiceCatalogId || body.voice_catalog_id || null,
    voice_settings: body.voiceSettings || body.voice_settings || {},
    voicemail_behavior:
      body.voicemailBehavior ||
      body.voicemail_behavior ||
      body.voicemail_settings?.action ||
      body.voicemailSettings?.action ||
      "hangup",
    voicemail_message:
      body.voicemailMessage ||
      body.voicemail_message ||
      body.voicemail_settings?.message ||
      body.voicemailSettings?.message ||
      "",
    voicemail_callback_delay_minutes: Number(
      body.voicemailCallbackDelayMinutes ||
        body.voicemail_callback_delay_minutes ||
        body.voicemail_settings?.callbackDelayMinutes ||
        body.voicemailSettings?.callbackDelayMinutes ||
        60,
    ),
    voicemail_max_redial_attempts: Number(
      body.voicemailMaxRedialAttempts ||
        body.voicemail_max_redial_attempts ||
        body.voicemail_settings?.maxRedialAttempts ||
        body.voicemailSettings?.maxRedialAttempts ||
        1,
    ),
    voicemail_settings: body.voicemailSettings || body.voicemail_settings || {},
    call_screening_enabled: body.callScreeningEnabled !== false,
    call_screening_message:
      body.callScreeningMessage || body.call_screening_message || "",
    call_screening_settings:
      body.callScreeningSettings || body.call_screening_settings || {},
    updated_at: new Date().toISOString(),
  };

  if (Array.isArray(body.callPurposes)) {
    optional.call_purposes = body.callPurposes;
  }
  if (knowledgeBaseId) {
    optional.knowledge_base_id = knowledgeBaseId;
  }
  return optional;
}

async function insertVoiceAgentSafely(db, payload) {
  let current = { ...payload };
  const warnings = [];

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const { data, error } = await db
      .from("voice_agents")
      .insert(current)
      .select()
      .single();

    if (!error && data) return { data, warnings };

    const missingColumn = extractMissingColumn(error);
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(current, missingColumn)
    ) {
      delete current[missingColumn];
      warnings.push(
        `Removed unsupported voice_agents.${missingColumn} during create retry.`,
      );
      continue;
    }

    if (isVoiceConstraintError(error)) {
      const previousVoice = current.voice;
      const fallback = LEGACY_VOICE_FALLBACK[previousVoice] || "Zephyr";
      if (previousVoice !== fallback) {
        current.voice = fallback;
        warnings.push(
          `Voice ${previousVoice} was rejected by the live DB constraint. Retried with ${fallback}.`,
        );
        continue;
      }
    }

    throw error;
  }

  throw new Error("Unable to create voice agent after schema-safe retries.");
}

async function updateVoiceAgentOptionalFieldsSafely(db, agentId, updates) {
  let current = { ...updates };
  const warnings = [];

  for (let attempt = 0; attempt < 14; attempt += 1) {
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
        `Skipped unsupported voice_agents.${missingColumn} during optional create update.`,
      );
      continue;
    }

    warnings.push(
      `Optional voice agent fields were not saved: ${error?.message || String(error)}`,
    );
    return warnings;
  }

  return warnings;
}

// ── GET /api/voice-agents ────────────────────────────────────
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("voice_agents")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[voice-agents:create] list failed:", error);
      return res
        .status(500)
        .json({ error: { message: "Failed to load voice agents." } });
    }

    res.json((data || []).map((row) => serializeAgent(row, [])));
  }),
);

// ── POST /api/voice-agents ───────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};

    const requestedKnowledgeBaseId =
      body.knowledgeBaseId || body.knowledge_base_id || null;
    const defaultKnowledgeBase = requestedKnowledgeBaseId
      ? await verifyKnowledgeBase(db, {
          organizationId: req.orgId,
          knowledgeBaseId: requestedKnowledgeBaseId,
        })
      : await ensureDefaultKnowledgeBaseForOrg(db, req.organization);

    if (requestedKnowledgeBaseId && !defaultKnowledgeBase?.id) {
      return res.status(400).json({
        error: { message: "Selected knowledge base was not found." },
      });
    }

    try {
      const corePayload = buildVoiceAgentCorePayload({
        body,
        organizationId: req.orgId,
      });

      const { data: agent, warnings: insertWarnings } =
        await insertVoiceAgentSafely(db, corePayload);

      const optionalWarnings = await updateVoiceAgentOptionalFieldsSafely(
        db,
        agent.id,
        buildVoiceAgentOptionalPayload({
          body,
          knowledgeBaseId: defaultKnowledgeBase?.id || null,
        }),
      );

      if (defaultKnowledgeBase?.id) {
        const assignResult = await assignVoiceAgentKnowledgeBase(db, {
          organizationId: req.orgId,
          agentId: agent.id,
          knowledgeBaseId: defaultKnowledgeBase.id,
        });
        if (assignResult?.ok) {
          agent.knowledge_base_id = defaultKnowledgeBase.id;
        }
      }

      if (insertWarnings.length || optionalWarnings.length) {
        console.warn("[voice-agents:create] schema-safe create warnings:", {
          organizationId: req.orgId,
          agentId: agent.id,
          warnings: [...insertWarnings, ...optionalWarnings],
        });
      }

      const { data: refreshed } = await db
        .from("voice_agents")
        .select("*")
        .eq("id", agent.id)
        .eq("organization_id", req.orgId)
        .maybeSingle();

      res.status(201).json(serializeAgent(refreshed || agent, []));
    } catch (error) {
      console.error("[voice-agents:create] failed:", {
        organizationId: req.orgId,
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
      });
      return res.status(500).json({
        error: {
          message:
            "Failed to create voice agent. The backend is reachable, but the database rejected the agent record. Apply the voice_agents schema drift migration and try again.",
          details:
            process.env.NODE_ENV !== "production"
              ? {
                  message: error?.message,
                  code: error?.code,
                  details: error?.details,
                  hint: error?.hint,
                }
              : undefined,
        },
      });
    }
  }),
);

// ── PATCH /api/voice-agents/:id ──────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const body = req.body || {};

    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.direction !== undefined) updates.direction = body.direction;
    if (body.voice !== undefined) updates.voice = body.voice;
    if (body.voiceProvider !== undefined)
      updates.voice_provider = body.voiceProvider || null;
    if (body.voiceId !== undefined) updates.voice_id = body.voiceId || null;
    if (body.voiceCatalogId !== undefined)
      updates.voice_catalog_id = body.voiceCatalogId || null;
    if (body.voiceSettings !== undefined || body.voice_settings !== undefined)
      updates.voice_settings = body.voiceSettings || body.voice_settings || {};
    if (body.language !== undefined) updates.language = body.language;
    if (body.greeting !== undefined) updates.greeting = body.greeting;
    if (body.tone !== undefined) updates.tone = body.tone;
    if (body.businessHours !== undefined)
      updates.business_hours = body.businessHours;
    if (body.escalationPhone !== undefined)
      updates.escalation_phone = body.escalationPhone;
    if (body.voicemailFallback !== undefined)
      updates.voicemail_fallback = body.voicemailFallback;
    if (body.voicemailBehavior !== undefined)
      updates.voicemail_behavior = body.voicemailBehavior || "hangup";
    if (body.voicemailMessage !== undefined)
      updates.voicemail_message = body.voicemailMessage || "";
    if (body.voicemailCallbackDelayMinutes !== undefined)
      updates.voicemail_callback_delay_minutes =
        Number(body.voicemailCallbackDelayMinutes) || 60;
    if (body.voicemailMaxRedialAttempts !== undefined)
      updates.voicemail_max_redial_attempts =
        Number(body.voicemailMaxRedialAttempts) || 1;
    if (
      body.voicemailSettings !== undefined ||
      body.voicemail_settings !== undefined
    )
      updates.voicemail_settings =
        body.voicemailSettings || body.voicemail_settings || {};
    if (body.callScreeningEnabled !== undefined)
      updates.call_screening_enabled = body.callScreeningEnabled !== false;
    if (body.callScreeningMessage !== undefined)
      updates.call_screening_message = body.callScreeningMessage || "";
    if (
      body.callScreeningSettings !== undefined ||
      body.call_screening_settings !== undefined
    )
      updates.call_screening_settings =
        body.callScreeningSettings || body.call_screening_settings || {};
    if (body.dataCaptureFields !== undefined)
      updates.data_capture_fields = body.dataCaptureFields;
    if (body.rules !== undefined) updates.rules = body.rules;
    if (body.twilioPhoneNumber !== undefined)
      updates.twilio_phone_number = body.twilioPhoneNumber;
    if (body.twilioPhoneSid !== undefined)
      updates.twilio_phone_sid = body.twilioPhoneSid;

    // Call purposes — outbound only, an array of plain-text call reasons
    if (body.callPurposes !== undefined)
      updates.call_purposes = Array.isArray(body.callPurposes)
        ? body.callPurposes
        : [];

    // ── Number unassignment ────────────────────────────────────
    // Clears twilio_phone_number and twilio_phone_sid from this agent
    // so the number can be assigned to a different agent.
    // The number itself remains in "All Owned" — it is NOT released from Twilio.
    // Shared outbound numbers are supported through agent_phone_number_assignments.
    // This legacy field is cleared only for the edited agent.
    if (body.unassignNumber === true) {
      // Conflict check — no other agent should be getting this number
      updates.twilio_phone_number = "";
      updates.twilio_phone_sid = "";
      updates.number_source = null;
    }

    updates.updated_at = new Date().toISOString();

    const { data: agent, error } = await db
      .from("voice_agents")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !agent) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    if (body.twilioPhoneSid) {
      try {
        await updateNumberWebhooks({ phoneSid: body.twilioPhoneSid });
      } catch (e) {
        console.warn("[voice-agents] webhook update failed:", e.message);
      }
    }

    const requestedKnowledgeBaseId =
      body.knowledgeBaseId || body.knowledge_base_id || null;
    if (
      requestedKnowledgeBaseId !== null &&
      requestedKnowledgeBaseId !== undefined
    ) {
      const result = await assignVoiceAgentKnowledgeBase(db, {
        organizationId: req.orgId,
        agentId: id,
        knowledgeBaseId: requestedKnowledgeBaseId,
      });
      if (!result.ok) {
        return res.status(400).json({ error: { message: result.message } });
      }
      agent.knowledge_base_id = requestedKnowledgeBaseId;
    }

    const assignedKnowledgeBaseIds =
      await getAssignedKnowledgeBaseIdsForVoiceAgent(db, {
        organizationId: req.orgId,
        agentId: id,
        organization: req.organization,
      });
    let faqsQuery = db
      .from("faqs")
      .select("*")
      .eq("organization_id", req.orgId);
    if (assignedKnowledgeBaseIds.length) {
      faqsQuery = faqsQuery
        .in("knowledge_base_id", assignedKnowledgeBaseIds)
        .or(`voice_agent_id.eq.${id},voice_agent_id.is.null`);
    } else {
      faqsQuery = faqsQuery
        .eq("voice_agent_id", id)
        .is("knowledge_base_id", null);
    }
    const { data: faqs } = await faqsQuery.order("created_at", {
      ascending: true,
    });
    res.json(serializeAgent(agent, faqs || []));
  }),
);

// ── POST /api/voice-agents/:id/activate ──────────────────────
router.post(
  "/:id/activate",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: agent } = await db
      .from("voice_agents")
      .select("id,twilio_phone_sid")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();
    if (!agent)
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });

    // Selecting an agent should only update the organization default pointer.
    // It must not deactivate other agents; all voice agents remain callable.
    await db
      .from("voice_agents")
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", req.orgId);
    await db
      .from("organizations")
      .update({ active_voice_agent_id: id })
      .eq("id", req.orgId);

    if (agent.twilio_phone_sid) {
      try {
        await updateNumberWebhooks({ phoneSid: agent.twilio_phone_sid });
      } catch (e) {
        console.warn("[activate] webhook sync failed:", e.message);
      }
    }

    const { data: updated } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", id)
      .single();
    const assignedKnowledgeBaseIds =
      await getAssignedKnowledgeBaseIdsForVoiceAgent(db, {
        organizationId: req.orgId,
        agentId: id,
        organization: req.organization,
      });
    let faqsQuery = db
      .from("faqs")
      .select("*")
      .eq("organization_id", req.orgId);
    if (assignedKnowledgeBaseIds.length) {
      faqsQuery = faqsQuery
        .in("knowledge_base_id", assignedKnowledgeBaseIds)
        .or(`voice_agent_id.eq.${id},voice_agent_id.is.null`);
    } else {
      faqsQuery = faqsQuery
        .eq("voice_agent_id", id)
        .is("knowledge_base_id", null);
    }
    const { data: faqs } = await faqsQuery.order("created_at", {
      ascending: true,
    });
    res.json(serializeAgent(updated, faqs || []));
  }),
);

// ── POST /api/voice-agents/:id/import-knowledge ──────────────
router.post(
  "/:id/import-knowledge",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { website } = req.body || {};
    if (!website || !String(website).trim()) {
      return res
        .status(400)
        .json({ error: { message: "website URL is required." } });
    }

    const db = getSupabase();
    const { data: agent } = await db
      .from("voice_agents")
      .select("id, knowledge_base_id")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (!agent?.id) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    let scrapeAndStore;
    try {
      ({ scrapeAndStore } = require("../../lib/scraper.service"));
    } catch (depErr) {
      console.error(
        "[voice-agents] scraper.service failed to load:",
        depErr.message,
      );
      return res.status(500).json({
        error: {
          message:
            "Website scraping is temporarily unavailable. A server dependency is missing (cheerio). Please contact support.",
          detail: depErr.message,
        },
      });
    }

    const knowledgeBaseIds = await getAssignedKnowledgeBaseIdsForVoiceAgent(
      db,
      {
        organizationId: req.orgId,
        agentId: id,
        organization: req.organization,
      },
    );
    const knowledgeBaseId =
      knowledgeBaseIds[0] || agent.knowledge_base_id || null;
    const source = knowledgeBaseId
      ? await findOrCreateKnowledgeSource(db, {
          organizationId: req.orgId,
          knowledgeBaseId,
          url: website,
          isPrimary: false,
        })
      : null;

    const result = await scrapeAndStore({
      url: website,
      organizationId: req.orgId,
      voiceAgentId: id,
      chatbotId: null,
      knowledgeBaseId,
      knowledgeSourceId: source?.id || null,
    });

    res.json({
      success: true,
      chunksStored: result.chunksStored,
      strategy: result.strategy,
      message: `Scraped ${result.chunksStored} content chunks using ${result.strategy}.`,
    });
  }),
);

// ── DELETE /api/voice-agents/:id ─────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: agent } = await db
      .from("voice_agents")
      .select("twilio_phone_sid")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();
    if (!agent)
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });

    await db.from("faqs").delete().eq("voice_agent_id", id);
    await db.from("knowledge_chunks").delete().eq("voice_agent_id", id);
    await db
      .from("voice_agents")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    if (req.organization.active_voice_agent_id === id) {
      const { data: rem } = await db
        .from("voice_agents")
        .select("id")
        .eq("organization_id", req.orgId)
        .limit(1)
        .single();
      await db
        .from("organizations")
        .update({ active_voice_agent_id: rem?.id || null })
        .eq("id", req.orgId);
    }

    res.json({ success: true });
  }),
);

module.exports = router;
