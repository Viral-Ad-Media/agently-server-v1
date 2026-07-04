#!/usr/bin/env node
"use strict";

try {
  require("dotenv").config();
} catch (_) {}

const fs = require("fs");
const path = require("path");
const { runPhase2ProviderSync } = require("../lib/provider-resource-sync");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const item = process.argv[i];
    if (item === `--${name}`) return process.argv[i + 1] || fallback;
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return fallback;
}

function listArg(name, fallback = "all") {
  return String(argValue(name, fallback) || fallback)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function main() {
  const organizationId = argValue("organization-id") || argValue("organizationId") || argValue("org");
  const providers = listArg("providers", "all");
  const startDate = argValue("from", "onboarding");
  const endDate = argValue("to", new Date().toISOString());
  const billingPeriod = argValue("billing-period", null);
  const out = argValue("out", null);

  if (!organizationId) {
    console.error("Usage: npm run billing:phase2-provider-sync -- --organization-id <uuid> [--providers mapping,twilio,app|all] [--from YYYY-MM-DD|onboarding] [--to YYYY-MM-DD] [--out file.json]");
    process.exit(1);
  }

  const report = await runPhase2ProviderSync({ organizationId, providers, startDate, endDate, billingPeriod });
  const output = JSON.stringify(report, null, 2);
  if (out) {
    const target = path.resolve(process.cwd(), out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
    console.log(`Wrote ${target}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err.message || String(err));
  process.exit(1);
});
