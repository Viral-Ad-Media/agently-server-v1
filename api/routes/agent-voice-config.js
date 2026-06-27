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
const {
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

function normalizeOpenAiSettings(value = {}) {
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const speedNum = Number(input.speed ?? process.env.OPENAI_TTS_SPEED ?? 1);
  return {
    model: String(
      input.model || process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    ),
    response_format: String(
      input.response_format ||
        input.responseFormat ||
        process.env.OPENAI_TTS_RESPONSE_FORMAT ||
        "mp3",
    ),
    speed: Math.max(
      0.25,
      Math.min(4, Number.isFinite(speedNum) ? speedNum : 1),
    ),
    ...(input.instructions || process.env.OPENAI_TTS_INSTRUCTIONS
      ? {
          instructions: String(
            input.instructions || process.env.OPENAI_TTS_INSTRUCTIONS,
          ),
        }
      : {}),
  };
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

function buildVoiceUpdates(body = {}) {
  const updates = {};
  const providerInput = pick(
    body,
    "voice_provider",
    "voiceProvider",
    "provider",
  );
  const hasExplicitElevenLabsSelection =
    pick(
      body,
      "elevenlabs_voice_id",
      "elevenLabsVoiceId",
      "elevenlabs_voice_name",
      "elevenLabsVoiceName",
    ) !== undefined;
  const hasExplicitOpenAiSelection =
    pick(body, "openai_voice_id", "openaiVoiceId", "openai_voice") !==
    undefined;
  const provider =
    providerInput !== undefined
      ? normalizeProvider(providerInput, "openai")
      : hasExplicitElevenLabsSelection
        ? "elevenlabs"
        : hasExplicitOpenAiSelection
          ? "openai"
          : undefined;
  const settings = pick(body, "voice_settings", "voiceSettings");

  if (provider !== undefined) updates.voice_provider = provider;

  if (provider === "elevenlabs") {
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
      "displayName",
      "name",
    );
    const normalizedId = String(elevenId || "").trim() || null;
    const normalizedName = String(elevenName || "").trim() || null;

    updates.elevenlabs_voice_id = normalizedId;
    updates.elevenlabs_voice_name = normalizedName;
    updates.voice_id = normalizedId;
    // Keep the legacy display column synchronized so old list endpoints do not show stale Sarah/Josh/Domi values.
    updates.voice = normalizedName || normalizedId || null;
    updates.voice_catalog_id = null;
    if (settings !== undefined)
      updates.voice_settings = normalizeElevenLabsSettings(settings || {});
  } else if (provider === "openai") {
    const openAiId = pick(
      body,
      "openai_voice_id",
      "openaiVoiceId",
      "voice_id",
      "voiceId",
      "voice",
    );
    const normalizedId =
      String(
        openAiId || process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy",
      ).trim() || "alloy";

    updates.voice_id = normalizedId;
    updates.voice = normalizedId;
    updates.elevenlabs_voice_id = null;
    updates.elevenlabs_voice_name = null;
    updates.voice_catalog_id = null;
    updates.voice_settings = normalizeOpenAiSettings(settings || {});
  } else {
    const genericVoice = pick(body, "voice", "voice_id", "voiceId");
    if (genericVoice !== undefined) {
      updates.voice = String(genericVoice || "").trim() || null;
      updates.voice_id = updates.voice;
    }
    if (settings !== undefined) updates.voice_settings = settings || {};
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
      return res.status(404).json({
        success: false,
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
      });
    const result = await listVoiceCatalog({ db, provider: "elevenlabs" });
    res.json({
      success: true,
      agentId: agent.id,
      current: {
        voice_provider: agent.voice_provider || "openai",
        voice: agent.voice || null,
        voice_id: agent.voice_id || null,
        openai_voice_id:
          agent.voice_provider === "openai"
            ? agent.voice_id || agent.voice || null
            : null,
        elevenlabs_voice_id:
          agent.voice_provider === "elevenlabs"
            ? agent.elevenlabs_voice_id || agent.voice_id || null
            : null,
        elevenlabs_voice_name:
          agent.voice_provider === "elevenlabs"
            ? agent.elevenlabs_voice_name || null
            : null,
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
      return res.status(404).json({
        success: false,
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
      });
    res.json({
      success: true,
      agentId: agent.id,
      voice_provider: agent.voice_provider || "openai",
      voice: agent.voice || null,
      voice_id: agent.voice_id || null,
      openai_voice_id:
        agent.voice_provider === "openai"
          ? agent.voice_id || agent.voice || null
          : null,
      elevenlabs_voice_id:
        agent.voice_provider === "elevenlabs"
          ? agent.elevenlabs_voice_id || agent.voice_id || null
          : null,
      elevenlabs_voice_name:
        agent.voice_provider === "elevenlabs"
          ? agent.elevenlabs_voice_name || null
          : null,
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
    console.log("[voice-config] save request", {
      agentId: req.params.agentId,
      provider:
        updates.voice_provider ||
        req.body?.voice_provider ||
        req.body?.voiceProvider ||
        "",
      selectedName:
        updates.elevenlabs_voice_name ||
        updates.voice ||
        req.body?.elevenlabs_voice_name ||
        req.body?.voiceName ||
        req.body?.voice ||
        "",
      selectedVoiceId:
        updates.elevenlabs_voice_id ||
        updates.voice_id ||
        req.body?.elevenlabs_voice_id ||
        req.body?.voiceId ||
        req.body?.voice_id ||
        "",
    });
    const { data, error } = await db
      .from("voice_agents")
      .update(updates)
      .eq("id", req.params.agentId)
      .eq("organization_id", req.orgId)
      .select(AGENT_SELECT)
      .maybeSingle();
    if (error)
      return res.status(500).json({
        success: false,
        error: {
          code: error.code || "UPDATE_FAILED",
          message: error.message || "Failed to update voice config.",
        },
      });
    if (!data)
      return res.status(404).json({
        success: false,
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
      });
    console.log("[voice-config] db after save", {
      agentId: data.id,
      voice_provider: data.voice_provider || "",
      elevenlabs_voice_id: data.elevenlabs_voice_id || "",
      elevenlabs_voice_name: data.elevenlabs_voice_name || "",
      voice_id: data.voice_id || "",
      voice: data.voice || "",
    });
    res.json({
      success: true,
      agent: serializeAgent(data, []),
      voiceConfig: {
        voice_provider: data.voice_provider,
        voice: data.voice || null,
        voice_id: data.voice_id || null,
        openai_voice_id:
          data.voice_provider === "openai"
            ? data.voice_id || data.voice || null
            : null,
        elevenlabs_voice_id:
          data.voice_provider === "elevenlabs"
            ? data.elevenlabs_voice_id || data.voice_id || null
            : null,
        elevenlabs_voice_name:
          data.voice_provider === "elevenlabs"
            ? data.elevenlabs_voice_name
            : null,
        voice_settings: data.voice_settings || {},
      },
    });
  }),
);

async function updateAgentVoice(req, res) {
  const db = getSupabase();
  const updates = buildVoiceUpdates(req.body || {});
  console.log("[voice-config] save request", {
    agentId: req.params.agentId,
    provider:
      updates.voice_provider ||
      req.body?.voice_provider ||
      req.body?.voiceProvider ||
      "",
    selectedName:
      updates.elevenlabs_voice_name ||
      updates.voice ||
      req.body?.elevenlabs_voice_name ||
      req.body?.voiceName ||
      req.body?.voice ||
      "",
    selectedVoiceId:
      updates.elevenlabs_voice_id ||
      updates.voice_id ||
      req.body?.elevenlabs_voice_id ||
      req.body?.voiceId ||
      req.body?.voice_id ||
      "",
  });
  const { data, error } = await db
    .from("voice_agents")
    .update(updates)
    .eq("id", req.params.agentId)
    .eq("organization_id", req.orgId)
    .select(AGENT_SELECT)
    .maybeSingle();
  if (error)
    return res.status(500).json({
      success: false,
      error: {
        code: error.code || "UPDATE_FAILED",
        message: error.message || "Failed to update voice.",
      },
    });
  if (!data)
    return res.status(404).json({
      success: false,
      error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
    });
  console.log("[voice-config] db after save", {
    agentId: data.id,
    voice_provider: data.voice_provider || "",
    elevenlabs_voice_id: data.elevenlabs_voice_id || "",
    elevenlabs_voice_name: data.elevenlabs_voice_name || "",
    voice_id: data.voice_id || "",
    voice: data.voice || "",
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
      return res.status(404).json({
        success: false,
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
      });

    const body = req.body || {};
    const provider = normalizeProvider(
      body.voice_provider ||
        body.voiceProvider ||
        body.provider ||
        agent.voice_provider,
      "openai",
    );
    const settings =
      body.voiceSettings || body.voice_settings || agent.voice_settings || {};

    if (provider === "openai") {
      const voiceId =
        body.openai_voice_id ||
        body.openaiVoiceId ||
        body.voiceId ||
        body.voice_id ||
        body.voice ||
        agent.voice_id ||
        agent.voice ||
        process.env.OPENAI_TTS_DEFAULT_VOICE ||
        "alloy";
      const audio = await synthesizeOpenAIPreview({
        voiceId,
        text: normalizeOpenAIPreviewText(
          body.text ||
            agent.greeting ||
            "Hello, this is an OpenAI voice test from Agently.",
        ),
        model:
          body.model ||
          body.model_id ||
          body.modelId ||
          settings.model ||
          process.env.OPENAI_TTS_MODEL ||
          "gpt-4o-mini-tts",
        responseFormat:
          body.response_format ||
          body.responseFormat ||
          body.output_format ||
          body.outputFormat ||
          settings.response_format ||
          settings.responseFormat ||
          process.env.OPENAI_TTS_RESPONSE_FORMAT ||
          "mp3",
        speed:
          body.speed || settings.speed || process.env.OPENAI_TTS_SPEED || 1,
        instructions:
          body.instructions ||
          settings.instructions ||
          process.env.OPENAI_TTS_INSTRUCTIONS ||
          "",
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
      return res.status(200).send(audio.buffer);
    }

    const voiceId =
      body.elevenlabs_voice_id ||
      body.elevenLabsVoiceId ||
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
      voiceSettings: settings,
      usageContext: {
        organizationId: req.orgId,
        userId: req.user?.id,
        voiceAgentId: agent.id,
        service: "voice_preview",
        route: "agent_voice_config.test_voice",
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
        mimeType: audio.mimeType || "audio/mpeg",
        audioBase64: audio.buffer.toString("base64"),
        size: audio.buffer.length,
      });
    }
    res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
    res.setHeader("Content-Length", String(audio.buffer.length));
    return res.status(200).send(audio.buffer);
  }),
);

module.exports = router;
