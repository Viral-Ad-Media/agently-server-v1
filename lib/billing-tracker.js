"use strict";

let started = false;

function start() {
  if (started) return;
  started = true;
  if (process.env.BILLING_TRACKER_ENABLED !== "true") {
    console.log("[billing-tracker] disabled; set BILLING_TRACKER_ENABLED=true to enable background cost tracking.");
    return;
  }
  // Placeholder for production billing aggregation. Keeping this module present
  // prevents dev boot noise while avoiding accidental billing jobs without an
  // explicit environment flag.
  console.log("[billing-tracker] enabled, but no aggregation worker is configured in this build.");
}

module.exports = { start };
