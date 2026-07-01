#!/usr/bin/env node
/*
  Agently detailed billing cost report generator.

  Usage:
    node generate-agently-cost-report.mjs --sync
    node generate-agently-cost-report.mjs --hours 87600
    node generate-agently-cost-report.mjs --org 747cf733-dd0d-42ba-87ab-bfea84590142 --sync

  Required config in .env.agently-billing:
    BASE=https://your-backend.vercel.app
    VERCEL_BYPASS=your_vercel_bypass_secret
    BILLING_KEY=your_internal_billing_key
*/

import fs from "node:fs";
import path from "node:path";

const DEFAULT_ORGS = [
  "747cf733-dd0d-42ba-87ab-bfea84590142",
  "74153a47-b031-46c6-85e6-1b57a94c182b",
];

function parseArgs(argv) {
  const args = {
    orgs: [],
    hours: 87600,
    sync: false,
    targetMarginPercent: 70,
    envFile: ".env.agently-billing",
    outDir: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--org") args.orgs.push(argv[++i]);
    else if (arg === "--hours") args.hours = Number(argv[++i]);
    else if (arg === "--sync") args.sync = true;
    else if (arg === "--target-margin")
      args.targetMarginPercent = Number(argv[++i]);
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.orgs.length) args.orgs = DEFAULT_ORGS;

  if (!Number.isFinite(args.hours) || args.hours <= 0) {
    throw new Error("--hours must be a positive number");
  }

  if (
    !Number.isFinite(args.targetMarginPercent) ||
    args.targetMarginPercent <= 0
  ) {
    throw new Error("--target-margin must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`
Agently detailed billing cost report generator

Options:
  --org <uuid>              Organization ID. Can be repeated.
  --hours <number>          Lookback window. Default 87600, about 10 years.
  --sync                    Run vendor-rate-sync/recalculate before reporting.
  --target-margin <number>  Margin target percent. Default 70.
  --env-file <path>         Env file path. Default .env.agently-billing.
  --out-dir <path>          Output directory. Default billing-report-<timestamp>.
`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = trimmed.indexOf("=");

    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();

    let value = trimmed.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing ${name}. Put it in .env.agently-billing or export it in your shell.`,
    );
  }

  return value;
}

function money(value) {
  const n = Number(value || 0);

  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function numberFmt(value) {
  const n = Number(value || 0);

  return Number.isInteger(n)
    ? String(n)
    : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);

  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function toCsv(rows, columns) {
  const header = columns.map((column) => csvEscape(column.label)).join(",");

  const lines = rows.map((row) => {
    return columns.map((column) => csvEscape(row[column.key])).join(",");
  });

  return [header, ...lines].join("\n") + "\n";
}

async function apiGet(base, headers, endpoint) {
  const res = await fetch(`${base}${endpoint}`, {
    method: "GET",
    headers,
  });

  const text = await res.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `GET ${endpoint} returned non-JSON HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }

  if (!res.ok) {
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 400);
    throw new Error(`GET ${endpoint} failed HTTP ${res.status}: ${msg}`);
  }

  return json;
}

async function apiPost(base, headers, endpoint, body = null) {
  const res = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: body
      ? { ...headers, "content-type": "application/json" }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `POST ${endpoint} returned non-JSON HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }

  if (!res.ok) {
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 400);
    throw new Error(`POST ${endpoint} failed HTTP ${res.status}: ${msg}`);
  }

  return json;
}

function extractRows(summary) {
  return (summary.rows || []).map((row) => ({
    category: row.category || row.billingLineItem || "",
    provider: row.provider || "",
    service: row.service || "",
    eventType: row.eventType || "",
    unit: row.unit || "",
    usageQuantity: row.usageQuantity ?? row.quantity ?? 0,
    eventCount: row.eventCount ?? row.events ?? 0,
    customerChargeUsd:
      row.userBillOrWalletDeductionUsd ?? row.customerChargeUsd ?? 0,
    internalCostUsd: row.realInternalCostUsd ?? row.internalCostUsd ?? 0,
    grossProfitUsd: row.grossProfitUsd ?? 0,
    grossMarginPercent: row.grossMarginPercent ?? "",
    billingStatus: row.billingStatus || row.status || "",
    implementationStatus: row.implementationStatus || "",
  }));
}

function summarizeRisks(margin) {
  const decisions = margin?.summary?.decisions || {};

  const output = Object.entries(decisions)
    .map(([decision, count]) => `${decision}: ${count}`)
    .join(", ");

  return output || "No risk rows returned";
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;

  const body = rows.map((row) => {
    return `| ${columns
      .map((column) => String(row[column.key] ?? "").replace(/\|/g, "\\|"))
      .join(" | ")} |`;
  });

  return [header, separator, ...body].join("\n");
}

function makeOrgMarkdown(org, summary, margin, pricing, liveCheck) {
  const totals = summary.totals || {};
  const counts = liveCheck?.counts || {};

  const costRows = extractRows(summary).map((row) => ({
    category: row.category,
    provider: row.provider,
    service: row.service,
    eventType: row.eventType,
    quantity: numberFmt(row.usageQuantity),
    events: numberFmt(row.eventCount),
    customerCharge: money(row.customerChargeUsd),
    internalCost: money(row.internalCostUsd),
    profit: money(row.grossProfitUsd),
    margin:
      row.grossMarginPercent === null || row.grossMarginPercent === ""
        ? ""
        : `${numberFmt(row.grossMarginPercent)}%`,
    status: row.billingStatus,
  }));

  const pricingRows = (pricing.rows || []).map((row) => ({
    provider: row.provider,
    service: row.service,
    eventType: row.eventType,
    unit: row.unit,
    quantity: numberFmt(row.quantity),
    internalCost: money(row.internalCostUsd),
    internalUnitCost: money(row.internalCostPerUnitUsd),
    minCustomerUnitPrice: money(row.minimumCustomerUnitPriceUsd),
  }));

  const riskRows = (margin.rows || []).slice(0, 50).map((row) => ({
    provider: row.provider,
    service: row.service,
    eventType: row.eventType,
    quantity: numberFmt(row.quantity),
    customerCharge: money(row.customerChargeUsd),
    internalCost: money(row.internalCostUsd),
    margin:
      row.grossMarginPercent === null || row.grossMarginPercent === undefined
        ? ""
        : `${numberFmt(row.grossMarginPercent)}%`,
    decision: row.decision,
    occurredAt: row.occurredAt || "",
  }));

  const lines = [];

  lines.push("# Agently Internal Cost Report");
  lines.push("");
  lines.push(`## Organization: ${org}`);
  lines.push("");
  lines.push(
    `Period: ${summary.period?.start || summary.start || margin.startAt || ""} to ${
      summary.period?.end || summary.end || margin.endAt || ""
    }`,
  );
  lines.push("");
  lines.push("### Executive summary");
  lines.push("");
  lines.push(`- Total usage events: ${numberFmt(totals.eventCount)}`);
  lines.push(
    `- Customer charged / wallet deduction: **${money(totals.userBillOrWalletDeductionUsd)}**`,
  );
  lines.push(
    `- Internal cost to Agently: **${money(totals.realInternalCostUsd)}**`,
  );
  lines.push(`- Gross profit: **${money(totals.grossProfitUsd)}**`);
  lines.push(
    `- Gross margin: **${
      totals.grossMarginPercent === null ||
      totals.grossMarginPercent === undefined
        ? "N/A"
        : `${numberFmt(totals.grossMarginPercent)}%`
    }**`,
  );
  lines.push(`- Margin risk summary: ${summarizeRisks(margin)}`);
  lines.push("");
  lines.push("### Account footprint");
  lines.push("");
  lines.push(`- Calls in account: ${numberFmt(counts.calls)}`);
  lines.push(`- Leads: ${numberFmt(counts.leads)}`);
  lines.push(`- Phone numbers: ${numberFmt(counts.phoneNumbers)}`);
  lines.push(`- Knowledge sources: ${numberFmt(counts.knowledgeSources)}`);
  lines.push(`- Knowledge chunks: ${numberFmt(counts.knowledgeChunks)}`);
  lines.push(`- FAQs: ${numberFmt(counts.faqs)}`);
  lines.push(`- Products: ${numberFmt(counts.products)}`);
  lines.push("");
  lines.push("### Detailed internal cost by category");
  lines.push("");
  lines.push(
    markdownTable(costRows, [
      { key: "category", label: "Category" },
      { key: "provider", label: "Provider" },
      { key: "service", label: "Service" },
      { key: "eventType", label: "Event Type" },
      { key: "quantity", label: "Qty" },
      { key: "events", label: "Events" },
      { key: "customerCharge", label: "Customer Charged" },
      { key: "internalCost", label: "Internal Cost" },
      { key: "profit", label: "Profit" },
      { key: "margin", label: "Margin" },
      { key: "status", label: "Status" },
    ]),
  );
  lines.push("");
  lines.push("### Recommended minimum customer pricing");
  lines.push("");

  if (pricingRows.length) {
    lines.push(
      markdownTable(pricingRows, [
        { key: "provider", label: "Provider" },
        { key: "service", label: "Service" },
        { key: "eventType", label: "Event Type" },
        { key: "unit", label: "Unit" },
        { key: "quantity", label: "Qty" },
        { key: "internalCost", label: "Internal Cost" },
        { key: "internalUnitCost", label: "Internal Unit Cost" },
        { key: "minCustomerUnitPrice", label: "Minimum Customer Unit Price" },
      ]),
    );
  } else {
    lines.push("No pricing recommendation rows returned for this period.");
  }

  lines.push("");
  lines.push("### Margin risk detail");
  lines.push("");

  if (riskRows.length) {
    lines.push(
      markdownTable(riskRows, [
        { key: "provider", label: "Provider" },
        { key: "service", label: "Service" },
        { key: "eventType", label: "Event Type" },
        { key: "quantity", label: "Qty" },
        { key: "customerCharge", label: "Customer Charged" },
        { key: "internalCost", label: "Internal Cost" },
        { key: "margin", label: "Margin" },
        { key: "decision", label: "Decision" },
        { key: "occurredAt", label: "Occurred At" },
      ]),
    );
  } else {
    lines.push("No margin-risk rows returned for this period.");
  }

  lines.push("");
  lines.push("### Notes");
  lines.push("");
  lines.push(
    "- Rows with zero cost mean no ledger event was recorded for that category during the selected period.",
  );
  lines.push(
    "- Account footprint counts can show assets such as leads, phone numbers, KB chunks, and calls even when no new billable event occurred in the selected period.",
  );
  lines.push(
    "- For true setup cost, confirm phone-number purchase and rental reconciliation has been run for the same period.",
  );
  lines.push("");

  return lines.join("\n");
}

async function run() {
  const args = parseArgs(process.argv);

  loadEnvFile(args.envFile);

  const base = requireEnv("BASE").replace(/\/$/, "");

  const headers = {
    "x-vercel-protection-bypass": requireEnv("VERCEL_BYPASS"),
    "x-internal-billing-key": requireEnv("BILLING_KEY"),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.outDir || `billing-report-${stamp}`;

  fs.mkdirSync(outDir, { recursive: true });

  const combinedMarkdown = [];
  const combinedCsvRows = [];

  console.log(`Writing reports to: ${path.resolve(outDir)}`);
  console.log(`Organizations: ${args.orgs.join(", ")}`);
  console.log(`Hours: ${args.hours}`);

  for (const org of args.orgs) {
    console.log(`\n=== ${org} ===`);

    if (args.sync) {
      console.log("Running sync/recalculation...");

      const sync = await apiPost(
        base,
        headers,
        `/api/billing-usage/vendor-rate-sync/run?organizationId=${encodeURIComponent(org)}&hours=${encodeURIComponent(args.hours)}`,
      );

      fs.writeFileSync(
        path.join(outDir, `vendor-sync-${org}.json`),
        JSON.stringify(sync, null, 2),
      );

      console.log(
        `Sync complete. Usage scanned: ${sync?.usageRecalc?.scanned ?? "n/a"}, customer charges updated: ${
          sync?.customerRecalc?.result?.charged_or_updated ?? "n/a"
        }`,
      );
    }

    console.log("Fetching production cost summary...");

    const summary = await apiGet(
      base,
      headers,
      `/api/billing-usage/production-cost-summary?organizationId=${encodeURIComponent(org)}&hours=${encodeURIComponent(args.hours)}`,
    );

    console.log("Fetching margin risk report...");

    const margin = await apiGet(
      base,
      headers,
      `/api/billing-usage/margin-risk-report?organizationId=${encodeURIComponent(org)}&hours=${encodeURIComponent(
        args.hours,
      )}&targetMarginPercent=${encodeURIComponent(args.targetMarginPercent)}`,
    );

    console.log("Fetching recommended pricing...");

    const pricing = await apiGet(
      base,
      headers,
      `/api/billing-usage/recommended-customer-pricing?organizationId=${encodeURIComponent(org)}&hours=${encodeURIComponent(
        args.hours,
      )}&targetMarginPercent=${encodeURIComponent(args.targetMarginPercent)}`,
    );

    let liveCheck = { counts: {} };

    try {
      console.log("Fetching account footprint counts...");

      liveCheck = await apiGet(
        base,
        headers,
        `/api/billing-usage/production-cost-live-check?organizationId=${encodeURIComponent(org)}&hours=${encodeURIComponent(
          args.hours,
        )}`,
      );
    } catch (err) {
      console.warn(`Live-check failed but report can continue: ${err.message}`);
    }

    fs.writeFileSync(
      path.join(outDir, `production-cost-summary-${org}.json`),
      JSON.stringify(summary, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, `margin-risk-report-${org}.json`),
      JSON.stringify(margin, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, `recommended-pricing-${org}.json`),
      JSON.stringify(pricing, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, `live-check-${org}.json`),
      JSON.stringify(liveCheck, null, 2),
    );

    const md = makeOrgMarkdown(org, summary, margin, pricing, liveCheck);

    fs.writeFileSync(path.join(outDir, `readable-cost-report-${org}.md`), md);

    combinedMarkdown.push(md);

    const rows = extractRows(summary).map((row) => ({ org, ...row }));

    combinedCsvRows.push(...rows);

    const columns = [
      { key: "org", label: "Organization ID" },
      { key: "category", label: "Category" },
      { key: "provider", label: "Provider" },
      { key: "service", label: "Service" },
      { key: "eventType", label: "Event Type" },
      { key: "unit", label: "Unit" },
      { key: "usageQuantity", label: "Usage Quantity" },
      { key: "eventCount", label: "Event Count" },
      { key: "customerChargeUsd", label: "Customer Charged USD" },
      { key: "internalCostUsd", label: "Internal Cost USD" },
      { key: "grossProfitUsd", label: "Gross Profit USD" },
      { key: "grossMarginPercent", label: "Gross Margin Percent" },
      { key: "billingStatus", label: "Billing Status" },
      { key: "implementationStatus", label: "Implementation Status" },
    ];

    fs.writeFileSync(
      path.join(outDir, `cost-breakdown-${org}.csv`),
      toCsv(rows, columns),
    );

    console.log(
      `Report written: ${path.join(outDir, `readable-cost-report-${org}.md`)}`,
    );
  }

  const combinedPath = path.join(outDir, "combined-agently-cost-report.md");

  fs.writeFileSync(combinedPath, combinedMarkdown.join("\n\n---\n\n"));

  const combinedColumns = [
    { key: "org", label: "Organization ID" },
    { key: "category", label: "Category" },
    { key: "provider", label: "Provider" },
    { key: "service", label: "Service" },
    { key: "eventType", label: "Event Type" },
    { key: "unit", label: "Unit" },
    { key: "usageQuantity", label: "Usage Quantity" },
    { key: "eventCount", label: "Event Count" },
    { key: "customerChargeUsd", label: "Customer Charged USD" },
    { key: "internalCostUsd", label: "Internal Cost USD" },
    { key: "grossProfitUsd", label: "Gross Profit USD" },
    { key: "grossMarginPercent", label: "Gross Margin Percent" },
    { key: "billingStatus", label: "Billing Status" },
    { key: "implementationStatus", label: "Implementation Status" },
  ];

  fs.writeFileSync(
    path.join(outDir, "combined-cost-breakdown.csv"),
    toCsv(combinedCsvRows, combinedColumns),
  );

  console.log("\nDone. Open these files:");
  console.log(`- ${combinedPath}`);
  console.log(`- ${path.join(outDir, "combined-cost-breakdown.csv")}`);
}

run().catch((err) => {
  console.error("\nFAILED:", err.message);
  console.error("\nCommon fixes:");
  console.error(
    "- Make sure BASE, VERCEL_BYPASS, and BILLING_KEY are in .env.agently-billing.",
  );
  console.error(
    "- Run this from Git Bash, VS Code terminal, or any terminal with Node 18+.",
  );
  console.error(
    "- If you see Vercel SSO/302/Access Denied, your VERCEL_BYPASS value is missing or wrong.",
  );
  console.error(
    "- If you see internal billing access denied, your BILLING_KEY value is missing or wrong.",
  );
  process.exit(1);
});
