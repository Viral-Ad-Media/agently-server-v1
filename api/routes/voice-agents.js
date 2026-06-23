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

    const insertPayload = {
      organization_id: req.orgId,
      name: body.name || "New AI Agent",
      direction: body.direction || "inbound",
      voice: body.voice || process.env.DEFAULT_AGENT_VOICE || "alloy",
      voice_provider:
        body.voiceProvider || process.env.VOICE_PROVIDER_DEFAULT || null,
      voice_id: body.voiceId || null,
      voice_catalog_id: body.voiceCatalogId || null,
      voice_settings: body.voiceSettings || body.voice_settings || {},
      language: body.language || "English",
      greeting:
        body.greeting ||
        "Hello, thank you for calling. How can I help you today?",
      tone: body.tone || "Professional",
      business_hours: body.businessHours || "9am-5pm Monday-Friday",
      escalation_phone: body.escalationPhone || "",
      voicemail_fallback: body.voicemailFallback ?? true,
      voicemail_behavior:
        body.voicemailBehavior ||
        body.voicemail_settings?.action ||
        body.voicemailSettings?.action ||
        "hangup",
      voicemail_message:
        body.voicemailMessage ||
        body.voicemail_settings?.message ||
        body.voicemailSettings?.message ||
        "",
      voicemail_callback_delay_minutes: Number(
        body.voicemailCallbackDelayMinutes ||
          body.voicemail_settings?.callbackDelayMinutes ||
          body.voicemailSettings?.callbackDelayMinutes ||
          60,
      ),
      voicemail_max_redial_attempts: Number(
        body.voicemailMaxRedialAttempts ||
          body.voicemail_settings?.maxRedialAttempts ||
          body.voicemailSettings?.maxRedialAttempts ||
          1,
      ),
      voicemail_settings:
        body.voicemailSettings || body.voicemail_settings || {},
      call_screening_enabled: body.callScreeningEnabled !== false,
      call_screening_message:
        body.callScreeningMessage || body.call_screening_message || "",
      call_screening_settings:
        body.callScreeningSettings || body.call_screening_settings || {},
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
    if (defaultKnowledgeBase?.id) {
      insertPayload.knowledge_base_id = defaultKnowledgeBase.id;
    }

    const { data: agent, error } = await db
      .from("voice_agents")
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create voice agent." } });
    }

    if (defaultKnowledgeBase?.id) {
      await assignVoiceAgentKnowledgeBase(db, {
        organizationId: req.orgId,
        agentId: agent.id,
        knowledgeBaseId: defaultKnowledgeBase.id,
      });
      agent.knowledge_base_id = defaultKnowledgeBase.id;
    }

    res.status(201).json(serializeAgent(agent, []));
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
