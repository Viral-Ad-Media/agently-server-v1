#!/usr/bin/env node
"use strict";

try {
  require("dotenv").config();
} catch (_) {}

const fs = require("fs");
const path = require("path");
const { getSupabase } = require("../lib/supabase");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const item = process.argv[i];
    if (item === `--${name}`) return process.argv[i + 1] || fallback;
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return fallback;
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw || ["all", "onboarding", "none"].includes(raw.toLowerCase())) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function round6(value) {
  return Math.round(n(value) * 1000000) / 1000000;
}

async function tableExists(sb, table) {
  try {
    const { error } = await sb.from(table).select("*").limit(1);
    return { table, exists: !error, error: error ? error.message : null };
  } catch (err) {
    return { table, exists: false, error: err.message || String(err) };
  }
}

async function rpcExists(sb) {
  try {
    const { data, error } = await sb.rpc("record_billing_usage_event", {
      p_organization_id: null,
      p_provider: "agently",
      p_service: "migration_check",
      p_unit: "event",
      p_quantity: 0,
      p_event_type: "function_smoke_test",
      p_source: "billing_audit_org_script",
      p_external_id: `function-smoke-${Date.now()}`,
      p_idempotency_key: `function-smoke-${Date.now()}`,
      p_billable: false,
      p_metadata: { non_billable_smoke_test: true },
    });
    return { exists: !error, error: error ? error.message : null, sample_id: data?.id || null };
  } catch (err) {
    return { exists: false, error: err.message || String(err), sample_id: null };
  }
}

async function fetchUsageRows(sb, organizationId, from, to) {
  let query = sb
    .from("billing_usage_events")
    .select("id,organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,billable,occurred_at,external_id,metadata")
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: false })
    .limit(100000);
  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lte("occurred_at", to);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function countTable(sb, table, organizationId, orgColumn = "organization_id") {
  try {
    let query = sb.from(table).select("*", { count: "exact", head: true });
    if (organizationId && orgColumn) query = query.eq(orgColumn, organizationId);
    const { count, error } = await query;
    if (error) throw error;
    return { table, count: count || 0, ok: true };
  } catch (err) {
    return { table, count: null, ok: false, error: err.message || String(err) };
  }
}

function summarize(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = [row.provider || "unknown", row.service || "unknown", row.event_type || "usage", row.unit || ""].join("|");
    if (!map.has(key)) {
      map.set(key, {
        provider: row.provider || "unknown",
        service: row.service || "unknown",
        event_type: row.event_type || "usage",
        unit: row.unit || null,
        event_count: 0,
        billable_event_count: 0,
        quantity: 0,
        recorded_internal_cost_usd: 0,
        missing_cost_event_count: 0,
        first_seen_at: row.occurred_at || null,
        last_seen_at: row.occurred_at || null,
      });
    }
    const item = map.get(key);
    item.event_count += 1;
    if (row.billable !== false) item.billable_event_count += 1;
    item.quantity += n(row.quantity);
    item.recorded_internal_cost_usd += n(row.estimated_cost_usd);
    if (row.billable !== false && row.estimated_cost_usd == null) item.missing_cost_event_count += 1;
    if (row.occurred_at && (!item.first_seen_at || row.occurred_at < item.first_seen_at)) item.first_seen_at = row.occurred_at;
    if (row.occurred_at && (!item.last_seen_at || row.occurred_at > item.last_seen_at)) item.last_seen_at = row.occurred_at;
  }
  return Array.from(map.values())
    .map((x) => ({ ...x, quantity: round6(x.quantity), recorded_internal_cost_usd: round6(x.recorded_internal_cost_usd) }))
    .sort((a, b) => b.recorded_internal_cost_usd - a.recorded_internal_cost_usd || b.event_count - a.event_count);
}

function providerCoverage(rows) {
  const providers = ["twilio", "openai", "elevenlabs", "railway", "supabase", "agently", "knowledge_base"];
  return providers.map((provider) => {
    const matches = rows.filter((row) => row.provider === provider);
    return {
      provider,
      status: matches.length ? "recorded" : "missing_no_ledger_rows",
      event_count: matches.length,
      quantity: round6(matches.reduce((sum, row) => sum + n(row.quantity), 0)),
      recorded_internal_cost_usd: round6(matches.reduce((sum, row) => sum + n(row.estimated_cost_usd), 0)),
      missing_cost_event_count: matches.filter((row) => row.billable !== false && row.estimated_cost_usd == null).length,
    };
  });
}

function markdown(report) {
  const lines = [];
  lines.push("# Agently Billing Ledger Audit");
  lines.push("");
  lines.push(`Organization ID: ${report.organization_id}`);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Range: ${report.range.from || "all"} to ${report.range.to || "now"}`);
  lines.push("");
  lines.push("## Migration status");
  lines.push("");
  lines.push("| Object | Status | Notes |");
  lines.push("|---|---|---|");
  for (const item of report.migration_status.tables) {
    lines.push(`| ${item.table} | ${item.exists ? "exists" : "missing"} | ${item.error || ""} |`);
  }
  lines.push(`| record_billing_usage_event RPC | ${report.migration_status.record_function.exists ? "exists" : "missing/error"} | ${report.migration_status.record_function.error || ""} |`);
  lines.push("");
  lines.push("## Provider coverage");
  lines.push("");
  lines.push("| Provider | Status | Events | Quantity | Recorded internal cost | Missing-cost events |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const row of report.provider_coverage) {
    lines.push(`| ${row.provider} | ${row.status} | ${row.event_count} | ${row.quantity} | $${row.recorded_internal_cost_usd} | ${row.missing_cost_event_count} |`);
  }
  lines.push("");
  lines.push("## Ledger summary");
  lines.push("");
  lines.push("| Provider | Service | Event type | Unit | Events | Quantity | Recorded internal cost | Missing-cost events |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|");
  if (!report.summary.length) {
    lines.push("| - | - | - | - | 0 | 0 | $0 | 0 |");
  } else {
    for (const row of report.summary) {
      lines.push(`| ${row.provider} | ${row.service} | ${row.event_type} | ${row.unit || ""} | ${row.event_count} | ${row.quantity} | $${row.recorded_internal_cost_usd} | ${row.missing_cost_event_count} |`);
    }
  }
  lines.push("");
  lines.push("## Source table counts");
  lines.push("");
  lines.push("| Table | Count | Status |");
  lines.push("|---|---:|---|");
  for (const row of report.source_table_counts) {
    lines.push(`| ${row.table} | ${row.count == null ? "" : row.count} | ${row.ok ? "ok" : row.error || "error"} |`);
  }
  lines.push("");
  lines.push("## What this means");
  lines.push("");
  lines.push("A provider marked `missing_no_ledger_rows` means Agently has not recorded organization-level usage for that provider yet. Do not treat that as zero cost. Treat it as a metering gap to fix in the next phase.");
  return lines.join("\n");
}

async function main() {
  const organizationId = argValue("organization-id") || argValue("org") || argValue("organizationId");
  const from = parseDate(argValue("from", "all"));
  const to = parseDate(argValue("to", null));
  const format = String(argValue("format", "md")).toLowerCase();
  const out = argValue("out", null);

  if (!organizationId) {
    console.error("Usage: npm run billing:audit-org -- --organization-id <uuid> [--from all|YYYY-MM-DD] [--to YYYY-MM-DD] [--format md|json] [--out file]");
    process.exit(1);
  }

  const sb = getSupabase();
  const requiredTables = [
    "billing_usage_events",
    "billing_provider_resources",
    "billing_rate_cards",
    "billing_customer_usage_charges",
    "billing_wallet_transactions",
    "billing_reconciliation_runs",
    "billing_daily_usage_rollups",
  ];

  const tables = [];
  for (const table of requiredTables) tables.push(await tableExists(sb, table));
  const recordFunction = await rpcExists(sb);

  let rows = [];
  const usageTableOk = tables.find((item) => item.table === "billing_usage_events")?.exists;
  if (usageTableOk) rows = await fetchUsageRows(sb, organizationId, from, to);

  const sourceTables = [
    ["call_records", "organization_id"],
    ["twilio_phone_numbers", "organization_id"],
    ["leads", "organization_id"],
    ["knowledge_bases", "organization_id"],
    ["knowledge_sources", "organization_id"],
    ["knowledge_chunks", "organization_id"],
    ["faqs", "organization_id"],
    ["chatbots", "organization_id"],
    ["chat_messages", "organization_id"],
    ["voice_agents", "organization_id"],
  ];
  const counts = [];
  for (const [table, orgColumn] of sourceTables) counts.push(await countTable(sb, table, organizationId, orgColumn));

  const report = {
    generated_at: new Date().toISOString(),
    organization_id: organizationId,
    range: { from, to },
    migration_status: { tables, record_function: recordFunction },
    event_count: rows.length,
    provider_coverage: providerCoverage(rows),
    summary: summarize(rows),
    source_table_counts: counts,
  };

  const output = format === "json" ? JSON.stringify(report, null, 2) : markdown(report);
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
