"use strict";

/**
 * agently-server/api/routes/platform-assistant.js   <-- NEW FILE
 *
 * Mounted at /api/platform-assistant
 *
 * The in-app Agently support assistant, for SIGNED-IN TENANTS ONLY.
 *
 * SECURITY NOTE — why this is not the public chatbot endpoint.
 * /api/chatbot-public/chat takes a chatbotId in the body and no credentials.
 * If the platform assistant were served that way, its chatbot id would sit in
 * the frontend bundle, and because the platform organization is billing-exempt
 * anyone on the internet could point a script at it and burn our money with no
 * wallet to stop them. Every route here requires a tenant session, so abuse is
 * attributable to a real account and rate-limited per user.
 */

const express = require("express");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { getOpenAI } = require("../../lib/openai-client");
const {
  loadChatbotContext,
  buildAssistantPrompt,
  cleanAssistantResponse,
} = require("../../lib/assistant-intelligence");
const {
  getPlatformChatbot,
  confidentialityDirective,
  scrubAssistantResponse,
  logConfidentialityViolation,
  getPlatformSpendStatus,
  answerFromFaqsOnly,
  createSupportRequest,
  SUPPORT_EMAIL,
} = require("../../lib/platform-assistant");

const router = express.Router();

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

/* ── Per-user rate limit ────────────────────────────────────────────────────
 * "they can ask unlimited questions" is a promise about billing, not a licence
 * for a runaway loop in a browser tab. This ceiling is high enough that no
 * human typing questions will ever reach it, and low enough that a scripted
 * client cannot drain the daily budget in one minute.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 30;
const rateBuckets = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const key = String(userId || "anon");
  const entry = rateBuckets.get(key);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_MAX_PER_WINDOW) return true;
  entry.count += 1;
  return false;
}

// Unbounded Maps are a slow leak on a long-lived process. Prune hourly.
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 5;
  for (const [key, entry] of rateBuckets) {
    if (entry.start < cutoff) rateBuckets.delete(key);
  }
}, 3_600_000).unref?.();

/* ══════════════════════════════════════════════════════════════════════════
 * GET /api/platform-assistant/config
 * Everything the floating widget needs to render before the first message.
 * ══════════════════════════════════════════════════════════════════════════ */
router.get(
  "/config",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const chatbot = await getPlatformChatbot();

    if (!chatbot || chatbot.is_active === false) {
      // A missing or disabled assistant is not an error condition for the
      // dashboard — the widget simply does not mount.
      return res.json({ enabled: false });
    }

    res.json({
      enabled: true,
      name: chatbot.name || "Agently Assistant",
      headerTitle: chatbot.header_title || "Agently Assistant",
      welcomeMessage:
        chatbot.welcome_message ||
        "Hi! I'm your Agently assistant. How can I help?",
      placeholder: chatbot.placeholder || "Ask me anything about Agently…",
      accentColor: chatbot.accent_color || "#F59E0B",
      position: chatbot.position === "left" ? "left" : "right",
      suggestedPrompts: Array.isArray(chatbot.suggested_prompts)
        ? chatbot.suggested_prompts.slice(0, 4)
        : [],
      supportEmail: chatbot.support_escalation_email || SUPPORT_EMAIL,
    });
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
 * POST /api/platform-assistant/chat
 * ══════════════════════════════════════════════════════════════════════════ */
router.post(
  "/chat",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { message, history } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: { message: "message is required." } });
    }

    if (isRateLimited(req.user?.id)) {
      return res.status(429).json({
        response:
          "You're sending messages faster than I can keep up with — give me a few seconds and try again.",
      });
    }

    const chatbot = await getPlatformChatbot();
    if (!chatbot) {
      return res.status(503).json({
        response: `The assistant isn't available right now. For anything urgent, email ${SUPPORT_EMAIL}.`,
      });
    }

    // ── Spend ceiling: degrade, never disappear ───────────────────────────
    const spend = await getPlatformSpendStatus();
    if (spend.degraded) {
      const answer = await answerFromFaqsOnly(message);
      return res.json({ response: answer, degraded: true });
    }

    // ── Build the prompt on the shared tenant pipeline ────────────────────
    let context;
    try {
      context = await loadChatbotContext(chatbot.id, message.trim());
    } catch (error) {
      console.error(
        "[platform-assistant] context load failed:",
        error?.message || String(error),
      );
      const answer = await answerFromFaqsOnly(message);
      return res.json({ response: answer, degraded: true });
    }

    const basePrompt = buildAssistantPrompt({
      context,
      message: message.trim(),
      mode: "text",
      direction: "chat",
      languageName: "English",
    });

    // The confidentiality block goes LAST. Instructions later in a system
    // prompt carry more weight against a conflicting earlier instruction, and
    // this is the one rule that must win every conflict.
    const systemPrompt = [
      basePrompt,
      confidentialityDirective({
        supportEmail: chatbot.support_escalation_email || SUPPORT_EMAIL,
      }),
    ].join("\n\n---\n\n");

    let raw = "";
    try {
      const completion = await getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: systemPrompt },
          ...(Array.isArray(history) ? history : [])
            .slice(-10)
            .map((m) => ({
              role: m.role === "assistant" || m.role === "model"
                ? "assistant"
                : "user",
              content: String(m.text || m.content || "").slice(0, 4000),
            })),
          { role: "user", content: message.trim() },
        ],
      });
      raw = completion.choices?.[0]?.message?.content || "";
    } catch (error) {
      console.error(
        "[platform-assistant] generation failed:",
        error?.message || String(error),
      );
      return res.status(200).json({
        response: `I'm having trouble reaching the assistant right now. Try again in a moment — or email ${SUPPORT_EMAIL} if it's urgent.`,
      });
    }

    // ── Layer B: scrub before anything leaves the server ──────────────────
    const cleaned = cleanAssistantResponse(raw);
    const scrubbed = scrubAssistantResponse(cleaned);

    if (!scrubbed.safe) {
      await logConfidentialityViolation({
        chatbotId: chatbot.id,
        askingOrganizationId: req.orgId || null,
        askingUserId: req.user?.id || null,
        question: message.trim(),
        matchedTerms: scrubbed.matched,
        rawResponse: cleaned,
      });
    }

    res.json({
      response: scrubbed.text,
      supportEmail: chatbot.support_escalation_email || SUPPORT_EMAIL,
    });
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
 * POST /api/platform-assistant/escalate
 * ══════════════════════════════════════════════════════════════════════════ */
router.post(
  "/escalate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { subject, body, contactName, contactEmail, history } = req.body || {};

    if (!body || !String(body).trim()) {
      return res
        .status(400)
        .json({ error: { message: "Please describe the issue." } });
    }

    const excerpt = (Array.isArray(history) ? history : [])
      .slice(-12)
      .map(
        (m) =>
          `${m.role === "assistant" || m.role === "model" ? "Assistant" : "Customer"}: ${String(m.text || m.content || "").slice(0, 600)}`,
      )
      .join("\n");

    const request = await createSupportRequest({
      organizationId: req.orgId || null,
      userId: req.user?.id || null,
      contactName: contactName || req.user?.name || "",
      contactEmail: contactEmail || req.user?.email || "",
      subject: subject || "Support request from the Agently assistant",
      body: String(body).trim(),
      conversationExcerpt: excerpt,
    });

    res.json({
      success: true,
      requestId: request.id,
      supportEmail: SUPPORT_EMAIL,
      message: `Logged it. The team will reply to ${request.contact_email || "your account email"}. You can also email ${SUPPORT_EMAIL} directly with anything you want to add.`,
    });
  }),
);

module.exports = router;
