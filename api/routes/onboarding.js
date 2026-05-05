"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateFaqsFromWebsite } = require("../../lib/openai");
const { serializeAgent } = require("../../lib/serializers");

const router = express.Router();

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

    // Update org profile
    await db
      .from("organizations")
      .update({
        name: profile.name || "My Business",
        industry: profile.industry || "",
        website: profile.website || "",
        location: profile.location || "",
        timezone: profile.timezone || "America/New_York",
        onboarded: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId);

    // Determine greeting — use provided or build from agent name + business name
    const agentName = agentConfig.name || "Maya";
    const businessName = profile.name || "our business";
    const greeting =
      agentConfig.greeting && agentConfig.greeting.trim()
        ? agentConfig.greeting
        : `Hello, thank you for calling ${businessName}! This is ${agentName}. How can I help you today?`;

    // Create voice agent using Twilio/OpenAI realtime pipeline
    const { data: agentRow, error: agentErr } = await db
      .from("voice_agents")
      .insert({
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
      })
      .select()
      .single();

    if (agentErr || !agentRow) {
      console.error("Voice agent creation error:", agentErr);
      return res.status(500).json({
        error: {
          message: "Failed to create AI voice agent. Please try again.",
        },
      });
    }

    // Insert FAQs
    const faqs = agentConfig.faqs || [];
    let insertedFaqs = [];
    if (faqs.length > 0) {
      const { data: faqData } = await db
        .from("faqs")
        .insert(
          faqs.map((f) => ({
            organization_id: orgId,
            voice_agent_id: agentRow.id,
            question: f.question,
            answer: f.answer,
          })),
        )
        .select();
      insertedFaqs = faqData || [];
    }

    // Set as active agent
    await db
      .from("organizations")
      .update({ active_voice_agent_id: agentRow.id })
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
        })
        .select()
        .single();

      if (chatbotRow) {
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
    res.json(updatedOrg);
  }),
);

module.exports = router;
