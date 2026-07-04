#!/usr/bin/env node
"use strict";

/**
 * reconcile-all-orgs-cost.js
 *
 * Runs the existing per-organization full-cost reconciliation
 * (lib/org-full-cost-reconciler.js -> runOrgFullCostReconciliation) across
 * EVERY organization in the database, one at a time, and writes one
 * consolidated JSON report plus a plain-text summary table to stdout.
 *
 * This is the "run sync in case any organization's data increases" job.
 * It does not replace live-call metering (that must work continuously via
 * agently-ws-server); this is the batch backstop that guarantees every org
 * has Twilio + OpenAI + ElevenLabs + Railway + Supabase usage reconciled
 * even for periods where live metering was down, missing, or the org
 * onboarded before metering existed.
 *
 * Usage:
 *   node scripts/reconcile-all-orgs-cost.js [--from onboarding|iso] [--to iso]
 *     [--providers all|twilio,openai,elevenlabs,railway,supabase]
 *     [--apply-wallet false] [--force true] [--concurrency 1]
 *     [--out reconcile-results/all-orgs-cost.json]
 *
 * Recommended: run this nightly (cron / Railway cron job / GitHub Action)
 * so every registered organization's usage ledger stays current without
 * anyone remembering to trigger it manually per org.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { getSupabase } = require("../lib/supabase");
const {
  PROVIDER_RECONCILIATION_STEPS,
  normalizeProviderSteps,
  runOrgFullCostReconciliation,
} = require("../lib/org-full-cost-reconciler");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

async function fetchAllOrganizations() {
  const db = getSupabase();
  const pageSize = 500;
  let from = 0;
  const orgs = [];
  for (;;) {
    const { data, error } = await db
      .from("organizations")
      .select("id,name,plan,subscription_status,created_at")
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    orgs.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return orgs;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(`Usage:
  node scripts/reconcile-all-orgs-cost.js [--from onboarding|iso] [--to iso]
    [--providers all|twilio,openai,elevenlabs,railway,supabase]
    [--apply-wallet false] [--force true] [--concurrency 1]
    [--out reconcile-results/all-orgs-cost.json]

Allowed providers: ${PROVIDER_RECONCILIATION_STEPS.join(", ")}, all`);
    process.exit(0);
  }

  const start = args.from || args.start || "onboarding";
  const end = args.to || args.end || new Date().toISOString();
  const providers = normalizeProviderSteps(
    args.providers || args.provider || "all",
  );
  const force = bool(args.force, true);
  const applyWallet = bool(args["apply-wallet"] ?? args.applyWallet, false);
  const concurrency = Math.max(1, Number(args.concurrency || 1));

  console.log(`[reconcile-all-orgs] loading organizations...`);
  const orgs = await fetchAllOrganizations();
  console.log(`[reconcile-all-orgs] found ${orgs.length} organizations`);

  const results = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= orgs.length) return;
      const org = orgs[idx];
      const label = `${org.name || "unnamed"} (${org.id})`;
      console.log(
        `[reconcile-all-orgs] (${idx + 1}/${orgs.length}) reconciling ${label}`,
      );
      try {
        const result = await runOrgFullCostReconciliation({
          organizationId: org.id,
          start,
          end,
          providers,
          force,
          applyWallet,
        });
        results.push({
          organizationId: org.id,
          organizationName: org.name || "",
          plan: org.plan || "",
          ok: result.ok !== false,
          steps: result.steps || result,
          errors: result.errors || [],
        });
      } catch (err) {
        console.warn(
          `[reconcile-all-orgs] FAILED for ${label}: ${err.message || err}`,
        );
        results.push({
          organizationId: org.id,
          organizationName: org.name || "",
          plan: org.plan || "",
          ok: false,
          error: err.message || String(err),
        });
      }
    }
  }

  const startedAt = new Date().toISOString();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const finishedAt = new Date().toISOString();

  const report = {
    source: "scripts/reconcile-all-orgs-cost.js",
    startedAt,
    finishedAt,
    organizationCount: orgs.length,
    requestedProviders: providers,
    window: { start, end },
    force,
    applyWallet,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };

  const outPath = path.resolve(
    process.cwd(),
    args.out || args.output || "reconcile-results/all-orgs-cost.json",
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    `\n[reconcile-all-orgs] done. ${report.succeeded}/${orgs.length} organizations reconciled successfully.`,
  );
  if (report.failed) {
    console.log(
      `[reconcile-all-orgs] ${report.failed} organization(s) had errors — see ${outPath}`,
    );
  }
  console.log(`[reconcile-all-orgs] full report written to ${outPath}`);
}

main().catch((err) => {
  console.error("[reconcile-all-orgs] fatal error:", err.message || err);
  process.exit(1);
});
