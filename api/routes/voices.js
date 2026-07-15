"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { requireWalletCredit } = require("../../lib/billing-credit-enforcement");
const {
  listVoiceCatalog,
  resolveVoice,
  synthesizeElevenLabsPreview,
  normalizePreviewText: normalizeElevenLabsPreviewText,
} = require("../../lib/elevenlabs");
const {
  listOpenAIVoices,
  synthesizeOpenAIPreview,
  normalizePreviewText: normalizeOpenAIPreviewText,
} = require("../../lib/openai-voices");

const router = express.Router();

async function loadTenantGreeting(db, req) {
  const agentId =
    req.body?.agentId ||
    req.body?.agent_id ||
    req.query?.agentId ||
    req.query?.agent_id ||
    req.organization?.active_voice_agent_id;
  if (!agentId) return "";
  try {
    const { data } = await db
      .from("voice_agents")
      .select("id,greeting,welcome_message")
      .eq("id", agentId)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    return data?.greeting || data?.welcome_message || "";
  } catch (_) {
    return "";
  }
}

function wantsJsonAudio(req) {
  const body = req.body || {};
  const accept = String(req.headers.accept || "").toLowerCase();
  return (
    body.returnJson === true ||
    body.return_json === true ||
    body.returnBase64 === true ||
    body.return_base64 === true ||
    accept.includes("application/json")
  );
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const provider = String(req.query?.provider || "elevenlabs")
      .trim()
      .toLowerCase();

    if (provider === "openai") {
      const result = listOpenAIVoices({
        model: req.query.model || req.query.model_id,
      });
      return res.json({ success: true, ...result });
    }

    const result = await listVoiceCatalog({
      db,
      provider: "elevenlabs",
      preferApi: true,
    });
    res.json({
      success: true,
      provider: "elevenlabs",
      source: result.source,
      warning: result.warning || undefined,
      count: result.voices.length,
      voices: result.voices.map((voice) => ({
        id: voice.voice_id || voice.voiceId || voice.id,
        provider: "elevenlabs",
        name: voice.name || voice.displayName,
        displayName: voice.name || voice.displayName,
        voice_id: voice.voice_id || voice.voiceId || voice.id,
        voiceId: voice.voice_id || voice.voiceId || voice.id,
        gender: voice.gender || voice.labels?.gender || null,
        language: voice.language || voice.labels?.language || null,
        accent: voice.accent || voice.labels?.accent || null,
        modelId:
          voice.modelId ||
          voice.model_id ||
          process.env.ELEVENLABS_DEFAULT_MODEL ||
          "eleven_flash_v2_5",
        preview_url: voice.preview_url || voice.previewUrl || null,
        previewUrl: voice.preview_url || voice.previewUrl || null,
        previewAvailable: true,
        metadata: voice.metadata || {},
      })),
    });
  }),
);

router.post(
  "/preview",
  requireAuth,
  requireWalletCredit({ action: "voice_preview" }),
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const provider = String(
      req.body?.provider || req.body?.voice_provider || "elevenlabs",
    )
      .trim()
      .toLowerCase();
    const tenantGreeting = await loadTenantGreeting(db, req);

    if (provider === "openai") {
      const audio = await synthesizeOpenAIPreview({
        voiceId:
          req.body?.voiceId ||
          req.body?.voice_id ||
          req.body?.id ||
          req.body?.voice,
        text: normalizeOpenAIPreviewText(req.body?.text || tenantGreeting),
        model: req.body?.model || req.body?.modelId || req.body?.model_id,
        responseFormat:
          req.body?.responseFormat ||
          req.body?.response_format ||
          req.body?.outputFormat ||
          req.body?.output_format,
        speed: req.body?.speed,
        instructions: req.body?.instructions,
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Voice-Provider", "openai");
      res.setHeader("X-Voice-Id", audio.voiceId);
      res.setHeader("X-OpenAI-TTS-Model", audio.model);
      if (wantsJsonAudio(req)) {
        return res.json({
          success: true,
          provider: "openai",
          voice_id: audio.voiceId,
          voiceId: audio.voiceId,
          model: audio.model,
          responseFormat: audio.responseFormat,
          mimeType: audio.mimeType || "audio/mpeg",
          audioBase64: audio.buffer.toString("base64"),
          size: audio.buffer.length,
        });
      }
      res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
      res.setHeader("Content-Length", String(audio.buffer.length));
      return res.status(200).send(audio.buffer);
    }

    const voice = await resolveVoice({
      db,
      provider: "elevenlabs",
      voiceId: req.body?.voiceId || req.body?.voice_id || req.body?.id,
    });
    const previewText = normalizeElevenLabsPreviewText(
      req.body?.text || tenantGreeting,
    );
    const audio = await synthesizeElevenLabsPreview({
      voiceId: voice.voiceId,
      text: previewText,
      modelId: req.body?.modelId || req.body?.model_id || voice.modelId,
      outputFormat: req.body?.outputFormat || req.body?.output_format,
      voiceSettings: req.body?.voiceSettings || req.body?.voice_settings || {},
      usageContext: {
        organizationId: req.orgId,
        userId: req.user?.id,
        service: "voice_preview",
        route: "voices.preview",
        metadata: { endpoint: req.originalUrl || req.path },
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Voice-Provider", "elevenlabs");
    res.setHeader("X-Voice-Id", voice.voiceId);

    if (wantsJsonAudio(req)) {
      return res.json({
        success: true,
        provider: "elevenlabs",
        voice_id: voice.voiceId,
        voiceId: voice.voiceId,
        modelId: audio.modelId,
        outputFormat: audio.outputFormat,
        mimeType: audio.mimeType || "audio/mpeg",
        audioBase64: audio.buffer.toString("base64"),
        size: audio.buffer.length,
      });
    }

    res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
    res.setHeader("Content-Length", String(audio.buffer.length));
    res.setHeader("X-Voice-Preview-Cache-Key", audio.cacheKey || "");
    res.setHeader("X-ElevenLabs-Model", audio.modelId || "");
    res.setHeader("X-ElevenLabs-Output-Format", audio.outputFormat || "");
    res.setHeader(
      "X-ElevenLabs-Voice-Settings",
      JSON.stringify(audio.voiceSettings || {}),
    );
    return res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
