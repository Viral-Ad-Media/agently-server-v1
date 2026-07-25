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
  const id = `agently-widget-${chatbot.id}`;
  const safeName = (chatbot.name || "My Chatbot").replace(/-->/g, "");

  return `<!-- Agently Chat Widget for: ${safeName} -->
<style>
  #${id}{
    position:fixed;
    bottom:16px;
    ${pos === "left" ? "left:16px;right:auto;" : "right:16px;left:auto;"}
    width:72px;
    height:72px;
    border:0;
    background:transparent;
    z-index:2147483646;
    overflow:visible;
    outline:none;
    display:block;
    border-radius:999px;
    transition:width .24s ease,height .24s ease,border-radius .24s ease,inset .24s ease;
  }
  #${id}[data-agently-open="true"]{
    width:min(390px,calc(100vw - 32px));
    height:min(640px,calc(100dvh - 32px));
    border-radius:22px;
    overflow:hidden;
    box-shadow:0 18px 54px rgba(15,23,42,.22);
  }
  @media (max-width:640px){
    #${id}[data-agently-open="true"]{
      top:12px!important;
      bottom:12px!important;
      ${pos === "left" ? "left:12px!important;right:12px!important;" : "right:12px!important;left:12px!important;"}
      width:auto!important;
      height:auto!important;
      max-width:none!important;
      max-height:none!important;
      border-radius:22px!important;
    }
  }
</style>
<iframe
  id="${id}"
  src="${widgetUrl}"
  scrolling="no"
  frameborder="0"
  allow="microphone"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"
  referrerpolicy="no-referrer-when-downgrade"
  loading="eager"
  title="Chat widget"
></iframe>
<script>
(function(){
  var el=document.getElementById("${id}");
  if(!el)return;
  var origin;
  try{origin=new URL("${widgetUrl}").origin;}catch(e){origin="*";}
  window.addEventListener("message",function(ev){
    if(origin!=="*"&&ev.origin!==origin)return;
    var d=ev.data;
    if(!d||d.channel!=="agently-widget"||d.widgetId!=="${chatbot.id}")return;
    if(d.type==="open")el.setAttribute("data-agently-open","true");
    if(d.type==="close")el.removeAttribute("data-agently-open");
    if(window.matchMedia&&window.matchMedia("(max-width:640px)").matches){
      document.documentElement.style.overflow=d.type==="open"?"hidden":"";
      document.body.style.overflow=d.type==="open"?"hidden":"";
    }
  },false);
})();
</script>`;
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
      return res.status(500).json({
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
