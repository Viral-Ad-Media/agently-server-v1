/**
 * Knowledge Base page discovery.
 *
 * Discovery catalogs URLs without extracting/chunking page content. It merges
 * sitemap data with a bounded crawl because real customer sites are often
 * incomplete, JavaScript-heavy, or use non-standard product paths such as
 * /jug, /phone, or /summer-kit rather than /product/....
 */

"use strict";

const cheerio = require("cheerio");
const { getSupabase } = require("./supabase");

const UA =
  process.env.SCRAPER_USER_AGENT ||
  "Mozilla/5.0 (compatible; AgentlyBot/2.0; +https://www.agentlycall.com)";
const CRAWL_CONCURRENCY = Math.max(
  2,
  Math.min(10, Number(process.env.DISCOVERY_CONCURRENCY || 6)),
);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(input) {
  if (!input) return "";
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source|session|sid)/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    let value = u.toString();
    if (value.endsWith("/") && u.pathname !== "/") value = value.slice(0, -1);
    return value;
  } catch (_) {
    return "";
  }
}

function sameHost(a, b) {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, "");
    const hb = new URL(b).hostname.replace(/^www\./, "");
    return ha === hb;
  } catch (_) {
    return false;
  }
}

function isBinary(url) {
  return /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|pdf|zip|rar|7z|mp4|mp3|avi|mov|woff2?|ttf|eot|xml|json|rss)(\?|$)/i.test(
    String(url || ""),
  );
}

function isUnhelpfulUrl(url) {
  let path = "";
  try {
    path = `${new URL(url).pathname}${new URL(url).search}`.toLowerCase();
  } catch (_) {
    return true;
  }
  return /\/(wp-admin|wp-login|login|signin|sign-in|account|my-account|cart|checkout|wishlist)(\/|$)|[?&](add-to-cart|replytocom)=/i.test(
    path,
  );
}

function titleFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    if (p === "/" || !p) return "Homepage";
    const last = p.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(last)
      .replace(/[-_]+/g, " ")
      .replace(/\.\w+$/, "")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 120);
  } catch (_) {
    return String(url || "").slice(0, 120);
  }
}

function scoreUrl(url, signals = {}) {
  let score = 50;
  let path = "/";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (_) {}
  if (path === "/" || path === "") return 100;
  if (
    /(about|service|product|pricing|plan|faq|contact|support|help)/.test(path)
  )
    score += 28;
  if (
    /(shop|store|catalog|collection|solution|feature|menu|inventory)/.test(path)
  )
    score += 22;
  if (/(blog|news|article|post)/.test(path)) score += 4;
  if (/(privacy|terms|legal|cookie|sitemap)/.test(path)) score -= 32;
  if (/(tag|category|author|page\/\d+|archive|feed)/.test(path)) score -= 18;
  score -= Math.max(0, (path.split("/").filter(Boolean).length - 1) * 3);
  if (signals.product) score += 38;
  if (signals.commerce) score += 18;
  if (signals.hasPrice) score += 12;
  if (signals.structuredData) score += 8;
  return Math.max(0, Math.min(100, score));
}

async function fetchText(
  url,
  { timeoutMs = 12000, accept = "text/html,*/*" } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolveInternalUrl(value, baseUrl) {
  const raw = cleanText(value);
  if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) return "";
  try {
    const resolved = normalizeUrl(new URL(raw, baseUrl).toString());
    return resolved && sameHost(resolved, baseUrl) && !isBinary(resolved)
      ? resolved
      : "";
  } catch (_) {
    return "";
  }
}

function addJsonUrls(value, baseUrl, out, inheritedProduct = false) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => addJsonUrls(item, baseUrl, out, inheritedProduct));
    return;
  }
  if (typeof value !== "object") return;
  const rawType = value["@type"] || value.type || "";
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const isProduct =
    inheritedProduct ||
    types.some((type) => /product|offer|itemlist/i.test(String(type || "")));
  for (const key of ["url", "@id", "item", "mainEntityOfPage"]) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      const url = resolveInternalUrl(candidate, baseUrl);
      if (url) out.set(url, { product: isProduct, structuredData: true });
    } else if (candidate && typeof candidate === "object") {
      addJsonUrls(candidate, baseUrl, out, isProduct);
    }
  }
  for (const child of [
    "@graph",
    "itemListElement",
    "offers",
    "mainEntity",
    "hasVariant",
    "isVariantOf",
  ]) {
    addJsonUrls(value[child], baseUrl, out, isProduct);
  }
}

function inspectHtml(html, pageUrl) {
  const links = new Map();
  const signals = {
    product: false,
    commerce: false,
    hasPrice: false,
    structuredData: false,
  };
  let title = titleFromUrl(pageUrl);
  let textLength = 0;
  try {
    const $ = cheerio.load(String(html || ""));
    title =
      cleanText($("title").first().text()) ||
      cleanText($("h1").first().text()) ||
      title;

    const fullBodyText = cleanText($("body").text());
    textLength = fullBodyText.length;
    const bodySample = fullBodyText.slice(0, 30000);
    signals.commerce =
      /\b(add to cart|add to bag|buy now|shop now|in stock|out of stock|checkout|sku|free shipping)\b/i.test(
        bodySample,
      );
    signals.hasPrice = /(?:[$£€₦]|USD|GBP|EUR|NGN)\s?\d[\d,.]*/i.test(
      bodySample,
    );
    signals.product =
      signals.commerce ||
      Boolean(
        $("[itemtype*='Product'], [itemprop='price'], form[action*='cart']")
          .length,
      );

    $(
      "a[href], [data-href], [data-url], form[action], link[rel='canonical']",
    ).each((_index, element) => {
      const node = $(element);
      const raw =
        node.attr("href") ||
        node.attr("data-href") ||
        node.attr("data-url") ||
        node.attr("action");
      const url = resolveInternalUrl(raw, pageUrl);
      if (!url) return;
      const label = cleanText(
        node.text() || node.attr("aria-label") || node.attr("title"),
      );
      const commerce =
        /\b(buy|shop|product|price|order|view item|details|add to cart)\b/i.test(
          `${label} ${raw || ""}`,
        );
      const previous = links.get(url) || {};
      links.set(url, {
        title: label || previous.title || titleFromUrl(url),
        product: previous.product || commerce,
        commerce: previous.commerce || commerce,
        structuredData: previous.structuredData || false,
      });
    });

    const ogUrl = resolveInternalUrl(
      $("meta[property='og:url']").attr("content"),
      pageUrl,
    );
    if (ogUrl) links.set(ogUrl, { title, structuredData: true });

    $("script[type='application/ld+json']").each((_index, element) => {
      try {
        const parsed = JSON.parse($(element).contents().text() || "null");
        addJsonUrls(parsed, pageUrl, links);
        signals.structuredData = true;
        const raw = JSON.stringify(parsed).slice(0, 12000);
        if (/"@type"\s*:\s*"Product"/i.test(raw)) signals.product = true;
      } catch (_) {}
    });
  } catch (_) {}
  return {
    title: title.slice(0, 160),
    links,
    signals,
    textLength,
  };
}

function inspectMarkdown(markdown, pageUrl) {
  const links = new Map();
  const re = /\[([^\]]{0,180})\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = re.exec(String(markdown || "")))) {
    const url = resolveInternalUrl(match[2], pageUrl);
    if (!url) continue;
    const label = cleanText(match[1]);
    links.set(url, {
      title: label || titleFromUrl(url),
      product: /\b(buy|shop|product|price|order|item)\b/i.test(label),
    });
  }
  return {
    title:
      cleanText(String(markdown || "").match(/^#\s+(.+)$/m)?.[1]) ||
      titleFromUrl(pageUrl),
    links,
    signals: {
      product: /\b(add to cart|buy now|in stock|out of stock|sku)\b/i.test(
        markdown,
      ),
      commerce: /\b(add to cart|buy now|shop now|checkout)\b/i.test(markdown),
      hasPrice: /(?:[$£€₦]|USD|GBP|EUR|NGN)\s?\d[\d,.]*/i.test(markdown),
      structuredData: false,
    },
  };
}

async function inspectPage(url) {
  const html = await fetchText(url);
  if (html) {
    const inspected = inspectHtml(html, url);
    if (inspected.links.size || inspected.textLength > 300) return inspected;
  }
  // Last-resort rendering proxy for JavaScript-only pages. It is used only
  // when the normal HTML fetch produced no useful document.
  const jinaUrl = `https://r.jina.ai/${url}`;
  const markdown = await fetchText(jinaUrl, {
    timeoutMs: 18000,
    accept: "text/plain,*/*",
  });
  return markdown ? inspectMarkdown(markdown, url) : null;
}

function parseLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = re.exec(String(xml || "")))) out.push(match[1].trim());
  return out;
}

async function discoverViaSitemap(rootUrl, { maxPages = 5000 } = {}) {
  const origin = new URL(rootUrl).origin;
  const seeds = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap/sitemap.xml`,
    `${origin}/product-sitemap.xml`,
    `${origin}/products-sitemap.xml`,
    `${origin}/wp-sitemap-posts-product-1.xml`,
    `${origin}/collections-sitemap.xml`,
  ];
  const robots = await fetchText(`${origin}/robots.txt`, {
    timeoutMs: 6000,
    accept: "text/plain,*/*",
  });
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (match) seeds.unshift(match[1].trim());
    }
  }

  const seen = new Set();
  const pages = new Set();
  const queue = [...new Set(seeds.map(normalizeUrl).filter(Boolean))];
  let fetched = 0;
  const maxSitemapFiles = Math.max(
    40,
    Math.min(500, Number(process.env.DISCOVERY_MAX_SITEMAPS || 200)),
  );
  while (queue.length && pages.size < maxPages && fetched < maxSitemapFiles) {
    const sitemap = queue.shift();
    if (!sitemap || seen.has(sitemap)) continue;
    seen.add(sitemap);
    const xml = await fetchText(sitemap, {
      timeoutMs: 12000,
      accept: "application/xml,text/xml,text/plain,*/*",
    });
    fetched += 1;
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const index = /<sitemapindex/i.test(xml);
    for (const loc of parseLocs(xml)) {
      const normalized = normalizeUrl(loc);
      if (!normalized || !sameHost(normalized, rootUrl)) continue;
      if (index || /sitemap.*\.xml(\?|$)/i.test(normalized)) {
        if (!seen.has(normalized)) queue.push(normalized);
      } else if (!isBinary(normalized) && !isUnhelpfulUrl(normalized)) {
        pages.add(normalized);
      }
      if (pages.size >= maxPages) break;
    }
  }
  return [...pages].slice(0, maxPages);
}

async function mapConcurrent(items, limit, worker) {
  const output = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return output;
}

async function discoverViaCrawl(
  rootUrl,
  { maxPages = 5000, maxDepth = 6, sitemapUrls = [] } = {},
) {
  const found = new Map();
  const details = new Map();
  found.set(rootUrl, 0);

  const likelyCatalogSeeds = sitemapUrls
    .filter((url) =>
      /(shop|store|catalog|collection|product|service|menu|inventory)/i.test(
        url,
      ),
    )
    .slice(0, 16);
  let frontier = [...new Set([rootUrl, ...likelyCatalogSeeds])];
  for (const seed of likelyCatalogSeeds) found.set(seed, 1);

  for (let depth = 0; depth <= maxDepth && found.size < maxPages; depth += 1) {
    const current = frontier.slice(0, depth === 0 ? 40 : 250);
    const inspected = await mapConcurrent(
      current,
      CRAWL_CONCURRENCY,
      async (url) => ({
        url,
        result: await inspectPage(url),
      }),
    );
    const next = [];
    for (const item of inspected) {
      if (!item?.result) continue;
      details.set(item.url, {
        title: item.result.title,
        signals: item.result.signals,
      });
      for (const [link, linkSignals] of item.result.links.entries()) {
        if (found.size >= maxPages) break;
        const previous = details.get(link) || {};
        details.set(link, {
          title: linkSignals.title || previous.title || titleFromUrl(link),
          signals: {
            ...(previous.signals || {}),
            ...linkSignals,
          },
        });
        if (!found.has(link) && !isUnhelpfulUrl(link)) {
          found.set(link, depth + 1);
          next.push(link);
        }
      }
    }
    if (!next.length) break;
    frontier = next.sort(
      (a, b) =>
        scoreUrl(b, details.get(b)?.signals) -
        scoreUrl(a, details.get(a)?.signals),
    );
  }
  return { urls: [...found.keys()], depths: found, details };
}

async function discoverPages({
  organizationId,
  knowledgeBaseId = null,
  knowledgeSourceId = null,
  rootUrl,
  maxPages = 5000,
  duringOnboarding = false,
  userId = null,
}) {
  const db = getSupabase();
  const root = normalizeUrl(rootUrl);
  if (!root) {
    throw Object.assign(new Error("A valid website URL is required."), {
      code: "INVALID_URL",
      status: 400,
    });
  }
  const domain = new URL(root).hostname.replace(/^www\./, "");
  let previouslySelectedPages = new Map();
  if (knowledgeBaseId && !duringOnboarding) {
    const { data: selectedRows } = await db
      .from("knowledge_discovered_pages")
      .select(
        "normalized_url,scrape_status,scrape_progress,chunks_created,faqs_created,content_hash,previous_content_hash,content_changed_at,last_scraped_at,last_checked_at,last_error",
      )
      .eq("organization_id", organizationId)
      .eq("knowledge_base_id", knowledgeBaseId)
      .eq("is_selected", true)
      .order("updated_at", { ascending: false })
      .limit(10000);
    previouslySelectedPages = new Map();
    for (const row of selectedRows || []) {
      const normalized = normalizeUrl(row.normalized_url);
      if (normalized && !previouslySelectedPages.has(normalized)) {
        previouslySelectedPages.set(normalized, row);
      }
    }
  }

  const { data: discovery, error: insertError } = await db
    .from("knowledge_page_discoveries")
    .insert({
      organization_id: organizationId,
      knowledge_base_id: knowledgeBaseId,
      knowledge_source_id: knowledgeSourceId,
      root_url: root,
      domain,
      status: "discovering",
      discovered_during_onboarding: duringOnboarding,
      created_at: nowIso(),
    })
    .select()
    .single();
  if (insertError) throw insertError;

  try {
    const sitemapUrls = await discoverViaSitemap(root, { maxPages });
    const crawled = await discoverViaCrawl(root, {
      maxPages,
      maxDepth: 6,
      sitemapUrls,
    });
    const allCandidateUrls = [
      ...new Set([root, ...sitemapUrls, ...crawled.urls]),
    ];
    const urls = allCandidateUrls
      .filter(
        (url) =>
          url && sameHost(url, root) && !isBinary(url) && !isUnhelpfulUrl(url),
      )
      .sort((a, b) => {
        if (a === root) return -1;
        if (b === root) return 1;
        return (
          scoreUrl(b, crawled.details.get(b)?.signals) -
          scoreUrl(a, crawled.details.get(a)?.signals)
        );
      })
      .slice(0, maxPages);
    const method = sitemapUrls.length ? "hybrid" : "crawl";

    const rows = urls.map((url) => {
      let path = "/";
      try {
        path = new URL(url).pathname;
      } catch (_) {}
      const detail = crawled.details.get(url) || {};
      const previous = previouslySelectedPages.get(url) || null;
      const selected = duringOnboarding ? url === root : Boolean(previous);
      return {
        discovery_id: discovery.id,
        organization_id: organizationId,
        knowledge_base_id: knowledgeBaseId,
        url,
        normalized_url: url,
        title: cleanText(detail.title) || titleFromUrl(url),
        path,
        depth: crawled.depths.get(url) ?? (url === root ? 0 : 1),
        priority_score: scoreUrl(url, detail.signals),
        is_selected: selected,
        scrape_status:
          selected && previous
            ? previous.scrape_status || "completed"
            : "pending",
        scrape_progress:
          selected && previous ? previous.scrape_progress || 100 : 0,
        chunks_created: selected && previous ? previous.chunks_created || 0 : 0,
        faqs_created: selected && previous ? previous.faqs_created || 0 : 0,
        content_hash:
          selected && previous ? previous.content_hash || null : null,
        previous_content_hash:
          selected && previous ? previous.previous_content_hash || null : null,
        content_changed_at:
          selected && previous ? previous.content_changed_at || null : null,
        last_scraped_at:
          selected && previous ? previous.last_scraped_at || null : null,
        last_checked_at:
          selected && previous ? previous.last_checked_at || null : null,
        last_error: selected && previous ? previous.last_error || null : null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
    });

    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db
        .from("knowledge_discovered_pages")
        .upsert(rows.slice(i, i + 100), {
          onConflict: "discovery_id,normalized_url",
          ignoreDuplicates: true,
        });
      if (error) throw error;
    }

    if (knowledgeBaseId) {
      await db
        .from("knowledge_discovered_pages")
        .update({ is_selected: false, updated_at: nowIso() })
        .eq("organization_id", organizationId)
        .eq("knowledge_base_id", knowledgeBaseId)
        .neq("discovery_id", discovery.id)
        .eq("is_selected", true);
    }

    await db
      .from("knowledge_page_discoveries")
      .update({
        status: "completed",
        total_pages_found: rows.length,
        metadata: {
          maxPages,
          truncated: allCandidateUrls.length > rows.length,
          candidatePagesFound: allCandidateUrls.length,
        },
        discovery_method: method,
        completed_at: nowIso(),
        updated_at: nowIso(),
      })
      .eq("id", discovery.id);

    try {
      const { insertUsageEvent } = require("./usage-ledger");
      await insertUsageEvent({
        organizationId,
        userId,
        provider: "agently",
        service: "knowledge_base",
        eventType: "page_discovery",
        source: "page_discovery_lib",
        externalId: discovery.id,
        knowledgeBaseId,
        unit: "discovery",
        quantity: 1,
        metadata: {
          knowledgeBaseId,
          knowledgeSourceId,
          discoveryId: discovery.id,
          domain,
          pagesFound: rows.length,
          method,
        },
      });
    } catch (error) {
      console.warn(
        "[page-discovery] metering skipped:",
        error?.message || error,
      );
    }

    return {
      discoveryId: discovery.id,
      rootUrl: root,
      domain,
      totalPagesFound: rows.length,
      candidatePagesFound: allCandidateUrls.length,
      truncated: allCandidateUrls.length > rows.length,
      maxPages,
      method,
      pages: rows.map((row) => ({
        url: row.url,
        title: row.title,
        path: row.path,
        depth: row.depth,
        priorityScore: row.priority_score,
        isSelected: row.is_selected,
      })),
    };
  } catch (error) {
    await db
      .from("knowledge_page_discoveries")
      .update({
        status: "failed",
        last_error: String(error?.message || error).slice(0, 500),
        updated_at: nowIso(),
      })
      .eq("id", discovery.id);
    throw error;
  }
}

module.exports = {
  discoverPages,
  normalizeUrl,
  scoreUrl,
  titleFromUrl,
  sameHost,
  inspectHtml,
  inspectMarkdown,
};
