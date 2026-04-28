// lib/scraper.service.js - website knowledge importer with link preservation
"use strict";

const { getSupabase } = require("./supabase");
const cheerio = require("cheerio");

const CHUNK_SIZE = Number(process.env.SCRAPER_CHUNK_SIZE || 450);
const CHUNK_OVERLAP = Number(process.env.SCRAPER_CHUNK_OVERLAP || 60);
const MAX_CHUNKS = Number(process.env.SCRAPER_MAX_CHUNKS || 120);
const MAX_PAGES = Number(process.env.SCRAPER_MAX_PAGES || 8);

function normalizeUrl(url) {
  return String(url || "").startsWith("http")
    ? String(url).trim()
    : `https://${String(url || "").trim()}`;
}

function sameHost(a, b) {
  try {
    return (
      new URL(a).hostname.replace(/^www\./, "") ===
      new URL(b).hostname.replace(/^www\./, "")
    );
  } catch (_) {
    return false;
  }
}

function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch (_) {
    return "Website page";
  }
}

async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/http://r.jina.ai/http://invalid`;
  const target = `https://r.jina.ai/${url.replace(/^https?:\/\//, "")}`;
  const res = await fetch(target, {
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
  return { text, title: titleFromUrl(url), links: extractUrls(text) };
}

function extractUrls(text) {
  return Array.from(
    new Set(
      (String(text || "").match(/https?:\/\/[^\s)\]"'<>{}]+/gi) || []).map(
        (u) => u.replace(/[.,;:!?]+$/, ""),
      ),
    ),
  );
}

async function fetchRaw(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Agently-bot/1.0)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const title = (
    $("title").first().text() ||
    $("h1").first().text() ||
    titleFromUrl(url)
  )
    .replace(/\s+/g, " ")
    .trim();
  const links = [];
  $("a[href]").each((_i, el) => {
    const href = String($(el).attr("href") || "").trim();
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
    try {
      const abs = new URL(href, url).toString().replace(/#.*$/, "");
      if (sameHost(abs, url))
        links.push({ label: label || titleFromUrl(abs), url: abs });
    } catch (_) {}
  });
  $("script, style, noscript, svg, canvas").remove();
  let text = "";
  $("body")
    .find("h1,h2,h3,h4,h5,h6,p,li,a,span,div,button")
    .each((_i, el) => {
      const content = $(el).text().replace(/\s+/g, " ").trim();
      if (content.length > 18) text += content + "\n";
    });
  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const linkText = Array.from(new Map(links.map((l) => [l.url, l])).values())
    .slice(0, 80)
    .map((l) => `Link: ${l.label} - ${l.url}`)
    .join("\n");
  if (linkText)
    text += `\n\nWebsite links discovered on this page:\n${linkText}`;
  if (text.length < 100)
    throw new Error("Page returned too little text content");
  return { text, title, links: links.map((l) => l.url) };
}

async function fetchPage(url) {
  try {
    return await fetchViaJina(url);
  } catch (jinaErr) {
    console.warn(
      "[scraper] Jina failed, falling back to raw fetch:",
      jinaErr.message,
    );
    return await fetchRaw(url);
  }
}

function chunkText(text, sourceUrl, sourceTitle) {
  const words = String(text || "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const chunks = [];
  let i = 0;
  let idx = 0;
  while (i < words.length && chunks.length < MAX_CHUNKS) {
    const slice = words
      .slice(i, i + CHUNK_SIZE)
      .join(" ")
      .trim();
    if (slice.length > 40)
      chunks.push({ content: slice, chunkIndex: idx, sourceUrl, sourceTitle });
    idx += 1;
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

async function scrapeAndStore({
  url,
  chatbotId,
  organizationId,
  voiceAgentId = null,
}) {
  const normalizedUrl = normalizeUrl(url);
  const pages = [];
  const home = await fetchPage(normalizedUrl);
  pages.push({
    url: normalizedUrl,
    title: home.title || titleFromUrl(normalizedUrl),
    text: home.text,
  });

  const candidateLinks = Array.from(
    new Set([...(home.links || []), ...extractUrls(home.text || "")]),
  )
    .filter((u) => sameHost(u, normalizedUrl))
    .filter(
      (u) => !/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp4|mp3|css|js)$/i.test(u),
    )
    .slice(0, Math.max(0, MAX_PAGES - 1));

  for (const pageUrl of candidateLinks) {
    try {
      const p = await fetchPage(pageUrl);
      pages.push({
        url: pageUrl,
        title: p.title || titleFromUrl(pageUrl),
        text: p.text,
      });
    } catch (e) {
      console.warn("[scraper] skipped linked page:", pageUrl, e.message);
    }
  }

  const chunks = [];
  for (const p of pages) chunks.push(...chunkText(p.text, p.url, p.title));
  if (!chunks.length) throw new Error("No usable content found at that URL.");

  const db = getSupabase();
  await db.from("knowledge_chunks").delete().eq("chatbot_id", chatbotId);
  const rows = chunks.slice(0, MAX_CHUNKS).map((c) => ({
    organization_id: organizationId,
    chatbot_id: chatbotId,
    voice_agent_id: voiceAgentId || null,
    source_url: c.sourceUrl,
    source_title: c.sourceTitle || titleFromUrl(c.sourceUrl),
    content: c.content.slice(0, 8000),
    chunk_index: c.chunkIndex,
  }));

  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db
      .from("knowledge_chunks")
      .insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`Failed to save chunks: ${error.message}`);
  }
  return {
    success: true,
    chunksStored: rows.length,
    pagesScraped: pages.length,
    strategy: "linked-knowledge-import",
  };
}

module.exports = { scrapeAndStore };
