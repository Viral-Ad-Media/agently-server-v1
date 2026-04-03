"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeChatbot } = require("../../lib/serializers");

const router = express.Router();

function buildEmbedScript(row) {
  const apiUrl = process.env.API_URL || "";
  const pos = row.position || "right";
  return `<iframe 
    id="agently-chatbot-${row.id}"
    src="${apiUrl}/chatbot-widget/${row.id}" 
    style="
        position: fixed;
        bottom: 20px;
        right: ${pos === "left" ? "auto" : "20px"};
        left: ${pos === "left" ? "20px" : "auto"};
        width: 420px;
        height: 700px;
        max-width: 90vw;
        max-height: 90vh;
        border: none;
        background: transparent;
        z-index: 1000000;
        overflow: hidden;
    "
    scrolling="no"
    frameborder="0"
    allow="microphone"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"
    referrerpolicy="no-referrer-when-downgrade"
    onerror="this.style.display='none';"
></iframe>`;
}

// ── POST /api/chatbots ───────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};

    const { data: chatbot, error } = await db
      .from("chatbots")
      .insert({
        organization_id: req.orgId,
        voice_agent_id:
          body.voiceAgentId || req.organization.active_voice_agent_id || null,
        name: body.name || "My Chatbot",
        header_title: body.headerTitle || "Chat with us",
        welcome_message:
          body.welcomeMessage || "Hello! How can I help you today?",
        placeholder: body.placeholder || "Type your message...",
        launcher_label: body.launcherLabel || "Chat",
        accent_color: body.accentColor || "#4f46e5",
        position: body.position || "right",
        avatar_label: body.avatarLabel || "A",
        custom_prompt: body.customPrompt || "",
        suggested_prompts: body.suggestedPrompts || [
          "What are your hours?",
          "How do I get started?",
        ],
        faqs: body.faqs || [],
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create chatbot." } });
    }

    const script = buildEmbedScript(chatbot);
    await db
      .from("chatbots")
      .update({ embed_script: script })
      .eq("id", chatbot.id);
    chatbot.embed_script = script;

    res.status(201).json(serializeChatbot(chatbot));
  }),
);

// ── PATCH /api/chatbots/:id ──────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const body = req.body || {};

    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.voiceAgentId !== undefined)
      updates.voice_agent_id = body.voiceAgentId;
    if (body.headerTitle !== undefined) updates.header_title = body.headerTitle;
    if (body.welcomeMessage !== undefined)
      updates.welcome_message = body.welcomeMessage;
    if (body.placeholder !== undefined) updates.placeholder = body.placeholder;
    if (body.launcherLabel !== undefined)
      updates.launcher_label = body.launcherLabel;
    if (body.accentColor !== undefined) updates.accent_color = body.accentColor;
    if (body.position !== undefined) updates.position = body.position;
    if (body.avatarLabel !== undefined) updates.avatar_label = body.avatarLabel;
    if (body.customPrompt !== undefined)
      updates.custom_prompt = body.customPrompt;
    if (body.suggestedPrompts !== undefined)
      updates.suggested_prompts = body.suggestedPrompts;
    if (body.faqs !== undefined) updates.faqs = body.faqs;
    updates.updated_at = new Date().toISOString();

    const { data: chatbot, error } = await db
      .from("chatbots")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    // Rebuild embed script if position changed
    if (body.position !== undefined) {
      const script = buildEmbedScript(chatbot);
      await db.from("chatbots").update({ embed_script: script }).eq("id", id);
      chatbot.embed_script = script;
    }

    res.json(serializeChatbot(chatbot));
  }),
);

// ── POST /api/chatbots/:id/activate ─────────────────────────
router.post(
  "/:id/activate",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: chatbot } = await db
      .from("chatbots")
      .select("id")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    await db
      .from("chatbots")
      .update({ is_active: false })
      .eq("organization_id", req.orgId);
    await db.from("chatbots").update({ is_active: true }).eq("id", id);
    await db
      .from("organizations")
      .update({ active_chatbot_id: id })
      .eq("id", req.orgId);

    const { data: updated } = await db
      .from("chatbots")
      .select("*")
      .eq("id", id)
      .single();
    res.json(serializeChatbot(updated));
  }),
);

// ── DELETE /api/chatbots/:id ─────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    await db
      .from("chatbots")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    if (req.organization.active_chatbot_id === id) {
      const { data: rem } = await db
        .from("chatbots")
        .select("id")
        .eq("organization_id", req.orgId)
        .limit(1)
        .single();
      await db
        .from("organizations")
        .update({ active_chatbot_id: rem?.id || null })
        .eq("id", req.orgId);
    }

    res.json({ success: true });
  }),
);

// ── GET /api/chatbots/:id/embed ──────────────────────────────
router.get(
  "/:id/embed",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: chatbot } = await db
      .from("chatbots")
      .select("*")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    const script = chatbot.embed_script || buildEmbedScript(chatbot);

    res.json({
      chatbot: serializeChatbot(chatbot),
      script,
    });
  }),
);

module.exports = router;
