"use strict";

const fetch = require("node-fetch");
const crypto = require("crypto");
const { getSupabase } = require("./supabase");
const {
  recalculateUsageEventCosts,
  rebuildDailyUsageRollups,
} = require("./usage-ledger");

const DEFAULT_PROVIDERS = ["twilio", "openai", "elevenlabs", "railway", "supabase", "resend"];

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value) {
  return String(value == null ? "" : value).trim();
}

function safeJson(value) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return {};
  }
}

function parseBool(value, fallback = false) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseJsonEnv(name, fallback = null) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function parseCsvEnv(name, fallback = []) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function timestampSeconds(date) {
  const d = date ? new Date(date) : new Date();
  return Math.floor(d.getTime() / 1000);
}

function normalizeProvider(value) {
  const p = safeString(value).toLowerCase();
  if (p === "eleven_labs" || p === "eleven-labs") return "elevenlabs";
  if (p === "open_ai") return "openai";
  return p;
}

function normalizeRateInput(row, source = "env") {
  if (!row || typeof row !== "object") return null;
  const provider = normalizeProvider(row.provider);
  const service = safeString(row.service || row.product || "*") || "*";
  const eventType = safeString(row.eventType || row.event_type || row.type || "*") || "*";
  const unit = safeString(row.unit || row.billing_unit);
  const unitCostUsd = row.unitCostUsd ?? row.unit_cost_usd ?? row.cost ?? row.priceUsd ?? row.price_usd;
  if (!provider || !unit || unitCostUsd == null || Number.isNaN(Number(unitCostUsd))) return null;
  return {
    provider,
    service,
    eventType,
    unit,
    unitCostUsd: safeNumber(unitCostUsd),
    currency: safeString(row.currency || "USD") || "USD",
    effectiveFrom: safeString(row.effectiveFrom || row.effective_from) || nowIso(),
    notes: safeString(row.notes || row.description || ""),
    source: safeString(row.source || source || "vendor_rate_sync"),
    metadata: safeJson(row.metadata || {}),
  };
}

function envRateCardsForProvider(provider) {
  const normalized = normalizeProvider(provider);
  const general = parseJsonEnv("VENDOR_RATE_CARD_JSON", []);
  const providerEnvName = `${normalized.toUpperCase()}_RATE_CARD_JSON`;
  const providerSpecific = parseJsonEnv(providerEnvName, []);
  const rows = [];
  for (const entry of Array.isArray(general) ? general : []) {
    const normalizedRow = normalizeRateInput(entry, "VENDOR_RATE_CARD_JSON");
    if (normalizedRow && normalizedRow.provider === normalized) rows.push(normalizedRow);
  }
  for (const entry of Array.isArray(providerSpecific) ? providerSpecific : []) {
    const normalizedRow = normalizeRateInput({ provider: normalized, ...entry }, providerEnvName);
    if (normalizedRow) rows.push(normalizedRow);
  }

  // Friendly scalar env fallbacks for common fixed rates. These are optional and are
  // intentionally not hardcoded prices; values must come from your environment.
  const scalarMap = {
    twilio: [
      ["TWILIO_VOICE_COST_PER_MINUTE_USD", "voice", "*", "minutes"],
      ["TWILIO_RECORDING_COST_PER_MINUTE_USD", "recordings", "recording_minutes", "minutes"],
      ["TWILIO_NUMBER_PURCHASE_COST_USD", "phone_number", "number_purchase", "number"],
      ["TWILIO_NUMBER_MONTHLY_RENTAL_USD", "phone_number", "monthly_rental", "number_month"],
    ],
    openai: [
      ["OPENAI_REALTIME_INPUT_TOKEN_COST_USD", "realtime", "input_tokens", "tokens"],
      ["OPENAI_REALTIME_OUTPUT_TOKEN_COST_USD", "realtime", "output_tokens", "tokens"],
      ["OPENAI_REALTIME_AUDIO_INPUT_TOKEN_COST_USD", "realtime", "audio_input_tokens", "tokens"],
      ["OPENAI_REALTIME_AUDIO_OUTPUT_TOKEN_COST_USD", "realtime", "audio_output_tokens", "tokens"],
      ["OPENAI_TRANSCRIPTION_COST_PER_MINUTE_USD", "transcription", "transcription_minutes", "minutes"],
      ["OPENAI_EMBEDDING_COST_PER_TOKEN_USD", "embeddings", "*", "tokens"],
    ],
    elevenlabs: [
      ["ELEVENLABS_COST_PER_CHARACTER_USD", "voice", "*", "characters"],
      ["ELEVENLABS_COST_PER_CREDIT_USD", "voice", "*", "credits"],
      ["ELEVENLABS_COST_PER_MINUTE_USD", "voice", "*", "minutes"],
    ],
    railway: [["RAILWAY_COST_PER_RUNTIME_SECOND_USD", "runtime", "*", "seconds"]],
    supabase: [
      ["SUPABASE_STORAGE_COST_PER_BYTE_MONTH_USD", "storage", "*", "bytes"],
      ["SUPABASE_COMPUTE_COST_PER_ORG_DAY_USD", "database_compute", "daily_compute_allocation", "org_day"],
    ],
    resend: [["RESEND_COST_PER_EMAIL_USD", "transactional_email", "*", "email"]],
  };
  for (const [envName, service, eventType, unit] of scalarMap[normalized] || []) {
    const raw = safeString(process.env[envName]);
    if (!raw || Number.isNaN(Number(raw))) continue;
    rows.push({
      provider: normalized,
      service,
      eventType,
      unit,
      unitCostUsd: safeNumber(raw),
      currency: "USD",
      effectiveFrom: nowIso(),
      notes: `Loaded from ${envName}`,
      source: envName,
      metadata: { env_name: envName, source: "scalar_env" },
    });
  }

  const gbMonth = safeString(process.env.SUPABASE_STORAGE_COST_PER_GB_MONTH_USD);
  if (normalized === "supabase" && gbMonth && !Number.isNaN(Number(gbMonth))) {
    rows.push({
      provider: "supabase",
      service: "storage",
      eventType: "*",
      unit: "bytes",
      unitCostUsd: safeNumber(gbMonth) / (1024 ** 3),
      currency: "USD",
      effectiveFrom: nowIso(),
      notes: "Converted from SUPABASE_STORAGE_COST_PER_GB_MONTH_USD to byte-month equivalent for storage snapshots.",
      source: "SUPABASE_STORAGE_COST_PER_GB_MONTH_USD",
      metadata: { env_name: "SUPABASE_STORAGE_COST_PER_GB_MONTH_USD", source: "converted_env", gb_month_usd: safeNumber(gbMonth) },
    });
  }

  return rows;
}

async function createSyncRun({ provider, mode, organizationId, startAt, endAt, metadata = {} }) {
  const sb = getSupabase();
  const payload = {
    provider,
    mode: mode || "vendor_rate_sync",
    organization_id: organizationId || null,
    period_start: startAt || null,
    period_end: endAt || null,
    status: "running",
    started_at: nowIso(),
    metadata: safeJson(metadata),
  };
  try {
    const { data, error } = await sb
      .from("billing_vendor_rate_sync_runs")
      .insert(payload)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    return null;
  }
}

async function finishSyncRun(id, patch) {
  if (!id) return null;
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("billing_vendor_rate_sync_runs")
      .update({ ...patch, finished_at: nowIso() })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (_) {
    return null;
  }
}

async function insertSnapshot({ provider, service = null, snapshotType, organizationId, periodStart, periodEnd, rawPayload, normalizedRates = [], metadata = {} }) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("billing_vendor_rate_snapshots")
      .insert({
        provider,
        service,
        snapshot_type: snapshotType,
        organization_id: organizationId || null,
        period_start: periodStart || null,
        period_end: periodEnd || null,
        raw_payload: safeJson(rawPayload),
        normalized_rates: safeJson(normalizedRates),
        metadata: safeJson(metadata),
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (_) {
    return null;
  }
}

function rateChanged(existing, next) {
  if (!existing) return true;
  return Math.abs(Number(existing.unit_cost_usd || 0) - Number(next.unitCostUsd || 0)) > 0.0000000001;
}

async function upsertEffectiveRateCard(rate) {
  const normalized = normalizeRateInput(rate, rate?.source || "vendor_rate_sync");
  if (!normalized) return { ok: false, skipped: true, reason: "invalid_rate_card", rate };
  const sb = getSupabase();
  const when = normalized.effectiveFrom || nowIso();
  const exact = {
    provider: normalized.provider,
    service: normalized.service,
    event_type: normalized.eventType,
    unit: normalized.unit,
  };

  const { data: activeRows, error: activeErr } = await sb
    .from("billing_rate_cards")
    .select("id,unit_cost_usd,effective_from,effective_to,metadata,source,notes")
    .match(exact)
    .is("effective_to", null)
    .order("effective_from", { ascending: false })
    .limit(5);
  if (activeErr) throw activeErr;

  const active = Array.isArray(activeRows) ? activeRows[0] || null : null;
  if (active && !rateChanged(active, normalized)) {
    await sb
      .from("billing_rate_cards")
      .update({
        metadata: {
          ...(active.metadata || {}),
          last_vendor_rate_sync_at: nowIso(),
          last_vendor_rate_sync_source: normalized.source,
          ...(normalized.metadata || {}),
        },
      })
      .eq("id", active.id);
    return { ok: true, changed: false, id: active.id, rate: normalized };
  }

  if (activeRows?.length) {
    const ids = activeRows.map((row) => row.id).filter(Boolean);
    if (ids.length) {
      await sb.from("billing_rate_cards").update({ effective_to: when, updated_at: nowIso() }).in("id", ids);
    }
  }

  const payload = {
    provider: normalized.provider,
    service: normalized.service,
    event_type: normalized.eventType,
    unit: normalized.unit,
    unit_cost_usd: normalized.unitCostUsd,
    currency: normalized.currency || "USD",
    effective_from: when,
    effective_to: null,
    source: normalized.source || "vendor_rate_sync",
    notes: normalized.notes || "Synced by vendor-rate sync engine.",
    metadata: {
      vendor_rate_sync: true,
      synced_at: nowIso(),
      ...(normalized.metadata || {}),
    },
  };
  const { data, error } = await sb.from("billing_rate_cards").insert(payload).select("id").maybeSingle();
  if (error) throw error;
  return { ok: true, changed: true, id: data?.id || null, rate: normalized };
}

async function upsertRateCards(rates = []) {
  const results = [];
  for (const rate of rates) {
    try {
      results.push(await upsertEffectiveRateCard(rate));
    } catch (err) {
      results.push({ ok: false, error: err.message || String(err), rate });
    }
  }
  return {
    attempted: rates.length,
    insertedOrChanged: results.filter((r) => r.ok && r.changed).length,
    unchanged: results.filter((r) => r.ok && r.changed === false).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body?.message || body?.error?.message || text || `HTTP ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function collectTwilioPhoneNumberRates(json, country) {
  const rates = [];
  const prices = json?.phone_number_prices || json?.phoneNumberPrices || json?.prices || [];
  for (const item of Array.isArray(prices) ? prices : []) {
    const type = safeString(item.number_type || item.type || item.category || "phone_number").toLowerCase().replace(/\s+/g, "_");
    const monthly = item.current_price ?? item.base_price ?? item.price ?? item.monthly_price ?? item.price_usd;
    if (monthly == null || Number.isNaN(Number(monthly))) continue;
    rates.push({
      provider: "twilio",
      service: "phone_number",
      eventType: `monthly_rental_${type}`,
      unit: "number_month",
      unitCostUsd: Math.abs(safeNumber(monthly)),
      source: "twilio_pricing_api",
      notes: `Twilio ${country} ${type} monthly phone-number rental price from Pricing API.`,
      metadata: { country, raw_item: item },
    });
  }
  return rates;
}

function collectTwilioVoiceRates(json, country) {
  const rates = [];
  const arrays = [
    ["outbound_call", json?.outbound_prefix_prices || json?.outboundPrefixPrices || []],
    ["inbound_call", json?.inbound_call_prices || json?.inboundCallPrices || []],
  ];
  for (const [eventType, arr] of arrays) {
    for (const item of Array.isArray(arr) ? arr : []) {
      const price = item.current_price ?? item.base_price ?? item.price ?? item.price_usd;
      if (price == null || Number.isNaN(Number(price))) continue;
      rates.push({
        provider: "twilio",
        service: "voice",
        eventType,
        unit: "minutes",
        unitCostUsd: Math.abs(safeNumber(price)),
        source: "twilio_pricing_api",
        notes: `Twilio ${country} ${eventType} per-minute price from Pricing API.`,
        metadata: { country, raw_item: item },
      });
    }
  }
  return rates;
}

async function syncTwilioRates({ startAt, endAt, organizationId, dryRun = false }) {
  const accountSid = safeString(process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_PARENT_ACCOUNT_SID);
  const authToken = safeString(process.env.TWILIO_AUTH_TOKEN);
  const countries = parseCsvEnv("TWILIO_RATE_SYNC_COUNTRIES", ["US"]);
  const warnings = [];
  let rates = envRateCardsForProvider("twilio");
  const snapshots = [];

  if (accountSid && authToken) {
    for (const country of countries) {
      try {
        const voice = await fetchJson(`https://pricing.twilio.com/v2/Voice/Countries/${encodeURIComponent(country)}`, {
          headers: { Authorization: basicAuth(accountSid, authToken) },
        });
        const normalized = collectTwilioVoiceRates(voice, country);
        rates = rates.concat(normalized);
        snapshots.push(await insertSnapshot({ provider: "twilio", service: "voice", snapshotType: "twilio_voice_pricing_api", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: voice, normalizedRates: normalized, metadata: { country } }));
      } catch (err) {
        warnings.push(`Twilio voice pricing ${country} skipped: ${err.message || String(err)}`);
      }
      try {
        const numbers = await fetchJson(`https://pricing.twilio.com/v2/PhoneNumbers/Countries/${encodeURIComponent(country)}`, {
          headers: { Authorization: basicAuth(accountSid, authToken) },
        });
        const normalized = collectTwilioPhoneNumberRates(numbers, country);
        rates = rates.concat(normalized);
        snapshots.push(await insertSnapshot({ provider: "twilio", service: "phone_number", snapshotType: "twilio_phone_number_pricing_api", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: numbers, normalizedRates: normalized, metadata: { country } }));
      } catch (err) {
        warnings.push(`Twilio phone-number pricing ${country} skipped: ${err.message || String(err)}`);
      }
    }
  } else {
    warnings.push("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set; using env JSON/scalar rate cards only.");
  }

  const upsert = dryRun ? { attempted: rates.length, insertedOrChanged: 0, unchanged: 0, failed: 0, results: [] } : await upsertRateCards(rates);
  return { provider: "twilio", ratesDiscovered: rates.length, upsert, warnings, snapshots: snapshots.filter(Boolean).length };
}

async function syncOpenAIRates({ startAt, endAt, organizationId, dryRun = false }) {
  const key = safeString(process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY);
  const warnings = [];
  const rates = envRateCardsForProvider("openai");
  let snapshots = 0;
  if (key) {
    try {
      const url = new URL("https://api.openai.com/v1/organization/costs");
      url.searchParams.set("start_time", String(timestampSeconds(startAt)));
      url.searchParams.set("end_time", String(timestampSeconds(endAt)));
      const data = await fetchJson(url.toString(), { headers: { Authorization: `Bearer ${key}`, "OpenAI-Organization": safeString(process.env.OPENAI_ORG_ID) || undefined } });
      await insertSnapshot({ provider: "openai", service: "all", snapshotType: "openai_cost_api", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: data, normalizedRates: rates, metadata: { api: "organization_costs" } });
      snapshots += 1;
    } catch (err) {
      warnings.push(`OpenAI cost API snapshot skipped: ${err.message || String(err)}`);
    }
  } else {
    warnings.push("OPENAI_ADMIN_KEY/OPENAI_API_KEY not set; using env rate cards only.");
  }
  const upsert = dryRun ? { attempted: rates.length, insertedOrChanged: 0, unchanged: 0, failed: 0, results: [] } : await upsertRateCards(rates);
  return { provider: "openai", ratesDiscovered: rates.length, upsert, warnings, snapshots };
}

async function syncElevenLabsRates({ startAt, endAt, organizationId, dryRun = false }) {
  const key = safeString(process.env.ELEVENLABS_API_KEY);
  const warnings = [];
  let rates = envRateCardsForProvider("elevenlabs");
  let snapshots = 0;
  if (key) {
    try {
      const subscription = await fetchJson("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
      const overage = subscription?.overage_price_per_character ?? subscription?.overagePricePerCharacter;
      if (overage != null && !Number.isNaN(Number(overage))) {
        rates.push({ provider: "elevenlabs", service: "voice", eventType: "*", unit: "characters", unitCostUsd: safeNumber(overage), source: "elevenlabs_subscription_api", notes: "ElevenLabs overage price per character from subscription API.", metadata: { subscription_tier: subscription?.tier || null } });
      }
      await insertSnapshot({ provider: "elevenlabs", service: "subscription", snapshotType: "elevenlabs_subscription_api", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: subscription, normalizedRates: rates, metadata: {} });
      snapshots += 1;
    } catch (err) {
      warnings.push(`ElevenLabs subscription snapshot skipped: ${err.message || String(err)}`);
    }
    try {
      const usageUrl = new URL("https://api.elevenlabs.io/v1/usage/character-stats");
      usageUrl.searchParams.set("start_unix", String(timestampSeconds(startAt)));
      usageUrl.searchParams.set("end_unix", String(timestampSeconds(endAt)));
      const usage = await fetchJson(usageUrl.toString(), { headers: { "xi-api-key": key } });
      await insertSnapshot({ provider: "elevenlabs", service: "usage", snapshotType: "elevenlabs_usage_api", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: usage, normalizedRates: [], metadata: {} });
      snapshots += 1;
    } catch (err) {
      warnings.push(`ElevenLabs usage snapshot skipped: ${err.message || String(err)}`);
    }
  } else {
    warnings.push("ELEVENLABS_API_KEY not set; using env rate cards only.");
  }
  const upsert = dryRun ? { attempted: rates.length, insertedOrChanged: 0, unchanged: 0, failed: 0, results: [] } : await upsertRateCards(rates);
  return { provider: "elevenlabs", ratesDiscovered: rates.length, upsert, warnings, snapshots };
}

async function syncRailwayRates({ startAt, endAt, organizationId, dryRun = false }) {
  const key = safeString(process.env.RAILWAY_API_TOKEN);
  const projectId = safeString(process.env.RAILWAY_PROJECT_ID);
  const serviceId = safeString(process.env.RAILWAY_SERVICE_ID);
  const warnings = [];
  const rates = envRateCardsForProvider("railway");
  let snapshots = 0;
  if (key && projectId) {
    try {
      const query = `query Project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } } }`;
      const data = await fetchJson("https://backboard.railway.com/graphql/v2", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { id: projectId } }),
      });
      await insertSnapshot({ provider: "railway", service: "project", snapshotType: "railway_graphql_project_snapshot", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: data, normalizedRates: rates, metadata: { project_id: projectId, service_id: serviceId || null } });
      snapshots += 1;
    } catch (err) {
      warnings.push(`Railway GraphQL snapshot skipped: ${err.message || String(err)}`);
    }
  } else {
    warnings.push("RAILWAY_API_TOKEN/RAILWAY_PROJECT_ID not set; using env rate cards only.");
  }
  const upsert = dryRun ? { attempted: rates.length, insertedOrChanged: 0, unchanged: 0, failed: 0, results: [] } : await upsertRateCards(rates);
  return { provider: "railway", ratesDiscovered: rates.length, upsert, warnings, snapshots };
}

async function syncSupabaseRates({ startAt, endAt, organizationId, dryRun = false }) {
  const token = safeString(process.env.SUPABASE_ACCESS_TOKEN);
  const projectRef = safeString(process.env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_ID);
  const warnings = [];
  const rates = envRateCardsForProvider("supabase");
  let snapshots = 0;
  if (token && projectRef) {
    try {
      const data = await fetchJson(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`, { headers: { Authorization: `Bearer ${token}` } });
      await insertSnapshot({ provider: "supabase", service: "project", snapshotType: "supabase_management_project_snapshot", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: data, normalizedRates: rates, metadata: { project_ref: projectRef } });
      snapshots += 1;
    } catch (err) {
      warnings.push(`Supabase project snapshot skipped: ${err.message || String(err)}`);
    }
  } else {
    warnings.push("SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_REF not set; using env rate cards only.");
  }
  const upsert = dryRun ? { attempted: rates.length, insertedOrChanged: 0, unchanged: 0, failed: 0, results: [] } : await upsertRateCards(rates);
  return { provider: "supabase", ratesDiscovered: rates.length, upsert, warnings, snapshots };
}

async function syncResendRates({ startAt, endAt, organizationId, dryRun = false }) {
  const key = safeString(process.env.RESEND_API_KEY);
  const warnings = [];
  const rates = envRateCardsForProvider("resend");
  let snapshots = 0;
  if (key) {
    try {
      // Resend does not expose enough account pricing in all plans. Store a reachability snapshot.
      const data = await fetchJson("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` } });
      await insertSnapshot({ provider: "resend", service: "account", snapshotType: "resend_api_reachability_snapshot", organizationId, periodStart: startAt, periodEnd: endAt, rawPayload: data, normalizedRates: rates, metadata: {} });
      snapshots += 1;
    } catch (err) {
      warnings.push(`Resend API snapshot skipped: ${err.message || String(err)}`);
    }
  } else {
    warnings.push("RESEND_API_KEY not set; using env rate cards only.");
  }
  const upsert = dryRun ? { attempted: rates.length, insertedOrChanged: 0, unchanged: 0, failed: 0, results: [] } : await upsertRateCards(rates);
  return { provider: "resend", ratesDiscovered: rates.length, upsert, warnings, snapshots };
}

const PROVIDER_SYNCERS = {
  twilio: syncTwilioRates,
  openai: syncOpenAIRates,
  elevenlabs: syncElevenLabsRates,
  railway: syncRailwayRates,
  supabase: syncSupabaseRates,
  resend: syncResendRates,
};

async function recalculateCustomerCharges({ organizationId, startAt, endAt, applyWallet = false, force = true, limit = 50000 } = {}) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc("billing_admin_recalculate_customer_charges", {
      p_organization_id: organizationId || null,
      p_start_at: startAt || null,
      p_end_at: endAt || null,
      p_apply_wallet: !!applyWallet,
      p_force: !!force,
      p_limit: Math.min(Math.max(Number(limit) || 50000, 1), 100000),
    });
    if (error) throw error;
    return { ok: true, result: data };
  } catch (err) {
    return { ok: false, warning: err.message || String(err) };
  }
}

async function runVendorRateSync({ providers = DEFAULT_PROVIDERS, organizationId = null, hours = 24, startAt = null, endAt = null, dryRun = false, recalculate = true, recalculateCustomers = true, applyWallet = false, targetMarginPercent = null } = {}) {
  const end = endAt || nowIso();
  const start = startAt || new Date(Date.now() - Math.max(Number(hours) || 24, 1) * 60 * 60 * 1000).toISOString();
  const normalizedProviders = Array.from(new Set((Array.isArray(providers) ? providers : String(providers || "").split(",")).map(normalizeProvider).filter(Boolean)));
  const runResults = [];
  const warnings = [];
  let totalRatesChanged = 0;

  for (const provider of normalizedProviders.length ? normalizedProviders : DEFAULT_PROVIDERS) {
    const syncer = PROVIDER_SYNCERS[provider];
    if (!syncer) {
      warnings.push(`Unsupported provider skipped: ${provider}`);
      continue;
    }
    const runId = await createSyncRun({ provider, mode: dryRun ? "dry_run" : "sync", organizationId, startAt: start, endAt: end, metadata: { target_margin_percent: targetMarginPercent } });
    try {
      const result = await syncer({ organizationId, startAt: start, endAt: end, dryRun });
      totalRatesChanged += Number(result?.upsert?.insertedOrChanged || 0);
      await finishSyncRun(runId, {
        status: result?.warnings?.length ? "completed_with_warnings" : "completed",
        rates_discovered: Number(result?.ratesDiscovered || 0),
        rates_upserted: Number(result?.upsert?.insertedOrChanged || 0),
        warnings: result?.warnings || [],
        metadata: safeJson(result),
      });
      runResults.push(result);
    } catch (err) {
      const message = err.message || String(err);
      await finishSyncRun(runId, { status: "failed", error_message: message, warnings: [message] });
      runResults.push({ provider, error: message });
      warnings.push(`${provider} failed: ${message}`);
    }
  }

  let usageRecalc = null;
  let customerRecalc = null;
  let rollup = null;
  if (!dryRun && recalculate) {
    usageRecalc = await recalculateUsageEventCosts({ organizationId, start, end, force: true, limit: 50000 });
    try {
      rollup = await rebuildDailyUsageRollups({ organizationId, start, end });
    } catch (err) {
      warnings.push(`daily rollup rebuild skipped: ${err.message || String(err)}`);
    }
  }
  if (!dryRun && recalculateCustomers) {
    customerRecalc = await recalculateCustomerCharges({ organizationId, startAt: start, endAt: end, applyWallet, force: true, limit: 50000 });
    if (!customerRecalc.ok) warnings.push(customerRecalc.warning);
  }

  return {
    ok: warnings.length === 0,
    dryRun: !!dryRun,
    organizationId,
    startAt: start,
    endAt: end,
    providers: normalizedProviders,
    totalRatesChanged,
    results: runResults,
    usageRecalc,
    customerRecalc,
    rollup,
    warnings,
  };
}

async function getVendorRateSyncStatus() {
  const sb = getSupabase();
  const env = {
    twilio: !!(safeString(process.env.TWILIO_ACCOUNT_SID) && safeString(process.env.TWILIO_AUTH_TOKEN)),
    openai: !!safeString(process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY),
    elevenlabs: !!safeString(process.env.ELEVENLABS_API_KEY),
    railway: !!(safeString(process.env.RAILWAY_API_TOKEN) && safeString(process.env.RAILWAY_PROJECT_ID)),
    supabase: !!(safeString(process.env.SUPABASE_ACCESS_TOKEN) && safeString(process.env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_ID)),
    resend: !!safeString(process.env.RESEND_API_KEY),
    vendorRateCardJson: !!safeString(process.env.VENDOR_RATE_CARD_JSON),
  };
  let latestRuns = [];
  let unpricedUsage = [];
  let rateCoverage = [];
  try {
    const { data } = await sb.from("billing_admin_vendor_rate_sync_status_v55").select("*").limit(100);
    latestRuns = data || [];
  } catch (_) {}
  try {
    const { data } = await sb.from("billing_admin_unpriced_usage_v55").select("*").limit(100);
    unpricedUsage = data || [];
  } catch (_) {}
  try {
    const { data } = await sb.from("billing_admin_rate_card_coverage_v54").select("*").limit(100);
    rateCoverage = data || [];
  } catch (_) {}
  return { env, latestRuns, unpricedUsage, rateCoverage };
}

async function getMarginRiskReport({ organizationId = null, hours = 24, targetMarginPercent = 70, startAt = null, endAt = null } = {}) {
  const sb = getSupabase();
  const end = endAt || nowIso();
  const start = startAt || new Date(Date.now() - Math.max(Number(hours) || 24, 1) * 60 * 60 * 1000).toISOString();
  let query = sb
    .from("billing_customer_usage_charges")
    .select("*, billing_usage_events(provider,service,event_type,unit,occurred_at,call_id,voice_agent_id,knowledge_base_id)")
    .gte("charged_at", start)
    .lte("charged_at", end)
    .limit(50000);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query;
  if (error) throw error;

  const target = Math.max(0, Math.min(99, safeNumber(targetMarginPercent, 70)));
  const rows = (data || []).map((row) => {
    const charge = safeNumber(row.customer_charge_usd);
    const cost = safeNumber(row.internal_cost_usd);
    const profit = safeNumber(row.gross_profit_usd, charge - cost);
    const margin = charge > 0 ? (profit / charge) * 100 : null;
    let decision = "ok";
    if (charge <= 0 && cost > 0) decision = "unbilled_cost";
    else if (cost <= 0) decision = "missing_internal_cost";
    else if (profit < 0) decision = "loss_making";
    else if (margin != null && margin < target) decision = "margin_below_target";
    return {
      id: row.id,
      organizationId: row.organization_id,
      usageEventId: row.usage_event_id,
      provider: row.provider || row.billing_usage_events?.provider,
      service: row.service || row.billing_usage_events?.service,
      eventType: row.event_type || row.billing_usage_events?.event_type,
      unit: row.unit || row.billing_usage_events?.unit,
      quantity: safeNumber(row.quantity),
      customerChargeUsd: charge,
      internalCostUsd: cost,
      grossProfitUsd: profit,
      grossMarginPercent: margin == null ? null : Math.round(margin * 100) / 100,
      decision,
      chargedAt: row.charged_at,
    };
  });
  const summary = rows.reduce((acc, row) => {
    acc.rows += 1;
    acc.customerChargeUsd += row.customerChargeUsd;
    acc.internalCostUsd += row.internalCostUsd;
    acc.grossProfitUsd += row.grossProfitUsd;
    acc.decisions[row.decision] = (acc.decisions[row.decision] || 0) + 1;
    return acc;
  }, { rows: 0, customerChargeUsd: 0, internalCostUsd: 0, grossProfitUsd: 0, decisions: {} });
  summary.grossMarginPercent = summary.customerChargeUsd > 0 ? Math.round((summary.grossProfitUsd / summary.customerChargeUsd) * 10000) / 100 : null;
  return { organizationId, startAt: start, endAt: end, targetMarginPercent: target, summary, rows };
}

async function getRecommendedCustomerPricing({ organizationId = null, hours = 24, targetMarginPercent = 70, startAt = null, endAt = null } = {}) {
  const sb = getSupabase();
  const end = endAt || nowIso();
  const start = startAt || new Date(Date.now() - Math.max(Number(hours) || 24, 1) * 60 * 60 * 1000).toISOString();
  let query = sb
    .from("billing_usage_events")
    .select("provider,service,event_type,unit,quantity,estimated_cost_usd,organization_id,occurred_at")
    .gte("occurred_at", start)
    .lte("occurred_at", end)
    .not("estimated_cost_usd", "is", null)
    .limit(50000);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query;
  if (error) throw error;
  const target = Math.max(0, Math.min(95, safeNumber(targetMarginPercent, 70))) / 100;
  const groups = new Map();
  for (const row of data || []) {
    const key = [row.provider, row.service, row.event_type, row.unit].join("|");
    if (!groups.has(key)) {
      groups.set(key, { provider: row.provider, service: row.service, eventType: row.event_type, unit: row.unit, quantity: 0, internalCostUsd: 0, events: 0 });
    }
    const item = groups.get(key);
    item.quantity += safeNumber(row.quantity);
    item.internalCostUsd += safeNumber(row.estimated_cost_usd);
    item.events += 1;
  }
  const rows = Array.from(groups.values()).map((item) => {
    const costPerUnit = item.quantity > 0 ? item.internalCostUsd / item.quantity : 0;
    const minimumCustomerUnitPrice = target < 1 ? costPerUnit / (1 - target) : null;
    return {
      ...item,
      internalCostPerUnitUsd: Math.round(costPerUnit * 100000000) / 100000000,
      targetMarginPercent: Math.round(target * 10000) / 100,
      minimumCustomerUnitPriceUsd: minimumCustomerUnitPrice == null ? null : Math.round(minimumCustomerUnitPrice * 100000000) / 100000000,
    };
  }).sort((a, b) => b.internalCostUsd - a.internalCostUsd);
  return { organizationId, startAt: start, endAt: end, targetMarginPercent: target * 100, rows };
}

module.exports = {
  DEFAULT_PROVIDERS,
  runVendorRateSync,
  getVendorRateSyncStatus,
  getMarginRiskReport,
  getRecommendedCustomerPricing,
  upsertEffectiveRateCard,
  upsertRateCards,
  envRateCardsForProvider,
};
