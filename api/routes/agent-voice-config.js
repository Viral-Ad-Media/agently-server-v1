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
  normalizePreviewText: normalizeElevenLabsPreviewText,
} = require("../../lib/elevenlabs");
const {
  listOpenAIVoices,
  normalizeVoiceId: normalizeOpenAIVoiceId,
  synthesizeOpenAIPreview,
  normalizePreviewText: normalizeOpenAIPreviewText,
} = require("../../lib/openai-voices");

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

function normalizeElevenLabsSettings(value = {}) {
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

function normalizeOpenAISettings(value = {}) {
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const speed = Number(input.speed ?? process.env.OPENAI_TTS_SPEED ?? 1);
  const settings = {
    model: String(
      input.model ||
        input.model_id ||
        input.modelId ||
        process.env.OPENAI_TTS_MODEL ||
        "gpt-4o-mini-tts",
    ),
    response_format: String(
      input.response_format ||
        input.responseFormat ||
        process.env.OPENAI_TTS_RESPONSE_FORMAT ||
        "mp3",
    ),
    speed: Math.max(0.25, Math.min(4, Number.isFinite(speed) ? speed : 1)),
  };
  const instructions = String(
    input.instructions || process.env.OPENAI_TTS_INSTRUCTIONS || "",
  ).trim();
  if (instructions) settings.instructions = instructions.slice(0, 1000);
  return settings;
}

function pick(body, ...names) {
  for (const name of names) if (body[name] !== undefined) return body[name];
  return undefined;
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

function toElevenLabsFrontendVoice(voice) {
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

function buildVoiceUpdates(body = {}) {
  const updates = {};
  const provider = normalizeProvider(
    pick(body, "voice_provider", "voiceProvider", "provider"),
    "openai",
  );
  const providerWasProvided =
    pick(body, "voice_provider", "voiceProvider", "provider") !== undefined;
  const settings = pick(body, "voice_settings", "voiceSettings");

  if (providerWasProvided) updates.voice_provider = provider;

  if (provider === "openai") {
    const rawOpenAIVoice = pick(
      body,
      "openai_voice_id",
      "openaiVoiceId",
      "voiceId",
      "voice_id",
      "voice",
    );
    if (rawOpenAIVoice !== undefined || providerWasProvided) {
      updates.voice_id = normalizeOpenAIVoiceId(
        rawOpenAIVoice,
        process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy",
      );
      updates.voice_catalog_id = null;
      updates.elevenlabs_voice_id = null;
      updates.elevenlabs_voice_name = null;
    }
    if (settings !== undefined)
      updates.voice_settings = normalizeOpenAISettings(settings || {});
  } else {
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
    if (elevenId !== undefined) {
      updates.elevenlabs_voice_id = String(elevenId || "").trim() || null;
      updates.voice_id = updates.elevenlabs_voice_id;
      updates.voice_catalog_id = null;
    }
    if (elevenName !== undefined)
      updates.elevenlabs_voice_name = String(elevenName || "").trim() || null;
    if (settings !== undefined)
      updates.voice_settings = normalizeElevenLabsSettings(settings || {});
  }

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
    const provider = normalizeProvider(
      req.query.provider || agent.voice_provider || "openai",
      "openai",
    );

    if (provider === "openai") {
      const result = listOpenAIVoices({
        model:
          req.query.model || req.query.model_id || agent.voice_settings?.model,
      });
      return res.json({
        success: true,
        agentId: agent.id,
        provider: "openai",
        current: {
          voice_provider: agent.voice_provider || "openai",
          voice_id:
            agent.voice_id || process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy",
          openai_voice_id:
            agent.voice_id || process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy",
          voice_settings: agent.voice_settings || {},
        },
        voices: result.voices,
        count: result.voices.length,
        source: result.source,
        model: result.model,
      });
    }

    const source = String(req.query.source || "api").toLowerCase();
    const result = await listVoiceCatalog({
      db,
      provider: "elevenlabs",
      source,
      preferApi: source !== "catalog",
    });
    res.json({
      success: true,
      agentId: agent.id,
      provider: "elevenlabs",
      current: {
        voice_provider: agent.voice_provider || "openai",
        elevenlabs_voice_id:
          agent.elevenlabs_voice_id || agent.voice_id || null,
        elevenlabs_voice_name: agent.elevenlabs_voice_name || null,
        voice_settings: agent.voice_settings || {},
      },
      voices: result.voices.map(toElevenLabsFrontendVoice),
      count: result.voices.length,
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
      openai_voice_id:
        (agent.voice_provider || "openai") === "openai"
          ? agent.voice_id || process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy"
          : null,
      elevenlabs_voice_id:
        agent.elevenlabs_voice_id ||
        ((agent.voice_provider || "") === "elevenlabs" ? agent.voice_id : null),
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
        voice_provider: data.voice_provider || "openai",
        voice_id: data.voice_id || null,
        openai_voice_id:
          (data.voice_provider || "openai") === "openai"
            ? data.voice_id || null
            : null,
        elevenlabs_voice_id:
          data.elevenlabs_voice_id ||
          ((data.voice_provider || "") === "elevenlabs" ? data.voice_id : null),
        elevenlabs_voice_name: data.elevenlabs_voice_name || null,
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
    const provider = normalizeProvider(
      body.voice_provider || body.provider || agent.voice_provider || "openai",
      "openai",
    );
    const text =
      body.text ||
      agent.greeting ||
      "Hello, this is a voice test from Agently.";

    if (provider === "openai") {
      const settings =
        body.voiceSettings || body.voice_settings || agent.voice_settings || {};
      const audio = await synthesizeOpenAIPreview({
        voiceId:
          body.openai_voice_id ||
          body.voiceId ||
          body.voice_id ||
          body.voice ||
          agent.voice_id ||
          process.env.OPENAI_TTS_DEFAULT_VOICE ||
          "alloy",
        text: normalizeOpenAIPreviewText(text),
        model:
          body.model || body.model_id || settings.model || settings.model_id,
        responseFormat:
          body.responseFormat ||
          body.response_format ||
          settings.response_format,
        speed: body.speed || settings.speed,
        instructions: body.instructions || settings.instructions,
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

    const voiceId =
      body.elevenlabs_voice_id ||
      body.voiceId ||
      body.voice_id ||
      agent.elevenlabs_voice_id ||
      agent.voice_id;
    const voice = await resolveVoice({ db, provider: "elevenlabs", voiceId });
    const audio = await synthesizeElevenLabsPreview({
      voiceId: voice.voiceId,
      text: normalizeElevenLabsPreviewText(text),
      modelId: body.modelId || body.model_id || voice.modelId,
      outputFormat: body.outputFormat || body.output_format,
      voiceSettings:
        body.voiceSettings || body.voice_settings || agent.voice_settings || {},
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
    res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
