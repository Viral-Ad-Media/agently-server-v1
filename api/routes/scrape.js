"use strict";

const express = require("express");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { scrapeAndSave } = require("../../lib/scraper");

const router = express.Router();

// POST /api/scrape
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { url, chatbotId } = req.body;
    if (!url) {
      return res.status(400).json({ error: { message: "url is required." } });
    }

    // chatbotId is optional – if not provided, we still scrape but don't save chunks
    const result = await scrapeAndSave(req.orgId, chatbotId || null, url);
    res.json({
      success: true,
      method: result.strategy,
      chunksStored: result.chunks,
      faqs: result.faqs,
      message: `Scraped ${result.chunks} content chunks and generated ${result.faqs.length} FAQs using ${result.strategy}.`,
    });
  }),
);

module.exports = router;
