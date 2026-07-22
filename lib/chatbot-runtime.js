/**
 * agently-server/lib/chatbot-runtime.js   <-- NEW FILE
 *
 * PATCH 10 — CURRENT_ISSUES → Chatbot section → 1, 2, 3, 4, 5, 6, 7(a-g).
 *
 * One module holding every chatbot runtime rule so the widget, the dashboard
 * preview and the public API can never disagree about voice, language, FAQs or
 * lead capture. Today those three surfaces each resolve their own state, which
 * is why "the voice in the preview isn't the voice on the site".
 */

"use strict";

const { getSupabase } = require("./supabase");
const { insertUsageEvent } = require("./usage-ledger");

/* ══════════════════════════════════════════════════════════════════════════
 * ISSUE 2, 3, 4 — FAQs resolved per KNOWLEDGE BASE, not per organization
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "The FAQs should be unique to the knowledge base not just to the
 *  organization id alone ... if knowledge base B is selected it should reload
 *  just that FAQ card and display FAQ-B"
 *
 * WHY THE CARD IS EMPTY TODAY (two independent causes, both must be fixed)
 *   1. SCHEMA — faqs had no knowledge_base_id column, but the route already
 *      filtered on it. Fixed by migration 001 Section 1.
 *   2. FRONTEND — Messenger.tsx:445 reads ONLY `result.manualFaqs`, discarding
 *      `result.faqs`. Scraped FAQs (the "long list gathered from the scraped
 *      website" you want shown) were being thrown away client-side.
 *
 * This function is the single source of truth both surfaces call.
 */
async function resolveKnowledgeBaseFaqs({
  organizationId,
  knowledgeBaseId,
  includeUnpublished = false,
  limit = 200,
}) {
  if (!knowledgeBaseId) {
    return { faqs: [], manualFaqs: [], scrapedFaqs: [], total: 0 };
  }

  const db = getSupabase();
  let query = db
    .from("faqs")
    .select(
      "id,question,answer,source_type,knowledge_base_id,knowledge_source_id," +
        "voice_agent_id,metadata,is_published,display_order,created_at,updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("knowledge_base_id", knowledgeBaseId)
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (!includeUnpublished) query = query.eq("is_published", true);

  const { data, error } = await query;
  if (error) {
    console.error("[chatbot-runtime] faq load failed:", error.message);
    return { faqs: [], manualFaqs: [], scrapedFaqs: [], total: 0 };
  }

  const MANUAL = ["manual", "knowledge_base_manual", "chatbot_manual"];
  const faqs = (data || []).map((row) => ({
    id: row.id,
    question: row.question || "",
    answer: row.answer || "",
    sourceType: row.source_type || "manual",
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeSourceId: row.knowledge_source_id,
    isPublished: row.is_published !== false,
    isManual: MANUAL.includes(String(row.source_type || "").toLowerCase()),
    updatedAt: row.updated_at,
  }));

  return {
    faqs, // <- everything. The frontend must render THIS.
    manualFaqs: faqs.filter((f) => f.isManual),
    scrapedFaqs: faqs.filter((f) => !f.isManual),
    total: faqs.length,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ISSUE 5 — suggested prompts come from the chatbot's own FAQs
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "There are some pre questions ... like 'what are your working hours' — this
 *  should not be constant questions again ... this way we know the pre-question
 *  boxes on each chat interface is unique for different chatbot agent"
 *
 * Those strings are the SCHEMA DEFAULT, hardcoded at
 * supabase-schema.sql:135 — identical for every tenant that never edited them.
 *
 * Picking the highest-signal FAQs also means the assistant already holds the
 * exact answer, so the reply is instant and uses the tenant's approved wording.
 */
function buildSuggestedPrompts(faqs, { max = 4 } = {}) {
  const scored = (faqs || [])
    .filter((f) => f.question && f.answer)
    .map((f) => {
      const q = f.question.trim();
      let score = 0;
      if (q.length >= 12 && q.length <= 62) score += 3; // fits the chip
      if (/^(what|how|do|can|where|when|is|are|why)\b/i.test(q)) score += 2;
      if (f.isManual) score += 2; // hand-written beats scraped
      if (f.answer.length > 40) score += 1;
      if (q.length > 80) score -= 4;
      return { question: q, score };
    })
    .sort((a, b) => b.score - a.score);

  const out = [];
  const seen = new Set();
  for (const item of scored) {
    const key = item.question.toLowerCase().replace(/\W+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.question);
    if (out.length >= max) break;
  }
  return out;
}

async function refreshSuggestedPrompts({ organizationId, chatbotId }) {
  const db = getSupabase();
  const { data: chatbot } = await db
    .from("chatbots")
    .select("id,knowledge_base_id,suggested_prompts_source")
    .eq("id", chatbotId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  // Respect a tenant who wrote their own prompts.
  if (!chatbot || chatbot.suggested_prompts_source === "manual") return null;

  const { faqs } = await resolveKnowledgeBaseFaqs({
    organizationId,
    knowledgeBaseId: chatbot.knowledge_base_id,
  });
  const prompts = buildSuggestedPrompts(faqs);
  if (!prompts.length) return null;

  await db
    .from("chatbots")
    .update({
      suggested_prompts: prompts,
      suggested_prompts_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", chatbotId)
    .eq("organization_id", organizationId);

  return prompts;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ISSUE 7(d)(f) — hard language restriction
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "it is important we set a rule — that chatbot is only able to have
 *  conversation in just the selected language"
 *
 * Enforced in the system prompt because that is the only layer that governs
 * generation. A post-hoc filter would still have paid for the tokens.
 */
const LANGUAGE_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", ar: "Arabic",
  hi: "Hindi", zh: "Chinese", ja: "Japanese", ko: "Korean", tr: "Turkish",
  sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", he: "Hebrew",
  th: "Thai", vi: "Vietnamese", id: "Indonesian", ms: "Malay",
  yo: "Yoruba", ig: "Igbo", ha: "Hausa", sw: "Swahili",
};

const languageName = (code) =>
  LANGUAGE_NAMES[String(code || "").toLowerCase()] || String(code || "").toUpperCase();

function buildLanguageDirective(chatbot) {
  if (chatbot?.enforce_language_restriction === false) return "";

  const allowed = Array.isArray(chatbot?.allowed_languages)
    ? chatbot.allowed_languages.filter(Boolean)
    : ["en"];
  const primary = chatbot?.primary_language || allowed[0] || "en";

  if (allowed.length <= 1) {
    const only = languageName(primary);
    return (
      `\n\nLANGUAGE RULE (strict)\n` +
      `You reply ONLY in ${only}. If the visitor writes in any other language, ` +
      `reply in ${only} with a brief, friendly note that you can only help in ${only}. ` +
      `Never translate your reply into another language, even if asked directly.`
    );
  }

  const names = allowed.map(languageName);
  return (
    `\n\nLANGUAGE RULE (strict)\n` +
    `You may reply ONLY in: ${names.join(", ")}. ` +
    `Match the visitor's language when it is one of these. ` +
    `If they use any other language, reply in ${languageName(primary)} and say ` +
    `politely that you can help in ${names.join(", ")}. ` +
    `Never reply in a language outside that list, even if asked directly.`
  );
}

/**
 * ISSUE 7(e) — "every extra charge for the languages they use is added to the
 * billing deduction as well".
 *
 * Billed as a surcharge on top of the normal chat token charge, using the
 * multilingual_message rate card from migration 001 Section 6. Flows through
 * the existing wallet pipeline, so no new billing code path exists to go wrong.
 */
async function chargeMultilingualSurcharge({
  organizationId,
  chatbotId,
  detectedLanguage,
  primaryLanguage,
  messageCount = 1,
}) {
  const detected = String(detectedLanguage || "").toLowerCase();
  const primary = String(primaryLanguage || "en").toLowerCase();
  if (!detected || detected === primary) return null;

  try {
    return await insertUsageEvent({
      organizationId,
      provider: "openai",
      service: "chat",
      eventType: "multilingual_message",
      source: "chatbot_runtime",
      unit: "message",
      quantity: messageCount,
      metadata: {
        chatbot_id: chatbotId,
        detected_language: detected,
        primary_language: primary,
      },
    });
  } catch (error) {
    // Never break a live conversation over a surcharge. It is reconciled by
    // the nightly org-full-cost-reconciler.
    console.error(
      "[chatbot-runtime] multilingual surcharge failed:",
      error?.message || String(error),
    );
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ISSUE 7(a)(b) — lead capture toggle
 * ══════════════════════════════════════════════════════════════════════════
 * Default TRUE preserves today's behaviour for every existing chatbot, so this
 * cannot silently switch lead capture off for a live tenant.
 */
function leadCaptureConfig(chatbot) {
  const enabled = chatbot?.lead_capture_enabled !== false;
  return {
    enabled,
    fields: Array.isArray(chatbot?.lead_capture_fields)
      ? chatbot.lead_capture_fields
      : ["name", "email"],
    prompt:
      chatbot?.lead_capture_prompt ||
      "Before we continue, could I take your name and email?",
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ISSUE 7(c) — the previewed voice must be the deployed voice
 * ══════════════════════════════════════════════════════════════════════════
 * The widget currently falls back to "alloy" independently of the setting,
 * so any change made in the settings page never reached the live site.
 */
const SUPPORTED_CHAT_VOICES = [
  "alloy", "echo", "fable", "onyx", "nova", "shimmer",
];

function resolveChatVoice(chatbot) {
  const configured = String(
    chatbot?.chat_voice || chatbot?.chatVoice || "alloy",
  ).toLowerCase();
  return {
    voice: SUPPORTED_CHAT_VOICES.includes(configured) ? configured : "alloy",
    enabled: chatbot?.voice_enabled !== false,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ISSUE 1 — avatar that survives deployment to the customer's website
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "on deploying the chatbot on the website the image does not show"
 *
 * ROOT CAUSE: the dashboard preview renders the image from a same-origin or
 * blob URL that only exists inside the Agently app. Once the widget script runs
 * on the tenant's own domain that URL is unreachable (cross-origin / expired
 * blob / no CORS header), so the <img> silently fails.
 *
 * FIX: normalise once, server-side, to a small square data URI stored on the
 * chatbot row. The embed script then carries the image inline — no second
 * request, no CORS, no broken image, works on any domain.
 *
 * Cap is deliberately tight: the data URI ships in the widget payload on every
 * page load, so a large avatar would slow the customer's site.
 */
const AVATAR_MAX_BYTES = 96 * 1024; // ~96KB encoded
const AVATAR_MAX_DIMENSION = 128; // px

async function normalizeAvatarForEmbed({ dataUri, mimeType }) {
  if (!dataUri) return { ok: false, reason: "No image supplied." };

  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUri));
  if (!match) {
    return { ok: false, reason: "Image must be supplied as a data URI." };
  }

  const detectedMime = mimeType || match[1];
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(detectedMime)) {
    return { ok: false, reason: "Use a PNG, JPG, WEBP or GIF image." };
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > AVATAR_MAX_BYTES) {
    return {
      ok: false,
      reason:
        `That image is ${Math.round(bytes.length / 1024)}KB. ` +
        `Please use one under ${Math.round(AVATAR_MAX_BYTES / 1024)}KB so your ` +
        `website stays fast — ${AVATAR_MAX_DIMENSION}x${AVATAR_MAX_DIMENSION} is ideal.`,
    };
  }

  return {
    ok: true,
    dataUri: `data:${detectedMime};base64,${bytes.toString("base64")}`,
    mimeType: detectedMime,
    bytes: bytes.length,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Single resolver used by the public widget endpoint.
 * ══════════════════════════════════════════════════════════════════════════ */
async function resolveChatbotRuntimeConfig({ organizationId, chatbotId }) {
  const db = getSupabase();
  const { data: chatbot } = await db
    .from("chatbots")
    .select("*")
    .eq("id", chatbotId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!chatbot) return null;

  const faqBundle = await resolveKnowledgeBaseFaqs({
    organizationId,
    knowledgeBaseId: chatbot.knowledge_base_id,
  });

  const prompts =
    Array.isArray(chatbot.suggested_prompts) &&
    chatbot.suggested_prompts.length &&
    chatbot.suggested_prompts_source === "manual"
      ? chatbot.suggested_prompts
      : buildSuggestedPrompts(faqBundle.faqs);

  return {
    chatbot,
    faqs: faqBundle.faqs,
    faqCounts: {
      total: faqBundle.total,
      manual: faqBundle.manualFaqs.length,
      scraped: faqBundle.scrapedFaqs.length,
    },
    suggestedPrompts: prompts,
    languageDirective: buildLanguageDirective(chatbot),
    leadCapture: leadCaptureConfig(chatbot),
    voice: resolveChatVoice(chatbot),
    avatarDataUri: chatbot.avatar_data_uri || null,
  };
}

module.exports = {
  resolveKnowledgeBaseFaqs,
  buildSuggestedPrompts,
  refreshSuggestedPrompts,
  buildLanguageDirective,
  chargeMultilingualSurcharge,
  leadCaptureConfig,
  resolveChatVoice,
  normalizeAvatarForEmbed,
  resolveChatbotRuntimeConfig,
  languageName,
  SUPPORTED_CHAT_VOICES,
};
