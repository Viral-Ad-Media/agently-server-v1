"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeAgent } = require("../../lib/serializers");
const {
  listVoiceCatalog,
  resolveVoice,
  synthesizeElevenLabsPreview,
  normalizePreviewText,
} = require("../../lib/elevenlabs");

const router = express.Router();

const AGENT_SELECT = "*";

function normalizeProvider(value, fallback = "openai") {
  const provider = String(value || fallback)
    .trim()
    .toLowerCase();
  return provider === "elevenlabs" || provider === "openai"
    ? provider
    : fallback;
}

function normalizeSettings(value = {}) {
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const n = (key, fallback, min, max) => {
    const raw =
      input[key] ?? input[key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())];
    const num = Number(raw);
    return Math.max(min, Math.min(max, Number.isFinite(num) ? num : fallback));
  };
  return {
    stability: n(
      "stability",
      Number(process.env.ELEVENLABS_STABILITY || 0.65),
      0,
      1,
    ),
    similarity_boost: n(
      "similarityBoost",
      Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.8),
      0,
      1,
    ),
    style: n("style", Number(process.env.ELEVENLABS_STYLE || 0.15), 0, 1),
    speed: n("speed", Number(process.env.ELEVENLABS_SPEED || 0.92), 0.7, 1.2),
    use_speaker_boost:
      input.use_speaker_boost ??
      input.useSpeakerBoost ??
      String(
        process.env.ELEVENLABS_USE_SPEAKER_BOOST || "true",
      ).toLowerCase() !== "false",
  };
}

function pick(body, ...names) {
  for (const name of names) if (body[name] !== undefined) return body[name];
  return undefined;
}

function buildVoiceUpdates(body = {}) {
  const updates = {};
  const provider = pick(body, "voice_provider", "voiceProvider", "provider");
  const elevenId = pick(
    body,
    "elevenlabs_voice_id",
    "elevenLabsVoiceId",
    "voiceId",
    "voice_id",
  );
  const elevenName = pick(
    body,
    "elevenlabs_voice_name",
    "elevenLabsVoiceName",
    "voiceName",
    "voice_name",
  );
  const settings = pick(body, "voice_settings", "voiceSettings");

  if (provider !== undefined)
    updates.voice_provider = normalizeProvider(provider, "openai");
  if (elevenId !== undefined) {
    updates.elevenlabs_voice_id = String(elevenId || "").trim() || null;
    updates.voice_id = updates.elevenlabs_voice_id;
    updates.voice_catalog_id = null;
  }
  if (elevenName !== undefined)
    updates.elevenlabs_voice_name = String(elevenName || "").trim() || null;
  if (settings !== undefined)
    updates.voice_settings = normalizeSettings(settings || {});

  const passthrough = {
    tone: ["tone"],
    speech_style: ["speech_style", "speechStyle"],
    call_purpose: ["call_purpose", "callPurpose"],
    custom_prompt: ["custom_prompt", "customPrompt"],
    core_purpose: ["core_purpose", "corePurpose"],
    fallback_message: ["fallback_message", "fallbackMessage"],
    call_transfer_number: ["call_transfer_number", "callTransferNumber"],
    record_calls: ["record_calls", "recordCalls"],
    transcribe_calls: ["transcribe_calls", "transcribeCalls"],
    use_knowledge_base: ["use_knowledge_base", "useKnowledgeBase"],
  };
  for (const [column, keys] of Object.entries(passthrough)) {
    const value = pick(body, ...keys);
    if (value !== undefined) updates[column] = value;
  }
  updates.updated_at = new Date().toISOString();
  return updates;
}

async function loadAgent(db, orgId, agentId) {
  const { data, error } = await db
    .from("voice_agents")
    .select(AGENT_SELECT)
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

router.get(
  "/:agentId/voices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agent = await loadAgent(db, req.orgId, req.params.agentId);
    if (!agent)
      return res
        .status(404)
        .json({
          success: false,
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
        });
    const result = await listVoiceCatalog({ db, provider: "elevenlabs" });
    res.json({
      success: true,
      agentId: agent.id,
      current: {
        voice_provider: agent.voice_provider || "openai",
        elevenlabs_voice_id:
          agent.elevenlabs_voice_id || agent.voice_id || null,
        elevenlabs_voice_name: agent.elevenlabs_voice_name || null,
        voice_settings: agent.voice_settings || {},
      },
      voices: result.voices,
      source: result.source,
      warning: result.warning || undefined,
    });
  }),
);
router.get(
  "/:agentId/voice-config",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agent = await loadAgent(db, req.orgId, req.params.agentId);
    if (!agent)
      return res
        .status(404)
        .json({
          success: false,
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
        });
    res.json({
      success: true,
      agentId: agent.id,
      voice_provider: agent.voice_provider || "openai",
      voice_id: agent.voice_id || null,
      elevenlabs_voice_id: agent.elevenlabs_voice_id || agent.voice_id || null,
      elevenlabs_voice_name: agent.elevenlabs_voice_name || null,
      voice_settings: agent.voice_settings || {},
      tone: agent.tone || null,
      speech_style: agent.speech_style || null,
      call_purpose: agent.call_purpose || null,
      custom_prompt: agent.custom_prompt || null,
      core_purpose: agent.core_purpose || null,
      fallback_message: agent.fallback_message || null,
      call_transfer_number: agent.call_transfer_number || null,
      record_calls: agent.record_calls !== false,
      transcribe_calls: agent.transcribe_calls !== false,
      use_knowledge_base: agent.use_knowledge_base !== false,
    });
  }),
);

router.patch(
  "/:agentId/voice-config",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const updates = buildVoiceUpdates(req.body || {});
    const { data, error } = await db
      .from("voice_agents")
      .update(updates)
      .eq("id", req.params.agentId)
      .eq("organization_id", req.orgId)
      .select(AGENT_SELECT)
      .maybeSingle();
    if (error)
      return res
        .status(500)
        .json({
          success: false,
          error: {
            code: error.code || "UPDATE_FAILED",
            message: error.message || "Failed to update voice config.",
          },
        });
    if (!data)
      return res
        .status(404)
        .json({
          success: false,
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
        });
    res.json({
      success: true,
      agent: serializeAgent(data, []),
      voiceConfig: {
        voice_provider: data.voice_provider,
        elevenlabs_voice_id: data.elevenlabs_voice_id || data.voice_id,
        elevenlabs_voice_name: data.elevenlabs_voice_name,
        voice_settings: data.voice_settings || {},
      },
    });
  }),
);

async function updateAgentVoice(req, res) {
  const db = getSupabase();
  const updates = buildVoiceUpdates(req.body || {});
  const { data, error } = await db
    .from("voice_agents")
    .update(updates)
    .eq("id", req.params.agentId)
    .eq("organization_id", req.orgId)
    .select(AGENT_SELECT)
    .maybeSingle();
  if (error)
    return res
      .status(500)
      .json({
        success: false,
        error: {
          code: error.code || "UPDATE_FAILED",
          message: error.message || "Failed to update voice.",
        },
      });
  if (!data)
    return res
      .status(404)
      .json({
        success: false,
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
      });
  res.json({ success: true, agent: serializeAgent(data, []) });
}

router.post(
  "/:agentId/voice",
  requireAuth,
  requireAdmin,
  asyncHandler(updateAgentVoice),
);
router.patch(
  "/:agentId/voice",
  requireAuth,
  requireAdmin,
  asyncHandler(updateAgentVoice),
);

router.post(
  "/:agentId/test-voice",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agent = await loadAgent(db, req.orgId, req.params.agentId);
    if (!agent)
      return res
        .status(404)
        .json({
          success: false,
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
        });
    const body = req.body || {};
    const voiceId =
      body.elevenlabs_voice_id ||
      body.voiceId ||
      body.voice_id ||
      agent.elevenlabs_voice_id ||
      agent.voice_id;
    const voice = await resolveVoice({ db, provider: "elevenlabs", voiceId });
    const text = normalizePreviewText(
      body.text ||
        agent.greeting ||
        "Hello, this is an ElevenLabs voice test from Agently.",
    );
    const audio = await synthesizeElevenLabsPreview({
      voiceId: voice.voiceId,
      text,
      modelId: body.modelId || body.model_id || voice.modelId,
      outputFormat: body.outputFormat || body.output_format,
      voiceSettings:
        body.voiceSettings || body.voice_settings || agent.voice_settings || {},
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
