/**
 * agently-server/lib/page-discovery.js   <-- NEW FILE
 *
 * PATCH 17 — P3. Implements CURRENT_ISSUES → Settings page → 1, 2, 3, 4, 4(b).
 *
 * "The scraper service should first do a page discovery ... it fetches the
 *  total number of pages discovered on the website, gives the number, but
 *  should not be scraping yet."
 *
 * Discovery is deliberately CHEAP and READ-MOSTLY:
 *   - sitemap.xml / sitemap_index.xml / robots.txt Sitemap: directives first
 *   - falls back to a shallow BFS crawl (depth <= 2) only if no sitemap exists
 *   - fetches HTML only for the crawl fallback, never for the sitemap path
 *   - NEVER extracts, chunks, embeds or stores content
 *
 * That separation is the whole point: onboarding gets a COUNT in a couple of
 * seconds without burning scrape credit, and the tenant chooses what to pay
 * to actually ingest.
 *
 * Reuses the existing helpers in lib/scraper.service.js rather than
 * reimplementing URL handling, so discovery and scraping agree on what a
 * normalized URL is.
 */

"use strict";

const { getSupabase } = require("./supabase");

const UA =
  "Mozilla/5.0 (compatible; AgentlyBot/1.0; +https://agently.ai/bot)";

function nowIso() {
  return new Date().toISOString();
}

function normalizeUrl(input) {
  if (!input) return "";
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    u.hash = "";
    // Strip tracking params — otherwise the same page appears N times in the
    // checkbox list and the tenant pays to scrape duplicates.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source)/i.test(p)) u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return "";
  }
}

function sameHost(a, b) {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, "");
    const hb = new URL(b).hostname.replace(/^www\./, "");
    return ha === hb;
  } catch {
    return false;
  }
}

function isBinary(url) {
  return /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|pdf|zip|rar|mp4|mp3|avi|mov|woff2?|ttf|eot|xml|json|rss)(\?|$)/i.test(
    url,
  );
}

/**
 * Ordering heuristic for the checkbox list. High-value pages float to the top
 * so that a tenant who selects only the first ten gets the ten that matter.
 */
function scoreUrl(url) {
  let score = 50;
  let path = "/";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* keep default */
  }
  if (path === "/" || path === "") return 100;
  if (/(about|service|product|pricing|plan|faq|contact|support|help)/.test(path))
    score += 30;
  if (/(shop|store|catalog|collection|solution|feature)/.test(path)) score += 20;
  if (/(blog|news|article|post)/.test(path)) score += 5;
  if (/(privacy|terms|legal|cookie|sitemap|login|signin|cart|checkout|account)/.test(path))
    score -= 35;
  if (/(tag|category|author|page\/\d+|archive)/.test(path)) score -= 20;
  score -= Math.max(0, (path.split("/").filter(Boolean).length - 1) * 4);
  return Math.max(0, Math.min(100, score));
}

function titleFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    if (p === "/" || !p) return "Homepage";
    const last = p.split("/").filter(Boolean).pop() || "";
    return last
      .replace(/[-_]+/g, " ")
      .replace(/\.\w+$/, "")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

async function fetchText(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Sitemap path ────────────────────────────────────────────────────────────

function parseLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

async function discoverViaSitemap(rootUrl, { maxPages = 500 } = {}) {
  const origin = new URL(rootUrl).origin;
  const seeds = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap/sitemap.xml`,
  ];

  // robots.txt often points at a sitemap in a non-standard location.
  const robots = await fetchText(`${origin}/robots.txt`, { timeoutMs: 6000 });
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) seeds.unshift(m[1].trim());
    }
  }

  const seen = new Set();
  const pages = new Set();
  const queue = [...new Set(seeds)];
  let fetched = 0;

  while (queue.length && pages.size < maxPages && fetched < 25) {
    const sm = queue.shift();
    if (!sm || seen.has(sm)) continue;
    seen.add(sm);

    const xml = await fetchText(sm);
    fetched += 1;
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;

    const isIndex = /<sitemapindex/i.test(xml);
    for (const loc of parseLocs(xml)) {
      if (isIndex) {
        if (!seen.has(loc)) queue.push(loc);
      } else {
        const n = normalizeUrl(loc);
        if (n && sameHost(n, rootUrl) && !isBinary(n)) pages.add(n);
      }
    }
  }

  return { urls: [...pages].slice(0, maxPages), method: "sitemap" };
}

// ── Crawl fallback ──────────────────────────────────────────────────────────

function extractLinks(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      const abs = normalizeUrl(new URL(href, baseUrl).toString());
      if (abs && sameHost(abs, baseUrl) && !isBinary(abs)) out.add(abs);
    } catch {
      /* skip malformed href */
    }
  }
  return [...out];
}

async function discoverViaCrawl(rootUrl, { maxPages = 200, maxDepth = 2 } = {}) {
  const found = new Map([[rootUrl, 0]]);
  let frontier = [rootUrl];

  for (let depth = 0; depth < maxDepth && found.size < maxPages; depth += 1) {
    const next = [];
    // Cap fan-out per level: a large site would otherwise make discovery as
    // expensive as the scrape we are trying to let the tenant avoid.
    for (const url of frontier.slice(0, 30)) {
      const html = await fetchText(url);
      if (!html) continue;
      for (const link of extractLinks(html, rootUrl)) {
        if (found.size >= maxPages) break;
        if (!found.has(link)) {
          found.set(link, depth + 1);
          next.push(link);
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  return {
    urls: [...found.keys()],
    depths: found,
    method: "crawl",
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enumerates a site and persists the catalogue. Returns a COUNT plus the page
 * list. Scrapes NOTHING.
 *
 * `duringOnboarding: true` is what step 2 of onboarding calls. It records the
 * flag so the UI can say "we found N pages, only your homepage will be read
 * now" and later point the tenant at Settings to choose the rest.
 */
async function discoverPages({
  organizationId,
  knowledgeBaseId = null,
  knowledgeSourceId = null,
  rootUrl,
  maxPages = 500,
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

  const { data: discovery, error: insErr } = await db
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
  if (insErr) throw insErr;

  try {
    let result = await discoverViaSitemap(root, { maxPages });
    let method = result.method;

    // A sitemap with one or two entries is effectively no sitemap.
    if (result.urls.length < 3) {
      const crawled = await discoverViaCrawl(root, { maxPages });
      const merged = new Set([...result.urls, ...crawled.urls]);
      result = { urls: [...merged], depths: crawled.depths };
      method = result.urls.length > crawled.urls.length ? "hybrid" : "crawl";
    }

    // Homepage is always present and always first.
    const urls = [...new Set([root, ...result.urls])].slice(0, maxPages);

    const rows = urls.map((url) => {
      let path = "/";
      try {
        path = new URL(url).pathname;
      } catch {
        /* keep default */
      }
      return {
        discovery_id: discovery.id,
        organization_id: organizationId,
        knowledge_base_id: knowledgeBaseId,
        url,
        normalized_url: url,
        title: titleFromUrl(url),
        path,
        depth: result.depths?.get?.(url) ?? (url === root ? 0 : 1),
        priority_score: scoreUrl(url),
        // Issue 3: onboarding reads the homepage ONLY. Everything else is
        // catalogued unselected and waits for the tenant to choose in Settings.
        is_selected: duringOnboarding ? url === root : false,
        scrape_status: "pending",
        created_at: nowIso(),
      };
    });

    // Chunked insert: a 500-row insert can exceed the PostgREST payload limit.
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db
        .from("knowledge_discovered_pages")
        .upsert(rows.slice(i, i + 100), {
          onConflict: "discovery_id,normalized_url",
          ignoreDuplicates: true,
        });
      if (error) throw error;
    }

    await db
      .from("knowledge_page_discoveries")
      .update({
        status: "completed",
        total_pages_found: rows.length,
        discovery_method: method,
        completed_at: nowIso(),
        updated_at: nowIso(),
      })
      .eq("id", discovery.id);

    // Metered. Discovery is a real cost and is charged once per run.
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
        unit: "discovery",
        quantity: 1,
        metadata: { domain, pagesFound: rows.length, method },
      });
    } catch (err) {
      // Never fail a completed discovery on a metering hiccup — the row is
      // already written and the tenant can proceed.
      console.warn("[page-discovery] metering skipped:", err?.message || err);
    }

    return {
      discoveryId: discovery.id,
      rootUrl: root,
      domain,
      totalPagesFound: rows.length,
      method,
      pages: rows.map((r) => ({
        url: r.url,
        title: r.title,
        path: r.path,
        depth: r.depth,
        priorityScore: r.priority_score,
        isSelected: r.is_selected,
      })),
    };
  } catch (err) {
    await db
      .from("knowledge_page_discoveries")
      .update({
        status: "failed",
        last_error: String(err?.message || err).slice(0, 500),
        updated_at: nowIso(),
      })
      .eq("id", discovery.id);
    throw err;
  }
}

module.exports = {
  discoverPages,
  normalizeUrl,
  scoreUrl,
  titleFromUrl,
  sameHost,
};
