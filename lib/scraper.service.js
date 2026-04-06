// lib/scraper.service.js
const { getSupabase } = require("./supabase");
const cheerio = require("cheerio");

const CHUNK_SIZE = 400; // words per chunk
const CHUNK_OVERLAP = 40; // word overlap
const MAX_CHUNKS = 80;

// Jina.ai reader (free, no API key) – works for most JS‑heavy sites
async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "")}`;
  const res = await fetch(jinaUrl, {
    headers: {
      Accept: "text/plain",
      "X-With-Images-Summary": "false",
      "X-With-Links-Summary": "true",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Jina returned ${res.status}`);
  const text = await res.text();
  if (text.trim().length < 100)
    throw new Error("Jina returned too little content");
  return text;
}

// Improved raw HTML fetch + cheerio text extraction
async function fetchRaw(url) {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  const res = await fetch(fullUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Agently-bot/1.0; +https://agently.ai)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();

  // Use cheerio to parse HTML and extract visible text
  const $ = cheerio.load(html);

  // Remove script, style, nav, footer, header tags
  $(
    'script, style, nav, footer, header, aside, .hidden, [style*="display:none"], [style*="display: none"]',
  ).remove();

  // Extract text from meaningful tags
  let text = "";
  $("body")
    .find("p, h1, h2, h3, h4, h5, h6, li, a, span, div:not(:empty)")
    .each((i, el) => {
      const content = $(el).text().trim();
      if (content.length > 20) {
        // ignore very short fragments
        text += content + "\n";
      }
    });

  // Fallback: if still very little text, take the whole body text
  if (text.length < 200) {
    text = $("body").text();
  }

  // Clean up extra whitespace
  text = text.replace(/\s+/g, " ").trim();

  if (text.length < 100)
    throw new Error("Page returned too little text content");
  return text;
}

function chunkText(text, url) {
  const words = text.split(/\s+/).filter((w) => w.length > 1);
  const chunks = [];
  let i = 0;
  let idx = 0;
  while (i < words.length && idx < MAX_CHUNKS) {
    const slice = words.slice(i, i + CHUNK_SIZE).join(" ");
    if (slice.trim().length > 30) {
      chunks.push({ content: slice, chunkIndex: idx, sourceUrl: url });
      idx++;
    }
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// Main function: scrape, chunk, store in knowledge_chunks
async function scrapeAndStore({ url, chatbotId, organizationId }) {
  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
  let rawText = "";
  let strategy = "jina";

  try {
    rawText = await fetchViaJina(normalizedUrl);
    console.log(`[scraper] Jina success, text length: ${rawText.length}`);
  } catch (jinaErr) {
    console.warn(
      "[scraper] Jina failed, falling back to raw fetch:",
      jinaErr.message,
    );
    try {
      rawText = await fetchRaw(normalizedUrl);
      strategy = "raw-html";
      console.log(
        `[scraper] Raw fetch success, text length: ${rawText.length}`,
      );
    } catch (rawErr) {
      throw new Error(
        `Could not fetch content from "${url}". Make sure the URL is public.`,
      );
    }
  }

  const chunks = chunkText(rawText, normalizedUrl);
  if (chunks.length === 0) {
    console.warn(`[scraper] No chunks created from ${rawText.length} chars`);
    throw new Error(
      "No usable content found at that URL (chunking produced zero chunks).",
    );
  }

  const db = getSupabase();
  // Delete old chunks for this chatbot
  await db.from("knowledge_chunks").delete().eq("chatbot_id", chatbotId);

  const rows = chunks.map((c) => ({
    organization_id: organizationId,
    chatbot_id: chatbotId,
    source_url: c.sourceUrl,
    content: c.content,
    chunk_index: c.chunkIndex,
  }));

  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db
      .from("knowledge_chunks")
      .insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`Failed to save chunks: ${error.message}`);
  }

  return { success: true, chunksStored: chunks.length, strategy };
}

module.exports = { scrapeAndStore };
