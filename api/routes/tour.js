"use strict";

/**
 * agently-server/api/routes/tour.js   <-- NEW FILE
 *
 * Mounted at /api/tour
 *
 * Product tour state for the signed-in user.
 *
 * The client asks once per session which pages it still owes the user, and
 * writes back when a page's tour ends. Everything is keyed on user_id, not
 * organization_id: the tour teaches a person the interface, and a second
 * teammate joining an existing workspace still needs to be shown around.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

/**
 * GET /api/tour/state
 *
 * Returns, for every enabled page, the version currently published and the
 * version this user last finished. The client shows a tour when
 * completedVersion < version. Doing the comparison client-side keeps the
 * decision in one place — the component that also knows whether the page's
 * anchors actually exist yet.
 */
router.get(
  "/state",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const userId = req.user?.id;

    const [pagesResult, progressResult] = await Promise.all([
      db
        .from("tour_pages")
        .select("page_key,label,version,is_enabled")
        .eq("is_enabled", true),
      db
        .from("user_tour_progress")
        .select("page_key,completed_version,status")
        .eq("user_id", userId),
    ]);

    // A missing table (migration not yet applied) must not break the app.
    // An empty page list simply means no tours run.
    if (pagesResult.error) {
      return res.json({ pages: [], progress: {}, degraded: true });
    }

    const progress = {};
    for (const row of progressResult.data || []) {
      progress[row.page_key] = {
        completedVersion: Number(row.completed_version) || 0,
        status: row.status,
      };
    }

    res.json({
      pages: (pagesResult.data || []).map((page) => ({
        pageKey: page.page_key,
        label: page.label || page.page_key,
        version: Number(page.version) || 1,
      })),
      progress,
    });
  }),
);

/**
 * POST /api/tour/complete  { pageKey, version, status }
 *
 * Recorded for "skipped" as well as "completed". Someone who dismisses a tour
 * has made a decision, and re-showing it on their next visit would be the
 * exact behaviour this replaces.
 */
router.post(
  "/complete",
  requireAuth,
  asyncHandler(async (req, res) => {
    const pageKey = String(req.body?.pageKey || "").trim();
    const version = Number.parseInt(String(req.body?.version), 10);
    const status = req.body?.status === "skipped" ? "skipped" : "completed";

    if (!pageKey || !Number.isFinite(version)) {
      return res
        .status(400)
        .json({ error: { message: "pageKey and version are required." } });
    }

    const { error } = await getSupabase()
      .from("user_tour_progress")
      .upsert(
        {
          user_id: req.user.id,
          page_key: pageKey,
          completed_version: version,
          status,
          completed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,page_key" },
      );

    if (error) {
      // The tour already finished on screen. Failing the request would only
      // produce an error the user cannot act on, and the client mirrors state
      // to localStorage so the immediate session stays correct either way.
      console.warn("[tour] progress write failed:", error.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
  }),
);

/**
 * POST /api/tour/reset  { pageKey? }
 *
 * Lets a user replay a page's tour from Settings. Omit pageKey to replay all.
 * Self-service only — it clears the caller's own rows and nobody else's.
 */
router.post(
  "/reset",
  requireAuth,
  asyncHandler(async (req, res) => {
    const pageKey = String(req.body?.pageKey || "").trim();
    let query = getSupabase()
      .from("user_tour_progress")
      .delete()
      .eq("user_id", req.user.id);

    if (pageKey) query = query.eq("page_key", pageKey);

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  }),
);

module.exports = router;
