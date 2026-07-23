"use strict";

let _openai = null;
const { logOpenAIUsage } = require("./usage-ledger");

function getOpenAI() {
  if (_openai) return _openai;
  const { OpenAI } = require("openai");
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  _openai = new OpenAI({ apiKey: key, timeout: 25000, maxRetries: 2 });
  return _openai;
}

// Use native fetch (Node 18+) with a timeout helper

async function maybeLogUsage(service, completion, context = {}) {
  try {
    await logOpenAIUsage({
      organizationId: context.organizationId || context.organization_id || null,
      userId: context.userId || context.user_id || null,
      service,
      eventType: context.eventType || "openai_text_tokens",
      model: context.model || completion?.model || "unknown",
      usage: completion?.usage || {},
      callId: context.callId || context.call_id || null,
      chatbotId: context.chatbotId || context.chatbot_id || null,
      voiceAgentId: context.voiceAgentId || context.voice_agent_id || null,
      knowledgeBaseId:
        context.knowledgeBaseId || context.knowledge_base_id || null,
      leadId: context.leadId || context.lead_id || null,
      externalId: context.externalId || completion?.id || null,
      metadata: context.metadata || {},
    });
  } catch (err) {
    console.warn(
      `[usage-ledger] OpenAI ${service} usage log skipped`,
      err.message || String(err),
    );
  }
}

async function fetchWithTimeout(url, options, ms = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function generateFaqsFromWebsite(website, usageContext = {}) {
  const openai = getOpenAI();

  // Normalise URL
  let url = website.trim();
  if (!url.startsWith("http")) url = "https://" + url;

  let siteContent = "";
  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentlyBot/1.0)" },
      },
      10000,
    );
    const html = await res.text();
    siteContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);
  } catch (err) {
    console.warn("Website scrape failed:", err.message);
    siteContent = `Business website: ${url}`;
  }

  const prompt = `You are helping set up an AI phone receptionist.
Based on this website content, generate exactly 8 FAQ entries a customer might ask when calling.
Return ONLY valid JSON: {"faqs":[{"question":"...","answer":"..."}]}
No markdown. No explanation. Just the JSON object.

Website content:
${siteContent}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1200,
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  await maybeLogUsage("faq_generation", completion, usageContext);

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content || "{}");
  } catch {
    return getDefaultFaqs();
  }

  const faqs =
    parsed.faqs || parsed.items || (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(faqs) || faqs.length === 0) return getDefaultFaqs();

  return faqs.slice(0, 10).map((f, i) => ({
    id: `faq-${Date.now()}-${i}`,
    question: String(f.question || "How can I help you?"),
    answer: String(f.answer || "Please contact us for more information."),
  }));
}

async function generateChatResponse(
  userMessage,
  history = [],
  systemPrompt = "",
  usageContext = {},
) {
  const openai = getOpenAI();

  const messages = [
    {
      role: "system",
      content:
        systemPrompt ||
        "You are a helpful AI assistant. Be concise and friendly.",
    },
    ...history.slice(-16).map((m) => ({
      role: m.role === "model" ? "assistant" : "user",
      content: m.text || m.content || "",
    })),
    { role: "user", content: userMessage },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 250,
    temperature: 0.65,
  });

  await maybeLogUsage("chatbot_response", completion, usageContext);

  return (
    completion.choices[0]?.message?.content ||
    "I'm here to help! Could you please clarify your question?"
  );
}

async function generateCallSummary(transcript, outcome, usageContext = {}) {
  const openai = getOpenAI();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Summarize this customer service call transcript in 1-2 sentences. Be factual and concise.",
      },
      {
        role: "user",
        content: `Call outcome: ${outcome || "unknown"}\n\nTranscript:\n${transcript}`,
      },
    ],
    max_tokens: 120,
    temperature: 0.2,
  });

  await maybeLogUsage("call_summary", completion, usageContext);

  return completion.choices[0]?.message?.content || "Call completed.";
}

function getDefaultFaqs() {
  return [
    {
      id: "faq-1",
      question: "What are your operating hours?",
      answer: "We are open Monday to Friday, 9 AM to 6 PM.",
    },
    {
      id: "faq-2",
      question: "How can I book an appointment?",
      answer: "You can book by calling us or using our online booking system.",
    },
    {
      id: "faq-3",
      question: "Where are you located?",
      answer: "Please visit our website for our full address and directions.",
    },
    {
      id: "faq-4",
      question: "What services do you offer?",
      answer:
        "We offer a wide range of professional services. Please contact us for details.",
    },
    {
      id: "faq-5",
      question: "How much do your services cost?",
      answer: "Pricing varies by service. We can provide a quote upon request.",
    },
    {
      id: "faq-6",
      question: "Do you offer emergency services?",
      answer: "Yes, please call our main line for urgent assistance.",
    },
    {
      id: "faq-7",
      question: "How do I cancel or reschedule an appointment?",
      answer: "Please call us at least 24 hours in advance to reschedule.",
    },
    {
      id: "faq-8",
      question: "What payment methods do you accept?",
      answer: "We accept cash, credit cards, and online payments.",
    },
  ];
}

/**
 * Stream an OpenAI chat completion token by token.
 * onToken(token: string) is called for each text chunk.
 * Used by the ConversationRelay WebSocket handler.
 */
async function generateStreamingResponse(messages, onToken, usageContext = {}) {
  const openai = getOpenAI();
  const model = usageContext.model || "gpt-4o-mini";

  const stream = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: 200,
    temperature: 0.55,
    stream: true,
    stream_options: { include_usage: true },
  });

  let finalUsage = null;
  let completionId = null;
  for await (const chunk of stream) {
    if (chunk?.id) completionId = chunk.id;
    if (chunk?.usage) finalUsage = chunk.usage;
    const token = chunk.choices?.[0]?.delta?.content || "";
    if (token) onToken(token);
  }

  try {
    if (finalUsage) {
      await logOpenAIUsage({
        organizationId:
          usageContext.organizationId || usageContext.organization_id || null,
        userId: usageContext.userId || usageContext.user_id || null,
        service: usageContext.service || "streaming_chat",
        eventType: usageContext.eventType || "openai_streaming_tokens",
        model,
        usage: finalUsage,
        callId: usageContext.callId || usageContext.call_id || null,
        chatbotId: usageContext.chatbotId || usageContext.chatbot_id || null,
        voiceAgentId:
          usageContext.voiceAgentId || usageContext.voice_agent_id || null,
        knowledgeBaseId:
          usageContext.knowledgeBaseId ||
          usageContext.knowledge_base_id ||
          null,
        externalId:
          usageContext.externalId ||
          usageContext.external_id ||
          completionId ||
          null,
        metadata: {
          exact_usage: true,
          route: usageContext.route || null,
          ...(usageContext.metadata || {}),
        },
      });
    } else {
      await logOpenAIUsage({
        organizationId:
          usageContext.organizationId || usageContext.organization_id || null,
        userId: usageContext.userId || usageContext.user_id || null,
        service: usageContext.service || "streaming_chat",
        eventType: "openai_streaming_usage_missing",
        model,
        inputTokens: 0,
        outputTokens: 0,
        callId: usageContext.callId || usageContext.call_id || null,
        chatbotId: usageContext.chatbotId || usageContext.chatbot_id || null,
        voiceAgentId:
          usageContext.voiceAgentId || usageContext.voice_agent_id || null,
        knowledgeBaseId:
          usageContext.knowledgeBaseId ||
          usageContext.knowledge_base_id ||
          null,
        externalId:
          usageContext.externalId ||
          usageContext.external_id ||
          completionId ||
          null,
        metadata: {
          usage_missing: true,
          note: "OpenAI stream ended without a usage chunk. Do not treat this row as token usage or cost.",
          route: usageContext.route || null,
          ...(usageContext.metadata || {}),
        },
      });
    }
  } catch (err) {
    console.warn(
      "[usage-ledger] OpenAI streaming usage log skipped",
      err.message || String(err),
    );
  }
}

module.exports = {
  // FIX: getOpenAI is defined at line 6 and used by four functions in this
  // file, but was never exported. api/routes/messenger.js does
  //   const { getOpenAI } = require("../../lib/openai")
  // which yielded undefined -> "getOpenAI is not a function" the moment a
  // voice preview was requested. Pre-existing; surfaced once previews started
  // reporting their errors instead of failing silently.
  getOpenAI,
  generateFaqsFromWebsite,
  generateChatResponse,
  generateCallSummary,
  generateStreamingResponse,
};
