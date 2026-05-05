"use strict";

const crypto = require("crypto");

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_PREVIEW_TEXT =
  "Hello, welcome to Agently AI receptionist service. How can I help you today?";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function elevenLabsConfig() {
  return {
    apiKey: env("ELEVENLABS_API_KEY"),
    defaultModel: env("ELEVENLABS_DEFAULT_MODEL", "eleven_flash_v2_5"),
    fallbackModel: env("ELEVENLABS_FALLBACK_MODEL", "eleven_multilingual_v2"),
    previewOutputFormat: env("ELEVENLABS_PREVIEW_OUTPUT_FORMAT", "mp3_44100_128"),
    telephonyOutputFormat: env("ELEVENLABS_TWILIO_OUTPUT_FORMAT", "ulaw_8000"),
    stability: Number(env("ELEVENLABS_STABILITY", "0.65")),
    similarityBoost: Number(env("ELEVENLABS_SIMILARITY_BOOST", "0.8")),
    style: Number(env("ELEVENLABS_STYLE", "0.2")),
    speed: Number(env("ELEVENLABS_SPEED", "1.0")),
    useSpeakerBoost:
      env("ELEVENLABS_USE_SPEAKER_BOOST", "true").toLowerCase() !== "false",
  };
}

function isMissingTableError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("voice_catalog")
  );
}

function previewCacheKey({ provider, voiceId, text, modelId, outputFormat }) {
  return crypto
    .createHash("sha256")
    .update([provider, voiceId, text, modelId, outputFormat].join("\n"))
    .digest("hex");
}

function normalizePreviewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_PREVIEW_TEXT;
  return text.slice(0, Number(process.env.ELEVENLABS_PREVIEW_MAX_CHARS || 280));
}

function serializeCatalogRow(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: row.id || row.voice_id,
    provider: row.provider || "elevenlabs",
    displayName: row.display_name || row.name || metadata.name || row.voice_id,
    voiceId: row.voice_id || row.id,
    gender: row.gender || metadata.gender || null,
    language: row.language || metadata.language || null,
    accent: row.accent || metadata.accent || null,
    modelId: row.model_id || metadata.model_id || elevenLabsConfig().defaultModel,
    previewAvailable: true,
    metadata,
  };
}

function serializeElevenLabsVoice(voice) {
  const labels = voice?.labels && typeof voice.labels === "object" ? voice.labels : {};
  const fineTuning = voice?.fine_tuning && typeof voice.fine_tuning === "object" ? voice.fine_tuning : {};
  return {
    id: voice.voice_id,
    provider: "elevenlabs",
    displayName: voice.name || voice.voice_id,
    voiceId: voice.voice_id,
    gender: labels.gender || null,
    language: labels.language || labels.languages || null,
    accent: labels.accent || null,
    modelId: elevenLabsConfig().defaultModel,
    previewAvailable: true,
    metadata: {
      category: voice.category || null,
      description: voice.description || null,
      labels,
      fine_tuning: fineTuning,
      preview_url: voice.preview_url || null,
    },
  };
}

async function fetchElevenLabsVoices() {
  const { apiKey } = elevenLabsConfig();
  if (!apiKey) {
    const err = new Error("ELEVENLABS_API_KEY is not configured.");
    err.code = "ELEVENLABS_API_KEY_MISSING";
    throw err;
  }
  const res = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
    method: "GET",
    headers: { "xi-api-key": apiKey },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      data?.detail?.message || data?.message || `ElevenLabs voices request failed: ${res.status}`,
    );
    err.status = res.status;
    err.raw = data;
    throw err;
  }
  return (data?.voices || []).map(serializeElevenLabsVoice).filter((v) => v.voiceId);
}

async function listVoiceCatalog({ db, provider = "elevenlabs" } = {}) {
  if (db) {
    try {
      const { data, error } = await db
        .from("voice_catalog")
        .select("id,provider,display_name,voice_id,gender,language,accent,model_id,is_active,metadata,created_at")
        .eq("provider", provider)
        .eq("is_active", true)
        .order("display_name", { ascending: true });
      if (error) throw error;
      if (Array.isArray(data) && data.length) {
        return { source: "database", voices: data.map(serializeCatalogRow) };
      }
    } catch (error) {
      if (!isMissingTableError(error)) {
        console.warn("[voices] voice_catalog query failed:", error.message || String(error));
      }
    }
  }

  try {
    const voices = await fetchElevenLabsVoices();
    return { source: "elevenlabs_api", voices };
  } catch (error) {
    if (error.code === "ELEVENLABS_API_KEY_MISSING") {
      return { source: "unconfigured", voices: [], warning: error.message };
    }
    throw error;
  }
}

async function resolveVoice({ db, provider = "elevenlabs", voiceId }) {
  const requested = String(voiceId || "").trim();
  if (!requested) {
    const err = new Error("voiceId is required.");
    err.status = 400;
    err.code = "VOICE_ID_REQUIRED";
    throw err;
  }

  if (db) {
    try {
      const { data, error } = await db
        .from("voice_catalog")
        .select("id,provider,display_name,voice_id,gender,language,accent,model_id,is_active,metadata")
        .eq("provider", provider)
        .eq("is_active", true)
        .or(`id.eq.${requested},voice_id.eq.${requested}`)
        .maybeSingle();
      if (error) throw error;
      if (data?.voice_id) return serializeCatalogRow(data);
    } catch (error) {
      if (!isMissingTableError(error)) {
        console.warn("[voices] voice lookup failed:", error.message || String(error));
      }
    }
  }

  return {
    id: requested,
    provider,
    displayName: requested,
    voiceId: requested,
    gender: null,
    language: null,
    accent: null,
    modelId: elevenLabsConfig().defaultModel,
    previewAvailable: true,
    metadata: { source: "request_voice_id" },
  };
}

async function synthesizeElevenLabsPreview({ voiceId, text, modelId, outputFormat }) {
  const config = elevenLabsConfig();
  if (!config.apiKey) {
    const err = new Error("ELEVENLABS_API_KEY is not configured.");
    err.status = 503;
    err.code = "ELEVENLABS_API_KEY_MISSING";
    throw err;
  }
  const cleanText = normalizePreviewText(text);
  const selectedModel = String(modelId || config.defaultModel).trim();
  const selectedOutputFormat = String(outputFormat || config.previewOutputFormat).trim();
  const url = `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(
    voiceId,
  )}/stream?output_format=${encodeURIComponent(selectedOutputFormat)}`;

  const body = {
    text: cleanText,
    model_id: selectedModel,
    voice_settings: {
      stability: config.stability,
      similarity_boost: config.similarityBoost,
      style: config.style,
      speed: config.speed,
      use_speaker_boost: config.useSpeakerBoost,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    let parsed;
    try {
      parsed = JSON.parse(errorText);
    } catch {
      parsed = { message: errorText };
    }
    const err = new Error(
      parsed?.detail?.message || parsed?.message || `ElevenLabs preview failed: ${res.status}`,
    );
    err.status = res.status;
    err.raw = parsed;
    throw err;
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return {
    buffer,
    mimeType: res.headers.get("content-type") || "audio/mpeg",
    text: cleanText,
    modelId: selectedModel,
    outputFormat: selectedOutputFormat,
    cacheKey: previewCacheKey({
      provider: "elevenlabs",
      voiceId,
      text: cleanText,
      modelId: selectedModel,
      outputFormat: selectedOutputFormat,
    }),
  };
}

module.exports = {
  elevenLabsConfig,
  listVoiceCatalog,
  resolveVoice,
  synthesizeElevenLabsPreview,
  normalizePreviewText,
};
