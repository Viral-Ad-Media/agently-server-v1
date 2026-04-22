"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeChatbot } = require("../../lib/serializers");
// scraper.service is required lazily inside the scrape route so that a missing
// cheerio dep does not take down the entire /api/chatbots router at load time.

const router = express.Router();

function buildEmbedScript(row) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  const widgetUrl = `${apiUrl}/chatbot-widget/${row.id}`;
  const pos = row.position === "left" ? "left" : "right";
  const opp = pos === "left" ? "right" : "left";
  return {
    widgetUrl,
    embedScript: `<!-- Agently Chat Widget -->\n<iframe\n  id="agently-widget-${row.id}"\n  src="${widgetUrl}"\n  style="position:fixed;bottom:20px;${pos}:20px;${opp}:auto;width:420px;height:700px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);border:none;background:transparent;z-index:2147483646;overflow:hidden;"\n  scrolling="no" frameborder="0" allow="microphone"\n  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"\n  title="Chat widget"\n></iframe>`,
  };
}

// ── POST /api/chatbots ────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const { embedScript, widgetUrl } = buildEmbedScript({
      id: "temp",
      position: body.position || "right",
    });

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
          "How do I book?",
          "What services do you offer?",
        ],
        faqs: body.faqs || [],
        chat_voice: body.chatVoice || "alloy",
        chat_languages: body.chatLanguages || ["en"],
      })
      .select()
      .single();

    if (error)
      return res
        .status(500)
        .json({ error: { message: "Failed to create chatbot." } });

    // Now compute correct embed with real ID
    const { embedScript: realScript, widgetUrl: realUrl } =
      buildEmbedScript(chatbot);
    await db
      .from("chatbots")
      .update({ embed_script: realScript, widget_script_url: realUrl })
      .eq("id", chatbot.id);
    chatbot.embed_script = realScript;
    chatbot.widget_script_url = realUrl;

    res.status(201).json(serializeChatbot(chatbot));
  }),
);

// ── PATCH /api/chatbots/:id ───────────────────────────────────
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
    if (body.chatVoice !== undefined) updates.chat_voice = body.chatVoice;
    if (body.chatLanguages !== undefined)
      updates.chat_languages = body.chatLanguages;
    updates.updated_at = new Date().toISOString();

    // Always recompute embed script (position may have changed)
    const tempRow = { id, position: body.position || "right" };
    const { embedScript, widgetUrl } = buildEmbedScript(tempRow);
    updates.embed_script = embedScript;
    updates.widget_script_url = widgetUrl;

    const { data: chatbot, error } = await db
      .from("chatbots")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !chatbot)
      return res.status(404).json({ error: { message: "Chatbot not found." } });

    res.json(serializeChatbot(chatbot));
  }),
);

// ── POST /api/chatbots/:id/import-website (chunks‑only) ───────
router.post(
  "/:id/import-website",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { website } = req.body;

    if (!website?.trim()) {
      return res
        .status(400)
        .json({ error: { message: "website URL is required." } });
    }

    const db = getSupabase();
    const { data: chatbot } = await db
      .from("chatbots")
      .select("id, voice_agent_id")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    // Lazy-load the scraper so a missing cheerio dep surfaces a clear error
    // instead of bringing down the whole /api/chatbots router at module load.
    let scrapeAndStore;
    try {
      ({ scrapeAndStore } = require("../../lib/scraper.service"));
    } catch (depErr) {
      console.error(
        "[chatbots] scraper.service failed to load:",
        depErr.message,
      );
      return res.status(500).json({
        error: {
          message:
            "Website scraping is temporarily unavailable. A server dependency is missing (cheerio). Please contact support.",
          detail: depErr.message,
        },
      });
    }

    // Use chunks‑only scraper (no FAQ generation)
    const result = await scrapeAndStore({
      url: website,
      chatbotId: id,
      organizationId: req.orgId,
      voiceAgentId: chatbot.voice_agent_id || null,
    });

    res.json({
      success: true,
      chunksStored: result.chunksStored,
      strategy: result.strategy,
      message: `Scraped ${result.chunksStored} content chunks using ${result.strategy}.`,
    });
  }),
);

// ── POST /api/chatbots/:id/activate ──────────────────────────
router.post(
  "/:id/activate",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: chatbot } = await db
      .from("chatbots")
      .select("id, voice_agent_id")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();
    if (!chatbot)
      return res.status(404).json({ error: { message: "Chatbot not found." } });

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

// ── DELETE /api/chatbots/:id ──────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    await db.from("knowledge_chunks").delete().eq("chatbot_id", id);
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

// ── GET /api/chatbots/:id/embed ───────────────────────────────
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
    if (!chatbot)
      return res.status(404).json({ error: { message: "Chatbot not found." } });

    const { embedScript, widgetUrl } = buildEmbedScript(chatbot);
    res.json({
      chatbot: serializeChatbot(chatbot),
      script: embedScript,
      widgetUrl,
    });
  }),
);

module.exports = router;
