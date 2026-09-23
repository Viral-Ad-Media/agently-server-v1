"use strict";

/**
 * s8: data export and erasure on request.
 *
 * Owner-only. An export is every lead, transcript and billing record the
 * workspace holds — that is not something a team member should be able to pull
 * unilaterally, and an erasure request is obviously not.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireOwner } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { exportOrganization, planErasure } = require("../../lib/account-data");
const { log } = require("../../lib/logger");

const router = express.Router();

router.use(requireAuth);
router.use(requireOwner);

/** GET /api/account/export — everything we hold, as a downloadable file. */
router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const payload = await exportOrganization(db, req.orgId);

    log.info("account.export", {
      requestId: req.id,
      orgId: req.orgId,
      userId: req.user?.id,
      tables: Object.keys(payload.counts).length,
      rows: Object.values(payload.counts).reduce((a, b) => a + (Number(b) || 0), 0),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="agently-export-${req.orgId}-${stamp}.json"`,
    );
    return res.status(200).send(JSON.stringify(payload, null, 2));
  }),
);

/** GET /api/account/erasure-preview — what erasure would remove. */
router.get(
  "/erasure-preview",
  asyncHandler(async (req, res) => {
    const plan = await planErasure(getSupabase(), req.orgId);
    return res.json({
      ...plan,
      retained:
        "Billing records are kept and anonymised rather than deleted — they are a financial audit trail with its own retention requirement.",
    });
  }),
);

/**
 * POST /api/account/erasure-request — record a request; do not execute it.
 *
 * Deliberately not a self-service delete. It is irreversible, it destroys
 * records that must be retained, and a request arriving from a hijacked
 * session would be unrecoverable. It is recorded, acknowledged, and executed
 * by a human against a reviewed plan.
 */
router.post(
  "/erasure-request",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const reason = String(req.body?.reason || "").slice(0, 2000);
    const plan = await planErasure(db, req.orgId);

    const row = {
      organization_id: req.orgId,
      requested_by: req.user?.id || null,
      requested_by_email: req.user?.email || null,
      reason: reason || null,
      status: "pending",
      plan,
      requested_at: new Date().toISOString(),
    };

    const { data, error } = await db
      .from("account_erasure_requests")
      .insert(row)
      .select("id, requested_at, status")
      .maybeSingle();

    if (error) {
      // The obligation does not disappear because a table is missing. Record
      // it in the log at error level so it is actioned manually rather than
      // lost, and tell the requester the truth.
      log.error("account.erasure_request.persist_failed", {
        requestId: req.id,
        orgId: req.orgId,
        userId: req.user?.id,
        reason: error.message,
      });
      return res.status(503).json({
        error: {
          code: "ERASURE_REQUEST_NOT_RECORDED",
          message:
            "We could not record your request automatically. It has been logged for manual action — please also email support so it is tracked.",
        },
      });
    }

    log.warn("account.erasure_request", {
      requestId: req.id,
      orgId: req.orgId,
      userId: req.user?.id,
      erasureRequestId: data?.id,
      rowsToDelete: Object.values(plan.deletes).reduce((a, b) => a + (Number(b) || 0), 0),
    });

    return res.status(202).json({
      id: data?.id,
      status: data?.status || "pending",
      requested_at: data?.requested_at,
      message:
        "Your erasure request has been recorded and will be actioned by a person. Export your data first if you still need it — erasure cannot be undone.",
      plan,
    });
  }),
);

/** GET /api/account/erasure-request — the status of any request. */
router.get(
  "/erasure-request",
  asyncHandler(async (req, res) => {
    const { data, error } = await getSupabase()
      .from("account_erasure_requests")
      .select("id, status, reason, requested_at, completed_at")
      .eq("organization_id", req.orgId)
      .order("requested_at", { ascending: false })
      .limit(20);
    if (error) return res.json({ requests: [], unavailable: true });
    return res.json({ requests: data || [] });
  }),
);

module.exports = router;
