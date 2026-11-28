"use strict";

/**
 * /api/business-verification — the owner's side of the paperwork some
 * countries require before a phone number can be issued. See
 * lib/business-verification.js for the lifecycle.
 *
 *   GET    /requirements?country=GB&type=local   what this country asks for
 *   GET    /                                      this workspace's verifications
 *   POST   /                                      step 1: details + address
 *   POST   /:id/documents                         step 2: one document (base64)
 *   POST   /:id/submit                            step 3: pre-check + send for review
 *   POST   /:id/refresh                           re-read the review status now
 *   DELETE /:id                                   discard a draft / rejected one
 *   POST   /status-callback                       carrier nudge (public)
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireOwner } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { buildAppUrl } = require("../../lib/app-url");
const { getBackendBaseUrl } = require("../../lib/backend-url");
const { ensureTenantTwilioAccount } = require("../../lib/twilio-platform");
const { sendBusinessVerificationDecisionEmail } = require("../../lib/email");
const verification = require("../../lib/business-verification");
const { countryName } = require("../../lib/number-countries");

const router = express.Router();

function callbackUrl() {
  return `${getBackendBaseUrl()}/api/business-verification/status-callback`;
}

/** In-app notification + email to every owner, once per decision. */
async function notifyDecision(row) {
  const db = getSupabase();
  const approved = row.status === "approved";
  const name = countryName(row.iso_country);
  const path = `/phone-numbers?verification=${encodeURIComponent(row.id)}`;

  await db
    .from("tenant_notifications")
    .insert({
      organization_id: row.organization_id,
      user_id: row.created_by || null,
      type: approved ? "business_verification_approved" : "business_verification_rejected",
      title: approved
        ? `${name} numbers unlocked`
        : `${name} business verification not approved`,
      body: approved
        ? `Your business verification was approved. Get your ${name} number in one click.`
        : row.rejection_reason || "Your business verification wasn't approved.",
      entity_type: "business_verification",
      entity_id: row.id,
      is_read: false,
      metadata: { path, country: row.iso_country, numberType: row.number_type },
    })
    .then(
      () => null,
      (error) => console.warn("[business-verification] notification insert failed:", error?.message),
    );

  const [{ data: owners }, { data: org }] = await Promise.all([
    db
      .from("users")
      .select("email")
      .eq("organization_id", row.organization_id)
      .eq("role", "Owner"),
    db.from("organizations").select("name").eq("id", row.organization_id).maybeSingle(),
  ]);
  const toEmails = (owners || []).map((owner) => owner.email).filter(Boolean);
  if (toEmails.length) {
    await sendBusinessVerificationDecisionEmail({
      toEmails,
      organizationName: org?.name,
      countryName: name,
      approved,
      reason: row.rejection_reason || "",
      actionUrl: buildAppUrl(path),
      usageContext: { organizationId: row.organization_id, route: "business_verification.decision" },
    });
  }
}

function sendError(res, error) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error("[business-verification]", error?.message || error);
  return res.status(status).json({
    error: {
      code: error?.code || (status >= 500 ? "VERIFICATION_FAILED" : "VERIFICATION_INVALID"),
      message:
        status >= 500 && !error?.code
          ? "Something went wrong with the verification. Please try again."
          : error?.message || "Verification request failed.",
      details: error?.details,
    },
  });
}

router.get(
  "/requirements",
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const requirements = await verification.getRequirements(
        req.query.country,
        req.query.type || "local",
      );
      res.json({ requirements });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    let rows = await verification.listVerifications(db, req.orgId);
    // Keep in-flight reviews fresh even if a carrier callback was missed.
    const stale = rows.filter(
      (row) =>
        verification.IN_FLIGHT.includes(row.status) &&
        (!row.last_checked_at || Date.now() - Date.parse(row.last_checked_at) > 60 * 1000),
    );
    for (const row of stale.slice(0, 3)) {
      try {
        const updated = await verification.refreshVerification({ db, row, notify: notifyDecision });
        rows = rows.map((item) => (item.id === updated.id ? updated : item));
      } catch (error) {
        console.warn("[business-verification] refresh failed:", error?.message || error);
      }
    }
    res.json({ verifications: rows.map(verification.serialize) });
  }),
);

router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    try {
      const row = await verification.createVerification({
        db: getSupabase(),
        organizationId: req.orgId,
        organizationName: req.organization?.name,
        userId: req.user.id,
        country: req.body?.country,
        numberType: req.body?.numberType || "local",
        details: req.body?.details || {},
        address: req.body?.address || {},
        ensureAccount: () =>
          ensureTenantTwilioAccount({
            organizationId: req.orgId,
            organizationName: req.organization?.name,
            createIfMissing: true,
          }),
      });
      res.status(201).json({ verification: verification.serialize(row) });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

router.post(
  "/:id/documents",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    try {
      const data = String(req.body?.data || "").replace(/^data:[^,]+,/, "");
      const row = await verification.uploadDocument({
        db: getSupabase(),
        organizationId: req.orgId,
        id: req.params.id,
        requirementKey: req.body?.requirement,
        documentType: req.body?.documentType,
        fields: req.body?.fields || {},
        fileName: req.body?.fileName,
        mimeType: req.body?.mimeType,
        buffer: Buffer.from(data, "base64"),
      });
      res.json({ verification: verification.serialize(row) });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

router.post(
  "/:id/submit",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    try {
      const row = await verification.submitVerification({
        db: getSupabase(),
        organizationId: req.orgId,
        id: req.params.id,
        callbackUrl: callbackUrl(),
      });
      res.json({ verification: verification.serialize(row) });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

router.post(
  "/:id/refresh",
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const db = getSupabase();
      const row = await verification.loadVerification(db, req.orgId, req.params.id);
      const updated = await verification.refreshVerification({ db, row, notify: notifyDecision });
      res.json({ verification: verification.serialize(updated) });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

router.delete(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    try {
      await verification.deleteVerification({
        db: getSupabase(),
        organizationId: req.orgId,
        id: req.params.id,
      });
      res.json({ success: true });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

/*
 * The carrier calls this when a review status changes. The body is only a
 * nudge: the status is re-read from the carrier with our own credentials, so
 * a forged callback can at most trigger a harmless refresh.
 */
router.post(
  "/status-callback",
  express.urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    const bundleSid = String(req.body?.BundleSid || req.body?.bundle_sid || "").trim();
    if (/^BU[0-9a-f]{32}$/i.test(bundleSid)) {
      try {
        await verification.refreshByBundleSid({
          db: getSupabase(),
          bundleSid,
          failureReason: req.body?.FailureReason || req.body?.failure_reason || "",
          notify: notifyDecision,
        });
      } catch (error) {
        console.warn("[business-verification] callback refresh failed:", error?.message || error);
      }
    }
    res.status(204).end();
  }),
);

module.exports = router;
module.exports.notifyDecision = notifyDecision;
