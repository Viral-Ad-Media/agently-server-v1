"use strict";

const express = require("express");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  listOpenAIVoices,
  synthesizeOpenAIPreview,
  normalizeVoiceId,
} = require("../../lib/openai-voices");

const router = express.Router();

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
  "/voices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = listOpenAIVoices({ model: req.query.model || req.query.model_id });
    res.json({ success: true, ...result });
  }),
);

router.get(
  "/voices/:voiceId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = listOpenAIVoices({ model: req.query.model || req.query.model_id });
    const voiceId = normalizeVoiceId(req.params.voiceId, "");
    const voice = result.voices.find((item) => item.voice_id === voiceId);
    if (!voice) {
      return res.status(404).json({
        success: false,
        error: { code: "OPENAI_VOICE_NOT_FOUND", message: "OpenAI voice not found." },
      });
    }
    res.json({ success: true, provider: "openai", voice });
  }),
);

router.post(
  "/test-voice",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const audio = await synthesizeOpenAIPreview({
      voiceId: body.voice_id || body.voiceId || body.id || body.voice,
      text: body.text,
      model: body.model || body.model_id || body.modelId,
      responseFormat: body.response_format || body.responseFormat || body.output_format || body.outputFormat,
      speed: body.speed,
      instructions: body.instructions,
    });

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Voice-Provider", "openai");
    res.setHeader("X-Voice-Id", audio.voiceId);
    res.setHeader("X-OpenAI-TTS-Model", audio.model);
    res.setHeader("X-OpenAI-Response-Format", audio.responseFormat);

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
    res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
