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

async function loadTenantGreeting(db, req) {
  const agentId = req.body?.agentId || req.query?.agentId || req.organization?.active_voice_agent_id;
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

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const provider = String(req.query?.provider || "elevenlabs").trim().toLowerCase();
    const result = await listVoiceCatalog({ db, provider });
    res.json({
      success: true,
      provider,
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

router.post(
  "/preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const provider = String(req.body?.provider || "elevenlabs").trim().toLowerCase();
    if (provider !== "elevenlabs") {
      return res.status(400).json({
        success: false,
        error: {
          code: "UNSUPPORTED_VOICE_PROVIDER",
          message: "Voice preview currently supports provider=elevenlabs.",
        },
      });
    }

    const voice = await resolveVoice({
      db,
      provider,
      voiceId: req.body?.voiceId || req.body?.id,
    });
    const tenantGreeting = await loadTenantGreeting(db, req);
    const previewText = normalizePreviewText(req.body?.text || tenantGreeting);
    const audio = await synthesizeElevenLabsPreview({
      voiceId: voice.voiceId,
      text: previewText,
      modelId: req.body?.modelId || voice.modelId,
      outputFormat: req.body?.outputFormat,
    });

    res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
    res.setHeader("Content-Length", String(audio.buffer.length));
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Voice-Provider", "elevenlabs");
    res.setHeader("X-Voice-Id", voice.voiceId);
    res.setHeader("X-Voice-Preview-Cache-Key", audio.cacheKey);
    res.setHeader("X-ElevenLabs-Model", audio.modelId);
    res.setHeader("X-ElevenLabs-Output-Format", audio.outputFormat);
    return res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
