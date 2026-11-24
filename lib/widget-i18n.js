"use strict";

/*
 * Chatbot widget translation.
 *
 * The widget used to switch only the language of the AI's replies: its own
 * labels (buttons, voice mode, the lead form, errors) and the business's own
 * text (header, welcome message, placeholder, suggested questions) stayed in
 * whatever they were written in. Now:
 *
 *  - UI strings: the English source list below, translated once per language
 *    and cached for the life of the process (shared by every chatbot).
 *  - Business text: translated per chatbot + language, cached by a hash of the
 *    source text, so editing the welcome message produces a fresh translation.
 *
 * Only languages the chatbot has enabled are accepted, so the number of model
 * calls is bounded by (languages × content versions). On any failure the
 * caller gets English/original text back, never an error in the widget.
 */

const crypto = require("crypto");
const { getOpenAI } = require("./openai-client");

const LANGUAGE_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ar: "Arabic",
  zh: "Simplified Chinese",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  nl: "Dutch",
};

// Every fixed English string the widget can show. The widget looks each one
// up with T('...'), so these must match the source text exactly.
const UI_STRINGS = [
  "Online · Instant replies",
  "Start voice conversation",
  "Toggle voice replies",
  "Voice replies on",
  "Voice replies off",
  "Close chat",
  "Language",
  "Language selector",
  "Chat messages",
  "Suggested questions",
  "Record voice message",
  "Record voice",
  "Message input",
  "Send message",
  "Voice Mode",
  "Tap to start speaking",
  "Speak naturally. I will reply instantly when you pause.",
  "End conversation",
  "Open chat",
  "Chat is temporarily unavailable",
  "Quick details",
  "Name *",
  "Phone",
  "Email",
  "What do you need help with?",
  "Save details",
  "Saving...",
  "Please enter your name.",
  "Please enter your phone number or email.",
  "Please enter your phone number.",
  "Please enter your email.",
  "Could not save details. Please try again.",
  "Your name and an email or phone number are required.",
  "Your name and phone number are required.",
  "Your name and email are required.",
  "An email or phone number is required.",
  "A phone number is required.",
  "An email is required.",
  "Thank you — I found your existing details. How else can I help you?",
  "Thank you! How else can I help you?",
  "I need microphone access to record. Please allow access and try again.",
  "Microphone access denied. Please allow microphone access and try again.",
  "Your browser does not support microphone access. Please use Chrome or Firefox.",
  "Could not connect to voice service. Please try again.",
  "Voice connection lost. Please try again.",
  "Voice mode is not configured.",
  "Voice mode is not supported by your browser.",
  "Voice mode encountered an error. Please try text chat instead.",
  "Connecting...",
  "Connecting to AI...",
  "Listening...",
  "Listening... speak now",
  "I will reply instantly when you pause.",
  "Speaking...",
  "Tap end to stop.",
  "Thinking...",
  "Sorry, something went wrong. Please try again.",
  "I'm here to help! Could you rephrase that?",
  "Sorry, I'm having trouble connecting right now. Please try again in a moment.",
];

const uiCache = new Map(); // lang -> Promise<{english: translated}>
const contentCache = new Map(); // `${chatbotId}:${lang}:${hash}` -> Promise<content>
const MAX_CONTENT_ENTRIES = 2000;

function languageName(code) {
  return LANGUAGE_NAMES[String(code || "").toLowerCase()] || null;
}

async function translateList(strings, lang) {
  const target = languageName(lang);
  if (!target || !strings.length) return strings.slice();
  const completion = await getOpenAI().chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `Translate short website chat-widget text into ${target}. ` +
          'Return JSON {"items": [...]} with exactly one translated string per input, in the same order. ' +
          "Keep emoji, punctuation style, brand and business names, URLs, phone numbers and the trailing ' *' unchanged. " +
          "Use natural, friendly, concise wording a website visitor would expect. " +
          `If an item is already in ${target}, return it unchanged.`,
      },
      { role: "user", content: JSON.stringify({ items: strings }) },
    ],
  });
  const parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  if (items.length !== strings.length) throw new Error("translation length mismatch");
  return items.map((item, index) =>
    typeof item === "string" && item.trim() ? item : strings[index],
  );
}

function getUiTranslations(lang) {
  const code = String(lang || "").toLowerCase();
  if (!languageName(code) || code === "en") return Promise.resolve({});
  if (!uiCache.has(code)) {
    const job = translateList(UI_STRINGS, code)
      .then((items) => Object.fromEntries(UI_STRINGS.map((s, i) => [s, items[i]])))
      .catch((err) => {
        uiCache.delete(code); // retry on the next request
        console.warn(`[widget-i18n] UI translation to ${code} failed:`, err?.message || err);
        return {};
      });
    uiCache.set(code, job);
  }
  return uiCache.get(code);
}

/**
 * content: { headerTitle, welcomeMessage, placeholder, suggestedPrompts[], leadAsk }
 */
function getContentTranslations(chatbotId, lang, content) {
  const code = String(lang || "").toLowerCase();
  const prompts = Array.isArray(content.suggestedPrompts)
    ? content.suggestedPrompts.map((p) => String(p || "")).slice(0, 12)
    : [];
  const source = [
    String(content.headerTitle || ""),
    String(content.welcomeMessage || ""),
    String(content.placeholder || ""),
    String(content.leadAsk || ""),
    ...prompts,
  ];
  const unpack = (items) => ({
    headerTitle: items[0],
    welcomeMessage: items[1],
    placeholder: items[2],
    leadAsk: items[3],
    suggestedPrompts: items.slice(4),
  });
  if (!languageName(code)) return Promise.resolve(unpack(source));

  const hash = crypto.createHash("sha1").update(JSON.stringify(source)).digest("hex").slice(0, 16);
  const key = `${chatbotId}:${code}:${hash}`;
  if (!contentCache.has(key)) {
    if (contentCache.size >= MAX_CONTENT_ENTRIES) {
      contentCache.delete(contentCache.keys().next().value);
    }
    const job = translateList(source, code)
      .then(unpack)
      .catch((err) => {
        contentCache.delete(key);
        console.warn(`[widget-i18n] content translation ${chatbotId} -> ${code} failed:`, err?.message || err);
        return unpack(source);
      });
    contentCache.set(key, job);
  }
  return contentCache.get(key);
}

module.exports = { UI_STRINGS, LANGUAGE_NAMES, getUiTranslations, getContentTranslations, languageName };
