"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { getOpenAI } = require("../../lib/openai-client");
const {
  loadChatbotContext,
  buildAssistantPrompt,
  generateGroundedChatResponse,
  cleanAssistantResponse,
  looksUnanswered,
} = require("../../lib/assistant-intelligence");

const router = express.Router();
const LANG_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ar: "Arabic",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  nl: "Dutch",
};
const rateLimitMap = new Map();
function isRateLimited(key) {
  const now = Date.now(),
    windowMs = 60000,
    max = 80;
  const entry = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count += 1;
  rateLimitMap.set(key, entry);
  return false;
}
function normalizePhone(phone) {
  return String(phone || "")
    .replace(/[^+0-9]/g, "")
    .trim();
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}
async function trackUnanswered({
  organizationId,
  chatbotId,
  question,
  botResponse,
}) {
  if (!organizationId || !question) return;
  try {
    await getSupabase()
      .from("unanswered_questions")
      .insert({
        organization_id: organizationId,
        chatbot_id: chatbotId,
        question,
        bot_response: botResponse || "",
      });
  } catch (e) {
    console.warn("[chatbot-public] unanswered insert failed:", e.message);
  }
}
async function saveChatMessage({ organizationId, chatbotId, role, text }) {
  if (!organizationId || !chatbotId || !text) return;
  try {
    await getSupabase()
      .from("chat_messages")
      .insert({
        organization_id: organizationId,
        chatbot_id: chatbotId,
        role,
        text: String(text).slice(0, 8000),
      });
  } catch (e) {
    console.warn("[chatbot-public] chat_messages insert failed:", e.message);
  }
}
async function captureLead({ chatbotId, organizationId, lead, reason = "" }) {
  const db = getSupabase();
  let orgId = organizationId,
    voiceAgentId = lead.voiceAgentId || null;
  if (!orgId || !voiceAgentId) {
    const { data: chatbot } = await db
      .from("chatbots")
      .select("organization_id,voice_agent_id")
      .eq("id", chatbotId)
      .maybeSingle();
    orgId = orgId || chatbot?.organization_id;
    voiceAgentId = voiceAgentId || chatbot?.voice_agent_id || null;
  }
  if (!orgId) throw new Error("organization not found for chatbot");
  const name = String(lead.name || "Unknown").trim() || "Unknown";
  const phone = normalizePhone(lead.phone);
  const email = String(lead.email || "")
    .trim()
    .toLowerCase();
  if (!name || (!phone && !email))
    throw new Error("name and phone or email required");
  if (email && !validEmail(email)) throw new Error("invalid email");
  const row = {
    organization_id: orgId,
    voice_agent_id: voiceAgentId,
    name,
    phone,
    email,
    reason: String(lead.reason || reason || "Website chat lead").slice(0, 1000),
    source: "chatbot",
    status: "new",
    tags: lead.tags || ["chatbot"],
    assignment_context: String(
      lead.assignmentContext || "Captured from embedded chat widget",
    ).slice(0, 1000),
    updated_at: new Date().toISOString(),
  };
  let existing = null;
  if (email)
    existing =
      (
        await db
          .from("leads")
          .select("id,tags")
          .eq("organization_id", orgId)
          .eq("email", email)
          .maybeSingle()
      ).data || null;
  if (!existing && phone)
    existing =
      (
        await db
          .from("leads")
          .select("id,tags")
          .eq("organization_id", orgId)
          .eq("phone", phone)
          .maybeSingle()
      ).data || null;
  if (existing?.id) {
    const tags = Array.from(
      new Set([
        ...(Array.isArray(existing.tags) ? existing.tags : []),
        ...(Array.isArray(row.tags) ? row.tags : []),
      ]),
    );
    const { data, error } = await db
      .from("leads")
      .update({ ...row, tags })
      .eq("id", existing.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db.from("leads").insert(row).select().single();
  if (error) throw error;
  return data;
}

router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    const { message, chatbotId, history, language, lead } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim())
      return res
        .status(400)
        .json({ error: { message: "message is required." } });
    if (!chatbotId)
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    if (isRateLimited(`chat:${chatbotId}`))
      return res.status(429).json({
        response:
          "I'm receiving many messages right now. Please try again in a moment.",
      });
    let result;
    try {
      result = await generateGroundedChatResponse({
        message: message.trim(),
        history: Array.isArray(history) ? history : [],
        chatbotId,
        languageName: LANG_NAMES[language] || "English",
      });
    } catch (e) {
      console.error("[chatbot-public/chat] generation failed:", e.message);
      return res.status(500).json({
        response:
          "I'm sorry, I'm having trouble reaching the assistant right now. Please try again shortly.",
      });
    }
    const response = cleanAssistantResponse(result.response);
    const orgId = result.context?.organization_id;
    await saveChatMessage({
      organizationId: orgId,
      chatbotId,
      role: "user",
      text: message.trim(),
    });
    await saveChatMessage({
      organizationId: orgId,
      chatbotId,
      role: "model",
      text: response,
    });
    if (lead && (lead.name || lead.phone || lead.email)) {
      try {
        await captureLead({
          chatbotId,
          organizationId: orgId,
          lead,
          reason: message.trim(),
        });
      } catch (e) {}
    }
    if (looksUnanswered(response))
      await trackUnanswered({
        organizationId: orgId,
        chatbotId,
        question: message.trim(),
        botResponse: response,
      });
    res.json({ response });
  }),
);

router.post(
  "/capture-lead",
  asyncHandler(async (req, res) => {
    const { chatbotId, name, phone, email, reason, tags } = req.body || {};
    if (!chatbotId)
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    try {
      const lead = await captureLead({
        chatbotId,
        lead: { name, phone, email, reason, tags },
      });
      res.json({ success: true, leadId: lead.id });
    } catch (e) {
      res
        .status(400)
        .json({ error: { message: e.message || "Could not capture lead." } });
    }
  }),
);

router.get(
  "/unanswered",
  asyncHandler(async (req, res) => {
    const { chatbotId, organizationId } = req.query;
    let query = getSupabase()
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
    const { addToFaq, question, answer, chatbotId } = req.body || {};
    const db = getSupabase();
    await db
      .from("unanswered_questions")
      .update({ is_resolved: true })
      .eq("id", id);
    if (addToFaq && question && answer && chatbotId) {
      const { data: chatbot } = await db
        .from("chatbots")
        .select("faqs")
        .eq("id", chatbotId)
        .maybeSingle();
      const existing = Array.isArray(chatbot?.faqs) ? chatbot.faqs : [];
      await db
        .from("chatbots")
        .update({
          faqs: [...existing, { id: `faq-${Date.now()}`, question, answer }],
        })
        .eq("id", chatbotId);
    }
    res.json({ success: true });
  }),
);

router.post(
  "/voice-token",
  asyncHandler(async (req, res) => {
    const { chatbotId, language } = req.body || {};
    if (!chatbotId)
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    if (isRateLimited(`voice:${chatbotId}`))
      return res
        .status(429)
        .json({ error: { message: "Rate limit exceeded." } });
    if (!process.env.OPENAI_API_KEY)
      return res
        .status(500)
        .json({ error: { message: "OPENAI_API_KEY not configured." } });
    const context = await loadChatbotContext(chatbotId);
    const requested = String(
      context.entity.chat_voice || "alloy",
    ).toLowerCase();
    const validVoices = new Set([
      "alloy",
      "ash",
      "ballad",
      "cedar",
      "coral",
      "echo",
      "marin",
      "sage",
      "shimmer",
      "verse",
    ]);
    const voice = validVoices.has(requested) ? requested : "alloy";
    const instructions = buildAssistantPrompt({
      context,
      message: "voice website assistant session",
      mode: "voice",
      direction: "chat",
      languageName: LANG_NAMES[language] || "English",
    });
    const openaiResp = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
            instructions,
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
              output: { format: { type: "audio/pcm", rate: 24000 }, voice },
            },
          },
        }),
      },
    );
    if (!openaiResp.ok) {
      const detail = await openaiResp.text().catch(() => "");
      return res.status(openaiResp.status).json({
        error: { message: "OpenAI rejected the session request.", detail },
      });
    }
    const data = await openaiResp.json();
    res.json({
      clientSecret: data.value || data.client_secret?.value || null,
      expiresAt: data.expires_at || data.client_secret?.expires_at || null,
      model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
      voice,
    });
  }),
);

router.post(
  "/transcribe",
  express.raw({ type: "audio/*", limit: "15mb" }),
  asyncHandler(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || "");
    if (!buffer.length)
      return res.status(400).json({ error: { message: "No audio received." } });
    const openai = getOpenAI();
    const file = new File([buffer], "voice.webm", {
      type: req.headers["content-type"] || "audio/webm",
    });
    const result = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
    });
    res.json({ text: result.text || "" });
  }),
);

router.post(
  "/speak",
  asyncHandler(async (req, res) => {
    const { chatbotId, text } = req.body || {};
    if (!text)
      return res.status(400).json({ error: { message: "text is required." } });
    let voice = "alloy";
    if (chatbotId) {
      try {
        const context = await loadChatbotContext(chatbotId);
        const requested = String(
          context.entity.chat_voice || "alloy",
        ).toLowerCase();
        const valid = new Set([
          "alloy",
          "ash",
          "ballad",
          "cedar",
          "coral",
          "echo",
          "marin",
          "sage",
          "shimmer",
          "verse",
        ]);
        voice = valid.has(requested) ? requested : "alloy";
      } catch (_) {}
    }
    const openai = getOpenAI();
    const audio = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: String(text).slice(0, 1500),
      format: "mp3",
    });
    const buf = Buffer.from(await audio.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  }),
);

module.exports = router;
