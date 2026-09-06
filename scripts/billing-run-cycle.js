#!/usr/bin/env node
"use strict";

/**
 * billing-run-cycle.js — run one usage billing cycle.
 *
 * Dry-run by default: it prints exactly what it WOULD charge and writes
 * nothing. Committing requires two independent signals, so neither a stray
 * flag nor a stray env var alone can move money:
 *
 *   --commit                      on the command line, AND
 *   BILLING_ENGINE_ENABLED=true   in the environment
 *
 * Usage:
 *   node scripts/billing-run-cycle.js                   # last hour, dry run
 *   node scripts/billing-run-cycle.js --hours 24
 *   node scripts/billing-run-cycle.js --from <iso> --to <iso>
 *   node scripts/billing-run-cycle.js --margin 70
 *   node scripts/billing-run-cycle.js --json            # machine-readable
 *   BILLING_ENGINE_ENABLED=true node scripts/billing-run-cycle.js --commit
 *
 * Schedule hourly once approved, e.g.
 *   0 * * * * cd /srv/agently-server && npm run billing:cycle:commit >> /var/log/agently-billing.log 2>&1
 */

require("dotenv").config();

const { getSupabase } = require("../lib/supabase");
const { runBillingCycle } = require("../lib/usage-billing-engine");

function parseArgs(argv) {
  const out = { commit: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") out.commit = true;
    else if (arg === "--json") out.json = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const usd = (n) => `$${Number(n).toFixed(4)}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const to = args.to || new Date().toISOString();
  const hours = Number(args.hours || 1);
  const from =
    args.from || new Date(new Date(to).getTime() - hours * 3600000).toISOString();

  const result = await runBillingCycle(getSupabase(), {
    from,
    to,
    dryRun: !args.commit,
    marginPercent: args.margin === undefined ? undefined : Number(args.margin),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { summary, rows } = result;

  console.log("");
  console.log(`  Billing cycle  ${summary.from}  ->  ${summary.to}  (${summary.hours}h)`);
  console.log(
    `  Margin         ${summary.marginPercent}%  = x${(100 / (100 - summary.marginPercent)).toFixed(3)}  (from ${summary.marginSource})`,
  );
  console.log(
    `  Mode           ${summary.dryRun ? "DRY RUN — nothing written" : "COMMIT"}${
      summary.skippedReason ? `  (${summary.skippedReason})` : ""
    }`,
  );
  console.log("");

  for (const warning of summary.warnings) console.log(`  !  ${warning}`);
  if (summary.warnings.length) console.log("");

  // How each shared bill was split, and on what.
  console.log("  Shared infrastructure for this window");
  for (const [poolName, pool] of Object.entries(summary.pools)) {
    const drivers = Object.entries(pool.drivers)
      .map(([name, weight]) => `${name} ${(weight * 100).toFixed(0)}%`)
      .join(", ");
    console.log(
      `    ${pad(poolName, 12)} ${lpad(usd(pool.poolUsd), 12)}  split by: ${drivers || "nothing used — absorbed"}`,
    );
  }
  console.log(
    `    ${pad("TOTAL", 12)} ${lpad(usd(summary.pooledSharedCostUsd), 12)}  (from ${usd(summary.sharedMonthlyUsd)}/month)`,
  );
  console.log("");
  console.log(
    `  Direct provider cost, already charged per event: ${usd(summary.totalDirectCostUsd)}`,
  );
  console.log("");

  // Whether the unit rate is actually covering the true cost. In absorb mode
  // the tenant's bill never mentions infrastructure, so this is the only place
  // a loss would show up.
  const e = summary.economics;
  console.log("  Economics — are we making money?");
  console.log(
    `    mode           ${e.mode}${e.mode === "absorb" ? "   (infra priced into the unit rate, never a line item)" : "   (infra billed to tenants directly)"}`,
  );
  console.log(
    `    true cost      ${usd(e.totalCostUsd)}  = provider ${usd(e.directCostUsd)} + infra ${usd(e.sharedCostUsd)}`,
  );
  console.log(`    revenue        ${usd(e.revenueUsd)}`);
  console.log(
    `    gross profit   ${usd(e.grossProfitUsd)}${e.profitable ? "" : "   <-- LOSS"}`,
  );
  console.log(
    `    actual margin  ${e.actualMarginPercent}%  (target ${summary.marginPercent}%)`,
  );
  console.log(
    `    multiplier     ${e.currentMultiplier}x now | ${e.breakEvenMultiplier}x break-even | ${e.requiredMultiplier}x for target margin`,
  );
  console.log(`    infra share    ${e.infraShareOfCostPercent}% of true cost`);
  console.log("");

  if (!rows.length) {
    console.log("  No usage in this window.\n");
    return;
  }

  console.log(
    `  ${pad("organization", 38)} ${lpad("compute s", 11)} ${lpad("stored MB", 10)} ${lpad("events", 7)} ${lpad("share %", 9)} ${lpad("our cost $", 11)} ${lpad("BILLED $", 10)}`,
  );
  console.log(`  ${"-".repeat(102)}`);

  for (const r of [...rows].sort((a, b) => b.sharedBillableUsd - a.sharedBillableUsd)) {
    console.log(
      `  ${pad(r.organizationId, 38)} ${lpad(r.drivers.computeSeconds, 11)} ${lpad(
        (r.drivers.storageBytes / 1e6).toFixed(1),
        10,
      )} ${lpad(r.eventCount, 7)} ${lpad(r.sharePercent.toFixed(3), 9)} ${lpad(
        r.sharedCostUsd.toFixed(6),
        11,
      )} ${lpad(r.sharedBillableUsd.toFixed(2), 10)}`,
    );
  }

  console.log("");
  console.log(
    `  Total charged to wallets this cycle: $${summary.totalSharedBillableUsd.toFixed(2)}`,
  );
  if (!summary.dryRun) {
    console.log(
      `  Period rows written: ${result.persisted}   Wallets debited: ${result.debited}`,
    );
  }
  console.log("");
}

main().catch((error) => {
  console.error("[billing-run-cycle] failed:", error?.message || error);
  process.exit(1);
});
