'use strict';

const express = require('express');
const { getSupabase } = require('../../lib/supabase');
const { asyncHandler } = require('../../middleware/error');
const { generateChatResponse } = require('../../lib/openai');

const router = express.Router();

// Simple per-chatbot rate limiter
const rlMap = new Map();
function isRateLimited(id) {
  const now = Date.now();
  const e = rlMap.get(id) || { n: 0, t: now };
  if (now - e.t > 60000) { rlMap.set(id, { n: 1, t: now }); return false; }
  if (e.n >= 60) return true;
  e.n++; rlMap.set(id, e); return false;
}

// ── POST /api/chatbot-public/chat ─────────────────────────────
router.post('/chat', asyncHandler(async (req, res) => {
  const { message, chatbotId, history } = req.body;

  if (!message?.trim() || !chatbotId) {
    return res.status(400).json({ error: { message: 'message and chatbotId are required.' } });
  }
  if (isRateLimited(chatbotId)) {
    return res.status(429).json({ response: "I'm receiving a lot of messages. Please try again in a moment." });
  }

  const db = getSupabase();
  const { data: chatbot } = await db
    .from('chatbots')
    .select('id, header_title, custom_prompt, faqs, organization_id')
    .eq('id', chatbotId)
    .single();

  if (!chatbot) return res.status(404).json({ error: { message: 'Chatbot not found.' } });

  const faqs = Array.isArray(chatbot.faqs) ? chatbot.faqs : [];
  const faqBlock = faqs.length
    ? 'FAQ KNOWLEDGE BASE:\n' + faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : '';

  const systemPrompt = chatbot.custom_prompt ||
    `You are a helpful AI assistant for ${chatbot.header_title || 'this business'}.
Be concise, friendly, and accurate. Keep replies to 2-4 sentences for chat.
Never make up information you are not sure about.

${faqBlock}`;

  const chatHistory = Array.isArray(history) ? history.slice(-16) : [];

  // Pass orgId + chatbotId so generateChatResponse can inject scraped knowledge context
  const response = await generateChatResponse(
    message.trim(),
    chatHistory,
    systemPrompt,
    chatbot.organization_id,
    chatbotId
  );

  res.json({ response });
}));

module.exports = router;
