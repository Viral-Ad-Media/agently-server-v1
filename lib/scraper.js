"use strict";

/**
 * Website scraper for Vercel serverless.
 *
 * Strategy (in order):
 * 1. Native fetch — works for most public sites
 * 2. Jina.ai Reader API (https://r.jina.ai/{url}) — free, returns clean markdown
 *    from any website including JS-rendered ones. No key needed.
 * 3. Fallback to OpenAI generating generic FAQs from the URL domain name alone
 *
 * Extracted content is:
 * a) Chunked and saved to `knowledge_chunks` table in Supabase
 * b) Summarised into FAQ pairs via OpenAI and saved to `faqs` table
 * c) Used directly as chatbot system context
 */

const { getSupabase } = require("./supabase");
const { getOpenAI } = require("./openai-client");

// ── Strategy 1: Direct fetch + HTML strip ─────────────────────
async function fetchDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (!html || html.length < 100)
      throw new Error("Empty or too short response");
    return extractTextFromHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

// ── Strategy 2: Jina Reader API (handles JS sites, free) ─────
async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: {
        Accept: "text/plain",
        "User-Agent": "AgentlyBot/1.0",
        // Optional: set X-Return-Format header for different output
      },
    });
    if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 100)
      throw new Error("Jina returned empty content");
    return text.slice(0, 8000);
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML text extractor ───────────────────────────────────────
function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

// ── Chunk content for Supabase storage ───────────────────────
function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.length > 50) chunks.push(chunk);
    i += chunkSize - overlap;
  }
  return chunks;
}

// ── Main scrape function ──────────────────────────────────────
async function scrapeWebsite(url) {
  // Normalise URL
  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith("http")) cleanUrl = "https://" + cleanUrl;

  let rawContent = "";
  let strategy = "";

  // Try Strategy 1: direct fetch
  try {
    rawContent = await fetchDirect(cleanUrl);
    strategy = "direct";
    console.log(`[scraper] Direct fetch OK (${rawContent.length} chars)`);
  } catch (e1) {
    console.warn("[scraper] Direct fetch failed:", e1.message);

    // Try Strategy 2: Jina Reader
    try {
      rawContent = await fetchViaJina(cleanUrl);
      strategy = "jina";
      console.log(`[scraper] Jina fetch OK (${rawContent.length} chars)`);
    } catch (e2) {
      console.warn("[scraper] Jina fetch failed:", e2.message);
      strategy = "fallback";
      rawContent = `Business website: ${cleanUrl}`;
    }
  }

  return { rawContent, strategy, url: cleanUrl };
}

// ── Generate FAQs from scraped content via OpenAI ─────────────
async function generateFaqsFromContent(rawContent, url) {
  const openai = getOpenAI();

  const prompt = `You are setting up an AI customer service agent for a business.

Based on the following website content, generate exactly 10 FAQ entries representing what customers commonly ask when they call or message this business.

Return ONLY valid JSON in this format (no markdown, no explanation):
{"faqs":[{"question":"...","answer":"..."}]}

Each answer should be clear, helpful, and 1-3 sentences.
If the content is sparse, use the business domain to infer reasonable FAQs.

Website URL: ${url}

Content:
${rawContent.slice(0, 5000)}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1500,
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content || "{}");
  } catch {
    return getDefaultFaqs();
  }

  const faqs =
    parsed.faqs || parsed.items || (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(faqs) || faqs.length === 0) return getDefaultFaqs();

  return faqs.slice(0, 12).map((f, i) => ({
    id: `scraped-${Date.now()}-${i}`,
    question: String(f.question || "How can I help you?").trim(),
    answer: String(
      f.answer || "Please contact us for more information.",
    ).trim(),
  }));
}

// ── Save knowledge chunks to Supabase ────────────────────────
async function saveKnowledgeChunks(orgId, chatbotId, url, rawContent, chunks) {
  const db = getSupabase();
  if (!orgId || !chatbotId) {
    console.warn(
      "[scraper] saveKnowledgeChunks skipped: missing orgId or chatbotId",
    );
    return 0;
  }

  // Delete old chunks for this chatbot+URL
  const { error: delErr } = await db
    .from("knowledge_chunks")
    .delete()
    .eq("organization_id", orgId)
    .eq("chatbot_id", chatbotId)
    .eq("source_url", url);
  if (delErr)
    console.warn("[scraper] Failed to delete old chunks:", delErr.message);

  if (!chunks.length) return 0;

  const rows = chunks.map((text, i) => ({
    organization_id: orgId,
    chatbot_id: chatbotId,
    source_url: url,
    chunk_index: i,
    content: text.slice(0, 8000), // limit per chunk
  }));

  const { error: insertErr } = await db.from("knowledge_chunks").insert(rows);
  if (insertErr) {
    console.error("[scraper] Failed to save chunks:", insertErr.message);
    return 0;
  }
  console.log(`[scraper] Saved ${rows.length} chunks for chatbot ${chatbotId}`);
  return rows.length;
}

// ── Full pipeline: scrape → chunk → save → generate FAQs ─────
async function scrapeAndSave(orgId, chatbotId, url) {
  // 1. Scrape the website
  const { rawContent, strategy } = await scrapeWebsite(url);

  // 2. Chunk the content
  const chunks = chunkText(rawContent);

  // 3. Save chunks to Supabase knowledge_chunks table
  if (orgId) {
    await saveKnowledgeChunks(orgId, chatbotId, url, rawContent, chunks);
  }

  // 4. Generate structured FAQs via OpenAI
  const faqs = await generateFaqsFromContent(rawContent, url);

  return {
    faqs,
    chunks: chunks.length,
    strategy,
    rawLength: rawContent.length,
  };
}

// ── Retrieve knowledge for a chatbot (for AI context) ────────
async function getKnowledgeContext(
  orgId,
  chatbotId,
  userMessage,
  maxChunks = 5,
) {
  const db = getSupabase();

  // Simple keyword-based retrieval (no embeddings needed)
  const keywords = userMessage
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);

  if (keywords.length === 0) return "";

  // Fetch all chunks for this chatbot (max 50 for performance)
  const { data: chunks } = await db
    .from("knowledge_chunks")
    .select("content, chunk_index")
    .eq("organization_id", orgId)
    .eq("chatbot_id", chatbotId)
    .order("chunk_index", { ascending: true })
    .limit(50);

  if (!chunks || chunks.length === 0) return "";

  // Score each chunk by keyword matches
  const scored = chunks.map((chunk) => {
    const text = chunk.content.toLowerCase();
    const score = keywords.reduce(
      (s, kw) => s + (text.includes(kw) ? 1 : 0),
      0,
    );
    return { content: chunk.content, score };
  });

  const topChunks = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map((c) => c.content);

  return topChunks.join("\n\n---\n\n");
}

function getDefaultFaqs() {
  return [
    {
      id: "df-1",
      question: "What are your business hours?",
      answer:
        "We are open Monday to Friday, 9 AM to 6 PM. Weekend hours may vary.",
    },
    {
      id: "df-2",
      question: "How do I book an appointment?",
      answer:
        "You can book by calling us directly or using our online booking system on our website.",
    },
    {
      id: "df-3",
      question: "Where are you located?",
      answer: "Please visit our website for our full address and directions.",
    },
    {
      id: "df-4",
      question: "What services do you offer?",
      answer:
        "We offer a range of professional services. Please contact us for a detailed list tailored to your needs.",
    },
    {
      id: "df-5",
      question: "How much do your services cost?",
      answer:
        "Pricing varies depending on the service. We are happy to provide a free quote upon request.",
    },
    {
      id: "df-6",
      question: "Do you offer emergency or same-day service?",
      answer:
        "Yes, we do our best to accommodate urgent requests. Please call us directly for immediate assistance.",
    },
    {
      id: "df-7",
      question: "How do I cancel or reschedule?",
      answer:
        "Please contact us at least 24 hours in advance to reschedule or cancel an appointment without charge.",
    },
    {
      id: "df-8",
      question: "What payment methods do you accept?",
      answer:
        "We accept cash, all major credit cards, and various online payment options.",
    },
    {
      id: "df-9",
      question: "Do you serve my area?",
      answer:
        "We serve a wide local area. Contact us with your location and we will confirm availability.",
    },
    {
      id: "df-10",
      question: "How can I get a quote?",
      answer:
        "You can request a free quote by calling us, emailing us, or filling out the contact form on our website.",
    },
  ];
}

module.exports = {
  scrapeAndSave,
  scrapeWebsite,
  generateFaqsFromContent,
  getKnowledgeContext,
  getDefaultFaqs,
};
