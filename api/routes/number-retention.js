"use strict";

const express = require("express");
const { asyncHandler } = require("../../middleware/error");
const { runNumberRetentionSweep } = require("../../lib/number-retention");

const router = express.Router();

function isAuthorizedCronRequest(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return false;

  const authorization = String(req.headers.authorization || "").trim();
  const legacyHeader = String(req.headers["x-cron-secret"] || "").trim();

  return authorization === `Bearer ${secret}` || legacyHeader === secret;
}

async function runSweep(req, res) {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: { message: "Unauthorized" } });
  }

  const limit = Math.max(
    1,
    Math.min(1000, Number(req.query.limit || req.body?.limit || 250) || 250),
  );
  const result = await runNumberRetentionSweep({ limit });
  return res.json({ success: true, ...result });
}

router.get("/run", asyncHandler(runSweep));
router.post("/run", asyncHandler(runSweep));

module.exports = router;
