"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  listVoiceCatalog,
  getVoiceSettings,
} = require("../../lib/elevenlabs");

const router = express.Router();

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
      voices: (result.voices || []).map((voice) => ({
        id: voice.id,
        provider: "elevenlabs",
        displayName: voice.displayName,
        voiceId: voice.voiceId,
        gender: voice.gender,
        language: voice.language,
        accent: voice.accent,
        modelId: voice.modelId,
        previewAvailable: true,
        metadata: voice.metadata || {},
      })),
    });
  }),
);

router.get(
  "/voices/:voiceId/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await getVoiceSettings(req.params.voiceId);
    res.json({ success: true, provider: "elevenlabs", voiceId: req.params.voiceId, settings });
  }),
);

module.exports = router;
