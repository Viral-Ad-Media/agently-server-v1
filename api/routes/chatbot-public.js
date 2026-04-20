"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");

const router = express.Router();

const rateLimitMap = new Map();
function isRateLimited(chatbotId) {
  const now = Date.now();
  const window = 60 * 1000;
  const max = 60;
  const entry = rateLimitMap.get(chatbotId) || { count: 0, start: now };
  if (now - entry.start > window) { rateLimitMap.set(chatbotId, { count: 1, start: now }); return false; }
  if (entry.count >= max) return true;
  entry.count++;
  rateLimitMap.set(chatbotId, entry);
  return false;
}

const UNANSWERED_PHRASES = [
  "i don't know", "i'm not sure", "i cannot", "i can't answer",
  "don't have that information", "not available", "connect them with a human",
  "reach out to", "contact us directly", "unfortunately", "i'm unable",
];
function isUnanswered(response) {
  const lower = response.toLowerCase();
  return UNANSWERED_PHRASES.some((p) => lower.includes(p));
}

/* FIX: clean raw AI response — strip literal \n sequences and normalize whitespace */
function cleanResponse(text) {
  if (!text) return text;
  // Replace literal backslash-n sequences (not real newlines) with actual newlines
  let cleaned = text.replace(/\\n/g, '\n');
  // Trim excessive blank lines (more than 2 in a row → 2)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  // Trim leading/trailing whitespace
  cleaned = cleaned.trim();
  return cleaned;
}

const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ar: 'Arabic', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', hi: 'Hindi', nl: 'Dutch',
};

router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    const { message, chatbotId, history, language } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: { message: "message is required." } });
    }
    if (!chatbotId) {
      return res.status(400).json({ error: { message: "chatbotId is required." } });
    }
    if (isRateLimited(chatbotId)) {
      return res.status(429).json({ response: "I'm receiving a lot of messages right now. Please try again in a moment." });
    }

    const db = getSupabase();

    const { data: chatbot, error } = await db
      .from("chatbots")
      .select("id, organization_id, header_title, welcome_message, custom_prompt, faqs, accent_color")
      .eq("id", chatbotId)
      .single();

    if (error || !chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    const faqs = Array.isArray(chatbot.faqs) ? chatbot.faqs : [];
    const faqBlock = faqs.length
      ? "KNOWLEDGE BASE:\n" + faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
      : "";

    // FIX: language-aware prompt instruction
    const langName = LANG_NAMES[language] || null;
    const langInstruction = langName && langName !== 'English'
      ? `\n\nIMPORTANT: The user's selected language is ${langName}. Please respond in ${langName}.`
      : '';

    // FIX: explicit formatting instruction so AI produces clean paragraphs, not raw \n
    const formatInstruction = `\n\nFORMATTING: Use plain paragraphs. Use markdown bullet points (- item) for lists. Do NOT use escaped newlines (\\n). Write naturally flowing text.`;

    const systemPrompt = chatbot.custom_prompt
      ? chatbot.custom_prompt + langInstruction + formatInstruction
      : `You are a helpful AI assistant for ${chatbot.header_title || "this business"}.
Be concise, friendly, and accurate. Keep replies to 2-4 sentences for chat.
Never make up information — if you don't know, say so and offer to connect them with a human.

${faqBlock}${langInstruction}${formatInstruction}`;

    const chatHistory = Array.isArray(history) ? history.slice(-16) : [];

    let response;
    try {
      response = await generateChatResponse(message.trim(), chatHistory, systemPrompt);
    } catch (e) {
      console.error("Chat generation error:", e.message);
      response = "I'm sorry, I'm having a moment of difficulty. Please try again shortly.";
    }

    // FIX: clean up response before sending
    response = cleanResponse(response);

    if (isUnanswered(response) && chatbot.organization_id) {
      try {
        await db.from("unanswered_questions").insert({
          organization_id: chatbot.organization_id,
          chatbot_id: chatbotId,
          question: message.trim(),
          bot_response: response,
        });
      } catch (trackErr) {
        console.warn("[chatbot-public] unanswered_questions table missing:", trackErr.message);
      }
    }

    res.json({ response });
  }),
);

router.get(
  "/unanswered",
  asyncHandler(async (req, res) => {
    const { chatbotId, organizationId } = req.query;
    const db = getSupabase();

    let query = db
      .from("unanswered_questions")
      .select("id, question, bot_response, created_at, is_resolved")
      .eq("is_resolved", false)
      .order("created_at", { ascending: false })
      .limit(50);

    if (chatbotId) query = query.eq("chatbot_id", chatbotId);
    if (organizationId) query = query.eq("organization_id", organizationId);

    const { data } = await query;
    res.json({ questions: data || [] });
  }),
);

router.patch(
  "/unanswered/:id/resolve",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { addToFaq, question, answer, chatbotId } = req.body;
    const db = getSupabase();

    await db.from("unanswered_questions").update({ is_resolved: true }).eq("id", id);

    if (addToFaq && question && answer && chatbotId) {
      const { data: chatbot } = await db.from("chatbots").select("faqs").eq("id", chatbotId).single();
      const existing = Array.isArray(chatbot?.faqs) ? chatbot.faqs : [];
      await db.from("chatbots").update({
        faqs: [...existing, { id: `faq-${Date.now()}`, question, answer }],
      }).eq("id", chatbotId);
    }

    res.json({ success: true });
  }),
);

module.exports = router;
