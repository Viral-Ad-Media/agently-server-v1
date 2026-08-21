"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");
const { serializeMessage } = require("../../lib/serializers");
const { logChatbotConversationUsage } = require("../../lib/billing-limits");
const {
  ensureWalletCreditOrRespond,
} = require("../../lib/billing-credit-enforcement");
const { loadVoiceContext } = require("../../lib/context-builder");
const {
  loadChatbotContext,
  buildAssistantPrompt,
  cleanAssistantResponse,
  ensureProductLinks,
} = require("../../lib/assistant-intelligence");

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

    const creditAllowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: orgId,
      action: "chatbot_message",
    });
    if (creditAllowed !== true) return;

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
    let groundedContext = null;

    if (chatbotId) {
      groundedContext = await loadChatbotContext(chatbotId, message.trim());
      if (groundedContext?.entity) {
        systemPrompt = buildAssistantPrompt({
          context: groundedContext,
          message: message.trim(),
          mode: "text",
          direction: "chat",
          languageName: "English",
        });
        unresolvedChatbotId = groundedContext.entity.id;
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

    let aiText = await generateChatResponse(
      message.trim(),
      history || [],
      systemPrompt,
      {
        organizationId: orgId,
        userId: req.user?.id,
        chatbotId: chatbotId || null,
        metadata: { route: "messenger.messages" },
      },
    );
    aiText = groundedContext
      ? ensureProductLinks({
          message: message.trim(),
          response: cleanAssistantResponse(aiText),
          products: groundedContext.products || [],
          chunks: groundedContext.chunks || [],
        })
      : cleanAssistantResponse(aiText);

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

    await logChatbotConversationUsage({
      organizationId: orgId,
      userId: req.user?.id,
      chatbotId: chatbotId || unresolvedChatbotId || null,
      messageId: aiMsg?.id || null,
      metadata: {
        route: "messenger.messages",
        user_message_id: userMsg?.id || null,
        assistant_message_id: aiMsg?.id || null,
        unanswered: isUnanswered(aiText),
      },
    }).catch((err) => {
      console.warn(
        "[billing] chatbot conversation usage log skipped",
        err.message || String(err),
      );
    });

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
    const creditAllowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: req.orgId,
      action: "voice_preview",
    });
    if (creditAllowed !== true) return;
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

    // PATCH: tts-1 is deprecated; errors were swallowed with no tenant-visible
    // reason (the frontend only checked resp.ok, so a 402 credit block looked
    // identical to a dead button); and previews were never metered.
    const { getOpenAI } = require("../../lib/openai");
    const openai = getOpenAI();

    let buffer;
    try {
      const speech = await openai.audio.speech.create({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: openaiVoice,
        input: String(text).slice(0, 600),
      });
      buffer = Buffer.from(await speech.arrayBuffer());
    } catch (err) {
      console.error("[messenger/voice-preview]", err?.message || err);
      return res.status(502).json({
        error: {
          code: "VOICE_PREVIEW_FAILED",
          message:
            "We couldn't play that voice sample just now. Please try again in a moment.",
        },
      });
    }

    // Meter it. Previews were free to tenants before this.
    try {
      const { insertUsageEvent } = require("../../lib/usage-ledger");
      await insertUsageEvent({
        organizationId: req.orgId,
        userId: req.user?.id || null,
        provider: "openai",
        service: "tts",
        eventType: "voice_preview",
        source: "messenger_voice_preview",
        externalId: `preview-${Date.now()}`,
        unit: "character",
        quantity: String(text).length,
        metadata: { voice: openaiVoice },
      });
    } catch (meterErr) {
      console.warn(
        "[messenger/voice-preview] metering skipped:",
        meterErr?.message,
      );
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  }),
);

/**
 * POST /api/messenger/transcribe
 *
 * Speech-to-text for the in-app chatbot preview's mic button.
 *
 * This route did not exist. The preview recorded audio, POSTed it here, got a
 * 404, swallowed the error, and put nothing in the input box — which is why
 * "Press mic to record" never produced text or a send button. The public
 * widget has had a working equivalent at /api/chatbot-public/transcribe all
 * along; this is the same implementation behind tenant auth.
 */
router.post(
  "/transcribe",
  requireAuth,
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "15mb" }),
  asyncHandler(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || "");
    if (!buffer.length) {
      return res
        .status(400)
        .json({ error: { message: "No audio received. Try recording again." } });
    }

    try {
      const { getOpenAI } = require("../../lib/openai-client");
      const { toFile } = require("openai");
      const openai = getOpenAI();
      // toFile(), not `new File(...)`: File only became a Node global in v20
      // and this service declares engines ">=18", so constructing one directly
      // throws a ReferenceError on an 18.x runtime and every transcription
      // fails with a generic error. The SDK helper works on any version.
      const file = await toFile(
        buffer,
        "voice.webm",
        { type: req.headers["content-type"] || "audio/webm" },
      );
      const result = await openai.audio.transcriptions.create({
        file,
        model: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
      });
      return res.json({ text: result.text || "" });
    } catch (err) {
      console.error("[messenger/transcribe] failed:", err?.message || err);
      return res.status(500).json({
        error: {
          message:
            "Could not transcribe that recording. Please try again, or type your message.",
        },
      });
    }
  }),
);

module.exports = router;
