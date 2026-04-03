"use strict";

/**
 * POST /api/chatbot-public/chat
 *
 * Public (no auth) endpoint used by embedded widget iframes.
 * Every client widget calls this single endpoint — centralized AI backend.
 * Rate-limited per chatbot ID to prevent abuse.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");

const router = express.Router();

/* Simple in-memory rate limiter: max 60 req/min per chatbotId */
const rateLimitMap = new Map();
function isRateLimited(chatbotId) {
  const now = Date.now();
  const window = 60 * 1000;
  const max = 60;
  const key = chatbotId;
  const entry = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - entry.start > window) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count++;
  rateLimitMap.set(key, entry);
  return false;
}

router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    const { message, chatbotId, history } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: { message: "message is required." } });
    }
    if (!chatbotId) {
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    }
    if (isRateLimited(chatbotId)) {
      return res
        .status(429)
        .json({
          response:
            "I'm receiving a lot of messages right now. Please try again in a moment.",
        });
    }

    const db = getSupabase();

    const { data: chatbot, error } = await db
      .from("chatbots")
      .select(
        "id, header_title, welcome_message, custom_prompt, faqs, accent_color",
      )
      .eq("id", chatbotId)
      .single();

    if (error || !chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    /* Build system prompt from chatbot config + FAQs */
    const faqs = Array.isArray(chatbot.faqs) ? chatbot.faqs : [];
    const faqBlock = faqs.length
      ? "KNOWLEDGE BASE:\n" +
        faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
      : "";

    const systemPrompt = chatbot.custom_prompt
      ? chatbot.custom_prompt
      : `You are a helpful AI assistant for ${chatbot.header_title || "this business"}.
Be concise, friendly, and accurate. Keep replies to 2-4 sentences for chat.
Never make up information — if you don't know, say so and offer to connect them with a human.

${faqBlock}`;

    /* Pass conversation history for context */
    const chatHistory = Array.isArray(history) ? history.slice(-16) : [];

    let response;
    try {
      response = await generateChatResponse(
        message.trim(),
        chatHistory,
        systemPrompt,
      );
    } catch (e) {
      console.error("Chat generation error:", e.message);
      response =
        "I'm sorry, I'm having a moment of difficulty. Please try again shortly.";
    }

    res.json({ response });
  }),
);

module.exports = router;
