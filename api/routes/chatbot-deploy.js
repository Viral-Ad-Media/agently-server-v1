"use strict";

/**
 * Chatbot embed generation.
 *
 * The widget is served directly from the backend at:
 *   GET /chatbot-widget/:chatbotId
 *
 * The copied embed script keeps the iframe collapsed to the launcher size until
 * the widget posts an "open" message. When opened, the iframe becomes a rounded,
 * responsive panel without covering the customer site unnecessarily.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeChatbot } = require("../../lib/serializers");
const { buildEmbedForChatbot, getApiBaseUrl } = require("../../lib/chatbot-widget-utils");

const router = express.Router();

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

    const apiUrl = getApiBaseUrl(req);
    if (!apiUrl) {
      return res.status(500).json({
        error: {
          message: "API_URL environment variable is not configured on the server.",
        },
      });
    }

    const { embedScript, widgetUrl } = buildEmbedForChatbot(chatbot, apiUrl);

    const { data: updated, error: updateError } = await db
      .from("chatbots")
      .update({ embed_script: embedScript, widget_script_url: widgetUrl })
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (updateError || !updated) {
      return res.status(500).json({
        error: { message: "Failed to save chatbot deployment script." },
      });
    }

    res.json({
      success: true,
      chatbot: serializeChatbot(updated),
      script: embedScript,
      widgetUrl,
    });
  }),
);

module.exports = router;
