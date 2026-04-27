"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { generateChatResponse } = require("../../lib/openai");
const { loadChatbotContext } = require("../../lib/context-builder");

const router = express.Router();

const rateLimitMap = new Map();
function isRateLimited(chatbotId) {
  const now = Date.now();
  const window = 60 * 1000;
  const max = 60;
  const entry = rateLimitMap.get(chatbotId) || { count: 0, start: now };
  if (now - entry.start > window) {
    rateLimitMap.set(chatbotId, { count: 1, start: now });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count += 1;
  rateLimitMap.set(chatbotId, entry);
  return false;
}

const UNANSWERED_PHRASES = [
  "i don't know",
  "i'm not sure",
  "i cannot",
  "i can't answer",
  "don't have that information",
  "not available",
  "contact support",
  "contact us directly",
  "unfortunately",
  "i'm unable",
  "someone will follow up",
];
function isUnanswered(response) {
  const lower = String(response || "").toLowerCase();
  return UNANSWERED_PHRASES.some((phrase) => lower.includes(phrase));
}

router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    const { message, chatbotId, history } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: { message: "message is required." } });
    }
    if (!chatbotId) {
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    }
    if (isRateLimited(chatbotId)) {
      return res.status(429).json({
        response:
          "I'm receiving a lot of messages right now. Please try again in a moment.",
      });
    }

    const db = getSupabase();
    const context = await loadChatbotContext(db, chatbotId, message.trim());

    if (!context?.chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    const chatHistory = Array.isArray(history) ? history.slice(-16) : [];

    let response;
    try {
      response = await generateChatResponse(
        message.trim(),
        chatHistory,
        context.systemPrompt,
      );
    } catch (err) {
      console.error("[chatbot-public] chat generation error:", err.message);
      response =
        "I'm sorry, I'm having a moment of difficulty. Please try again shortly.";
    }

    if (isUnanswered(response) && context.chatbot.organization_id) {
      try {
        await db.from("unanswered_questions").insert({
          organization_id: context.chatbot.organization_id,
          chatbot_id: chatbotId,
          question: message.trim(),
          bot_response: response,
        });
      } catch (trackErr) {
        console.warn(
          "[chatbot-public] unanswered_questions insert failed:",
          trackErr.message,
        );
      }
    }

    res.json({
      response,
      meta: {
        collectLeads: !!context.chatbot.collect_leads,
        links: context.links || [],
      },
    });
  }),
);

router.post(
  "/lead",
  asyncHandler(async (req, res) => {
    const { chatbotId, name, email, phone, reason = "" } = req.body || {};
    if (!chatbotId) {
      return res
        .status(400)
        .json({ error: { message: "chatbotId is required." } });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: { message: "name is required." } });
    }
    if (!String(email || "").trim() && !String(phone || "").trim()) {
      return res.status(400).json({
        error: { message: "Provide at least an email or phone number." },
      });
    }

    const db = getSupabase();
    const { data: chatbot } = await db
      .from("chatbots")
      .select("id, organization_id, collect_leads, leads_collected_count")
      .eq("id", chatbotId)
      .single();

    if (!chatbot) {
      return res.status(404).json({ error: { message: "Chatbot not found." } });
    }

    const { data: lead, error } = await db
      .from("leads")
      .insert({
        organization_id: chatbot.organization_id,
        name: String(name || "").trim(),
        email: String(email || "").trim(),
        phone: String(phone || "").trim(),
        reason: String(reason || "").trim(),
        source: "chat_widget",
        status: "new",
      })
      .select("id, name, email, phone")
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: error.message || "Failed to save lead." } });
    }

    if (chatbot.collect_leads) {
      await db
        .from("chatbots")
        .update({
          leads_collected_count: (chatbot.leads_collected_count || 0) + 1,
        })
        .eq("id", chatbotId)
        .catch(() => {});
    }

    res.status(201).json({ success: true, lead });
  }),
);

router.get(
  "/unanswered",
  asyncHandler(async (req, res) => {
    const { chatbotId, organizationId } = req.query;
    const db = getSupabase();

    let query = db
      .from("unanswered_questions")
      .select("id, question, bot_response, created_at, is_resolved")
      .eq("is_resolved", false)
      .order("created_at", { ascending: false })
      .limit(50);

    if (chatbotId) query = query.eq("chatbot_id", chatbotId);
    if (organizationId) query = query.eq("organization_id", organizationId);

    const { data } = await query;
    res.json({ questions: data || [] });
  }),
);

router.patch(
  "/unanswered/:id/resolve",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { addToFaq, question, answer, chatbotId } = req.body;
    const db = getSupabase();

    await db
      .from("unanswered_questions")
      .update({ is_resolved: true })
      .eq("id", id);

    if (addToFaq && question && answer && chatbotId) {
      const { data: chatbot } = await db
        .from("chatbots")
        .select("faqs")
        .eq("id", chatbotId)
        .single();
      const existing = Array.isArray(chatbot?.faqs) ? chatbot.faqs : [];
      await db
        .from("chatbots")
        .update({
          faqs: [...existing, { id: `faq-${Date.now()}`, question, answer }],
        })
        .eq("id", chatbotId);
    }

    res.json({ success: true });
  }),
);

module.exports = router;
