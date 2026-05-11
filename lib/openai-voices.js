"use strict";

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_RESPONSE_FORMAT = process.env.OPENAI_TTS_RESPONSE_FORMAT || "mp3";
const OPENAI_TTS_PREVIEW_TEXT =
  process.env.OPENAI_TTS_PREVIEW_TEXT ||
  "Hello, this is an OpenAI voice preview from Agently.";

// Built-in OpenAI Speech API voices. OpenAI does not currently expose a
// public "list voices" endpoint like ElevenLabs, so we keep this canonical
// supported list in one backend module and expose it through the API.
const OPENAI_VOICES = [
  { id: "alloy", name: "Alloy", displayName: "Alloy", tone: "Balanced, neutral, versatile" },
  { id: "ash", name: "Ash", displayName: "Ash", tone: "Calm, steady, clear" },
  { id: "ballad", name: "Ballad", displayName: "Ballad", tone: "Warm, expressive, storytelling" },
  { id: "coral", name: "Coral", displayName: "Coral", tone: "Bright, friendly, upbeat" },
  { id: "echo", name: "Echo", displayName: "Echo", tone: "Clear, direct, professional" },
  { id: "fable", name: "Fable", displayName: "Fable", tone: "Narrative, warm, characterful" },
  { id: "nova", name: "Nova", displayName: "Nova", tone: "Friendly, polished, energetic" },
  { id: "onyx", name: "Onyx", displayName: "Onyx", tone: "Deep, confident, authoritative" },
  { id: "sage", name: "Sage", displayName: "Sage", tone: "Measured, composed, helpful" },
  { id: "shimmer", name: "Shimmer", displayName: "Shimmer", tone: "Soft, pleasant, approachable" },
  { id: "verse", name: "Verse", displayName: "Verse", tone: "Expressive, modern, conversational" },
  { id: "marin", name: "Marin", displayName: "Marin", tone: "Natural, high-quality, recommended" },
  { id: "cedar", name: "Cedar", displayName: "Cedar", tone: "Natural, high-quality, recommended" },
];

const LEGACY_TTS_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
]);

function getOpenAIApiKey() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    const err = new Error("OPENAI_API_KEY is not configured.");
    err.status = 503;
    err.code = "OPENAI_API_KEY_MISSING";
    throw err;
  }
  return key;
}

function normalizeVoiceId(value, fallback = "alloy") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const match = OPENAI_VOICES.find((voice) => voice.id === raw);
  return match ? match.id : fallback;
}

function normalizeTtsModel(model) {
  const raw = String(model || OPENAI_TTS_MODEL || "gpt-4o-mini-tts").trim();
  if (["tts-1", "tts-1-hd", "gpt-4o-mini-tts"].includes(raw)) return raw;
  if (raw.startsWith("gpt-4o-mini-tts")) return raw;
  return "gpt-4o-mini-tts";
}

function supportedByModel(voiceId, model) {
  const m = normalizeTtsModel(model);
  if (m === "tts-1" || m === "tts-1-hd") return LEGACY_TTS_VOICES.has(voiceId);
  return OPENAI_VOICES.some((voice) => voice.id === voiceId);
}

function listOpenAIVoices({ model } = {}) {
  const resolvedModel = normalizeTtsModel(model);
  const voices = OPENAI_VOICES.map((voice) => ({
    id: voice.id,
    provider: "openai",
    name: voice.name,
    displayName: voice.displayName,
    voice_id: voice.id,
    voiceId: voice.id,
    model_id: resolvedModel,
    modelId: resolvedModel,
    category: "built_in",
    previewAvailable: true,
    supports_model: supportedByModel(voice.id, resolvedModel),
    tone: voice.tone,
    metadata: {
      source: "openai_builtin_supported_voices",
      recommended: voice.id === "marin" || voice.id === "cedar",
      legacy_tts_supported: LEGACY_TTS_VOICES.has(voice.id),
    },
  }));
  return {
    provider: "openai",
    source: "openai_builtin_supported_voices",
    model: resolvedModel,
    count: voices.length,
    voices,
  };
}

function normalizePreviewText(text) {
  const fallback = OPENAI_TTS_PREVIEW_TEXT;
  const raw = String(text || fallback).replace(/\s+/g, " ").trim();
  return raw.slice(0, 1200) || fallback;
}

function normalizeSpeed(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number(process.env.OPENAI_TTS_SPEED || 1);
  return Math.max(0.25, Math.min(4, num));
}

function mimeForFormat(format) {
  const f = String(format || "mp3").toLowerCase();
  if (f === "wav") return "audio/wav";
  if (f === "opus") return "audio/opus";
  if (f === "aac") return "audio/aac";
  if (f === "flac") return "audio/flac";
  if (f === "pcm") return "audio/L16";
  return "audio/mpeg";
}

async function synthesizeOpenAIPreview({
  voiceId,
  text,
  model,
  responseFormat,
  speed,
  instructions,
} = {}) {
  const resolvedModel = normalizeTtsModel(model);
  const resolvedVoice = normalizeVoiceId(voiceId, process.env.OPENAI_TTS_DEFAULT_VOICE || "alloy");
  if (!supportedByModel(resolvedVoice, resolvedModel)) {
    const err = new Error(`Voice '${resolvedVoice}' is not supported by model '${resolvedModel}'.`);
    err.status = 400;
    err.code = "OPENAI_VOICE_MODEL_UNSUPPORTED";
    throw err;
  }

  const response_format = String(responseFormat || OPENAI_TTS_RESPONSE_FORMAT || "mp3").toLowerCase();
  const body = {
    model: resolvedModel,
    voice: resolvedVoice,
    input: normalizePreviewText(text),
    response_format,
    speed: normalizeSpeed(speed),
  };
  const finalInstructions = String(instructions || process.env.OPENAI_TTS_INSTRUCTIONS || "").trim();
  if (finalInstructions && resolvedModel !== "tts-1" && resolvedModel !== "tts-1-hd") {
    body.instructions = finalInstructions.slice(0, 1000);
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOpenAIApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch (_) {}
    const err = new Error(`OpenAI speech preview failed with HTTP ${response.status}.`);
    err.status = response.status;
    err.code = "OPENAI_TTS_PREVIEW_FAILED";
    err.detail = detail.slice(0, 1000);
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    provider: "openai",
    voiceId: resolvedVoice,
    model: resolvedModel,
    responseFormat: response_format,
    mimeType: response.headers.get("content-type") || mimeForFormat(response_format),
    buffer: Buffer.from(arrayBuffer),
    request: body,
  };
}

module.exports = {
  OPENAI_VOICES,
  listOpenAIVoices,
  normalizeVoiceId,
  normalizeTtsModel,
  normalizePreviewText,
  synthesizeOpenAIPreview,
  supportedByModel,
};
