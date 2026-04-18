"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeAgent } = require("../../lib/serializers");
const { generateFaqsFromWebsite } = require("../../lib/openai");
const { upsertVapiAssistant, deleteVapiAssistant } = require("../../lib/vapi");

const router = express.Router();

// Helper: get active agent with FAQs
async function getActiveAgent(db, org) {
  const agentId = org.active_voice_agent_id;
  if (!agentId) return null;

  const { data: agent } = await db
    .from("voice_agents")
    .select("*")
    .eq("id", agentId)
    .single();

  if (!agent) return null;

  const { data: faqs } = await db
    .from("faqs")
    .select("*")
    .eq("voice_agent_id", agentId)
    .order("created_at", { ascending: true });

  return serializeAgent(agent, faqs || []);
}

// ── PATCH /api/agent ─────────────────────────────────────────
router.patch(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const org = req.organization;
    const agentId = org.active_voice_agent_id;

    if (!agentId) {
      return res
        .status(404)
        .json({ error: { message: "No active agent found." } });
    }

    const allowed = [
      "name",
      "direction",
      "voice",
      "language",
      "greeting",
      "tone",
      "business_hours",
      "escalation_phone",
      "voicemail_fallback",
      "data_capture_fields",
      "rules",
    ];

    const updates = {};
    const body = req.body;

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

    updates.updated_at = new Date().toISOString();

    const { data: updatedAgent, error } = await db
      .from("voice_agents")
      .update(updates)
      .eq("id", agentId)
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to update agent." } });
    }

    // Sync to Vapi
    if (process.env.VAPI_API_KEY) {
      const { data: faqs } = await db
        .from("faqs")
        .select("*")
        .eq("voice_agent_id", agentId);
      try {
        await upsertVapiAssistant(updatedAgent, faqs || []);
      } catch (e) {
        console.warn("Vapi sync failed:", e.message);
      }
    }

    const agent = await getActiveAgent(db, org);
    res.json(agent);
  }),
);

// ── POST /api/agent/restart ──────────────────────────────────
router.post(
  "/restart",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agentId = req.organization.active_voice_agent_id;

    if (agentId && process.env.VAPI_API_KEY) {
      const { data: agent } = await db
        .from("voice_agents")
        .select("*")
        .eq("id", agentId)
        .single();
      const { data: faqs } = await db
        .from("faqs")
        .select("*")
        .eq("voice_agent_id", agentId);

      if (agent) {
        try {
          const vapiAgent = await upsertVapiAssistant(agent, faqs || []);
          if (vapiAgent?.id && vapiAgent.id !== agent.vapi_assistant_id) {
            await db
              .from("voice_agents")
              .update({ vapi_assistant_id: vapiAgent.id })
              .eq("id", agentId);
          }
        } catch (e) {
          console.warn("Vapi restart failed:", e.message);
        }
      }
    }

    res.json({
      success: true,
      message: "Agent configuration reloaded and synced successfully.",
      restartedAt: new Date().toISOString(),
    });
  }),
);

// ── POST /api/agent/faqs ─────────────────────────────────────
router.post(
  "/faqs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res
        .status(400)
        .json({ error: { message: "Question and answer are required." } });
    }

    const db = getSupabase();
    const agentId = req.organization.active_voice_agent_id;

    const { data: faq, error } = await db
      .from("faqs")
      .insert({
        organization_id: req.orgId,
        voice_agent_id: agentId || null,
        question,
        answer,
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create FAQ." } });
    }

    res
      .status(201)
      .json({ id: faq.id, question: faq.question, answer: faq.answer });
  }),
);

// ── PATCH /api/agent/faqs/:id ────────────────────────────────
router.patch(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { question, answer } = req.body;

    const db = getSupabase();
    const updates = {};
    if (question !== undefined) updates.question = question;
    if (answer !== undefined) updates.answer = answer;
    updates.updated_at = new Date().toISOString();

    const { data: faq, error } = await db
      .from("faqs")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !faq) {
      return res.status(404).json({ error: { message: "FAQ not found." } });
    }

    res.json({ id: faq.id, question: faq.question, answer: faq.answer });
  }),
);

// ── DELETE /api/agent/faqs/:id ───────────────────────────────
router.delete(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    await db
      .from("faqs")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    res.json({ success: true });
  }),
);

// ── POST /api/agent/faqs/sync ────────────────────────────────
router.post(
  "/faqs/sync",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { website } = req.body;
    const db = getSupabase();

    const targetWebsite = website || req.organization.website;
    if (!targetWebsite) {
      return res
        .status(400)
        .json({ error: { message: "No website URL provided or configured." } });
    }

    const faqs = await generateFaqsFromWebsite(targetWebsite);
    const agentId = req.organization.active_voice_agent_id;

    // Delete old synced FAQs and insert new ones
    if (agentId) {
      await db
        .from("faqs")
        .delete()
        .eq("voice_agent_id", agentId)
        .eq("organization_id", req.orgId);
    }

    if (faqs.length > 0) {
      const rows = faqs.map((f) => ({
        organization_id: req.orgId,
        voice_agent_id: agentId || null,
        question: f.question,
        answer: f.answer,
      }));
      await db.from("faqs").insert(rows);
    }

    // Re-fetch
    const { data: updatedFaqs } = await db
      .from("faqs")
      .select("*")
      .eq("organization_id", req.orgId);

    res.json({
      website: targetWebsite,
      faqs: (updatedFaqs || []).map((f) => ({
        id: f.id,
        question: f.question,
        answer: f.answer,
      })),
    });
  }),
);

// ============================================================
// VOICE AGENTS (multi-agent)
// ============================================================

// ── POST /api/voice-agents ───────────────────────────────────
router.post(
  "/voice-agents",
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
        voice: body.voice || "Zephyr",
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
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create voice agent." } });
    }

    if (process.env.VAPI_API_KEY) {
      try {
        const vapiAgent = await upsertVapiAssistant(agent, []);
        if (vapiAgent?.id) {
          await db
            .from("voice_agents")
            .update({ vapi_assistant_id: vapiAgent.id })
            .eq("id", agent.id);
        }
      } catch (e) {
        console.warn("Vapi creation failed:", e.message);
      }
    }

    res.status(201).json(serializeAgent(agent, []));
  }),
);

// ── PATCH /api/voice-agents/:id ──────────────────────────────
router.patch(
  "/voice-agents/:id",
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
    if (body.webhookUrl !== undefined) updates.webhook_url = body.webhookUrl;
    if (body.escalationWorkingHoursStart !== undefined)
      updates.escalation_hours_start = body.escalationWorkingHoursStart;
    if (body.escalationWorkingHoursEnd !== undefined)
      updates.escalation_hours_end = body.escalationWorkingHoursEnd;
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

    const { data: faqs } = await db
      .from("faqs")
      .select("*")
      .eq("voice_agent_id", id);

    if (process.env.VAPI_API_KEY) {
      try {
        await upsertVapiAssistant(agent, faqs || []);
      } catch (e) {
        console.warn("Vapi update failed:", e.message);
      }
    }

    res.json(serializeAgent(agent, faqs || []));
  }),
);

// ── POST /api/voice-agents/:id/activate ──────────────────────
router.post(
  "/voice-agents/:id/activate",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    // Verify agent belongs to org
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

    // Deactivate all, activate selected
    await db
      .from("voice_agents")
      .update({ is_active: false })
      .eq("organization_id", req.orgId);
    await db.from("voice_agents").update({ is_active: true }).eq("id", id);
    await db
      .from("organizations")
      .update({ active_voice_agent_id: id })
      .eq("id", req.orgId);

    const { data: updatedAgent } = await db
      .from("voice_agents")
      .select("*")
      .eq("id", id)
      .single();
    const { data: faqs } = await db
      .from("faqs")
      .select("*")
      .eq("voice_agent_id", id);

    res.json(serializeAgent(updatedAgent, faqs || []));
  }),
);

// ── DELETE /api/voice-agents/:id ─────────────────────────────
router.delete(
  "/voice-agents/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: agent } = await db
      .from("voice_agents")
      .select("vapi_assistant_id")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!agent) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    // Delete from Vapi
    if (agent.vapi_assistant_id) {
      await deleteVapiAssistant(agent.vapi_assistant_id);
    }

    await db.from("faqs").delete().eq("voice_agent_id", id);
    await db
      .from("voice_agents")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    // If this was the active agent, clear it
    if (req.organization.active_voice_agent_id === id) {
      const { data: remaining } = await db
        .from("voice_agents")
        .select("id")
        .eq("organization_id", req.orgId)
        .limit(1)
        .single();
      await db
        .from("organizations")
        .update({ active_voice_agent_id: remaining?.id || null })
        .eq("id", req.orgId);
    }

    res.json({ success: true });
  }),
);

module.exports = router;
