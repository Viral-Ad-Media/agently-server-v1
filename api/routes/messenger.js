"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");
const { serializeMessage } = require("../../lib/serializers");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

// ── POST /api/messenger/messages ─────────────────────────────
router.post(
  "/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { message, chatbotId } = req.body;

    if (!message || !message.trim()) {
      return res
        .status(400)
        .json({ error: { message: "Message is required." } });
    }

    const db = getSupabase();
    const orgId = req.orgId;

    // Fetch chat history
    let historyQuery = db
      .from("chat_messages")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .limit(40);

    if (chatbotId) {
      historyQuery = historyQuery.eq("chatbot_id", chatbotId);
    } else {
      historyQuery = historyQuery.is("chatbot_id", null);
    }

    const { data: history } = await historyQuery;

    // Build system prompt
    let systemPrompt =
      "You are a helpful AI receptionist assistant. Be concise, professional, and helpful.";

    if (chatbotId) {
      const { data: chatbot } = await db
        .from("chatbots")
        .select("*")
        .eq("id", chatbotId)
        .eq("organization_id", orgId)
        .single();

      if (chatbot) {
        const faqText = (chatbot.faqs || [])
          .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
          .join("\n\n");
        systemPrompt =
          chatbot.custom_prompt ||
          `You are ${chatbot.header_title || "an AI assistant"}. Be helpful and concise.\n\nKnowledge Base:\n${faqText}`;
      }
    } else {
      // Use active agent's FAQs
      const agentId = req.organization.active_voice_agent_id;
      if (agentId) {
        const { data: faqs } = await db
          .from("faqs")
          .select("*")
          .eq("voice_agent_id", agentId);
        const { data: agent } = await db
          .from("voice_agents")
          .select("*")
          .eq("id", agentId)
          .single();
        if (agent && faqs) {
          const faqText = faqs
            .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
            .join("\n\n");
          systemPrompt = `You are ${agent.name}, an AI receptionist with a ${agent.tone} tone.\n\nKnowledge Base:\n${faqText}\n\nBe concise and helpful.`;
        }
      }
    }

    // Save user message
    const { data: userMsg } = await db
      .from("chat_messages")
      .insert({
        organization_id: orgId,
        chatbot_id: chatbotId || null,
        role: "user",
        text: message.trim(),
      })
      .select()
      .single();

    // Generate AI response
    const aiText = await generateChatResponse(
      message.trim(),
      history || [],
      systemPrompt,
    );

    // Save AI response
    const { data: aiMsg } = await db
      .from("chat_messages")
      .insert({
        organization_id: orgId,
        chatbot_id: chatbotId || null,
        role: "model",
        text: aiText,
      })
      .select()
      .single();

    // Return updated conversation
    const { data: updatedHistory } = await (chatbotId
      ? db
          .from("chat_messages")
          .select("*")
          .eq("organization_id", orgId)
          .eq("chatbot_id", chatbotId)
          .order("created_at", { ascending: true })
      : db
          .from("chat_messages")
          .select("*")
          .eq("organization_id", orgId)
          .is("chatbot_id", null)
          .order("created_at", { ascending: true }));

    res.json({
      userMessage: serializeMessage(userMsg),
      assistantMessage: serializeMessage(aiMsg),
      conversation: (updatedHistory || []).map(serializeMessage),
    });
  }),
);

// ── DELETE /api/messenger/messages ───────────────────────────
router.delete(
  "/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { chatbotId } = req.body || {};
    const db = getSupabase();
    const orgId = req.orgId;

    if (chatbotId) {
      await db
        .from("chat_messages")
        .delete()
        .eq("organization_id", orgId)
        .eq("chatbot_id", chatbotId);
    } else {
      await db
        .from("chat_messages")
        .delete()
        .eq("organization_id", orgId)
        .is("chatbot_id", null);
    }

    res.json({ success: true, conversation: [] });
  }),
);

// ── POST /api/messenger/voice-preview ─────────────────────────
router.post(
  "/voice-preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { voice, text } = req.body;
    if (!voice || !text) {
      return res
        .status(400)
        .json({ error: { message: "voice and text are required" } });
    }

    // Map frontend voice IDs to OpenAI TTS voices
    const voiceMap = {
      alloy: "alloy",
      echo: "echo",
      fable: "fable",
      onyx: "onyx",
      nova: "nova",
      shimmer: "shimmer",
    };
    const openaiVoice = voiceMap[voice] || "alloy";

    const { getOpenAI } = require("../../lib/openai");
    const openai = getOpenAI();
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: openaiVoice,
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);
  }),
);

module.exports = router;
