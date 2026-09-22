"use strict";

// Do not report completion until an installed worker finishes. This endpoint
// does not install or enable a worker: scheduler ownership is a release decision.
function createBillingSyncHandler({
  getSecret = () => process.env.CRON_SECRET,
  getTracker = () => require("./billing-tracker"),
  logger = console,
} = {}) {
  return async function runBillingSyncCron(req, res) {
    const secret = String(getSecret() || "").trim();
    const headers = req.headers || {};
    const authorized = secret && (
      String(headers.authorization || "").trim() === `Bearer ${secret}` ||
      String(headers["x-cron-secret"] || "").trim() === secret
    );
    if (!authorized) {
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }
    try {
      const tracker = getTracker();
      if (typeof tracker?.runOnce !== "function") {
        return res.status(503).json({ error: {
          code: "BILLING_SYNC_UNAVAILABLE",
          message: "Billing synchronization is not configured on this service.",
        } });
      }
      await tracker.runOnce();
      return res.json({ success: true, triggered: new Date().toISOString() });
    } catch (_err) {
      logger.error("[billing-sync cron] worker failed");
      return res.status(500).json({ error: {
        code: "BILLING_SYNC_FAILED", message: "Billing sync failed.",
      } });
    }
  };
}

module.exports = { createBillingSyncHandler };
