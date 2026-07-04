#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
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

function isoOrNull(value) {
  const raw = String(value || "").trim();
  if (!raw || ["onboarding", "all", "all_time"].includes(raw.toLowerCase())) {
    return null;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildWindows(start, end, chunkDays) {
  const from = isoOrNull(start);
  const to = isoOrNull(end) || new Date().toISOString();
  const days = Math.max(Number(chunkDays) || 0, 0);
  if (!from || !days) return [{ start: start || "onboarding", end: to }];
  const windows = [];
  let cursor = new Date(from);
  const finalEnd = new Date(to);
  while (cursor < finalEnd) {
    const windowStart = cursor.toISOString();
    const next = new Date(cursor.getTime() + days * 24 * 60 * 60 * 1000);
    const windowEnd = next < finalEnd ? next.toISOString() : finalEnd.toISOString();
    windows.push({ start: windowStart, end: windowEnd });
    cursor = next;
  }
  return windows.length ? windows : [{ start: from, end: to }];
}

function usage(exitCode = 0) {
  const text = `Usage:
  node scripts/reconcile-org-cost.js --organization-id <uuid> [--from onboarding|iso] [--to iso] [--providers all|twilio,openai] [--chunk-days 7] [--apply-wallet false] [--force true] [--out reconcile-results/org-cost.json]

Examples:
  node scripts/reconcile-org-cost.js --organization-id 747cf733-dd0d-42ba-87ab-bfea84590142 --from onboarding --providers all
  node scripts/reconcile-org-cost.js --organization-id 747cf733-dd0d-42ba-87ab-bfea84590142 --from 2026-06-01 --to 2026-07-01 --providers twilio --chunk-days 7

Allowed providers: ${PROVIDER_RECONCILIATION_STEPS.join(", ")}, all
`;
  console.log(text);
  process.exit(exitCode);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) usage(0);

  const organizationId = String(
    args["organization-id"] || args.organizationId || args.org || "",
  ).trim();
  if (!organizationId) usage(1);

  const selected = normalizeProviderSteps(args.providers || args.provider || "all");
  const providerRuns = selected.includes("mappings")
    ? selected
    : ["mappings", ...selected];
  const start = args.from || args.start || "onboarding";
  const end = args.to || args.end || new Date().toISOString();
  const windows = buildWindows(start, end, args["chunk-days"] || args.chunkDays);
  const force = bool(args.force, true);
  const applyWallet = bool(args["apply-wallet"] ?? args.applyWallet, false);
  const startedAt = new Date().toISOString();
  const results = [];

  for (const provider of providerRuns) {
    const providerWindows = provider === "mappings" ? [windows[0]] : windows;
    for (const window of providerWindows) {
      console.log(
        `[billing-reconcile] org=${organizationId} provider=${provider} start=${window.start} end=${window.end}`,
      );
      const result = await runOrgFullCostReconciliation({
        organizationId,
        start: window.start,
        end: window.end,
        providers: [provider],
        force,
        applyWallet,
      });
      results.push({ provider, window, result });
      if (!result.ok) {
        console.warn(
          `[billing-reconcile] provider=${provider} completed with errors: ${JSON.stringify(result.errors || [])}`,
        );
      }
    }
  }

  const report = {
    ok: results.every((item) => item.result?.ok !== false),
    source: "scripts/reconcile-org-cost.js",
    organizationId,
    requestedProviders: selected,
    executedProviders: providerRuns,
    windowCount: windows.length,
    force,
    applyWallet,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };

  const out = args.out || args.output;
  if (out) {
    const outputPath = path.resolve(process.cwd(), out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`[billing-reconcile] wrote ${outputPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 2);
}

main().catch((err) => {
  console.error("[billing-reconcile] failed", err?.message || String(err));
  process.exit(1);
});
