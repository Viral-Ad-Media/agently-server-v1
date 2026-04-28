"use strict";

const { getSupabase } = require("./supabase");
let getOpenAI;
try {
  ({ getOpenAI } = require("./openai-client"));
} catch (_) {
  ({ getOpenAI } = require("./openai"));
}

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const MAX_FAQS = 40;
const MAX_CHUNKS = Number(process.env.ASSISTANT_MAX_CHUNKS || 16);
const MAX_CONTEXT_CHARS = Number(
  process.env.ASSISTANT_MAX_CONTEXT_CHARS || 18000,
);

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "get",
  "go",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "our",
  "please",
  "show",
  "take",
  "tell",
  "that",
  "the",
  "them",
  "there",
  "this",
  "to",
  "want",
  "what",
  "where",
  "which",
  "with",
  "you",
  "your",
  "about",
  "info",
  "information",
  "details",
  "link",
  "links",
  "page",
  "website",
  "site",
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
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9+#/._-]+/g, " ")
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
  return { question, answer, urls: extractUrls(`${question} ${answer}`) };
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
    chunk_index: Number.isFinite(Number(c.chunk_index))
      ? Number(c.chunk_index)
      : 0,
    urls: uniqueBy([sourceUrl, ...inlineUrls].filter(Boolean), (u) => u),
  };
}

function scoreText(queryTokens, text, url = "") {
  const hay = `${text || ""} ${url || ""}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) score += tok.length >= 6 ? 4 : 2;
    if (url && url.toLowerCase().includes(tok)) score += 4;
  }
  if (
    /social|instagram|facebook|twitter|x\.com|linkedin|tiktok|youtube/i.test(
      text + " " + url,
    ) &&
    queryTokens.some((t) =>
      [
        "social",
        "instagram",
        "facebook",
        "linkedin",
        "tiktok",
        "youtube",
        "twitter",
      ].includes(t),
    )
  )
    score += 8;
  return score;
}

function rankFaqs(message, faqs, limit = 10) {
  const tokens = tokenize(message);
  if (!tokens.length) return (faqs || []).slice(0, Math.min(6, limit));
  return (faqs || [])
    .map((faq) => ({
      ...faq,
      _score: scoreText(
        tokens,
        `${faq.question} ${faq.answer}`,
        (faq.urls || []).join(" "),
      ),
    }))
    .filter((f) => f._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...faq }) => faq);
}

function rankChunks(message, chunks, limit = MAX_CHUNKS) {
  const tokens = tokenize(message);
  if (!tokens.length) return (chunks || []).slice(0, Math.min(8, limit));
  const ranked = (chunks || [])
    .map((chunk) => ({
      ...chunk,
      _score: scoreText(
        tokens,
        `${chunk.source_title || ""} ${chunk.content || ""}`,
        `${chunk.source_url || ""} ${(chunk.urls || []).join(" ")}`,
      ),
    }))
    .filter((c) => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...chunk }) => chunk);
  return ranked.length ? ranked : (chunks || []).slice(0, Math.min(8, limit));
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

async function loadOrganization(orgId) {
  if (!orgId) return null;
  const data = await safeQuery(
    "organization",
    () =>
      getSupabase()
        .from("organizations")
        .select("id,name,industry,website,location,phone_number,timezone")
        .eq("id", orgId)
        .maybeSingle(),
    null,
  );
  return data || null;
}

async function loadKnowledgeChunks({
  organizationId,
  chatbotId,
  voiceAgentId,
  limit = 160,
}) {
  const db = getSupabase();
  const chunks = [];
  if (chatbotId) {
    chunks.push(
      ...(await safeQuery("chatbot knowledge chunks", () =>
        db
          .from("knowledge_chunks")
          .select(
            "source_url,source_title,content,chunk_index,chatbot_id,voice_agent_id,organization_id",
          )
          .eq("chatbot_id", chatbotId)
          .order("chunk_index", { ascending: true })
          .limit(limit),
      )),
    );
  }
  if (voiceAgentId) {
    chunks.push(
      ...(await safeQuery("voice agent knowledge chunks", () =>
        db
          .from("knowledge_chunks")
          .select(
            "source_url,source_title,content,chunk_index,chatbot_id,voice_agent_id,organization_id",
          )
          .eq("voice_agent_id", voiceAgentId)
          .order("chunk_index", { ascending: true })
          .limit(limit),
      )),
    );
  }
  if (organizationId) {
    // Fallback matters because older imports sometimes saved organization_id but no chatbot_id/voice_agent_id.
    chunks.push(
      ...(await safeQuery("organization knowledge chunks", () =>
        db
          .from("knowledge_chunks")
          .select(
            "source_url,source_title,content,chunk_index,chatbot_id,voice_agent_id,organization_id",
          )
          .eq("organization_id", organizationId)
          .order("chunk_index", { ascending: true })
          .limit(limit),
      )),
    );
  }
  return uniqueBy(
    chunks.map(normalizeChunk).filter(Boolean),
    (c) => `${c.source_url}|${c.chunk_index}|${c.content.slice(0, 160)}`,
  );
}

async function loadChatbotContext(chatbotId) {
  const db = getSupabase();
  const { data: chatbot, error } = await db
    .from("chatbots")
    .select(
      "id,organization_id,voice_agent_id,name,header_title,welcome_message,custom_prompt,faqs,chat_voice,chat_languages,collect_leads",
    )
    .eq("id", chatbotId)
    .maybeSingle();
  if (error || !chatbot) throw new Error("Chatbot not found.");

  const org = await loadOrganization(chatbot.organization_id);
  let linkedAgent = null;
  let linkedAgentFaqs = [];
  if (chatbot.voice_agent_id) {
    linkedAgent = await safeQuery(
      "linked voice agent",
      () =>
        db
          .from("voice_agents")
          .select(
            "id,name,direction,greeting,tone,language,business_hours,escalation_phone,data_capture_fields,rules,call_purposes",
          )
          .eq("id", chatbot.voice_agent_id)
          .maybeSingle(),
      null,
    );
    linkedAgentFaqs = await safeQuery("linked voice faqs", () =>
      db
        .from("faqs")
        .select("question,answer")
        .eq("voice_agent_id", chatbot.voice_agent_id)
        .limit(MAX_FAQS),
    );
  }

  const chatbotFaqs = asArray(chatbot.faqs).map(normalizeFaq).filter(Boolean);
  const chunks = await loadKnowledgeChunks({
    organizationId: chatbot.organization_id,
    chatbotId,
    voiceAgentId: chatbot.voice_agent_id,
  });

  return {
    type: "chatbot",
    organization_id: chatbot.organization_id,
    entity: chatbot,
    organization: org,
    linkedAgent,
    customPrompt: chatbot.custom_prompt || "",
    faqs: uniqueBy(
      [...chatbotFaqs, ...linkedAgentFaqs.map(normalizeFaq).filter(Boolean)],
      (f) => `${f.question}|${f.answer}`,
    ).slice(0, MAX_FAQS),
    chunks,
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

  const org = await loadOrganization(agent.organization_id);
  const [agentFaqs, linkedChatbots] = await Promise.all([
    safeQuery("voice faqs", () =>
      db
        .from("faqs")
        .select("question,answer")
        .eq("voice_agent_id", agentId)
        .limit(MAX_FAQS),
    ),
    safeQuery("linked chatbots", () =>
      db
        .from("chatbots")
        .select("id,custom_prompt,faqs,name,header_title,welcome_message")
        .eq("voice_agent_id", agentId)
        .limit(10),
    ),
  ]);

  const chatbotFaqs = [];
  const chatbotPrompts = [];
  for (const bot of linkedChatbots || []) {
    chatbotFaqs.push(...asArray(bot.faqs).map(normalizeFaq).filter(Boolean));
    if (bot.custom_prompt) chatbotPrompts.push(cleanText(bot.custom_prompt));
  }
  const chunks = await loadKnowledgeChunks({
    organizationId: agent.organization_id,
    voiceAgentId: agentId,
  });

  return {
    type: "voice_agent",
    organization_id: agent.organization_id,
    entity: agent,
    organization: org,
    linkedChatbots,
    customPrompt: chatbotPrompts.join("\n\n"),
    faqs: uniqueBy(
      [...agentFaqs.map(normalizeFaq).filter(Boolean), ...chatbotFaqs],
      (f) => `${f.question}|${f.answer}`,
    ).slice(0, MAX_FAQS),
    chunks,
  };
}

function buildBusinessProfile(context) {
  const org = context.organization || {};
  const entity = context.entity || {};
  const agent = context.linkedAgent || {};
  const lines = [];
  lines.push(
    `Business/platform name: ${org.name || entity.header_title || entity.name || "this business"}`,
  );
  if (org.website) lines.push(`Official website: ${org.website}`);
  if (org.industry) lines.push(`Industry: ${org.industry}`);
  if (org.location) lines.push(`Location: ${org.location}`);
  if (org.phone_number) lines.push(`Business phone: ${org.phone_number}`);
  if (entity.header_title)
    lines.push(`Widget title/customer-facing name: ${entity.header_title}`);
  if (entity.welcome_message)
    lines.push(`Configured welcome message: ${entity.welcome_message}`);
  if (agent.name) lines.push(`Linked voice agent name: ${agent.name}`);
  if (agent.greeting) lines.push(`Linked voice greeting: ${agent.greeting}`);
  return lines.join("\n");
}

function buildLinkCatalog(
  { chunks = [], faqs = [], organization = {} },
  max = 30,
) {
  const rows = [];
  if (organization.website)
    rows.push({
      label: "Official website",
      url: organization.website,
      source: "organization",
    });
  for (const faq of faqs || [])
    for (const url of faq.urls || [])
      rows.push({ label: faq.question || "FAQ link", url, source: "faq" });
  for (const c of chunks || []) {
    for (const url of c.urls || []) {
      const label = c.source_title || inferLabelFromUrl(url) || "Website page";
      rows.push({
        label,
        url,
        source: c.source_title || c.source_url || "website knowledge",
      });
    }
  }
  return uniqueBy(rows, (r) => r.url).slice(0, max);
}

function inferLabelFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch (_) {
    return "";
  }
}

function buildKnowledgeBlock({ faqs = [], chunks = [], linkCatalog = [] }) {
  const faqText = faqs.length
    ? faqs
        .map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`)
        .join("\n")
    : "";
  let usedChars = 0;
  const chunkLines = [];
  for (const [i, c] of (chunks || []).entries()) {
    if (usedChars >= MAX_CONTEXT_CHARS) break;
    const snippet = c.content.slice(
      0,
      Math.min(1500, MAX_CONTEXT_CHARS - usedChars),
    );
    usedChars += snippet.length;
    const links =
      c.urls && c.urls.length ? `\n   Links: ${c.urls.join(" | ")}` : "";
    const title = c.source_title ? `Title: ${c.source_title}\n   ` : "";
    chunkLines.push(
      `${i + 1}. ${title}Source: ${c.source_url || "stored website content"}\n   Content: ${snippet}${links}`,
    );
  }
  const chunkText = chunkLines.length ? chunkLines.join("\n\n") : "";
  const linksText = linkCatalog.length
    ? linkCatalog.map((l, i) => `${i + 1}. ${l.label}: ${l.url}`).join("\n")
    : "";
  return [
    faqText ? `SCOPED FAQS:\n${faqText}` : "",
    linksText
      ? `AVAILABLE LINKS FROM THIS BUSINESS/WEBSITE:\n${linksText}`
      : "",
    chunkText ? `SCOPED WEBSITE KNOWLEDGE CHUNKS:\n${chunkText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function baseBehaviorInstructions({
  mode = "text",
  direction = "inbound",
  entity = {},
  languageName = "English",
}) {
  const isVoice = mode === "voice";
  const captureFields = asArray(entity.data_capture_fields).length
    ? asArray(entity.data_capture_fields).join(", ")
    : "name, phone, email, reason";
  const callPurposes = asArray(entity.call_purposes)
    .map((p) => cleanText(p))
    .filter(Boolean);
  return `ROLE AND IDENTITY:
- You are the customer-facing AI receptionist/website concierge for the business in BUSINESS PROFILE.
- Never introduce yourself as OpenAI, ChatGPT, a generic AI module, a demo, or a software integration.
- If a name is configured, use it naturally. Otherwise say you are the business assistant.
- Stay focused on this business, its website, its products/services, its FAQs, and customer support.

GROUNDING RULES:
- Use ONLY the scoped custom prompt, FAQs, website knowledge chunks, available links, business profile, and outbound call purposes when relevant.
- Do not invent social links, products, addresses, prices, policies, or capabilities that are not in the scoped knowledge.
- If information is missing, say: "I could not find that in the information I have." Then offer useful available options or collect a message.
- For broad requests with multiple possible matches, ask one concise clarifying question and list the closest options.
- For specific requests with a strong match, give the direct answer and the best link immediately.
- For website navigation requests, use markdown links in text mode: [Page name](https://example.com/page).
- Do not say you cannot provide clickable links in text chat. If links are in the available knowledge, provide them.
- Do not answer unrelated general questions unless they help the visitor use this business website.

RESPONSE STYLE:
- Format text replies with **bold section headers** when helpful, clean paragraphs, and short bullet lists.
- Keep answers organized and easy to scan. No raw JSON.
- Respond in ${languageName || "English"} unless the visitor asks otherwise.
${isVoice ? "- Voice mode: keep responses short, natural, and speakable. If a link is needed, identify the page clearly and say you can show/send the link in the chat interface if available." : "- Text mode: make links clickable and easy to scan."}

LEAD AND MESSAGE CAPTURE:
- Collect ${captureFields} when the visitor asks for a quote, callback, booking, order help, human assistance, or leaves a message.
- Do not repeatedly ask for contact details after the visitor has already provided them.

CALL RULES:
- Inbound calls answer questions from the business knowledge and collect caller details/messages when needed.
- Outbound calls use call purposes only when direction is outbound.
${direction === "outbound" && callPurposes.length ? `- Outbound call purposes to cover: ${callPurposes.join("; ")}` : "- If this is inbound/chat, do not force outbound call purposes into the conversation."}`;
}

function buildAssistantPrompt({
  context,
  message = "",
  mode = "text",
  direction = "inbound",
  languageName = "English",
}) {
  const relevantFaqs = rankFaqs(message, context.faqs || []);
  const relevantChunks = rankChunks(message, context.chunks || []);
  const fallbackFaqs = relevantFaqs.length
    ? relevantFaqs
    : (context.faqs || []).slice(0, 10);
  const fallbackChunks = relevantChunks.length
    ? relevantChunks
    : (context.chunks || []).slice(0, 10);
  const linkCatalog = buildLinkCatalog({
    chunks: fallbackChunks.length ? fallbackChunks : context.chunks,
    faqs: fallbackFaqs,
    organization: context.organization || {},
  });
  return [
    `BUSINESS PROFILE:\n${buildBusinessProfile(context)}`,
    context.customPrompt
      ? `CUSTOM PROMPT FROM BUSINESS OWNER:\n${context.customPrompt}`
      : "",
    baseBehaviorInstructions({
      mode,
      direction,
      entity: context.entity || {},
      languageName,
    }),
    buildKnowledgeBlock({
      faqs: fallbackFaqs,
      chunks: fallbackChunks,
      linkCatalog,
    }),
    `CURRENT USER REQUEST:\n${message || "session started"}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function cleanAssistantResponse(text) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function generateGroundedChatResponse({
  message,
  history = [],
  chatbotId,
  languageName = "English",
}) {
  const context = await loadChatbotContext(chatbotId);
  const openai = getOpenAI();
  const systemPrompt = buildAssistantPrompt({
    context,
    message,
    mode: "text",
    direction: "chat",
    languageName,
  });
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.15,
    max_tokens: 750,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.slice(-10).map((m) => ({
        role: m.role === "model" ? "assistant" : "user",
        content: m.text || m.content || "",
      })),
      { role: "user", content: message },
    ],
  });
  return {
    response: cleanAssistantResponse(
      completion.choices[0]?.message?.content ||
        "I could not find that in the information I have. Would you like to leave your details so someone can follow up?",
    ),
    context,
  };
}

function looksUnanswered(text) {
  const lower = String(text || "").toLowerCase();
  return [
    "could not find",
    "don't have",
    "do not have",
    "not available",
    "not listed",
    "someone can follow up",
    "leave your details",
    "information i have",
  ].some((p) => lower.includes(p));
}

function getContextStats(context) {
  const links = buildLinkCatalog({
    chunks: context.chunks || [],
    faqs: context.faqs || [],
    organization: context.organization || {},
  });
  return {
    type: context.type,
    organizationId: context.organization_id,
    businessName:
      context.organization?.name ||
      context.entity?.header_title ||
      context.entity?.name ||
      "",
    faqCount: (context.faqs || []).length,
    chunkCount: (context.chunks || []).length,
    linkCount: links.length,
    sampleLinks: links.slice(0, 8),
    sampleChunks: (context.chunks || []).slice(0, 3).map((c) => ({
      source_url: c.source_url,
      title: c.source_title,
      preview: c.content.slice(0, 180),
    })),
  };
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
  buildLinkCatalog,
  getContextStats,
};
