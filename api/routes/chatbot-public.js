"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");
// getOpenAI lives in openai-client.js (NOT in lib/openai.js)
const { getOpenAI } = require("../../lib/openai-client");

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Rate limit: 60 requests per minute per chatbot
// ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function isRateLimited(chatbotId) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 60;
  const entry = rateLimitMap.get(chatbotId) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    rateLimitMap.set(chatbotId, { count: 1, start: now });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count++;
  rateLimitMap.set(chatbotId, entry);
  return false;
}

// ─────────────────────────────────────────────────────────────
// Language map — MUST match the widget's language picker list
// ─────────────────────────────────────────────────────────────
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

// Clean up raw AI output (strip literal \n sequences, trim extra blank lines)
function cleanResponse(text) {
  if (!text) return text;
  let cleaned = text.replace(/\\n/g, "\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

// ─────────────────────────────────────────────────────────────
// Build the full knowledge base from FAQs + scraped website chunks.
// This is the function that was MISSING before — knowledge_chunks
// was in the DB but nothing ever read it.
// ─────────────────────────────────────────────────────────────
async function buildKnowledgeBase(db, chatbotId, faqs) {
  const parts = [];

  // 1) User-curated FAQs first — highest priority
  if (Array.isArray(faqs) && faqs.length > 0) {
    parts.push(
      "CURATED FAQS (use these first when relevant):\n" +
        faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n"),
    );
  }

  // 2) Scraped website content from knowledge_chunks table
  const { data: chunks, error } = await db
    .from("knowledge_chunks")
    .select("content, source_url, chunk_index")
    .eq("chatbot_id", chatbotId)
    .order("chunk_index", { ascending: true })
    .limit(30);

  if (error) {
    console.warn(
      "[chatbot-public] knowledge_chunks query failed:",
      error.message,
    );
  }

  if (Array.isArray(chunks) && chunks.length > 0) {
    // Cap total size so we stay well under the model's context window.
    // 18,000 chars ≈ 4,500 tokens — plenty of room for history + response.
    const MAX_CHARS = 18000;
    let total = 0;
    const used = [];
    for (const chunk of chunks) {
      const content = (chunk.content || "").trim();
      if (!content) continue;
      if (total + content.length > MAX_CHARS) break;
      used.push(content);
      total += content.length;
    }
    if (used.length > 0) {
      parts.push(
        "WEBSITE CONTENT (use this to answer questions about the business):\n" +
          used.join("\n\n---\n\n"),
      );
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

// ─────────────────────────────────────────────────────────────
// Build the language instruction — STRICT.
// Tells the AI (a) the one language to respond in, and
// (b) explicitly that it must NOT language-switch regardless of
// what the user writes in.
// ─────────────────────────────────────────────────────────────
function buildLanguageInstruction(selectedLanguageCode, allowedLanguageCodes) {
  const selectedName = LANG_NAMES[selectedLanguageCode] || "English";
  const allowedNames =
    Array.isArray(allowedLanguageCodes) && allowedLanguageCodes.length > 0
      ? allowedLanguageCodes.map((c) => LANG_NAMES[c] || c).join(", ")
      : selectedName;

  return [
    "",
    "═══════════════════════════════════════════════════════════",
    "LANGUAGE RULES (STRICT, NON-NEGOTIABLE):",
    `• The user has selected: ${selectedName}.`,
    `• This chatbot is configured ONLY for: ${allowedNames}.`,
    `• Respond ONLY in ${selectedName}, no matter what.`,
    `• If the user writes in Arabic, Chinese, French, or any language that is NOT ${selectedName}, you still respond in ${selectedName}.`,
    `• Do NOT mirror the user's language. Do NOT auto-detect and switch.`,
    `• The ONLY acceptable response language is ${selectedName}.`,
    "═══════════════════════════════════════════════════════════",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// POST /api/chatbot-public/chat  (no auth — used by the widget)
// Body: { message, chatbotId, history?, language? }
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// Shared: fetch chatbot + voice agent, build system prompt.
// Reused by both /chat and /chat-stream.
// ─────────────────────────────────────────────────────────────
async function buildChatContext(db, chatbotId, requestedLanguage) {
  // Chatbot row (include voice_agent_id so we can pick up the tone)
  const { data: chatbot, error } = await db
    .from("chatbots")
    .select(
      "id, organization_id, header_title, welcome_message, custom_prompt, faqs, chat_languages, voice_agent_id",
    )
    .eq("id", chatbotId)
    .single();

  if (error || !chatbot) return { error: "Chatbot not found." };

  // Linked voice agent — source of the "tone" the user configured
  let agentTone = "Professional";
  if (chatbot.voice_agent_id) {
    const { data: agent } = await db
      .from("voice_agents")
      .select("tone")
      .eq("id", chatbot.voice_agent_id)
      .single();
    if (agent && agent.tone) agentTone = agent.tone;
  }

  const faqs = Array.isArray(chatbot.faqs) ? chatbot.faqs : [];
  const allowedLanguages =
    Array.isArray(chatbot.chat_languages) && chatbot.chat_languages.length > 0
      ? chatbot.chat_languages
      : ["en"];
  const selectedLanguage =
    requestedLanguage && allowedLanguages.includes(requestedLanguage)
      ? requestedLanguage
      : allowedLanguages[0];

  const knowledgeBase = await buildKnowledgeBase(db, chatbotId, faqs);
  const languageBlock = buildLanguageInstruction(
    selectedLanguage,
    allowedLanguages,
  );
  const toneBlock = buildToneInstruction(agentTone);
  const businessName = chatbot.header_title || "this business";

  const basePrompt =
    chatbot.custom_prompt && chatbot.custom_prompt.trim()
      ? chatbot.custom_prompt.trim()
      : [
          `You are a helpful AI assistant for ${businessName}.`,
          `Your job is to answer questions about ${businessName} using the information provided in the KNOWLEDGE BASE below.`,
          "",
          "BEHAVIOUR:",
          `• Answer CONFIDENTLY using facts from the KNOWLEDGE BASE — including the owner's name, services, experience, contact details, social links, and anything else present there.`,
          `• Do NOT say "I cannot provide that information" if the information is in the KNOWLEDGE BASE — USE it.`,
          `• Be concise: 2–3 sentences for normal replies (voice mode playback gets long very quickly).`,
          `• If a question genuinely isn't covered by the KNOWLEDGE BASE, briefly say so and offer to connect them with a human.`,
          `• Never invent facts that aren't in the KNOWLEDGE BASE.`,
          `• Format with plain paragraphs. Use "- " for bullet lists. Never use literal "\\n" escape sequences — use real line breaks only.`,
        ].join("\n");

  const systemPrompt = [
    basePrompt,
    toneBlock,
    languageBlock,
    "",
    knowledgeBase
      ? `KNOWLEDGE BASE:\n${knowledgeBase}`
      : "KNOWLEDGE BASE:\n(No business-specific information has been loaded yet. Politely say you don't have that information and offer to connect them with a human.)",
  ].join("\n\n");

  return { chatbot, systemPrompt, selectedLanguage, agentTone };
}

function buildToneInstruction(tone) {
  const t = (tone || "Professional").toLowerCase();
  const map = {
    professional:
      "Maintain a PROFESSIONAL tone: clear, courteous, business-appropriate. Avoid slang.",
    friendly:
      "Maintain a FRIENDLY tone: warm, conversational, approachable. Light humor okay.",
    empathetic:
      "Maintain an EMPATHETIC tone: acknowledge feelings, be patient and understanding.",
  };
  return `TONE: ${map[t] || map.professional}`;
}

// ─────────────────────────────────────────────────────────────
// POST /api/chatbot-public/chat  (no auth — used by the widget)
// Body: { message, chatbotId, history?, language? }
// ─────────────────────────────────────────────────────────────
router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    const { message, chatbotId, history, language } = req.body || {};

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
      return res.status(429).json({
        response:
          "I'm receiving a lot of messages right now. Please try again in a moment.",
      });
    }

    const db = getSupabase();
    const ctx = await buildChatContext(db, chatbotId, language);
    if (ctx.error) {
      return res.status(404).json({ error: { message: ctx.error } });
    }

    const { chatbot, systemPrompt, selectedLanguage } = ctx;
    const chatHistory = Array.isArray(history) ? history.slice(-16) : [];

    let response;
    try {
      response = await generateChatResponse(
        message.trim(),
        chatHistory,
        systemPrompt,
      );
    } catch (err) {
      console.error("[chatbot-public] chat generation failed:", err.message);
      // Friendly fallback, localized best-effort
      const fallback =
        selectedLanguage === "es"
          ? "Lo siento, estoy teniendo dificultades en este momento. Por favor, inténtalo de nuevo en breve."
          : "I'm sorry, I'm having a moment of difficulty. Please try again shortly.";
      return res.json({ response: fallback });
    }

    response = cleanResponse(response);

    // Track unanswered questions (best-effort; table is optional)
    const UNANSWERED_PHRASES = [
      "i don't know",
      "i'm not sure",
      "i cannot",
      "i can't",
      "don't have that information",
      "not available",
      "connect them with a human",
      "contact us directly",
      "i'm unable",
    ];
    const isUnanswered = UNANSWERED_PHRASES.some((p) =>
      response.toLowerCase().includes(p),
    );
    if (isUnanswered && chatbot.organization_id) {
      try {
        await db.from("unanswered_questions").insert({
          organization_id: chatbot.organization_id,
          chatbot_id: chatbotId,
          question: message.trim(),
          bot_response: response,
        });
      } catch (trackErr) {
        // Table is optional — don't fail the request if it doesn't exist
        console.warn(
          "[chatbot-public] unanswered_questions insert skipped:",
          trackErr.message,
        );
      }
    }

    return res.json({ response });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/chatbot-public/chat-stream  (no auth, SSE)
// Body: { message, chatbotId, history?, language? }
// Response: Server-Sent Events
//   data: {"token":"Hello"}
//   data: {"token":" world"}
//   data: {"done":true}
//   data: {"error":"..."}  (on failure)
// Lets the widget speak sentences as they stream in instead of
// waiting for the full reply — critical for voice-mode latency.
// ─────────────────────────────────────────────────────────────
router.post(
  "/chat-stream",
  asyncHandler(async (req, res) => {
    const { message, chatbotId, history, language } = req.body || {};

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
      return res.status(429).json({ error: { message: "Too many requests." } });
    }

    const db = getSupabase();
    const ctx = await buildChatContext(db, chatbotId, language);
    if (ctx.error) {
      return res.status(404).json({ error: { message: ctx.error } });
    }
    const { systemPrompt } = ctx;
    const chatHistory = Array.isArray(history) ? history.slice(-16) : [];

    // SSE headers — disable buffering so tokens flush immediately
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx / proxy hint
    res.flushHeaders && res.flushHeaders();

    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch (_) {
        /* socket closed */
      }
    };

    try {
      const openai = getOpenAI();

      const messages = [
        { role: "system", content: systemPrompt },
        ...chatHistory.map((m) => ({
          role: m.role === "model" ? "assistant" : "user",
          content: m.text || m.content || "",
        })),
        { role: "user", content: message.trim() },
      ];

      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        stream: true,
        max_tokens: 300,
        temperature: 0.65,
      });

      // Abort the OpenAI stream if the client disconnects mid-response
      let clientClosed = false;
      req.on("close", () => {
        clientClosed = true;
        try {
          stream.controller && stream.controller.abort();
        } catch (_) {}
      });

      for await (const chunk of stream) {
        if (clientClosed) break;
        const token = chunk.choices[0]?.delta?.content || "";
        if (token) send({ token });
      }

      if (!clientClosed) send({ done: true });
    } catch (err) {
      console.error("[chatbot-public/chat-stream] failed:", err.message);
      send({ error: err.message || "Streaming failed." });
    } finally {
      try {
        res.end();
      } catch (_) {}
    }
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/chatbot-public/transcribe  (no auth — used by widget mic)
// Query: ?chatbotId=<uuid>
// Body:  raw audio bytes (audio/webm from MediaRecorder)
// Returns: { text: string }
// ─────────────────────────────────────────────────────────────
router.post(
  "/transcribe",
  asyncHandler(async (req, res) => {
    const chatbotId = req.query.chatbotId;

    if (!chatbotId) {
      return res
        .status(400)
        .json({ error: { message: "chatbotId query parameter is required." } });
    }
    if (isRateLimited(chatbotId)) {
      return res.status(429).json({
        error: { message: "Too many requests. Please wait a moment." },
      });
    }

    // Verify the chatbot exists (prevents random UUIDs from burning quota)
    const db = getSupabase();
    const { data: chatbot } = await db
      .from("chatbots")
      .select("id")
      .eq("id", chatbotId)
      .single();
    if (!chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    // Read raw audio bytes from the request stream, with a size cap
    const MAX_BYTES = 10 * 1024 * 1024; // 10MB
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BYTES) {
          return res
            .status(413)
            .json({ error: { message: "Audio file too large (max 10MB)." } });
        }
        chunks.push(chunk);
      }
    } catch (readErr) {
      return res
        .status(400)
        .json({ error: { message: "Failed to read audio stream." } });
    }

    const audioBuffer = Buffer.concat(chunks);
    if (audioBuffer.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "No audio data received." } });
    }

    // Guess the file extension from content-type so Whisper gets a recognizable file
    const ct = (req.headers["content-type"] || "").toLowerCase();
    let filename = "recording.webm";
    let fileType = "audio/webm";
    if (ct.includes("mp4")) {
      filename = "recording.mp4";
      fileType = "audio/mp4";
    } else if (ct.includes("ogg")) {
      filename = "recording.ogg";
      fileType = "audio/ogg";
    } else if (ct.includes("wav")) {
      filename = "recording.wav";
      fileType = "audio/wav";
    } else if (ct.includes("mpeg") || ct.includes("mp3")) {
      filename = "recording.mp3";
      fileType = "audio/mpeg";
    }

    try {
      const { toFile } = require("openai");
      const openai = getOpenAI();
      const audioFile = await toFile(audioBuffer, filename, { type: fileType });

      // verbose_json gives us the detected language alongside the transcript
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1",
        response_format: "verbose_json",
      });

      // Whisper returns full language names (e.g. "english", "spanish").
      // Map to ISO codes so the widget can match them against its chat_languages list.
      const LANG_NAME_TO_CODE = {
        english: "en",
        spanish: "es",
        french: "fr",
        german: "de",
        italian: "it",
        portuguese: "pt",
        arabic: "ar",
        chinese: "zh",
        mandarin: "zh",
        japanese: "ja",
        korean: "ko",
        hindi: "hi",
        dutch: "nl",
      };
      const rawLang = String(transcription.language || "").toLowerCase();
      const language =
        LANG_NAME_TO_CODE[rawLang] || rawLang.slice(0, 2) || null;

      const text = (transcription.text || "").trim();
      return res.json({ text, language });
    } catch (err) {
      console.error("[chatbot-public/transcribe] failed:", err.message);
      return res.status(500).json({
        error: { message: "Transcription failed. Please try again." },
      });
    }
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/chatbot-public/speak  (no auth — used by widget TTS)
// Body: { text: string, chatbotId: string }
// Returns: audio/mpeg stream
// ─────────────────────────────────────────────────────────────
router.post(
  "/speak",
  asyncHandler(async (req, res) => {
    const { text, chatbotId } = req.body || {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: { message: "text is required." } });
    }
    if (!chatbotId) {
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    }
    if (isRateLimited(chatbotId)) {
      return res.status(429).json({
        error: { message: "Too many requests. Please wait a moment." },
      });
    }

    const db = getSupabase();
    const { data: chatbot, error } = await db
      .from("chatbots")
      .select("id, chat_voice")
      .eq("id", chatbotId)
      .single();

    if (error || !chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    // Validate the voice from the DB — fall back to 'alloy' if missing/invalid
    const VALID_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    const voice = VALID_VOICES.includes(chatbot.chat_voice)
      ? chatbot.chat_voice
      : "alloy";

    // Cap text length — TTS billing scales with character count
    const MAX_CHARS = 2000;
    const input = text.slice(0, MAX_CHARS);

    try {
      const openai = getOpenAI();
      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice,
        input,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "no-store");
      return res.send(buffer);
    } catch (err) {
      console.error("[chatbot-public/speak] failed:", err.message);
      return res.status(500).json({
        error: { message: "Speech generation failed. Please try again." },
      });
    }
  }),
);

// ─────────────────────────────────────────────────────────────
// GET /api/chatbot-public/unanswered  (used by admin dashboard)
// ─────────────────────────────────────────────────────────────
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
    return res.json({ questions: data || [] });
  }),
);

// ─────────────────────────────────────────────────────────────
// PATCH /api/chatbot-public/unanswered/:id/resolve
// ─────────────────────────────────────────────────────────────
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
        .single();
      const existing = Array.isArray(chatbot?.faqs) ? chatbot.faqs : [];
      await db
        .from("chatbots")
        .update({
          faqs: [...existing, { id: `faq-${Date.now()}`, question, answer }],
        })
        .eq("id", chatbotId);
    }

    return res.json({ success: true });
  }),
);

module.exports = router;
