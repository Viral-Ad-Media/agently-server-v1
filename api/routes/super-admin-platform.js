"use strict";

/**
 * agently-server/api/routes/super-admin-tour.js   <-- NEW FILE
 *
 * Mounted at /api/super-admin/tour
 *
 * Requirement 11: the only thing that brings a finished tour back is you
 * deciding it should come back — after redesigning a page or adding a feature
 * to it.
 *
 * That is a version bump, not a delete. Bumping tour_pages.version leaves
 * every completion row intact but makes it stale, so the page's tour runs once
 * more for everyone and then settles again. Deleting progress rows would work
 * too, but it destroys the record of who had already been shown around, and it
 * cannot be undone if you bump the wrong page.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const {
  requireSuperAdmin,
  logSecurityEvent,
} = require("../../lib/super-admin-auth");

const router = express.Router();
router.use(requireSuperAdmin);

/** GET /  — every page, its version, and how many users have finished it. */
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const db = getSupabase();

    const [pagesResult, progressResult] = await Promise.all([
      db
        .from("tour_pages")
        .select("page_key,label,version,is_enabled,updated_at")
        .order("page_key", { ascending: true }),
      db
        .from("user_tour_progress")
        .select("page_key,completed_version,status")
        .limit(20000),
    ]);

    if (pagesResult.error) {
      return res.status(503).json({
        error: {
          message:
            "Tour tables are missing. Run migration 20260729_product_tour.sql.",
        },
      });
    }

    const byPage = new Map();
    for (const row of progressResult.data || []) {
      const entry = byPage.get(row.page_key) || { completed: 0, skipped: 0 };
      if (row.status === "skipped") entry.skipped += 1;
      else entry.completed += 1;
      byPage.set(row.page_key, entry);
    }

    res.json({
      pages: (pagesResult.data || []).map((page) => {
        const counts = byPage.get(page.page_key) || {
          completed: 0,
          skipped: 0,
        };
        return {
          pageKey: page.page_key,
          label: page.label || page.page_key,
          version: Number(page.version) || 1,
          isEnabled: page.is_enabled !== false,
          updatedAt: page.updated_at,
          completedCount: counts.completed,
          skippedCount: counts.skipped,
        };
      }),
    });
  }),
);

/**
 * POST /:pageKey/retrigger
 *
 * pageKey arrives URL-encoded because it is a route path ("/phone-numbers").
 */
router.post(
  "/:pageKey/retrigger",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const pageKey = decodeURIComponent(String(req.params.pageKey || "")).trim();

    const { data: page, error: readError } = await db
      .from("tour_pages")
      .select("page_key,version")
      .eq("page_key", pageKey)
      .maybeSingle();

    if (readError) throw readError;
    if (!page) {
      return res
        .status(404)
        .json({ error: { message: `No tour page "${pageKey}".` } });
    }

    const nextVersion = (Number(page.version) || 1) + 1;
    const { error } = await db
      .from("tour_pages")
      .update({ version: nextVersion, updated_at: new Date().toISOString() })
      .eq("page_key", pageKey);
    if (error) throw error;

    await logSecurityEvent(req, "tour_page_retriggered", true, {
      adminEmail: req.superAdmin.email,
      pageKey,
      version: nextVersion,
    });

    res.json({ success: true, pageKey, version: nextVersion });
  }),
);

/** PATCH /:pageKey  — enable or disable a page's tour entirely. */
router.patch(
  "/:pageKey",
  asyncHandler(async (req, res) => {
    const pageKey = decodeURIComponent(String(req.params.pageKey || "")).trim();
    const patch = { updated_at: new Date().toISOString() };

    if (typeof req.body?.isEnabled === "boolean") {
      patch.is_enabled = req.body.isEnabled;
    }
    if (typeof req.body?.label === "string") {
      patch.label = req.body.label.slice(0, 120);
    }

    const { data, error } = await getSupabase()
      .from("tour_pages")
      .update(patch)
      .eq("page_key", pageKey)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return res
        .status(404)
        .json({ error: { message: `No tour page "${pageKey}".` } });
    }

    res.json({ success: true, page: data });
  }),
);

module.exports = router;
