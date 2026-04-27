"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");
const { serializeMessage } = require("../../lib/serializers");
const {
  loadChatbotContext,
  loadVoiceContext,
} = require("../../lib/context-builder");

const router = express.Router();

const UNANSWERED_PHRASES = [
  "i don't know",
  "i'm not sure",
  "i cannot",
  "i can't answer",
  "don't have that information",
  "not available",
  "contact support",
  "contact us directly",
  "unfortunately",
  "i'm unable",
];
function isUnanswered(response) {
  const lower = String(response || "").toLowerCase();
  return UNANSWERED_PHRASES.some((phrase) => lower.includes(phrase));
}

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

    let historyQuery = db
      .from("chat_messages")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .limit(40);

    if (chatbotId) historyQuery = historyQuery.eq("chatbot_id", chatbotId);
    else historyQuery = historyQuery.is("chatbot_id", null);

    const { data: history } = await historyQuery;

    let systemPrompt =
      "You are a helpful AI receptionist assistant. Be concise, professional, and helpful.";
    let unresolvedChatbotId = chatbotId || null;

    if (chatbotId) {
      const context = await loadChatbotContext(db, chatbotId, message.trim());
      if (context?.chatbot) {
        systemPrompt = context.systemPrompt;
        unresolvedChatbotId = context.chatbot.id;
      }
    } else {
      const activeAgentId = req.organization.active_voice_agent_id;
      if (activeAgentId) {
        const { data: agent } = await db
          .from("voice_agents")
          .select("*")
          .eq("id", activeAgentId)
          .single();
        if (agent) {
          const voiceContext = await loadVoiceContext(
            db,
            orgId,
            agent,
            message.trim(),
            {},
          );
          if (voiceContext?.systemPrompt)
            systemPrompt = voiceContext.systemPrompt;
        }
      }
    }

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

    const aiText = await generateChatResponse(
      message.trim(),
      history || [],
      systemPrompt,
    );

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

    if (unresolvedChatbotId && isUnanswered(aiText)) {
      await db
        .from("unanswered_questions")
        .insert({
          organization_id: orgId,
          chatbot_id: unresolvedChatbotId,
          question: message.trim(),
          bot_response: aiText,
        })
        .catch(() => {});
    }

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
