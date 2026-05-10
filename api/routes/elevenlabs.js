"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  listVoiceCatalog,
  resolveVoice,
  synthesizeElevenLabsPreview,
  normalizePreviewText,
} = require("../../lib/elevenlabs");

const router = express.Router();
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

function apiKey() {
  return String(process.env.ELEVENLABS_API_KEY || "").trim();
}

function elevenLabsHeaders() {
  const key = apiKey();
  if (!key) {
    const err = new Error("ELEVENLABS_API_KEY is not configured.");
    err.status = 503;
    err.code = "ELEVENLABS_API_KEY_MISSING";
    throw err;
  }
  return { "xi-api-key": key, Accept: "application/json" };
}

function normalizeVoiceSettings(value = {}) {
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  function number(name, fallback, min, max) {
    const raw =
      input[name] ??
      input[name.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())];
    const n = Number(raw);
    const out = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, out));
  }
  return {
    stability: number(
      "stability",
      Number(process.env.ELEVENLABS_STABILITY || 0.65),
      0,
      1,
    ),
    similarity_boost: number(
      "similarityBoost",
      Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.8),
      0,
      1,
    ),
    style: number("style", Number(process.env.ELEVENLABS_STYLE || 0.15), 0, 1),
    speed: number(
      "speed",
      Number(process.env.ELEVENLABS_SPEED || 0.92),
      0.7,
      1.2,
    ),
    use_speaker_boost:
      input.use_speaker_boost ??
      input.useSpeakerBoost ??
      String(
        process.env.ELEVENLABS_USE_SPEAKER_BOOST || "true",
      ).toLowerCase() !== "false",
  };
}

function toFrontendVoice(voice) {
  const voiceId = voice.voice_id || voice.voiceId || voice.id;
  const name = voice.name || voice.displayName || voice.display_name || voiceId;
  const metadata =
    voice.metadata && typeof voice.metadata === "object" ? voice.metadata : {};
  const previewUrl =
    voice.preview_url || voice.previewUrl || metadata.preview_url || null;
  const labels = voice.labels || metadata.labels || {};
  return {
    id: voiceId,
    provider: "elevenlabs",
    name,
    displayName: name,
    voice_id: voiceId,
    voiceId,
    category: voice.category || metadata.category || null,
    labels,
    gender: voice.gender || labels.gender || null,
    language: voice.language || labels.language || labels.languages || null,
    accent: voice.accent || labels.accent || null,
    description: voice.description || metadata.description || null,
    model_id:
      voice.model_id ||
      voice.modelId ||
      process.env.ELEVENLABS_DEFAULT_MODEL ||
      "eleven_flash_v2_5",
    modelId:
      voice.modelId ||
      voice.model_id ||
      process.env.ELEVENLABS_DEFAULT_MODEL ||
      "eleven_flash_v2_5",
    preview_url: previewUrl,
    previewUrl,
    previewAvailable: Boolean(previewUrl || voiceId),
    metadata,
  };
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

async function sendPreviewAudio(
  req,
  res,
  { voiceId, text, modelId, outputFormat, voiceSettings },
) {
  const db = getSupabase();
  const voice = await resolveVoice({ db, provider: "elevenlabs", voiceId });
  const audio = await synthesizeElevenLabsPreview({
    voiceId: voice.voiceId,
    text: normalizePreviewText(
      text || "Hello, this is an ElevenLabs voice test from Agently.",
    ),
    modelId: modelId || voice.modelId,
    outputFormat,
    voiceSettings: normalizeVoiceSettings(voiceSettings || {}),
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
      mimeType: audio.mimeType || "audio/mpeg",
      audioBase64: audio.buffer.toString("base64"),
      size: audio.buffer.length,
    });
  }

  res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
  res.setHeader("Content-Length", String(audio.buffer.length));
  return res.status(200).send(audio.buffer);
}

router.get(
  "/voices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const source = String(req.query.source || "api").toLowerCase();
    const result = await listVoiceCatalog({
      db,
      provider: "elevenlabs",
      source,
      preferApi: source !== "catalog",
    });
    const voices = result.voices.map(toFrontendVoice);
    res.json({
      success: true,
      provider: "elevenlabs",
      source: result.source,
      count: voices.length,
      warning: result.warning || undefined,
      voices,
    });
  }),
);

router.get(
  "/voices/:voiceId/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const voiceId = String(req.params.voiceId || "").trim();
    if (!voiceId) {
      return res.status(400).json({
        success: false,
        error: { code: "VOICE_ID_REQUIRED", message: "voiceId is required." },
      });
    }

    const response = await fetch(
      `${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voiceId)}/settings`,
      {
        headers: elevenLabsHeaders(),
      },
    );
    const body = await response.text();
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch (_) {
      parsed = { message: body };
    }
    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: {
          code:
            parsed?.detail?.status ||
            parsed?.status ||
            `http_${response.status}`,
          message:
            parsed?.detail?.message ||
            parsed?.message ||
            "Failed to fetch ElevenLabs voice settings.",
        },
      });
    }
    res.json({ success: true, voice_id: voiceId, voiceId, settings: parsed });
  }),
);

router.post(
  "/test-voice",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const voiceId = body.elevenlabs_voice_id || body.voice_id || body.voiceId;
    if (!voiceId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VOICE_ID_REQUIRED",
          message: "voice_id is required.",
        },
      });
    }
    return sendPreviewAudio(req, res, {
      voiceId,
      text: body.text,
      modelId: body.model_id || body.modelId,
      outputFormat: body.output_format || body.outputFormat,
      voiceSettings: body.voice_settings || body.voiceSettings || {},
    });
  }),
);

module.exports = router;
