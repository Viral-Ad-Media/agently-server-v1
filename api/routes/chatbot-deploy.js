"use strict";

/**
 * Chatbot embed generation.
 *
 * The widget is served directly from YOUR backend at:
 *   GET /chatbot-widget/:chatbotId
 *
 * So the embed script is simply an <iframe> pointing to that URL.
 * No GitHub. No per-client Vercel deployment.
 * This is the same model as your existing Ava chatbot.
 *
 * When the client copies the embed script and pastes it on their site,
 * their visitors see a customized widget that calls YOUR centralized
 * /api/chatbot-public/chat endpoint for AI responses.
 *
 * Config changes (colors, FAQs, greeting) take effect immediately —
 * the widget HTML is rendered fresh on every request from the backend.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeChatbot } = require("../../lib/serializers");

const router = express.Router();

/* Build the iframe embed snippet */
function buildEmbed(chatbot, widgetUrl) {
  const pos = chatbot.position || "right";
  return `<!-- Agently Chat Widget for: ${(chatbot.name || "My Chatbot").replace(/-->/g, "")} -->
<iframe
  id="agently-widget-${chatbot.id}"
  src="${widgetUrl}"
  style="position:fixed;bottom:20px;${pos === "left" ? "left:20px;right:auto" : "right:20px;left:auto"};width:420px;height:700px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);border:none;background:transparent;z-index:2147483646;overflow:hidden;"
  scrolling="no"
  frameborder="0"
  allow="microphone"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
  referrerpolicy="no-referrer-when-downgrade"
  loading="lazy"
  title="Chat widget"
></iframe>`;
}

/* ── POST /api/chatbots/:id/deploy ──────────────────────────── */
/* Generates (or regenerates) the embed script for a chatbot.   */
router.post(
  "/:id/deploy",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: chatbot, error } = await db
      .from("chatbots")
      .select("*")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (error || !chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
    if (!apiUrl) {
      return res
        .status(500)
        .json({
          error: {
            message:
              "API_URL environment variable is not configured on the server.",
          },
        });
    }

    const widgetUrl = `${apiUrl}/chatbot-widget/${id}`;
    const embedScript = buildEmbed(chatbot, widgetUrl);

    /* Save both back to DB */
    const { data: updated } = await db
      .from("chatbots")
      .update({
        widget_script_url: widgetUrl,
        embed_script: embedScript,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    res.json({
      success: true,
      widgetUrl,
      embedScript,
      chatbot: serializeChatbot(updated || chatbot),
    });
  }),
);

/* ── GET /api/chatbots/:id/deploy-status ────────────────────── */
router.get(
  "/:id/deploy-status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: chatbot } = await db
      .from("chatbots")
      .select("id, widget_script_url, embed_script, updated_at")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!chatbot)
      return res.status(404).json({ error: { message: "Chatbot not found." } });

    res.json({
      ready: !!chatbot.widget_script_url,
      widgetUrl: chatbot.widget_script_url || null,
      embedScript: chatbot.embed_script || null,
      updatedAt: chatbot.updated_at,
    });
  }),
);

module.exports = router;
