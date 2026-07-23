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

  /*
   * ISSUE 5 — "The size of the chat interface when it opens up on mobile is not
   * proportional at all to the screen size ... almost as if it is about to enter
   * into the top-left corner of the screen"
   *
   * ROOT CAUSE, and it was structural, not cosmetic:
   *   The embed was a bare <iframe> with INLINE styles:
   *       width:420px; height:800px; max-width:90vw; max-height:90vh;
   *   Inline styles cannot carry media queries, so there was no mobile handling
   *   anywhere in the chain. On a 390px phone the iframe resolves to 90vw =
   *   351px, while the panel INSIDE it (#cw) is a fixed 370px. The panel is
   *   19px wider than its own frame, so its left edge is clipped off — exactly
   *   what your screenshot shows.
   *
   *   It was also 351x760 AT ALL TIMES, even closed: a near-fullscreen
   *   invisible iframe sitting on top of the customer's site, swallowing taps.
   *
   * FIX — two parts, because one alone is not enough:
   *   1. A <style> block (media queries work here; inline styles never could).
   *   2. postMessage. The widget tells the parent when it opens and closes, and
   *      the frame is sized to match: collapsed to just the launcher, expanded
   *      to a panel on desktop or genuine fullscreen on mobile.
   *
   * The listener is namespaced to this widget id and validates the message
   * origin, so a third-party script on the customer's page cannot resize or
   * open their chat widget.
   */
  return `<!-- Agently Chat Widget for: ${(chatbot.name || "My Chatbot").replace(/-->/g, "")} -->
<style>
  #${id}{
    position:fixed;
    bottom:20px;
    ${pos === "left" ? "left:20px;right:auto;" : "right:20px;left:auto;"}
    width:96px;height:96px;
    border:none;background:transparent;
    z-index:2147483646;
    overflow:hidden;outline:none;display:block;
    color-scheme:normal;
    transition:width .28s cubic-bezier(.34,1.2,.64,1),height .28s cubic-bezier(.34,1.2,.64,1),bottom .28s ease,right .28s ease,left .28s ease,border-radius .28s ease;
  }
  #${id}[data-agently-open="true"]{
    width:404px;height:660px;
    max-width:calc(100vw - 32px);
    max-height:calc(100vh - 40px);
  }
  /* Phones: the panel takes the whole screen. Anything less gets clipped or
     forces the customer to pinch-zoom to read a reply. */
  @media (max-width:640px){
    #${id}[data-agently-open="true"]{
      inset:0 !important;
      width:100vw !important;
      height:100vh !important;
      height:100dvh !important;
      max-width:none !important;
      max-height:none !important;
      border-radius:0 !important;
    }
  }
  @media (max-width:640px) and (display-mode:browser){
    #${id}[data-agently-open="true"]{ height:100dvh !important; }
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
  var el = document.getElementById("${id}");
  if (!el) return;
  var origin;
  try { origin = new URL("${widgetUrl}").origin; } catch (e) { origin = "*"; }

  window.addEventListener("message", function(ev){
    // Only accept messages from the widget's own origin and for THIS widget.
    if (origin !== "*" && ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.channel !== "agently-widget" || d.widgetId !== "${chatbot.id}") return;

    if (d.type === "open")  el.setAttribute("data-agently-open","true");
    if (d.type === "close") el.removeAttribute("data-agently-open");

    // Locks the host page behind a fullscreen mobile panel so the site does
    // not scroll underneath the conversation.
    if (window.matchMedia && window.matchMedia("(max-width:640px)").matches) {
      document.documentElement.style.overflow = d.type === "open" ? "hidden" : "";
      document.body.style.overflow = d.type === "open" ? "hidden" : "";
    }
  }, false);
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
