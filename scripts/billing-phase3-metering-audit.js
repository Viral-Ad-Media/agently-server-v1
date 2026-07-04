#!/usr/bin/env node
"use strict";

try {
  require("dotenv").config();
} catch (_) {}

const fs = require("fs");
const path = require("path");
const { getSupabase } = require("../lib/supabase");
const {
  estimateTenantStorageBytes,
  rebuildDailyUsageRollups,
  logOpenAIUsage,
} = require("../lib/usage-ledger");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const item = process.argv[i];
    if (item === `--${name}`) return process.argv[i + 1] || fallback;
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round6(value) {
  return Math.round(toNumber(value) * 1000000) / 1000000;
}

function parseDate(value, fallback = null) {
  const raw = String(value || "").trim();
  if (!raw || raw === "all" || raw === "onboarding") return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

async function fetchUsageRows(sb, organizationId, from, to) {
  let query = sb
    .from("billing_usage_events")
    .select(
      "id,organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,billable,occurred_at,external_id,metadata",
    )
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: false })
    .limit(100000);
  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lte("occurred_at", to);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function groupByProviderService(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = [row.provider, row.service, row.unit || ""].join("|");
    if (!map.has(key)) {
      map.set(key, {
        provider: row.provider || "unknown",
        service: row.service || "unknown",
        unit: row.unit || null,
        events: 0,
        billable_events: 0,
        quantity: 0,
        recorded_internal_cost_usd: 0,
        first_seen_at: row.occurred_at || null,
        last_seen_at: row.occurred_at || null,
        event_types: new Set(),
      });
    }
    const item = map.get(key);
    item.events += 1;
    if (row.billable !== false) item.billable_events += 1;
    item.quantity += toNumber(row.quantity);
    item.recorded_internal_cost_usd += toNumber(row.estimated_cost_usd);
    if (row.event_type) item.event_types.add(row.event_type);
    if (row.occurred_at && (!item.first_seen_at || row.occurred_at < item.first_seen_at)) item.first_seen_at = row.occurred_at;
    if (row.occurred_at && (!item.last_seen_at || row.occurred_at > item.last_seen_at)) item.last_seen_at = row.occurred_at;
  }
  return Array.from(map.values())
    .map((item) => ({
      ...item,
      quantity: round6(item.quantity),
      recorded_internal_cost_usd: round6(item.recorded_internal_cost_usd),
      event_types: Array.from(item.event_types).sort(),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.service.localeCompare(b.service));
}

async function backfillOpenAIComponentRows(rows) {
  let scanned = 0;
  let createdRequests = 0;
  let skipped = 0;
  for (const row of rows || []) {
    if (row.provider !== "openai" || row.unit !== "tokens") continue;
    const meta = row.metadata || {};
    if (meta.token_component) continue;
    if (meta.usage_missing === true || String(row.event_type || "").includes("usage_missing")) continue;
    const usage = meta.usage && typeof meta.usage === "object" ? meta.usage : {};
    const inputTokens = meta.input_tokens ?? usage.input_tokens ?? usage.prompt_tokens;
    const outputTokens = meta.output_tokens ?? usage.output_tokens ?? usage.completion_tokens;
    const cachedInputTokens = meta.cached_input_tokens ?? usage.input_token_details?.cached_tokens;
    const audioInputTokens = meta.audio_input_tokens ?? usage.input_token_details?.audio_tokens;
    const audioOutputTokens = meta.audio_output_tokens ?? usage.output_token_details?.audio_tokens;
    const total =
      toNumber(inputTokens) +
      toNumber(outputTokens) +
      toNumber(cachedInputTokens) +
      toNumber(audioInputTokens) +
      toNumber(audioOutputTokens);
    scanned += 1;
    if (total <= 0) {
      skipped += 1;
      continue;
    }
    await logOpenAIUsage({
      organizationId: row.organization_id,
      service: row.service,
      eventType: meta.original_event_type || row.event_type || "openai_tokens",
      model: meta.model || usage.model || "unknown",
      usage,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      audioInputTokens,
      audioOutputTokens,
      externalId: `${row.external_id || row.id}:phase3_component_backfill`,
      metadata: {
        ...(meta || {}),
        phase3_component_backfill: true,
        migrated_from_usage_event_id: row.id,
      },
    });
    createdRequests += 1;
  }
  return { scanned, created_requests: createdRequests, skipped };
}

function inspectRuntimeHealth(rows) {
  const usageMissing = [];
  const openaiComponents = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
  };
  let elevenlabsCharacters = 0;
  let railwayFinalSeconds = 0;
  let supabaseBytes = 0;

  for (const row of rows || []) {
    const meta = row.metadata || {};
    const eventType = String(row.event_type || "");
    if (meta.usage_missing === true || eventType.includes("usage_missing")) {
      usageMissing.push({
        provider: row.provider,
        service: row.service,
        event_type: row.event_type,
        external_id: row.external_id,
        occurred_at: row.occurred_at,
      });
    }
    if (row.provider === "openai") {
      const component = meta.token_component;
      if (component && Object.prototype.hasOwnProperty.call(openaiComponents, component)) {
        openaiComponents[component] += toNumber(row.quantity);
      }
    }
    if (row.provider === "elevenlabs" && row.unit === "characters") {
      elevenlabsCharacters += toNumber(row.quantity);
    }
    if (row.provider === "railway" && row.service === "runtime" && row.event_type === "websocket_runtime_final") {
      railwayFinalSeconds += toNumber(row.quantity);
    }
    if (row.provider === "supabase" && row.unit === "bytes") {
      supabaseBytes += toNumber(row.quantity);
    }
  }

  return {
    openai_components: Object.fromEntries(
      Object.entries(openaiComponents).map(([key, value]) => [key, round6(value)]),
    ),
    elevenlabs_characters: round6(elevenlabsCharacters),
    railway_runtime_final_seconds: round6(railwayFinalSeconds),
    supabase_storage_bytes: round6(supabaseBytes),
    usage_missing_count: usageMissing.length,
    usage_missing_samples: usageMissing.slice(0, 50),
  };
}

function markdownReport(report) {
  const lines = [];
  lines.push("# Agently Phase 3 Runtime Metering Audit");
  lines.push("");
  lines.push(`Organization ID: ${report.organization_id}`);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Range: ${report.range.from || "all recorded time"} to ${report.range.to || "now"}`);
  lines.push("");
  lines.push("## Runtime health");
  lines.push("");
  lines.push(`- OpenAI input tokens: ${report.runtime_health.openai_components.input_tokens}`);
  lines.push(`- OpenAI output tokens: ${report.runtime_health.openai_components.output_tokens}`);
  lines.push(`- OpenAI cached input tokens: ${report.runtime_health.openai_components.cached_input_tokens}`);
  lines.push(`- OpenAI audio input tokens: ${report.runtime_health.openai_components.audio_input_tokens}`);
  lines.push(`- OpenAI audio output tokens: ${report.runtime_health.openai_components.audio_output_tokens}`);
  lines.push(`- ElevenLabs characters: ${report.runtime_health.elevenlabs_characters}`);
  lines.push(`- Railway final runtime seconds: ${report.runtime_health.railway_runtime_final_seconds}`);
  lines.push(`- Supabase storage bytes recorded: ${report.runtime_health.supabase_storage_bytes}`);
  lines.push(`- Usage-missing markers: ${report.runtime_health.usage_missing_count}`);
  lines.push("");
  lines.push("## Provider/service summary");
  lines.push("");
  lines.push("| Provider | Service | Unit | Events | Billable events | Quantity | Recorded internal cost | Event types |");
  lines.push("|---|---|---|---:|---:|---:|---:|---|");
  for (const row of report.summary) {
    lines.push(`| ${row.provider} | ${row.service} | ${row.unit || ""} | ${row.events} | ${row.billable_events} | ${row.quantity} | $${row.recorded_internal_cost_usd} | ${row.event_types.join(", ")} |`);
  }
  if (!report.summary.length) lines.push("| - | - | - | 0 | 0 | 0 | $0 | - |");
  if (report.storage_snapshot) {
    lines.push("");
    lines.push("## Storage snapshot written");
    lines.push("");
    lines.push(`- Total MB: ${report.storage_snapshot.totalMb}`);
    lines.push(`- Table MB: ${report.storage_snapshot.tableMb}`);
    lines.push(`- Bucket MB: ${report.storage_snapshot.bucketMb}`);
  }
  if (report.openai_component_backfill) {
    lines.push("");
    lines.push("## OpenAI component backfill");
    lines.push("");
    lines.push(`- Rows scanned: ${report.openai_component_backfill.scanned}`);
    lines.push(`- Requests converted: ${report.openai_component_backfill.created_requests}`);
    lines.push(`- Skipped: ${report.openai_component_backfill.skipped}`);
  }
  if (report.rollup) {
    lines.push("");
    lines.push("## Daily rollup rebuild");
    lines.push("");
    lines.push(`- Source events: ${report.rollup.sourceEvents}`);
    lines.push(`- Rollup rows: ${report.rollup.rollupRows}`);
  }
  if (report.runtime_health.usage_missing_samples.length) {
    lines.push("");
    lines.push("## Usage-missing samples");
    lines.push("");
    lines.push("| Provider | Service | Event type | External ID | Occurred at |");
    lines.push("|---|---|---|---|---|");
    for (const row of report.runtime_health.usage_missing_samples) {
      lines.push(`| ${row.provider} | ${row.service} | ${row.event_type} | ${row.external_id || ""} | ${row.occurred_at || ""} |`);
    }
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  lines.push("Phase 3 checks whether live runtime metering is now recording exact provider units. OpenAI cost should be calculated from component token rows, not one rough total-token row. Usage-missing markers are intentionally non-billable and mean the provider did not return usable metering for that request.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const organizationId = argValue("organization-id") || argValue("org") || argValue("organizationId");
  const from = parseDate(argValue("from", "all"));
  const to = parseDate(argValue("to", null));
  const out = argValue("out");
  const format = String(argValue("format", out && out.endsWith(".md") ? "md" : "json")).toLowerCase();
  const writeStorageSnapshot = hasFlag("write-storage-snapshot");
  const rebuildRollups = hasFlag("rebuild-rollups");
  const backfillOpenAIComponents = hasFlag("backfill-openai-components");

  if (!organizationId) {
    console.error("Usage: npm run billing:phase3-metering-audit -- --organization-id <uuid> [--write-storage-snapshot] [--rebuild-rollups] [--out file]");
    process.exit(1);
  }

  const sb = getSupabase();
  let storageSnapshot = null;
  let rollup = null;

  if (writeStorageSnapshot) {
    storageSnapshot = await estimateTenantStorageBytes(organizationId);
  }

  let rows = await fetchUsageRows(sb, organizationId, from, to);
  let openAIComponentBackfill = null;
  if (backfillOpenAIComponents) {
    openAIComponentBackfill = await backfillOpenAIComponentRows(rows);
    rows = await fetchUsageRows(sb, organizationId, from, to);
  }

  if (rebuildRollups) {
    rollup = await rebuildDailyUsageRollups({ organizationId, start: from, end: to });
  }
  const report = {
    generated_at: new Date().toISOString(),
    organization_id: organizationId,
    range: { from, to },
    event_count: rows.length,
    summary: groupByProviderService(rows),
    runtime_health: inspectRuntimeHealth(rows),
    storage_snapshot: storageSnapshot,
    openai_component_backfill: openAIComponentBackfill,
    rollup,
  };

  const output = format === "md" || format === "markdown" ? markdownReport(report) : JSON.stringify(report, null, 2);
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
