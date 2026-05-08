"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  resolveVoice,
  synthesizeSpeech,
  normalizePreviewText,
} = require("../../lib/elevenlabs");
const {
  buildVoiceAgentContext,
  getKnowledgeContextForCall,
} = require("../../lib/voice-agent-context");

const router = express.Router();

function normalizeProvider(value) {
  const provider = String(value || "openai").trim().toLowerCase();
  return provider === "elevenlabs" ? "elevenlabs" : "openai";
}

function numberSetting(value, fallback, min, max) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, base));
}

function normalizeVoiceSettings(body = {}) {
  const raw = body.voiceSettings || body.voice_settings || body.settings || {};
  const out = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (body.stability !== undefined || out.stability !== undefined) out.stability = numberSetting(body.stability ?? out.stability, 0.5, 0, 1);
  if (body.similarity_boost !== undefined || body.similarityBoost !== undefined || out.similarity_boost !== undefined || out.similarityBoost !== undefined) {
    out.similarity_boost = numberSetting(body.similarity_boost ?? body.similarityBoost ?? out.similarity_boost ?? out.similarityBoost, 0.75, 0, 1);
    delete out.similarityBoost;
  }
  if (body.speed !== undefined || out.speed !== undefined) out.speed = numberSetting(body.speed ?? out.speed, 1.0, 0.7, 1.2);
  if (body.style !== undefined || out.style !== undefined) out.style = numberSetting(body.style ?? out.style, 0, 0, 1);
  if (body.use_speaker_boost !== undefined || body.useSpeakerBoost !== undefined || out.use_speaker_boost !== undefined || out.useSpeakerBoost !== undefined) {
    out.use_speaker_boost = Boolean(body.use_speaker_boost ?? body.useSpeakerBoost ?? out.use_speaker_boost ?? out.useSpeakerBoost);
    delete out.useSpeakerBoost;
  }
  return out;
}

async function loadAgent(req, db) {
  const { data, error } = await db
    .from("voice_agents")
    .select("*")
    .eq("id", req.params.agentId)
    .eq("organization_id", req.orgId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function voiceConfigFromAgent(agent = {}) {
  return {
    agentId: agent.id,
    voiceProvider: normalizeProvider(agent.voice_provider),
    voice_provider: normalizeProvider(agent.voice_provider),
    voice: agent.voice || "",
    voiceId: agent.voice_id || agent.elevenlabs_voice_id || "",
    voice_id: agent.voice_id || agent.elevenlabs_voice_id || "",
    elevenlabsVoiceId: agent.elevenlabs_voice_id || agent.voice_id || "",
    elevenlabs_voice_id: agent.elevenlabs_voice_id || agent.voice_id || "",
    elevenlabsVoiceName: agent.elevenlabs_voice_name || "",
    elevenlabs_voice_name: agent.elevenlabs_voice_name || "",
    voiceSettings: agent.voice_settings || {},
    voice_settings: agent.voice_settings || {},
    tone: agent.tone || "Professional",
    speechStyle: agent.speech_style || agent.voice_settings?.speech_style || "",
    speech_style: agent.speech_style || agent.voice_settings?.speech_style || "",
    callPurpose: agent.call_purpose || agent.voice_settings?.call_purpose || "",
    call_purpose: agent.call_purpose || agent.voice_settings?.call_purpose || "",
    customPrompt: agent.custom_prompt || agent.voice_settings?.custom_prompt || "",
    custom_prompt: agent.custom_prompt || agent.voice_settings?.custom_prompt || "",
    corePurpose: agent.core_purpose || agent.voice_settings?.core_purpose || "",
    core_purpose: agent.core_purpose || agent.voice_settings?.core_purpose || "",
    fallbackMessage: agent.fallback_message || agent.voice_settings?.fallback_message || "",
    fallback_message: agent.fallback_message || agent.voice_settings?.fallback_message || "",
    callTransferNumber: agent.call_transfer_number || agent.escalation_phone || "",
    call_transfer_number: agent.call_transfer_number || agent.escalation_phone || "",
    recordCalls: agent.record_calls !== false,
    record_calls: agent.record_calls !== false,
    transcribeCalls: agent.transcribe_calls !== false,
    transcribe_calls: agent.transcribe_calls !== false,
    useKnowledgeBase: agent.use_knowledge_base !== false,
    use_knowledge_base: agent.use_knowledge_base !== false,
    updatedAt: agent.updated_at,
  };
}

async function updateAgentVoice(req, res) {
  const db = getSupabase();
  const agent = await loadAgent(req, db);
  if (!agent) return res.status(404).json({ error: { message: "Agent not found." } });

  const body = req.body || {};
  const provider = normalizeProvider(body.voiceProvider || body.voice_provider || agent.voice_provider);
  const updates = {
    voice_provider: provider,
    voice_settings: normalizeVoiceSettings({ ...agent.voice_settings, ...(body.voiceSettings || body.voice_settings || {}), ...body }),
    updated_at: new Date().toISOString(),
  };

  if (provider === "openai") {
    if (body.voice !== undefined || body.voiceId !== undefined || body.voice_id !== undefined) {
      updates.voice = String(body.voice || body.voiceId || body.voice_id || agent.voice || "alloy");
    }
    updates.elevenlabs_voice_id = null;
    updates.elevenlabs_voice_name = null;
    if (body.voice_id !== undefined || body.voiceId !== undefined) updates.voice_id = String(body.voice_id || body.voiceId || updates.voice || "");
  } else {
    const requestedVoiceId = String(body.elevenlabsVoiceId || body.elevenlabs_voice_id || body.voiceId || body.voice_id || "").trim();
    if (!requestedVoiceId) return res.status(400).json({ error: { code: "VOICE_ID_REQUIRED", message: "ElevenLabs voiceId is required." } });
    const resolved = await resolveVoice({ db, provider: "elevenlabs", voiceId: requestedVoiceId });
    updates.voice_id = resolved.voiceId;
    updates.elevenlabs_voice_id = resolved.voiceId;
    updates.elevenlabs_voice_name = body.elevenlabsVoiceName || body.elevenlabs_voice_name || resolved.displayName || resolved.voiceId;
    updates.voice = updates.elevenlabs_voice_name;
  }

  const { data, error } = await db
    .from("voice_agents")
    .update(updates)
    .eq("id", agent.id)
    .eq("organization_id", req.orgId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  res.json({ success: true, voiceConfig: voiceConfigFromAgent(data || { ...agent, ...updates }) });
}

router.get(
  "/:agentId/voices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { listVoiceCatalog } = require("../../lib/elevenlabs");
    const agent = await loadAgent(req, db);
    if (!agent) return res.status(404).json({ error: { message: "Agent not found." } });
    const result = await listVoiceCatalog({ db, provider: "elevenlabs" });
    res.json({ success: true, agentId: agent.id, current: voiceConfigFromAgent(agent), voices: result.voices || [], source: result.source, warning: result.warning || undefined });
  }),
);

router.get(
  "/:agentId/voice-config",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agent = await loadAgent(req, db);
    if (!agent) return res.status(404).json({ error: { message: "Agent not found." } });
    res.json({ success: true, voiceConfig: voiceConfigFromAgent(agent) });
  }),
);

router.post("/:agentId/voice", requireAuth, requireAdmin, asyncHandler(updateAgentVoice));
router.patch("/:agentId/voice", requireAuth, requireAdmin, asyncHandler(updateAgentVoice));
router.patch("/:agentId/voice-config", requireAuth, requireAdmin, asyncHandler(updateAgentVoice));

router.post(
  "/:agentId/test-voice",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agent = await loadAgent(req, db);
    if (!agent) return res.status(404).json({ error: { message: "Agent not found." } });
    const provider = normalizeProvider(req.body?.voiceProvider || req.body?.voice_provider || agent.voice_provider);
    if (provider !== "elevenlabs") return res.status(400).json({ error: { code: "UNSUPPORTED_PROVIDER", message: "test-voice currently returns audio for ElevenLabs voices only." } });
    const voiceId = String(req.body?.voiceId || req.body?.voice_id || req.body?.elevenlabsVoiceId || req.body?.elevenlabs_voice_id || agent.elevenlabs_voice_id || agent.voice_id || "").trim();
    if (!voiceId) return res.status(400).json({ error: { code: "VOICE_ID_REQUIRED", message: "voiceId is required." } });
    const text = normalizePreviewText(req.body?.text || agent.greeting || agent.welcome_message);
    const audio = await synthesizeSpeech({
      text,
      voiceId,
      modelId: req.body?.modelId || req.body?.model_id,
      outputFormat: req.body?.outputFormat || req.body?.output_format,
      voiceSettings: normalizeVoiceSettings({ ...agent.voice_settings, ...(req.body?.voiceSettings || req.body?.voice_settings || {}) }),
    });
    res.setHeader("Content-Type", audio.mimeType || "audio/mpeg");
    res.setHeader("Content-Length", String(audio.buffer.length));
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("X-Voice-Provider", "elevenlabs");
    res.setHeader("X-Voice-Id", voiceId);
    res.status(200).send(audio.buffer);
  }),
);

router.get(
  "/:agentId/knowledge-context",
  requireAuth,
  asyncHandler(async (req, res) => {
    const context = await getKnowledgeContextForCall({
      tenantId: req.orgId,
      agentId: req.params.agentId,
      query: req.query.q || req.query.query || "",
      callPurpose: req.query.callPurpose || req.query.call_purpose || "",
      leadId: req.query.leadId || req.query.lead_id || "",
      scheduleId: req.query.scheduleId || req.query.schedule_id || "",
    });
    if (!context.agent) return res.status(404).json({ error: { message: "Agent not found." } });
    res.json({ success: true, context });
  }),
);

router.post(
  "/:agentId/knowledge-base/query",
  requireAuth,
  asyncHandler(async (req, res) => {
    const context = await getKnowledgeContextForCall({
      tenantId: req.orgId,
      agentId: req.params.agentId,
      query: req.body?.query || req.body?.message || "",
      callPurpose: req.body?.callPurpose || req.body?.call_purpose || "",
      leadId: req.body?.leadId || req.body?.lead_id || "",
      scheduleId: req.body?.scheduleId || req.body?.schedule_id || "",
    });
    if (!context.agent) return res.status(404).json({ error: { message: "Agent not found." } });
    res.json({ success: true, results: { faqs: context.faqs, knowledgeChunks: context.knowledgeChunks, stats: context.stats } });
  }),
);

router.post(
  "/:agentId/voice-context/preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const context = await buildVoiceAgentContext({
      tenantId: req.orgId,
      agentId: req.params.agentId,
      leadId: req.body?.leadId || req.body?.lead_id || "",
      scheduleId: req.body?.scheduleId || req.body?.schedule_id || "",
      callDirection: req.body?.callDirection || req.body?.call_direction || "inbound",
      userUtterance: req.body?.userUtterance || req.body?.user_utterance || req.body?.query || "",
      callPurposeOverride: req.body?.callPurpose || req.body?.call_purpose || "",
    });
    if (!context.agent) return res.status(404).json({ error: { message: "Agent not found." } });
    res.json({ success: true, context });
  }),
);

router.patch(
  "/:agentId/knowledge-settings",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agent = await loadAgent(req, db);
    if (!agent) return res.status(404).json({ error: { message: "Agent not found." } });
    const existing = agent.voice_settings && typeof agent.voice_settings === "object" ? agent.voice_settings : {};
    const updates = { voice_settings: { ...existing }, updated_at: new Date().toISOString() };
    if (req.body?.useKnowledgeBase !== undefined || req.body?.use_knowledge_base !== undefined) {
      updates.use_knowledge_base = Boolean(req.body.useKnowledgeBase ?? req.body.use_knowledge_base);
      updates.voice_settings.use_knowledge_base = updates.use_knowledge_base;
    }
    if (req.body?.fallbackMessage !== undefined || req.body?.fallback_message !== undefined) {
      updates.fallback_message = String(req.body.fallbackMessage ?? req.body.fallback_message ?? "");
      updates.voice_settings.fallback_message = updates.fallback_message;
    }
    if (req.body?.corePurpose !== undefined || req.body?.core_purpose !== undefined) {
      updates.core_purpose = String(req.body.corePurpose ?? req.body.core_purpose ?? "");
      updates.voice_settings.core_purpose = updates.core_purpose;
    }
    const { data, error } = await db.from("voice_agents").update(updates).eq("id", agent.id).eq("organization_id", req.orgId).select("*").maybeSingle();
    if (error) throw error;
    res.json({ success: true, voiceConfig: voiceConfigFromAgent(data || { ...agent, ...updates }) });
  }),
);

module.exports = router;
