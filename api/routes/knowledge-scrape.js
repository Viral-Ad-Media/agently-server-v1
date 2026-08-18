/**
 * agently-server/api/routes/knowledge-scrape.js   <-- NEW FILE
 *
 * PATCH 21 — P3. The six routes behind the new Knowledge Base flow.
 * CURRENT_ISSUES → Settings page → 1-4, 4(b), 4(f), 4(g).
 *
 * MOUNT in api/index.js and api/routes/index.js:
 *   safeMount("/api/knowledge-scrape", () => require("./routes/knowledge-scrape"), "knowledge-scrape");
 *   app.use("/api/knowledge-scrape", require("./routes/knowledge-scrape"));
 *
 * IMPORTANT: every route here is fast and returns immediately. None of them
 * does work that outlives the response — that was the original sin
 * (setImmediate on serverless). They only enqueue; the Railway worker executes.
 *
 * The existing POST /:id/sources/:sourceId/sync route is left in place and
 * untouched so nothing that depends on it breaks. Set
 * KNOWLEDGE_LEGACY_SYNC_ENABLED=false once this flow is verified.
 */

"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  ensureWalletCreditOrRespond,
} = require("../../lib/billing-credit-enforcement");
const { discoverPages, normalizeUrl } = require("../../lib/page-discovery");
const {
  findOrCreateKnowledgeSource,
  ensureDefaultKnowledgeBaseForOrg,
} = require("../../lib/knowledge-bases");

const router = express.Router();
const nowIso = () => new Date().toISOString();

/** Estimated tenant cost of scraping N pages. Drives the burn-rate warning. */
function estimateScrapeCostUsd(pageCount) {
  const perPage = Number(process.env.BILLING_SCRAPE_PER_PAGE_USD || 0.02);
  return Math.round(pageCount * perPage * 10000) / 10000;
}

async function verifyKb(db, organizationId, knowledgeBaseId) {
  const { data } = await db
    .from("knowledge_bases")
    .select("*")
    .eq("id", knowledgeBaseId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. DISCOVER — count pages, scrape nothing.
//    Issues 1, 2: called at onboarding step 2 AND from the KB page.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/discover",
  requireAuth,
  asyncHandler(async (req, res) => {
    const allowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: req.orgId,
      action: "page_discovery",
    });
    if (allowed !== true) return;

    const {
      website,
      url,
      knowledgeBaseId = null,
      knowledgeSourceId = null,
      duringOnboarding = false,
      maxPages = Number(process.env.DISCOVERY_MAX_PAGES || 5000),
    } = req.body || {};

    try {
      const requestedRoot = normalizeUrl(website || url);
      let resolvedKnowledgeBaseId = knowledgeBaseId || null;
      let resolvedKnowledgeSourceId = knowledgeSourceId || null;

      const db = getSupabase();

      // Onboarding intentionally does not crawl the whole website anymore.
      // When this endpoint is used by an older client, still attach the result
      // to the tenant's primary KB so the page list is not orphaned.
      if (!resolvedKnowledgeBaseId && duringOnboarding === true) {
        const { data: org } = await db
          .from("organizations")
          .select("id,name,industry,website")
          .eq("id", req.orgId)
          .maybeSingle();
        const onboardingKb = await ensureDefaultKnowledgeBaseForOrg(db, {
          id: req.orgId,
          name: org?.name || "My Business",
          industry: org?.industry || "",
          website: requestedRoot || org?.website || "",
        });
        if (onboardingKb?.id) {
          resolvedKnowledgeBaseId = onboardingKb.id;
          if (
            requestedRoot &&
            normalizeUrl(onboardingKb.primary_url) !== requestedRoot
          ) {
            await db
              .from("knowledge_bases")
              .update({
                primary_url: requestedRoot,
                domain: new URL(requestedRoot).hostname.replace(/^www\./, ""),
                updated_at: nowIso(),
              })
              .eq("id", onboardingKb.id)
              .eq("organization_id", req.orgId);
          }
        }
      }

      if (resolvedKnowledgeBaseId) {
        const kb = await verifyKb(db, req.orgId, resolvedKnowledgeBaseId);
        if (!kb) {
          return res
            .status(404)
            .json({ error: { message: "Knowledge base not found." } });
        }
        const source = await findOrCreateKnowledgeSource(db, {
          organizationId: req.orgId,
          knowledgeBaseId: resolvedKnowledgeBaseId,
          url: requestedRoot || kb.primary_url,
          title: kb.name || "Website",
          isPrimary: true,
        });
        resolvedKnowledgeSourceId = source?.id || resolvedKnowledgeSourceId;
      }

      const configuredMax = Math.max(
        100,
        Math.min(10000, Number(process.env.DISCOVERY_MAX_PAGES || 5000)),
      );
      const result = await discoverPages({
        organizationId: req.orgId,
        knowledgeBaseId: resolvedKnowledgeBaseId,
        knowledgeSourceId: resolvedKnowledgeSourceId,
        rootUrl: requestedRoot,
        maxPages: Math.max(
          100,
          Math.min(Number(maxPages) || configuredMax, configuredMax),
        ),
        duringOnboarding: duringOnboarding === true,
        userId: req.user?.id || null,
      });

      return res.json({
        success: true,
        ...result,
        estimatedFullScanUsd: estimateScrapeCostUsd(result.totalPagesFound),
        // Issue 2: exact wording the onboarding screen shows.
        onboardingMessage: duringOnboarding
          ? `We found ${result.totalPagesFound} pages on your website. For now we'll read just your homepage so you can get started quickly. You can choose the rest anytime from Settings.`
          : null,
      });
    } catch (err) {
      return res.status(err.status || 500).json({
        error: {
          code: err.code || "DISCOVERY_FAILED",
          message:
            err.code === "INVALID_URL"
              ? "That doesn't look like a valid website address."
              : "We couldn't read that website. Check the address is correct and publicly reachable.",
        },
      });
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. LIST PAGES — backs the checkbox list. Issue 4, 4(b).
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  "/discoveries/:discoveryId/pages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: discovery } = await db
      .from("knowledge_page_discoveries")
      .select("*")
      .eq("id", req.params.discoveryId)
      .eq("organization_id", req.orgId)
      .maybeSingle();

    if (!discovery) {
      return res
        .status(404)
        .json({ error: { message: "That page list no longer exists." } });
    }

    const { data: pages } = await db
      .from("knowledge_discovered_pages")
      .select(
        "id,url,title,path,depth,priority_score,is_selected,scrape_status,scrape_progress,chunks_created,faqs_created,content_changed_at,last_scraped_at,last_error",
      )
      .eq("discovery_id", req.params.discoveryId)
      .eq("organization_id", req.orgId)
      .order("priority_score", { ascending: false })
      .order("path", { ascending: true });

    const rows = pages || [];
    const selected = rows.filter((p) => p.is_selected).length;

    return res.json({
      discovery: {
        id: discovery.id,
        rootUrl: discovery.root_url,
        domain: discovery.domain,
        status: discovery.status,
        totalPagesFound: discovery.total_pages_found,
        method: discovery.discovery_method,
      },
      totalPages: rows.length,
      selectedCount: selected,
      estimatedSelectedUsd: estimateScrapeCostUsd(selected),
      estimatedAllUsd: estimateScrapeCostUsd(rows.length),
      // Issue 4: the exact warning copy the UI renders above the list.
      creditWarning:
        "Selecting every page gives your agent the widest knowledge but uses your credit much faster. We recommend choosing only the pages that matter to your customers.",
      pages: rows.map((p) => ({
        id: p.id,
        url: p.url,
        title: p.title,
        path: p.path,
        depth: p.depth,
        priorityScore: p.priority_score,
        isSelected: p.is_selected,
        scrapeStatus: p.scrape_status,
        scrapeProgress: p.scrape_progress,
        chunksCreated: p.chunks_created,
        faqsCreated: p.faqs_created,
        contentChangedAt: p.content_changed_at,
        lastScrapedAt: p.last_scraped_at,
        lastError: p.last_error,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. SELECT — individual, bulk, and select-all. Issue 4(b).
// ═══════════════════════════════════════════════════════════════════════════
router.put(
  "/discoveries/:discoveryId/selection",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { pageIds, selectAll, selectNone } = req.body || {};

    const base = db
      .from("knowledge_discovered_pages")
      .update({ is_selected: selectNone ? false : true, updated_at: nowIso() })
      .eq("discovery_id", req.params.discoveryId)
      .eq("organization_id", req.orgId);

    if (selectAll === true || selectNone === true) {
      const { error } = await base;
      if (error) throw error;
    } else if (Array.isArray(pageIds)) {
      // Explicit list = exact state. Clear everything, then set the chosen set,
      // so deselection works with the same call.
      await db
        .from("knowledge_discovered_pages")
        .update({ is_selected: false, updated_at: nowIso() })
        .eq("discovery_id", req.params.discoveryId)
        .eq("organization_id", req.orgId);

      if (pageIds.length) {
        const { error } = await db
          .from("knowledge_discovered_pages")
          .update({ is_selected: true, updated_at: nowIso() })
          .eq("discovery_id", req.params.discoveryId)
          .eq("organization_id", req.orgId)
          .in("id", pageIds);
        if (error) throw error;
      }
    } else {
      return res.status(400).json({
        error: { message: "Provide pageIds, selectAll or selectNone." },
      });
    }

    const { count } = await db
      .from("knowledge_discovered_pages")
      .select("id", { count: "exact", head: true })
      .eq("discovery_id", req.params.discoveryId)
      .eq("organization_id", req.orgId)
      .eq("is_selected", true);

    return res.json({
      success: true,
      selectedCount: count || 0,
      estimatedUsd: estimateScrapeCostUsd(count || 0),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. START — "Proceed to scrape". Issue 4(c).
//    Enqueues ONLY. Returns in milliseconds. The worker does the work.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/jobs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { knowledgeBaseId, discoveryId } = req.body || {};

    const kb = await verifyKb(db, req.orgId, knowledgeBaseId);
    if (!kb) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }
    if (!discoveryId) {
      return res
        .status(400)
        .json({ error: { message: "A page discovery is required." } });
    }

    const { data: discovery } = await db
      .from("knowledge_page_discoveries")
      .select("id,knowledge_base_id,knowledge_source_id,status")
      .eq("id", discoveryId)
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", knowledgeBaseId)
      .maybeSingle();
    if (!discovery) {
      return res.status(404).json({
        error: {
          message: "That page list does not belong to this knowledge base.",
        },
      });
    }
    if (discovery.status !== "completed") {
      return res.status(409).json({
        error: {
          message: "Page discovery is still running. Try again shortly.",
        },
      });
    }

    const { data: selected } = await db
      .from("knowledge_discovered_pages")
      .select("id,scrape_status")
      .eq("discovery_id", discoveryId)
      .eq("organization_id", req.orgId)
      .eq("is_selected", true);

    const selectedRows = selected || [];
    const willRescrapeCompleted =
      req.body?.rescrapeCompleted === true || req.body?.forceRescrape === true;
    const forcedIds = new Set(
      Array.isArray(req.body?.rescrapePageIds) ? req.body.rescrapePageIds : [],
    );

    // Count only the pages this job will actually read, so progress reflects
    // real work. Counting the whole selection made a job that re-read one new
    // page report "1 of 10" and sit at 10% forever.
    const pageCount = selectedRows.filter(
      (p) =>
        willRescrapeCompleted ||
        forcedIds.has(p.id) ||
        p.scrape_status !== "completed",
    ).length;

    if (!selectedRows.length) {
      return res.status(400).json({
        error: { message: "Choose at least one page before starting." },
      });
    }

    // Everything selected is already read. Say so rather than starting a job
    // that would bill for nothing and immediately complete.
    if (!pageCount) {
      return res.status(400).json({
        error: {
          code: "NOTHING_TO_SCRAPE",
          message:
            "Every selected page has already been read. Select a new page, or choose re-scrape on a page to read it again.",
        },
      });
    }

    const estimated = estimateScrapeCostUsd(pageCount);

    const allowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: req.orgId,
      action: "page_scrape",
      minimumUsd: estimated,
    });
    if (allowed !== true) return;

    // One active job per knowledge base. Prevents a double-click producing two
    // workers scraping the same pages and double-charging.
    const { data: existingJobs, error: existingJobError } = await db
      .from("knowledge_scrape_jobs")
      .select("id,status")
      .eq("knowledge_base_id", knowledgeBaseId)
      .eq("organization_id", req.orgId)
      .in("status", ["queued", "running", "paused"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (existingJobError) throw existingJobError;
    const existing = existingJobs?.[0] || null;

    if (existing) {
      return res.status(409).json({
        error: {
          code: "JOB_ALREADY_RUNNING",
          message: "A scan is already running for this knowledge base.",
          jobId: existing.id,
          details: { jobId: existing.id },
        },
      });
    }

    // Queue only pages that still need reading.
    //
    // This used to reset EVERY selected page to "queued", so selecting one
    // extra page re-scraped the entire selection. With nine pages already
    // done, adding a tenth re-read all ten — and pages are billed per read,
    // so the customer paid nine times over for content that had not changed.
    //
    // Completed pages are now left alone unless the caller explicitly asks to
    // re-read them (the UI's "re-scrape this page" action), which is also what
    // makes the content_hash short-circuit in the worker meaningful.
    const rescrapeCompleted =
      req.body?.rescrapeCompleted === true ||
      req.body?.forceRescrape === true;
    const forcedPageIds = Array.isArray(req.body?.rescrapePageIds)
      ? req.body.rescrapePageIds.filter(Boolean)
      : [];

    let queueQuery = db
      .from("knowledge_discovered_pages")
      .update({
        scrape_status: "queued",
        scrape_progress: 0,
        updated_at: nowIso(),
      })
      .eq("discovery_id", discoveryId)
      .eq("organization_id", req.orgId)
      .eq("is_selected", true);

    if (!rescrapeCompleted) {
      queueQuery = queueQuery.neq("scrape_status", "completed");
    }
    await queueQuery;

    // Explicitly forced pages are re-queued even though they are completed.
    if (!rescrapeCompleted && forcedPageIds.length) {
      await db
        .from("knowledge_discovered_pages")
        .update({
          scrape_status: "queued",
          scrape_progress: 0,
          updated_at: nowIso(),
        })
        .eq("discovery_id", discoveryId)
        .eq("organization_id", req.orgId)
        .in("id", forcedPageIds);
    }

    const { data: job, error } = await db
      .from("knowledge_scrape_jobs")
      .insert({
        organization_id: req.orgId,
        knowledge_base_id: knowledgeBaseId,
        discovery_id: discoveryId,
        status: "queued",
        job_type: "selective_scrape",
        total_pages: pageCount,
        estimated_credit_usd: estimated,
        requested_by_user_id: req.user?.id || null,
        created_at: nowIso(),
      })
      .select()
      .single();
    if (error) throw error;

    await db
      .from("knowledge_bases")
      .update({ sync_status: "scraping", updated_at: nowIso() })
      .eq("id", knowledgeBaseId)
      .eq("organization_id", req.orgId);

    return res.status(202).json({
      success: true,
      job: { id: job.id, status: job.status, totalPages: pageCount },
      estimatedUsd: estimated,
      message: `Reading ${pageCount} page${pageCount === 1 ? "" : "s"}. You can leave this page — we'll notify you when it's done.`,
    });
  }),
);

// Return the active job when a tenant comes back after navigating away.
router.get(
  "/knowledge-bases/:knowledgeBaseId/active-job",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const kb = await verifyKb(db, req.orgId, req.params.knowledgeBaseId);
    if (!kb) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const { data: jobs, error } = await db
      .from("knowledge_scrape_jobs")
      .select("id,status,discovery_id,created_at")
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.knowledgeBaseId)
      .in("status", ["queued", "running", "paused"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;

    const active = Array.isArray(jobs) ? jobs[0] : null;
    return res.json({
      job: active
        ? {
            id: active.id,
            status: active.status,
            discoveryId: active.discovery_id,
          }
        : null,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. JOB STATUS — polled by the UI. Cheap, per-page, no full page reload.
//    Issue 4(d), 4(e).
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  "/jobs/:jobId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: job } = await db
      .from("knowledge_scrape_jobs")
      .select("*")
      .eq("id", req.params.jobId)
      .eq("organization_id", req.orgId)
      .maybeSingle();

    if (!job) {
      return res.status(404).json({ error: { message: "Job not found." } });
    }

    const { data: pages } = await db
      .from("knowledge_discovered_pages")
      .select("id,url,title,scrape_status,scrape_progress,last_error")
      .eq("discovery_id", job.discovery_id)
      .eq("organization_id", req.orgId)
      .eq("is_selected", true)
      .order("priority_score", { ascending: false });

    return res.json({
      job: {
        id: job.id,
        status: job.status,
        jobType: job.job_type,
        totalPages: job.total_pages,
        completedPages: job.completed_pages,
        failedPages: job.failed_pages,
        progressPercent: job.progress_percent,
        currentPageUrl: job.current_page_url,
        estimatedUsd: Number(job.estimated_credit_usd || 0),
        consumedUsd: Number(job.consumed_credit_usd || 0),
        lastError: job.last_error,
        startedAt: job.started_at,
        completedAt: job.completed_at,
      },
      // The UI updates ONLY these cards. It must never re-fetch the whole
      // knowledge base list on a tick — that is what caused the glitching.
      pages: (pages || []).map((p) => ({
        id: p.id,
        url: p.url,
        title: p.title,
        scrapeStatus: p.scrape_status,
        scrapeProgress: p.scrape_progress,
        lastError: p.last_error,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 6. CONTROL — pause / resume / cancel. Issue 4(f), 4(g).
//    Sets a flag; the worker observes it on its next heartbeat.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/jobs/:jobId/:action(pause|resume|cancel)",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { action } = req.params;

    const { data: job } = await db
      .from("knowledge_scrape_jobs")
      .select("id,status,completed_pages,total_pages")
      .eq("id", req.params.jobId)
      .eq("organization_id", req.orgId)
      .maybeSingle();

    if (!job) {
      return res.status(404).json({ error: { message: "Job not found." } });
    }

    const patch = { updated_at: nowIso() };
    let message = "";

    if (action === "pause") {
      patch.status = "paused";
      message = "Scan paused. Your progress so far is saved.";
    } else if (action === "resume") {
      patch.status = "queued";
      patch.cancel_requested = false;
      patch.claimed_by = null;
      patch.lease_expires_at = null;
      message = "Resuming where we left off.";
    } else {
      patch.cancel_requested = true;
      patch.status = "cancelled";
      patch.completed_at = nowIso();
      message = "Scan cancelled. Pages already read have been kept.";

      await db
        .from("knowledge_discovered_pages")
        .update({
          scrape_status: "pending",
          scrape_progress: 0,
          updated_at: nowIso(),
        })
        .eq("discovery_id", job.discovery_id)
        .eq("organization_id", req.orgId)
        .in("scrape_status", ["queued", "scraping"]);
    }

    await db
      .from("knowledge_scrape_jobs")
      .update(patch)
      .eq("id", job.id)
      .eq("organization_id", req.orgId);

    return res.json({
      success: true,
      status: patch.status,
      message,
      // Issue 4(g): the frontend renders this in the stop-confirmation modal.
      warning:
        action === "cancel"
          ? `Stopping now means ${Math.max(0, (job.total_pages || 0) - (job.completed_pages || 0))} page(s) won't be read. Your agent will answer from what it has so far. You can start again at any time.`
          : null,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 7. CHANGE EVENTS — issue 4(i)/(j): review and act on detected changes.
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  "/knowledge-bases/:kbId/changes",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data } = await db
      .from("knowledge_change_events")
      .select("*")
      .eq("knowledge_base_id", req.params.kbId)
      .eq("organization_id", req.orgId)
      .eq("status", "pending")
      .order("detected_at", { ascending: false })
      .limit(100);

    return res.json({
      changes: (data || []).map((c) => ({
        id: c.id,
        url: c.url,
        changeType: c.change_type,
        detectedAt: c.detected_at,
        pageId: c.discovered_page_id,
      })),
      count: (data || []).length,
    });
  }),
);

router.post(
  "/knowledge-bases/:kbId/changes/resync",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { changeIds } = req.body || {};

    let q = db
      .from("knowledge_change_events")
      .select("id,discovered_page_id")
      .eq("knowledge_base_id", req.params.kbId)
      .eq("organization_id", req.orgId)
      .eq("status", "pending");
    if (Array.isArray(changeIds) && changeIds.length) q = q.in("id", changeIds);

    const { data: changes } = await q;
    const pageIds = (changes || [])
      .map((c) => c.discovered_page_id)
      .filter(Boolean);

    if (!pageIds.length) {
      return res.json({
        success: true,
        queued: 0,
        message: "Nothing to update.",
      });
    }

    const allowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: req.orgId,
      action: "page_scrape",
      minimumUsd: estimateScrapeCostUsd(pageIds.length),
    });
    if (allowed !== true) return;

    const { data: firstPage } = await db
      .from("knowledge_discovered_pages")
      .select("discovery_id")
      .eq("id", pageIds[0])
      .maybeSingle();

    await db
      .from("knowledge_discovered_pages")
      .update({
        scrape_status: "queued",
        scrape_progress: 0,
        updated_at: nowIso(),
      })
      .in("id", pageIds);

    const { data: job } = await db
      .from("knowledge_scrape_jobs")
      .insert({
        organization_id: req.orgId,
        knowledge_base_id: req.params.kbId,
        discovery_id: firstPage?.discovery_id || null,
        status: "queued",
        job_type: "change_rescan",
        total_pages: pageIds.length,
        estimated_credit_usd: estimateScrapeCostUsd(pageIds.length),
        requested_by_user_id: req.user?.id || null,
        created_at: nowIso(),
      })
      .select()
      .single();

    await db
      .from("knowledge_change_events")
      .update({ status: "resync_queued" })
      .in(
        "id",
        (changes || []).map((c) => c.id),
      );

    return res.status(202).json({
      success: true,
      queued: pageIds.length,
      jobId: job?.id,
      message: `Re-reading ${pageIds.length} updated page(s).`,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 8. MONITORING TOGGLE — issue 4(i)/(k).
// ═══════════════════════════════════════════════════════════════════════════
router.put(
  "/knowledge-bases/:kbId/monitoring",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { enabled, mode } = req.body || {};

    // Tenant's actual choice: "auto_rescrape" (re-read changed pages
    // automatically) or "notify_only" (just tell them, they decide when).
    // This used to be hardcoded to auto_rescrape regardless of what was
    // sent — change-monitor.js's notify_only branch existed and worked, it
    // just never ran because nothing could ever request it.
    const resolvedMode = mode === "notify_only" ? "notify_only" : "auto_rescrape";
    const patch = {
      updated_at: nowIso(),
      change_monitoring_enabled: enabled === true,
      change_monitoring_mode: resolvedMode,
      change_monitoring_interval_hours: 24,
    };

    const { data, error } = await db
      .from("knowledge_bases")
      .update(patch)
      .eq("id", req.params.kbId)
      .eq("organization_id", req.orgId)
      .select()
      .single();
    if (error) throw error;

    return res.json({
      success: true,
      monitoring: {
        enabled: data.change_monitoring_enabled,
        mode: data.change_monitoring_mode,
        intervalHours: data.change_monitoring_interval_hours,
        lastCheckedAt: data.last_change_check_at,
        pendingChangeCount: data.pending_change_count,
      },
    });
  }),
);

module.exports = router;
