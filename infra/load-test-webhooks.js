"use strict";
/**
 * p11: what the webhook path does under concurrency.
 *
 * This matters more here than a generic load test would, for a measured
 * reason: the API is a nano container (0.25 vCPU) in us-east-1 and the
 * database is in eu-central-1 (N010), so every handler pays a transatlantic
 * round trip. Stripe retries on timeout, and a handler that is merely SLOW
 * under load turns into duplicate deliveries.
 *
 * DELIBERATELY DRIVEN WITH INVALID SIGNATURES. A signature check runs before
 * any business logic, so this measures the path's capacity to accept, parse
 * and reject — the work every delivery pays — without creating a single
 * payment, email block or call record. A load test that mutated production
 * state to measure throughput would be a bad trade.
 *
 * What it therefore does NOT measure: the cost of the work AFTER verification.
 * Stated rather than implied.
 *
 *   node infra/load-test-webhooks.js                    # 50 requests, 10 at a time
 *   node infra/load-test-webhooks.js --total 200 --concurrency 25
 *   node infra/load-test-webhooks.js --target resend|stripe
 */
const path = require("path");

const SERVER = path.join(__dirname, "..");
require(path.join(SERVER, "node_modules", "dotenv")).config({
  path: path.join(SERVER, ".env"),
});

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

const API =
  process.env.LOAD_TEST_API ||
  "https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com";
const TOTAL = Number(arg("total", 50));
const CONCURRENCY = Number(arg("concurrency", 10));
const TARGET = String(arg("target", "resend"));

const ENDPOINTS = {
  resend: { path: "/api/email/resend/webhook", body: { type: "email.bounced", data: {} } },
  stripe: { path: "/api/billing/stripe/webhook", body: { id: "evt_loadtest", type: "ping" } },
};

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

(async () => {
  const endpoint = ENDPOINTS[TARGET];
  if (!endpoint) throw new Error(`unknown target ${TARGET}`);

  console.log(`target      : ${API}${endpoint.path}`);
  console.log(`load        : ${TOTAL} requests, ${CONCURRENCY} concurrent`);
  console.log(`signatures  : intentionally INVALID — measures accept/parse/reject only\n`);

  const results = [];
  let index = 0;

  async function worker() {
    for (;;) {
      const mine = index++;
      if (mine >= TOTAL) return;
      const startedAt = process.hrtime.bigint();
      try {
        const res = await fetch(`${API}${endpoint.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...endpoint.body, nonce: mine }),
          signal: AbortSignal.timeout(20000),
        });
        results.push({
          ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
          status: res.status,
        });
      } catch (error) {
        results.push({
          ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
          status: 0,
          error: error.message,
        });
      }
    }
  }

  const wallStart = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = Date.now() - wallStart;

  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  console.log(`wall clock  : ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`throughput  : ${(TOTAL / (wallMs / 1000)).toFixed(1)} req/s`);
  console.log(`latency ms  : p50 ${pct(times, 0.5).toFixed(0)}  p95 ${pct(times, 0.95).toFixed(0)}  p99 ${pct(times, 0.99).toFixed(0)}  max ${times[times.length - 1]?.toFixed(0)}`);
  console.log(`statuses    : ${JSON.stringify(byStatus)}`);

  const failed = results.filter((r) => r.status === 0);
  if (failed.length) {
    console.log(`\nTRANSPORT FAILURES: ${failed.length}`);
    console.log(`  e.g. ${failed[0].error}`);
  }

  const fives = results.filter((r) => r.status >= 500).length;
  const expected = results.filter((r) => r.status === 400 || r.status === 401).length;

  console.log("\nreading:");
  console.log(`  ${expected}/${TOTAL} rejected cleanly, which is the correct answer to an invalid signature.`);
  if (fives) console.log(`  ${fives} FIVE-HUNDREDS — the path fell over rather than rejecting. That is a defect.`);
  if (failed.length) console.log(`  ${failed.length} never completed. Stripe treats that as a failed delivery and retries.`);

  // Stripe's own timeout. A p95 near it means retries and duplicate work.
  const STRIPE_TIMEOUT_MS = 10000;
  const p95 = pct(times, 0.95);
  console.log(
    p95 >= STRIPE_TIMEOUT_MS
      ? `  p95 ${p95.toFixed(0)}ms is AT OR PAST Stripe's ~10s timeout: deliveries would be retried.`
      : `  p95 ${p95.toFixed(0)}ms leaves ${((STRIPE_TIMEOUT_MS - p95) / 1000).toFixed(1)}s of headroom before Stripe retries.`,
  );
  console.log("\nNot measured: the cost of the work that runs AFTER a signature verifies.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
