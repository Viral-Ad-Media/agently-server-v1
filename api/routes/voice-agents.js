"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeAgent } = require("../../lib/serializers");
const { updateNumberWebhooks } = require("../../lib/twilio");
const { scrapeAndStore } = require("../../lib/scraper.service");

const router = express.Router();

// ── POST /api/voice-agents ───────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};

    const { data: agent, error } = await db
      .from("voice_agents")
      .insert({
        organization_id: req.orgId,
        name: body.name || "New AI Agent",
        direction: body.direction || "inbound",
        voice: body.voice || "Rachel",
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
        is_active: false,
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create voice agent." } });
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
    if (body.language !== undefined) updates.language = body.language;
    if (body.greeting !== undefined) updates.greeting = body.greeting;
    if (body.tone !== undefined) updates.tone = body.tone;
    if (body.businessHours !== undefined)
      updates.business_hours = body.businessHours;
    if (body.escalationPhone !== undefined)
      updates.escalation_phone = body.escalationPhone;
    if (body.voicemailFallback !== undefined)
      updates.voicemail_fallback = body.voicemailFallback;
    if (body.dataCaptureFields !== undefined)
      updates.data_capture_fields = body.dataCaptureFields;
    if (body.rules !== undefined) updates.rules = body.rules;
    if (body.twilioPhoneNumber !== undefined)
      updates.twilio_phone_number = body.twilioPhoneNumber;
    if (body.twilioPhoneSid !== undefined)
      updates.twilio_phone_sid = body.twilioPhoneSid;
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

    const { data: faqs } = await db
      .from("faqs")
      .select("*")
      .eq("voice_agent_id", id);
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

    await db
      .from("voice_agents")
      .update({ is_active: false })
      .eq("organization_id", req.orgId);
    await db.from("voice_agents").update({ is_active: true }).eq("id", id);
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
    const { data: faqs } = await db
      .from("faqs")
      .select("*")
      .eq("voice_agent_id", id);
    res.json(serializeAgent(updated, faqs || []));
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


// ── POST /api/voice-agents/:id/import-knowledge ─────────────
router.post(
  "/:id/import-knowledge",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { website } = req.body || {};

    if (!website?.trim()) {
      return res
        .status(400)
        .json({ error: { message: "website URL is required." } });
    }

    const db = getSupabase();
    const { data: agent } = await db
      .from("voice_agents")
      .select("id")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!agent) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    const result = await scrapeAndStore({
      url: website,
      organizationId: req.orgId,
      voiceAgentId: id,
    });

    res.json({
      success: true,
      chunksStored: result.chunksStored,
      strategy: result.strategy,
      message: `Imported ${result.chunksStored} knowledge chunks for this voice agent.`,
    });
  }),
);

module.exports = router;
