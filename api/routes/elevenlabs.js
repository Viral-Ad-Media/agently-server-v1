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
  return { "xi-api-key": key };
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

router.get(
  "/voices",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const db = getSupabase();
    const result = await listVoiceCatalog({ db, provider: "elevenlabs" });
    res.json({
      success: true,
      provider: "elevenlabs",
      source: result.source,
      warning: result.warning || undefined,
      voices: result.voices.map((voice) => ({
        id: voice.id,
        provider: voice.provider,
        displayName: voice.displayName,
        voiceId: voice.voiceId,
        gender: voice.gender,
        language: voice.language,
        accent: voice.accent,
        modelId: voice.modelId,
        previewAvailable: voice.previewAvailable,
      })),
    });
  }),
);

router.get(
  "/voices/:voiceId/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const voiceId = String(req.params.voiceId || "").trim();
    if (!voiceId) {
      return res
        .status(400)
        .json({
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
    res.json({ success: true, voiceId, settings: parsed });
  }),
);

router.post(
  "/test-voice",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const voice = await resolveVoice({
      db,
      provider: "elevenlabs",
      voiceId: body.voiceId || body.voice_id || body.elevenlabs_voice_id,
    });
    const text = normalizePreviewText(
      body.text || "Hello, this is an ElevenLabs voice test from Agently.",
    );
    const audio = await synthesizeElevenLabsPreview({
      voiceId: voice.voiceId,
      text,
      modelId: body.modelId || body.model_id || voice.modelId,
      outputFormat: body.outputFormat || body.output_format,
      voiceSettings: normalizeVoiceSettings(
        body.voiceSettings || body.voice_settings || {},
      ),
    });
    res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
    res.setHeader("Content-Length", String(audio.buffer.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Voice-Provider", "elevenlabs");
    res.setHeader("X-Voice-Id", voice.voiceId);
    res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
