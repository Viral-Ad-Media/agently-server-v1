"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeAgent } = require("../../lib/serializers");
const { generateFaqsFromWebsite } = require("../../lib/openai");

const router = express.Router();

async function loadActiveAgent(db, org) {
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

router.patch(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agentId = req.organization.active_voice_agent_id;

    if (!agentId) {
      return res.status(404).json({ error: { message: "No active agent found." } });
    }

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.direction !== undefined) updates.direction = body.direction;
    if (body.voice !== undefined) updates.voice = body.voice;
    if (body.language !== undefined) updates.language = body.language;
    if (body.greeting !== undefined) updates.greeting = body.greeting;
    if (body.tone !== undefined) updates.tone = body.tone;
    if (body.businessHours !== undefined) updates.business_hours = body.businessHours;
    if (body.escalationPhone !== undefined) updates.escalation_phone = body.escalationPhone;
    if (body.voicemailFallback !== undefined) updates.voicemail_fallback = body.voicemailFallback;
    if (body.dataCaptureFields !== undefined) updates.data_capture_fields = body.dataCaptureFields;
    if (body.rules !== undefined) updates.rules = body.rules;
    if (body.webhookUrl !== undefined) updates.webhook_url = body.webhookUrl;
    if (body.escalationWorkingHoursStart !== undefined) updates.escalation_hours_start = body.escalationWorkingHoursStart;
    if (body.escalationWorkingHoursEnd !== undefined) updates.escalation_hours_end = body.escalationWorkingHoursEnd;
    updates.updated_at = new Date().toISOString();

    const { error } = await db
      .from("voice_agents")
      .update(updates)
      .eq("id", agentId)
      .eq("organization_id", req.orgId);

    if (error) {
      return res.status(500).json({ error: { message: error.message || "Failed to update agent." } });
    }

    const agent = await loadActiveAgent(db, req.organization);
    res.json(agent);
  }),
);

router.post(
  "/restart",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      message: "Agent configuration reloaded successfully.",
      restartedAt: new Date().toISOString(),
    });
  }),
);

router.post(
  "/faqs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { question, answer } = req.body || {};
    if (!question || !answer) {
      return res.status(400).json({ error: { message: "Question and answer are required." } });
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
      return res.status(500).json({ error: { message: error.message || "Failed to create FAQ." } });
    }

    res.status(201).json({ id: faq.id, question: faq.question, answer: faq.answer });
  }),
);

router.patch(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { question, answer } = req.body || {};
    const db = getSupabase();

    const updates = { updated_at: new Date().toISOString() };
    if (question !== undefined) updates.question = question;
    if (answer !== undefined) updates.answer = answer;

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

router.delete(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    await db.from("faqs").delete().eq("id", id).eq("organization_id", req.orgId);
    res.json({ success: true });
  }),
);

router.post(
  "/faqs/sync",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { website } = req.body || {};
    const db = getSupabase();
    const targetWebsite = website || req.organization.website;

    if (!targetWebsite) {
      return res.status(400).json({ error: { message: "No website URL provided or configured." } });
    }

    const faqs = await generateFaqsFromWebsite(targetWebsite);
    const agentId = req.organization.active_voice_agent_id;

    if (agentId) {
      await db
        .from("faqs")
        .delete()
        .eq("voice_agent_id", agentId)
        .eq("organization_id", req.orgId);
    }

    if (faqs.length > 0) {
      await db.from("faqs").insert(
        faqs.map((faq) => ({
          organization_id: req.orgId,
          voice_agent_id: agentId || null,
          question: faq.question,
          answer: faq.answer,
        })),
      );
    }

    const { data: updatedFaqs } = await db
      .from("faqs")
      .select("*")
      .eq("organization_id", req.orgId)
      .eq("voice_agent_id", agentId || null)
      .order("created_at", { ascending: true });

    res.json({
      website: targetWebsite,
      faqs: (updatedFaqs || []).map((faq) => ({
        id: faq.id,
        question: faq.question,
        answer: faq.answer,
      })),
    });
  }),
);

module.exports = router;
