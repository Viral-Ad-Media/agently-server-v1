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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isElevenLabsQuotaError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(
    error?.code || error?.raw?.detail?.status || "",
  ).toLowerCase();
  return (
    code.includes("quota") ||
    code.includes("credit") ||
    message.includes("exceeds your quota") ||
    message.includes("credits remaining") ||
    message.includes("quota exceeded") ||
    message.includes("insufficient credits")
  );
}

async function resolvePreviewVoice({ db, requestedVoiceId, requestedModelId }) {
  const voiceId = String(requestedVoiceId || "").trim();
  if (!voiceId) {
    const error = new Error("voice_id is required.");
    error.status = 400;
    error.code = "VOICE_ID_REQUIRED";
    throw error;
  }

  // ElevenLabs voice IDs are external alphanumeric IDs, not UUIDs. Querying
  // voice_catalog.id with them makes Postgres reject the whole OR condition.
  if (!UUID_PATTERN.test(voiceId)) {
    return {
      voiceId,
      modelId:
        requestedModelId ||
        process.env.ELEVENLABS_DEFAULT_MODEL ||
        "eleven_flash_v2_5",
    };
  }

  return resolveVoice({ db, provider: "elevenlabs", voiceId });
}

function sendQuotaUnavailable(res, error) {
  const providerMessage = String(error?.message || "").trim();
  return res.status(503).json({
    success: false,
    error: {
      code: "ELEVENLABS_QUOTA_UNAVAILABLE",
      message:
        "The ElevenLabs API key configured on the backend cannot generate this preview because its provider quota is unavailable. This is separate from the organization's Agently wallet balance.",
      details: { providerMessage: providerMessage || undefined },
    },
  });
}

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
          previewText: audio.text,
        });
      }
      res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
      res.setHeader("Content-Length", String(audio.buffer.length));
      return res.status(200).send(audio.buffer);
    }

    const requestedModelId =
      req.body?.modelId || req.body?.model_id || req.body?.model;
    const voice = await resolvePreviewVoice({
      db,
      requestedVoiceId:
        req.body?.elevenlabs_voice_id ||
        req.body?.voiceId ||
        req.body?.voice_id ||
        req.body?.id,
      requestedModelId,
    });
    const previewText = normalizeElevenLabsPreviewText(
      req.body?.text || tenantGreeting,
    );

    let audio;
    let providerUsed = "elevenlabs";
    try {
      audio = await synthesizeElevenLabsPreview({
        voiceId: voice.voiceId,
        text: previewText,
        modelId: requestedModelId || voice.modelId,
        outputFormat: req.body?.outputFormat || req.body?.output_format,
        voiceSettings:
          req.body?.voiceSettings || req.body?.voice_settings || {},
        usageContext: {
          organizationId: req.orgId,
          userId: req.user?.id,
          service: "voice_preview",
          route: "voices.preview",
          metadata: { endpoint: req.originalUrl || req.path },
        },
      });
    } catch (error) {
      if (!isElevenLabsQuotaError(error)) throw error;
      // ElevenLabs account itself is out of quota/credits — that's a
      // provider-side problem, not the tenant's wallet. Rather than dead-end
      // the preview, fall back to OpenAI TTS so the admin still hears
      // something and can tell the preview pipeline itself is healthy.
      try {
        audio = await synthesizeOpenAIPreview({
          voiceId: process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy",
          text: previewText,
        });
        providerUsed = "openai-fallback";
      } catch (fallbackError) {
        return sendQuotaUnavailable(res, error);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Voice-Provider", providerUsed);
    res.setHeader("X-Voice-Id", voice.voiceId);
    if (providerUsed === "openai-fallback") {
      res.setHeader("X-Voice-Fallback-Reason", "elevenlabs_quota_unavailable");
    }

    if (wantsJsonAudio(req)) {
      return res.json({
        success: true,
        provider: providerUsed,
        voice_id: voice.voiceId,
        voiceId: voice.voiceId,
        modelId: audio.modelId || audio.model,
        outputFormat: audio.outputFormat || audio.responseFormat,
        mimeType: audio.mimeType || "audio/mpeg",
        audioBase64: audio.buffer.toString("base64"),
        size: audio.buffer.length,
        previewText: audio.text || previewText,
        fallback: providerUsed === "openai-fallback",
      });
    }

    res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
    res.setHeader("Content-Length", String(audio.buffer.length));
    if (providerUsed === "elevenlabs") {
      res.setHeader("X-Voice-Preview-Cache-Key", audio.cacheKey || "");
      res.setHeader("X-ElevenLabs-Model", audio.modelId || "");
      res.setHeader("X-ElevenLabs-Output-Format", audio.outputFormat || "");
      res.setHeader(
        "X-ElevenLabs-Voice-Settings",
        JSON.stringify(audio.voiceSettings || {}),
      );
    }
    return res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
