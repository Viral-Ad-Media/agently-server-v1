"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateFaqsFromWebsite } = require("../../lib/openai");
const { serializeAgent } = require("../../lib/serializers");
const { upsertVapiAssistant } = require("../../lib/vapi");

const router = express.Router();

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

    // Update organization profile
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

    // Create the first voice agent
    const { data: agentRow, error: agentErr } = await db
      .from("voice_agents")
      .insert({
        organization_id: orgId,
        name: agentConfig.name || "My AI Agent",
        direction: agentConfig.direction || "inbound",
        voice: agentConfig.voice || "Zephyr",
        language: agentConfig.language || "English",
        greeting:
          agentConfig.greeting ||
          "Hello, thank you for calling. How can I help you today?",
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
      console.error("Agent creation error:", agentErr);
      return res
        .status(500)
        .json({ error: { message: "Failed to create AI agent." } });
    }

    // Insert FAQs
    const faqs = agentConfig.faqs || [];
    let insertedFaqs = [];

    if (faqs.length > 0) {
      const faqRows = faqs.map((f) => ({
        organization_id: orgId,
        voice_agent_id: agentRow.id,
        question: f.question,
        answer: f.answer,
      }));

      const { data: faqData } = await db.from("faqs").insert(faqRows).select();
      insertedFaqs = faqData || [];
    }

    // Set as active agent
    await db
      .from("organizations")
      .update({ active_voice_agent_id: agentRow.id })
      .eq("id", orgId);

    // Create Vapi assistant (non-blocking)
    if (process.env.VAPI_API_KEY) {
      try {
        const vapiAgent = await upsertVapiAssistant(agentRow, insertedFaqs);
        if (vapiAgent?.id) {
          await db
            .from("voice_agents")
            .update({ vapi_assistant_id: vapiAgent.id })
            .eq("id", agentRow.id);
        }
      } catch (vapiErr) {
        console.warn("Vapi assistant creation failed:", vapiErr.message);
      }
    }

    // Create a default chatbot
    const { data: chatbotRow } = await db
      .from("chatbots")
      .insert({
        organization_id: orgId,
        voice_agent_id: agentRow.id,
        name: `${profile.name || "My"} Chat Agent`,
        header_title: profile.name || "Chat with us",
        welcome_message: `Hello! Welcome to ${profile.name || "our business"}. How can I help you today?`,
        faqs: faqs.map((f) => ({ question: f.question, answer: f.answer })),
        is_active: true,
      })
      .select()
      .single();

    if (chatbotRow) {
      const embedScript = buildEmbedScript(chatbotRow);
      await db
        .from("chatbots")
        .update({ embed_script: embedScript })
        .eq("id", chatbotRow.id);

      await db
        .from("organizations")
        .update({ active_chatbot_id: chatbotRow.id })
        .eq("id", orgId);
    }

    // Fetch updated org
    const { data: updatedOrg } = await db
      .from("organizations")
      .select("*")
      .eq("id", orgId)
      .single();

    res.json(updatedOrg);
  }),
);

function buildEmbedScript(row) {
  const apiUrl = process.env.API_URL || "";
  return `<iframe 
    id="agently-chatbot-${row.id}"
    src="${apiUrl}/chatbot-widget/${row.id}" 
    style="position:fixed;bottom:20px;right:20px;width:420px;height:700px;max-width:90vw;max-height:90vh;border:none;background:transparent;z-index:1000000;overflow:hidden;"
    scrolling="no"
    frameborder="0"
    allow="microphone"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"
></iframe>`;
}

module.exports = router;
