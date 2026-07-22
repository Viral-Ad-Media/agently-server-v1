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
const { discoverPages } = require("../../lib/page-discovery");

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
      maxPages = 500,
    } = req.body || {};

    try {
      const result = await discoverPages({
        organizationId: req.orgId,
        knowledgeBaseId,
        knowledgeSourceId,
        rootUrl: website || url,
        maxPages: Math.min(Number(maxPages) || 500, 1000),
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
      return res
        .status(400)
        .json({ error: { message: "Provide pageIds, selectAll or selectNone." } });
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

    const { data: selected } = await db
      .from("knowledge_discovered_pages")
      .select("id")
      .eq("discovery_id", discoveryId)
      .eq("organization_id", req.orgId)
      .eq("is_selected", true);

    const pageCount = (selected || []).length;
    if (!pageCount) {
      return res.status(400).json({
        error: { message: "Choose at least one page before starting." },
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
    const { data: existing } = await db
      .from("knowledge_scrape_jobs")
      .select("id,status")
      .eq("knowledge_base_id", knowledgeBaseId)
      .eq("organization_id", req.orgId)
      .in("status", ["queued", "running"])
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error: {
          code: "JOB_ALREADY_RUNNING",
          message: "A scan is already running for this knowledge base.",
          jobId: existing.id,
        },
      });
    }

    await db
      .from("knowledge_discovered_pages")
      .update({ scrape_status: "queued", scrape_progress: 0, updated_at: nowIso() })
      .eq("discovery_id", discoveryId)
      .eq("organization_id", req.orgId)
      .eq("is_selected", true);

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
        .update({ scrape_status: "pending", scrape_progress: 0, updated_at: nowIso() })
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
    const pageIds = (changes || []).map((c) => c.discovered_page_id).filter(Boolean);

    if (!pageIds.length) {
      return res.json({ success: true, queued: 0, message: "Nothing to update." });
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
      .update({ scrape_status: "queued", scrape_progress: 0, updated_at: nowIso() })
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
      .in("id", (changes || []).map((c) => c.id));

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
    const { enabled, mode, intervalHours } = req.body || {};

    const patch = { updated_at: nowIso() };
    if (enabled !== undefined) patch.change_monitoring_enabled = enabled === true;
    if (mode !== undefined) {
      patch.change_monitoring_mode = ["notify_only", "auto_rescrape"].includes(mode)
        ? mode
        : "notify_only";
    }
    if (intervalHours !== undefined) {
      patch.change_monitoring_interval_hours = Math.max(
        1,
        Math.min(Number(intervalHours) || 24, 168),
      );
    }

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
