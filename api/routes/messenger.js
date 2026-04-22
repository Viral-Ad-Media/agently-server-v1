'use strict';

const express = require('express');
const { getSupabase } = require('../../lib/supabase');
const { requireAuth } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/error');
const { generateChatResponse } = require('../../lib/openai');
// getOpenAI lives in openai-client.js, NOT in openai.js
const { getOpenAI } = require('../../lib/openai-client');
const { serializeMessage } = require('../../lib/serializers');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/messenger/messages
// Sends a message and receives an AI reply.
// Body: { message: string, chatbotId?: string }
// ─────────────────────────────────────────────────────────────
router.post('/messages', requireAuth, asyncHandler(async (req, res) => {
  const { message, chatbotId } = req.body || {};

  if (!message || !message.trim()) {
    return res.status(400).json({ error: { message: 'Message is required.' } });
  }

  const db = getSupabase();
  const orgId = req.orgId;
  const trimmedMessage = message.trim();

  // ── Fetch recent chat history ──────────────────────────────
  let historyQuery = db
    .from('chat_messages')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true })
    .limit(40);

  if (chatbotId) {
    historyQuery = historyQuery.eq('chatbot_id', chatbotId);
  } else {
    historyQuery = historyQuery.is('chatbot_id', null);
  }

  const { data: history } = await historyQuery;

  // ── Build system prompt ────────────────────────────────────
  let systemPrompt = 'You are a helpful AI receptionist assistant. Be concise, professional, and helpful.';

  if (chatbotId) {
    // Use the chatbot's own config and FAQs
    const { data: chatbot } = await db
      .from('chatbots')
      .select('*')
      .eq('id', chatbotId)
      .eq('organization_id', orgId)
      .single();

    if (chatbot) {
      const faqText = (chatbot.faqs || [])
        .map(f => `Q: ${f.question}\nA: ${f.answer}`)
        .join('\n\n');

      systemPrompt = chatbot.custom_prompt
        || `You are ${chatbot.header_title || 'an AI assistant'}. Be helpful and concise.\n\nKnowledge Base:\n${faqText}`;
    }
  } else {
    // Fall back to the org's active voice agent FAQs
    const agentId = req.organization.active_voice_agent_id;
    if (agentId) {
      const [{ data: agent }, { data: faqs }] = await Promise.all([
        db.from('voice_agents').select('*').eq('id', agentId).single(),
        db.from('faqs').select('*').eq('voice_agent_id', agentId),
      ]);

      if (agent) {
        const faqText = (faqs || [])
          .map(f => `Q: ${f.question}\nA: ${f.answer}`)
          .join('\n\n');
        systemPrompt = `You are ${agent.name}, an AI receptionist with a ${agent.tone || 'Professional'} tone.\n\nKnowledge Base:\n${faqText}\n\nBe concise and helpful.`;
      }
    }
  }

  // ── Save the user's message ────────────────────────────────
  const { data: userMsg, error: userMsgErr } = await db
    .from('chat_messages')
    .insert({
      organization_id: orgId,
      chatbot_id: chatbotId || null,
      role: 'user',
      text: trimmedMessage,
    })
    .select()
    .single();

  if (userMsgErr || !userMsg) {
    return res.status(500).json({ error: { message: 'Failed to save message.' } });
  }

  // ── Generate AI reply ──────────────────────────────────────
  let aiText = "I'm here to help! Could you please clarify your question?";
  try {
    aiText = await generateChatResponse(trimmedMessage, history || [], systemPrompt);
  } catch (aiErr) {
    console.error('[messenger] AI generation failed:', aiErr.message);
  }

  // ── Save the AI reply ──────────────────────────────────────
  const { data: aiMsg, error: aiMsgErr } = await db
    .from('chat_messages')
    .insert({
      organization_id: orgId,
      chatbot_id: chatbotId || null,
      role: 'model',
      text: aiText,
    })
    .select()
    .single();

  if (aiMsgErr || !aiMsg) {
    return res.status(500).json({ error: { message: 'Failed to save AI response.' } });
  }

  // ── Return updated conversation ────────────────────────────
  const updatedQuery = db
    .from('chat_messages')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true });

  const { data: updatedHistory } = await (
    chatbotId
      ? updatedQuery.eq('chatbot_id', chatbotId)
      : updatedQuery.is('chatbot_id', null)
  );

  return res.json({
    userMessage: serializeMessage(userMsg),
    assistantMessage: serializeMessage(aiMsg),
    conversation: (updatedHistory || []).map(serializeMessage),
  });
}));

// ─────────────────────────────────────────────────────────────
// DELETE /api/messenger/messages
// Clears conversation history.
// Body: { chatbotId?: string }
// ─────────────────────────────────────────────────────────────
router.delete('/messages', requireAuth, asyncHandler(async (req, res) => {
  const { chatbotId } = req.body || {};
  const db = getSupabase();
  const orgId = req.orgId;

  const deleteQuery = db
    .from('chat_messages')
    .delete()
    .eq('organization_id', orgId);

  if (chatbotId) {
    await deleteQuery.eq('chatbot_id', chatbotId);
  } else {
    await deleteQuery.is('chatbot_id', null);
  }

  return res.json({ success: true, conversation: [] });
}));

// ─────────────────────────────────────────────────────────────
// POST /api/messenger/voice-preview
// Returns an audio/mpeg stream for the given voice and text.
// Body: { voice: string, text: string }
// ─────────────────────────────────────────────────────────────
router.post('/voice-preview', requireAuth, asyncHandler(async (req, res) => {
  const { voice, text } = req.body || {};

  if (!voice || !text) {
    return res.status(400).json({ error: { message: 'voice and text are required.' } });
  }

  // Allowed OpenAI TTS voices
  const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const ttsVoice = VALID_VOICES.includes(voice) ? voice : 'alloy';

  // getOpenAI is from lib/openai-client.js — this is the correct import
  const openai = getOpenAI();
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: ttsVoice,
    input: text.slice(0, 500), // cap to avoid large bills
  });

  const buffer = Buffer.from(await mp3.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
}));

// ─────────────────────────────────────────────────────────────
// POST /api/messenger/transcribe
// Transcribes audio (webm blob) using OpenAI Whisper.
// Body: multipart/form-data with field "audio"
// ─────────────────────────────────────────────────────────────
router.post('/transcribe', requireAuth, asyncHandler(async (req, res) => {
  // Parse multipart form manually using built-in Node streams.
  // We avoid adding multer as a dep — Vercel serverless can handle raw streams.
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  if (!rawBody.length) {
    return res.status(400).json({ error: { message: 'No audio data received.' } });
  }

  const openai = getOpenAI();

  // Build a File-like object for the OpenAI SDK
  const { toFile } = require('openai');
  const audioFile = await toFile(rawBody, 'recording.webm', { type: 'audio/webm' });

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    response_format: 'text',
  });

  return res.json({ text: typeof transcription === 'string' ? transcription : (transcription.text || '') });
}));

module.exports = router;
