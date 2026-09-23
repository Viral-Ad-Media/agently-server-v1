"use strict";

/**
 * GET /api/webhooks/health — p7.
 *
 * Gated by a shared key rather than a user session, because the caller that
 * matters is an uptime checker at 3am, not a person with a browser. Returns
 * 503 when a provider's recent failure rate crosses the threshold, so an
 * external monitor alerts on the status code alone without parsing anything.
 */

const express = require("express");
const crypto = require("crypto");
const { asyncHandler } = require("../../middleware/error");
const { health } = require("../../lib/webhook-monitor");

const router = express.Router();

function keyMatches(supplied) {
  const expected = String(process.env.INTERNAL_BILLING_ADMIN_KEY || "");
  // No key configured means no access. An unset secret must not open a door —
  // the fail-open pattern this codebase has now been bitten by four times.
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get(
  "/health",
  asyncHandler(async (req, res) => {
    const supplied = req.headers["x-internal-key"] || String(req.query.key || "");
    if (!keyMatches(supplied)) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    }

    const windowMinutes = Math.min(Math.max(Number(req.query.window) || 15, 1), 1440);
    const report = await health({ windowMinutes });

    // 503 so an uptime checker alerts without reading the body. `unknown`
    // is also 503: not being able to tell is not the same as healthy, and
    // reporting ok would be the failure this row exists to prevent.
    return res.status(report.ok ? 200 : 503).json(report);
  }),
);

module.exports = router;
