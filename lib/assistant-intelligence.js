"use strict";

const { getSupabase } = require("./supabase");
const { getOpenAI } = require("./openai-client");

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const MAX_CHUNKS = 12;
const MAX_FAQS = 30;

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","can","do","for","from","go","how","i","in","is","it","me","my","of","on","or","our","please","show","take","that","the","them","there","this","to","want","what","where","which","with","you","your","need"
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenize(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9+#/.-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractUrls(value) {
  const text = String(value || "");
  const urls = text.match(/https?:\/\/[^\s)\]"'<>{}]+/gi) || [];
  return urls.map((u) => u.replace(/[.,;:!?]+$/, ""));
}

function normalizeFaq(f) {
  if (!f) return null;
  const question = cleanText(f.question || f.q || f.title);
  const answer = cleanText(f.answer || f.a || f.content || f.text);
  if (!question || !answer) return null;
  return { question, answer };
}

function normalizeChunk(c) {
  if (!c) return null;
  const content = cleanText(c.content || c.text || "");
  if (!content) return null;
  const sourceUrl = cleanText(c.source_url || c.url || "");
  const sourceTitle = cleanText(c.source_title || c.title || "");
  const inlineUrls = extractUrls(content);
  return {
    content,
    source_url: sourceUrl,
    source_title: sourceTitle,
    urls: uniqueBy([sourceUrl, ...inlineUrls].filter(Boolean), (u) => u),
  };
}

function scoreText(queryTokens, text, url = "") {
  const hay = `${text || ""} ${url || ""}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) score += tok.length >= 6 ? 3 : 1;
  }
  return score;
}

function rankFaqs(message, faqs) {
  const tokens = tokenize(message);
  return (faqs || [])
    .map((faq) => ({ ...faq, _score: scoreText(tokens, `${faq.question} ${faq.answer}`) }))
    .filter((f) => f._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8)
    .map(({ _score, ...faq }) => faq);
}

function rankChunks(message, chunks, limit = MAX_CHUNKS) {
  const tokens = tokenize(message);
  if (!tokens.length) return (chunks || []).slice(0, Math.min(6, limit));
  return (chunks || [])
    .map((chunk) => ({
      ...chunk,
      _score: scoreText(tokens, `${chunk.source_title || ""} ${chunk.content || ""}`, chunk.source_url || ""),
    }))
    .filter((c) => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...chunk }) => chunk);
}

async function safeQuery(label, fn, fallback = []) {
  try {
    const { data, error } = await fn();
    if (error) {
      console.warn(`[assistant-intelligence] ${label}:`, error.message);
      return fallback;
    }
    return data || fallback;
  } catch (e) {
    console.warn(`[assistant-intelligence] ${label}:`, e.message);
    return fallback;
  }
}

async function loadChatbotContext(chatbotId) {
  const db = getSupabase();
  const { data: chatbot, error } = await db
    .from("chatbots")
    .select("id, organization_id, voice_agent_id, name, header_title, welcome_message, custom_prompt, faqs, chat_voice, chat_languages, collect_leads")
    .eq("id", chatbotId)
    .maybeSingle();
  if (error || !chatbot) throw new Error("Chatbot not found.");

  const chatbotFaqs = asArray(chatbot.faqs).map(normalizeFaq).filter(Boolean);
  const chunks = await safeQuery("chatbot knowledge chunks", () =>
    db.from("knowledge_chunks")
      .select("source_url,source_title,content,chunk_index")
      .eq("chatbot_id", chatbotId)
      .order("chunk_index", { ascending: true })
      .limit(80),
  );

  let linkedAgentFaqs = [];
  let linkedAgentChunks = [];
  if (chatbot.voice_agent_id) {
    linkedAgentFaqs = await safeQuery("linked voice faqs", () =>
      db.from("faqs").select("question,answer").eq("voice_agent_id", chatbot.voice_agent_id).limit(MAX_FAQS),
    );
    linkedAgentChunks = await safeQuery("linked voice chunks", () =>
      db.from("knowledge_chunks").select("source_url,source_title,content,chunk_index").eq("voice_agent_id", chatbot.voice_agent_id).limit(40),
    );
  }

  return {
    type: "chatbot",
    organization_id: chatbot.organization_id,
    entity: chatbot,
    customPrompt: chatbot.custom_prompt || "",
    faqs: uniqueBy([...chatbotFaqs, ...linkedAgentFaqs.map(normalizeFaq).filter(Boolean)], (f) => `${f.question}|${f.answer}`).slice(0, MAX_FAQS),
    chunks: uniqueBy([...chunks, ...linkedAgentChunks].map(normalizeChunk).filter(Boolean), (c) => `${c.source_url}|${c.content.slice(0, 120)}`),
  };
}

async function loadVoiceAgentContext(agentId) {
  const db = getSupabase();
  const { data: agent, error } = await db
    .from("voice_agents")
    .select("*")
    .eq("id", agentId)
    .maybeSingle();
  if (error || !agent) throw new Error("Voice agent not found.");

  const [agentFaqs, agentChunks, linkedChatbots] = await Promise.all([
    safeQuery("voice faqs", () => db.from("faqs").select("question,answer").eq("voice_agent_id", agentId).limit(MAX_FAQS)),
    safeQuery("voice chunks", () => db.from("knowledge_chunks").select("source_url,source_title,content,chunk_index").eq("voice_agent_id", agentId).limit(80)),
    safeQuery("linked chatbots", () => db.from("chatbots").select("id,custom_prompt,faqs,name,header_title").eq("voice_agent_id", agentId).limit(10)),
  ]);

  let chatbotFaqs = [];
  let chatbotChunks = [];
  for (const bot of linkedChatbots || []) {
    chatbotFaqs.push(...asArray(bot.faqs).map(normalizeFaq).filter(Boolean));
    const chunks = await safeQuery(`chatbot chunks ${bot.id}`, () =>
      db.from("knowledge_chunks").select("source_url,source_title,content,chunk_index").eq("chatbot_id", bot.id).limit(50),
    );
    chatbotChunks.push(...chunks);
  }

  return {
    type: "voice_agent",
    organization_id: agent.organization_id,
    entity: agent,
    customPrompt: "",
    faqs: uniqueBy([...agentFaqs.map(normalizeFaq).filter(Boolean), ...chatbotFaqs], (f) => `${f.question}|${f.answer}`).slice(0, MAX_FAQS),
    chunks: uniqueBy([...agentChunks, ...chatbotChunks].map(normalizeChunk).filter(Boolean), (c) => `${c.source_url}|${c.content.slice(0, 120)}`),
  };
}

function buildKnowledgeBlock({ faqs = [], chunks = [] }) {
  const faqText = faqs.length
    ? faqs.map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`).join("\n")
    : "";

  const chunkText = chunks.length
    ? chunks.map((c, i) => {
        const links = c.urls && c.urls.length ? `\n   Links: ${c.urls.join(" | ")}` : "";
        const title = c.source_title ? `Title: ${c.source_title}\n   ` : "";
        return `${i + 1}. ${title}Content: ${c.content.slice(0, 1200)}${links}`;
      }).join("\n\n")
    : "";

  return [faqText ? `SCOPED FAQS:\n${faqText}` : "", chunkText ? `SCOPED WEBSITE KNOWLEDGE AND LINKS:\n${chunkText}` : ""].filter(Boolean).join("\n\n");
}

function baseBehaviorInstructions({ mode = "text", direction = "inbound", entity = {}, languageName = "English" }) {
  const isVoice = mode === "voice";
  const captureFields = asArray(entity.data_capture_fields).length
    ? asArray(entity.data_capture_fields).join(", ")
    : "name, phone, email, reason";
  const callPurposes = asArray(entity.call_purposes).map((p) => cleanText(p)).filter(Boolean);

  return `You are Agently's website assistant for ${entity.header_title || entity.name || "this business"}.

CORE BEHAVIOR:
- Use ONLY the scoped knowledge provided for this chatbot or voice agent: custom prompt, FAQs, call purpose when outbound, and website knowledge chunks.
- Do not merge unrelated agents' knowledge. If information is not present, say you could not find it and offer the closest available options.
- Be helpful like a website concierge. When a user asks to go somewhere, find the best matching page/section/product link from the provided links and share it.
- If the request is broad and has multiple possible matches, ask a brief clarifying question and list the available options as clickable links.
- If the user is specific and an exact/strong match exists, give the direct link immediately.
- If the exact item does not exist, say so clearly and offer related available options.
- Format answers cleanly: use **bold section headers**, short paragraphs, and bullet lists. Use markdown links: [Page name](https://example.com/page).
- Do not output raw JSON to the customer.
- Write in ${languageName || "English"} unless the user asks otherwise.
${isVoice ? "- This is voice mode: be concise, natural, and speakable. Mention links by page name and say you can also send/show the link in chat where applicable." : "- This is text mode: make links clickable and easy to scan."}

LEAD CAPTURE:
- When appropriate, collect ${captureFields}. If the visitor asks for a quote, callback, appointment, support, human agent, or leaves a message, ask for name and either phone or email.

CALL RULES:
- Inbound calls answer questions and collect caller details/messages when needed.
- Outbound calls use call purpose only when direction is outbound.
${direction === "outbound" && callPurposes.length ? `- Outbound call purposes to cover: ${callPurposes.join("; ")}` : "- If this is inbound, do not force outbound call purposes into the conversation."}
- If you cannot answer a call question from available knowledge, take a message and say someone can follow up.`;
}

function buildAssistantPrompt({ context, message = "", mode = "text", direction = "inbound", languageName = "English" }) {
  const relevantFaqs = rankFaqs(message, context.faqs || []);
  const relevantChunks = rankChunks(message, context.chunks || []);
  const fallbackFaqs = relevantFaqs.length ? relevantFaqs : (context.faqs || []).slice(0, 8);
  const fallbackChunks = relevantChunks.length ? relevantChunks : (context.chunks || []).slice(0, 6);

  return [
    context.customPrompt ? `CUSTOM PROMPT:\n${context.customPrompt}` : "",
    baseBehaviorInstructions({ mode, direction, entity: context.entity || {}, languageName }),
    buildKnowledgeBlock({ faqs: fallbackFaqs, chunks: fallbackChunks }),
  ].filter(Boolean).join("\n\n---\n\n");
}

function cleanAssistantResponse(text) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function generateGroundedChatResponse({ message, history = [], chatbotId, languageName = "English" }) {
  const context = await loadChatbotContext(chatbotId);
  const openai = getOpenAI();
  const systemPrompt = buildAssistantPrompt({ context, message, mode: "text", direction: "chat", languageName });

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.35,
    max_tokens: 520,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.slice(-12).map((m) => ({ role: m.role === "model" ? "assistant" : "user", content: m.text || m.content || "" })),
      { role: "user", content: message },
    ],
  });

  return { response: cleanAssistantResponse(completion.choices[0]?.message?.content || "I could not find that information. Would you like to leave your details so someone can follow up?"), context };
}

function looksUnanswered(text) {
  const lower = String(text || "").toLowerCase();
  return ["could not find", "don't have", "do not have", "not available", "not listed", "someone can follow up", "leave your details"].some((p) => lower.includes(p));
}

module.exports = {
  loadChatbotContext,
  loadVoiceAgentContext,
  buildAssistantPrompt,
  generateGroundedChatResponse,
  cleanAssistantResponse,
  looksUnanswered,
  rankChunks,
  rankFaqs,
};
