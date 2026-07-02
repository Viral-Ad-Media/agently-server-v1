"use strict";

const express = require("express");
const {
  insertUsageEvent,
  summarizeUsage,
  reconcileTwilioAccountUsage,
  reconcileTwilioCallRecords,
  estimateTenantStorageBytes,
  estimateAllTenantStorageBytes,
  rebuildDailyUsageRollups,
  recalculateUsageEventCosts,
  upsertProviderResource,
  buildTenantUsageReport,
  logRecordingUsage,
  logTranscriptUsage,
  logRailwayRuntimeUsage,
  logKnowledgeSyncUsage,
  logLeadStorageUsage,
} = require("../../lib/usage-ledger");
const { getSupabase } = require("../../lib/supabase");
const {
  getPlanLimitStatus,
  createPlanLimitSnapshot,
} = require("../../lib/billing-limits");
const {
  evaluateEntitlement,
  getEnforcementMode,
} = require("../../lib/billing-entitlements");

const {
  DEFAULT_PROVIDERS,
  runVendorRateSync,
  getVendorRateSyncStatus,
  getMarginRiskReport,
  getRecommendedCustomerPricing,
} = require("../../lib/vendor-rate-sync");

const router = express.Router();

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getInternalBillingKey() {
  return String(process.env.INTERNAL_BILLING_ADMIN_KEY || "").trim();
}

function isSafeInternalKey(key) {
  return key && key.length >= 32;
}

function requireInternalBillingAccess(req, res, next) {
  const expected = getInternalBillingKey();
  if (!isSafeInternalKey(expected)) {
    return res.status(503).json({
      error: {
        message:
          "Internal billing usage endpoints are locked. Set INTERNAL_BILLING_ADMIN_KEY to a long random secret on the backend.",
      },
    });
  }

  const provided = String(
    req.headers["x-internal-billing-key"] ||
      req.headers["x-agently-internal-key"] ||
      (req.method === "GET" ? req.query?.key : "") ||
      "",
  ).trim();

  if (provided !== expected) {
    return res
      .status(403)
      .json({ error: { message: "Internal billing access required." } });
  }
  next();
}

function cleanOrgId(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function normalizePhoneForBillingResource(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[\s().-]/g, "");
  return cleaned.startsWith("+") ? cleaned : raw;
}

function pickFirstString(row, keys) {
  for (const key of keys) {
    const value = row && row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function syncTwilioProviderResources({
  organizationId = null,
  limit = 1000,
} = {}) {
  const sb = getSupabase();
  const max = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const results = {
    source: "twilio_phone_numbers_and_twilio_accounts",
    phoneNumbersScanned: 0,
    phoneNumbersMapped: 0,
    accountsScanned: 0,
    accountsMapped: 0,
    skipped: 0,
    warnings: [],
  };

  try {
    let query = sb
      .from("twilio_phone_numbers")
      .select("*")
      .not("organization_id", "is", null)
      .limit(max);
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query;
    if (error) throw error;

    for (const row of data || []) {
      results.phoneNumbersScanned += 1;
      const orgId = row.organization_id;
      const phoneNumber = normalizePhoneForBillingResource(
        pickFirstString(row, [
          "phone_number",
          "number",
          "friendly_name",
          "display_phone_number",
        ]),
      );
      const phoneSid = pickFirstString(row, [
        "phone_sid",
        "sid",
        "twilio_phone_sid",
      ]);
      const accountSid = pickFirstString(row, [
        "account_sid",
        "twilio_account_sid",
        "subaccount_sid",
      ]);

      if (!orgId) {
        results.skipped += 1;
        continue;
      }

      if (phoneNumber) {
        await upsertProviderResource({
          organizationId: orgId,
          provider: "twilio",
          resourceType: "phone_number",
          externalId: phoneNumber,
          displayValue: phoneNumber,
          metadata: {
            source_table: "twilio_phone_numbers",
            row_id: row.id || null,
            phone_sid: phoneSid || null,
            account_sid: accountSid || null,
          },
        });
        results.phoneNumbersMapped += 1;
      }

      if (phoneSid) {
        await upsertProviderResource({
          organizationId: orgId,
          provider: "twilio",
          resourceType: "phone_sid",
          externalId: phoneSid,
          displayValue: phoneNumber || phoneSid,
          metadata: {
            source_table: "twilio_phone_numbers",
            row_id: row.id || null,
            phone_number: phoneNumber || null,
            account_sid: accountSid || null,
          },
        });
      }

      if (accountSid) {
        await upsertProviderResource({
          organizationId: orgId,
          provider: "twilio",
          resourceType: "account_sid",
          externalId: accountSid,
          displayValue: accountSid,
          metadata: {
            source_table: "twilio_phone_numbers",
            row_id: row.id || null,
            phone_number: phoneNumber || null,
            phone_sid: phoneSid || null,
          },
        });
      }
    }
  } catch (err) {
    results.warnings.push(
      `twilio_phone_numbers sync skipped: ${err.message || String(err)}`,
    );
  }

  try {
    let accountQuery = sb
      .from("twilio_accounts")
      .select("*")
      .not("organization_id", "is", null)
      .limit(max);
    if (organizationId)
      accountQuery = accountQuery.eq("organization_id", organizationId);
    const { data, error } = await accountQuery;
    if (error) throw error;

    for (const row of data || []) {
      results.accountsScanned += 1;
      const orgId = row.organization_id;
      const accountSid = pickFirstString(row, [
        "account_sid",
        "sid",
        "twilio_account_sid",
        "subaccount_sid",
      ]);
      if (!orgId || !accountSid) {
        results.skipped += 1;
        continue;
      }
      await upsertProviderResource({
        organizationId: orgId,
        provider: "twilio",
        resourceType: "account_sid",
        externalId: accountSid,
        displayValue: row.friendly_name || row.name || accountSid,
        metadata: { source_table: "twilio_accounts", row_id: row.id || null },
      });
      results.accountsMapped += 1;
    }
  } catch (err) {
    results.warnings.push(
      `twilio_accounts sync skipped: ${err.message || String(err)}`,
    );
  }

  return results;
}

const PRODUCTION_COST_SERVICE_CATALOG = [
  {
    provider: "agently",
    service: "leads",
    eventType: "lead_created_or_imported",
    unit: "lead",
    category: "crm.leads",
    costType: "usage_count_and_storage",
    chargeTiming: "per_lead_create_or_import",
    customerChargeType: "included_quota_or_per_lead",
    internalCostSource: "lead row count + Supabase storage rate cards",
    sourceOfTruth: "billing_usage_events + leads",
    existingEndpoint:
      "automatic from Leads create/import routes + POST /api/billing-usage/reconcile/leads-storage",
    requiredEndpoint: "POST /api/billing-usage/reconcile/leads-storage",
    status: "implemented",
    notes:
      "Lead growth is metered as CRM lead count plus Supabase storage bytes.",
  },
  {
    provider: "twilio",
    service: "voice",
    eventType: "twilio_call",
    unit: "minutes",
    category: "calls.telephony",
    costType: "usage_time",
    chargeTiming: "per_call_or_reconciled",
    customerChargeType: "per_minute",
    internalCostSource:
      "Twilio Calls API price, Twilio Usage Records API, or billing_rate_cards fallback",
    sourceOfTruth:
      "billing_usage_events + call_records + Twilio reconciliation",
    existingEndpoint:
      "POST /api/billing-usage/reconcile/twilio and GET /api/billing-usage/events",
    requiredEndpoint: "POST /api/billing-usage/reconcile/twilio?mode=calls",
    status: "implemented_partial",
    notes:
      "Call usage exists, but accuracy depends on Twilio reconciliation and provider-resource mapping.",
  },
  {
    provider: "twilio_or_supabase",
    service: "recordings",
    eventType: "recording_storage",
    unit: "minutes_or_gb_hours",
    category: "calls.recordings",
    costType: "usage_time_and_storage",
    chargeTiming: "per_recording_and_monthly_storage",
    customerChargeType: "usually_included_or_markup",
    internalCostSource:
      "Twilio Recording resources / Usage Records API, or external object storage provider if offloaded",
    sourceOfTruth: "recording metadata on call_records + billing_usage_events",
    existingEndpoint:
      "POST /api/billing-usage/reconcile/twilio-recordings and generic POST /api/billing-usage/events",
    requiredEndpoint: "POST /api/billing-usage/reconcile/twilio-recordings",
    status: "implemented",
    notes:
      "If recordings remain in Twilio Cloud, Twilio is the recording/storage provider. If archived to Supabase/S3, storage must be charged under that provider too.",
  },
  {
    provider: "twilio_or_openai",
    service: "transcription",
    eventType: "call_transcription",
    unit: "minutes_or_tokens",
    category: "calls.transcripts",
    costType: "usage_time_or_token",
    chargeTiming: "per_transcript",
    customerChargeType: "included_or_per_minute",
    internalCostSource:
      "Twilio transcription, OpenAI transcription/realtime tokens, or selected transcript provider",
    sourceOfTruth: "billing_usage_events + call_records.transcription_status",
    existingEndpoint:
      "POST /api/billing-usage/reconcile/transcripts and generic POST /api/billing-usage/events",
    requiredEndpoint: "POST /api/billing-usage/reconcile/transcripts",
    status: "implemented",
    notes:
      "Your schema stores transcript status on call_records, but billing needs provider-specific usage rows.",
  },
  {
    provider: "resend",
    service: "transactional_email",
    eventType: "email_sent",
    unit: "email",
    category: "messaging.email",
    costType: "usage_count",
    chargeTiming: "per_email_or_monthly_quota_overage",
    customerChargeType: "included_or_per_email",
    internalCostSource: "Resend API sends + billing_rate_cards",
    sourceOfTruth: "billing_usage_events",
    existingEndpoint:
      "automatic via lib/email.js and GET /api/billing-usage/events",
    requiredEndpoint: "already instrumented for app-sent emails",
    status: "implemented",
    notes: "Only emails sent through lib/email.js are logged automatically.",
  },
  {
    provider: "twilio",
    service: "phone_number",
    eventType: "number_purchase",
    unit: "number",
    category: "phone_numbers.purchase",
    costType: "one_time_or_initial_charge",
    chargeTiming: "on_purchase",
    customerChargeType: "one_time_or_pass_through_markup",
    internalCostSource:
      "Twilio IncomingPhoneNumber purchase response + Twilio Pricing API",
    sourceOfTruth: "twilio_phone_numbers + billing_usage_events",
    existingEndpoint:
      "POST /api/billing-usage/record/twilio-number-purchase and generic POST /api/billing-usage/events",
    requiredEndpoint: "POST /api/billing-usage/record/twilio-number-purchase",
    status: "implemented",
    notes:
      "Number rows exist, but purchase cost must be written at purchase time so profit is accurate.",
  },
  {
    provider: "twilio",
    service: "phone_number",
    eventType: "monthly_rental",
    unit: "number_month",
    category: "phone_numbers.rental",
    costType: "monthly_recurring_prorated",
    chargeTiming: "monthly_or_daily_prorated",
    customerChargeType: "monthly_number_fee_or_included",
    internalCostSource:
      "Twilio Pricing API monthly price, twilio_phone_numbers metadata, or voice_agents.twilio_monthly_rental_usd",
    sourceOfTruth: "twilio_phone_numbers + billing_usage_events",
    existingEndpoint:
      "partial fallback in reports; no dedicated monthly rental ledger writer",
    requiredEndpoint: "POST /api/billing-usage/reconcile/twilio-number-rentals",
    status: "implemented",
    notes:
      "Your schema has twilio_monthly_rental_usd on voice_agents, but billing should move to phone-number rows and usage events.",
  },
  {
    provider: "elevenlabs",
    service: "voice",
    eventType: "tts_or_agent_voice",
    unit: "characters_or_credits_or_minutes",
    category: "ai.voice",
    costType: "usage_metered",
    chargeTiming: "per_synthesis_or_call",
    customerChargeType: "included_in_call_minute_or_metered",
    internalCostSource:
      "ElevenLabs usage analytics/API + usage-ledger logElevenLabsUsage",
    sourceOfTruth: "billing_usage_events",
    existingEndpoint:
      "helper exists but not wired to every ElevenLabs runtime path",
    requiredEndpoint:
      "POST /api/billing-usage/reconcile/elevenlabs and runtime websocket log on every synthesis",
    status: "implemented",
    notes:
      "The ledger function exists, but the websocket/runtime ElevenLabs path needs to call it with org/call/voice metadata.",
  },
  {
    provider: "openai",
    service: "realtime",
    eventType: "openai_realtime_tokens",
    unit: "tokens",
    category: "ai.brain",
    costType: "token_based",
    chargeTiming: "per_session_or_response_usage_event",
    customerChargeType: "included_in_call_minute_or_metered",
    internalCostSource:
      "OpenAI realtime response/session usage object + billing_rate_cards",
    sourceOfTruth: "billing_usage_events",
    existingEndpoint:
      "runtime logging exists in openai-realtime-bridge; GET /api/billing-usage/events",
    requiredEndpoint:
      "already instrumented where OpenAI usage events expose usage metadata",
    status: "implemented_partial",
    notes:
      "Accuracy depends on receiving realtime usage objects. Add fallback estimate by call duration when usage is missing.",
  },
  {
    provider: "railway",
    service: "runtime",
    eventType: "websocket_runtime",
    unit: "seconds",
    category: "infrastructure.runtime",
    costType: "compute_time",
    chargeTiming: "per_runtime_second_or_daily_allocation",
    customerChargeType: "included_in_call_minute_or_platform_fee",
    internalCostSource:
      "Railway project/service usage export or estimated runtime seconds per call",
    sourceOfTruth: "billing_usage_events",
    existingEndpoint:
      "runtime inserts exist in backend bridge; ws-server needs consistent logging",
    requiredEndpoint:
      "POST /api/billing-usage/reconcile/railway-runtime or runtime event on call end",
    status: "implemented",
    notes:
      "Railway is account-level billing, so tenant attribution should be call-duration allocation unless Railway service-level export is imported.",
  },
  {
    provider: "supabase",
    service: "storage",
    eventType: "tenant_storage_snapshot",
    unit: "bytes",
    category: "infrastructure.storage",
    costType: "storage_gb_hours_monthly",
    chargeTiming: "daily_snapshot_monthly_rollup",
    customerChargeType: "included_quota_or_overage",
    internalCostSource:
      "tenant data size estimates + Supabase pricing/rate cards",
    sourceOfTruth: "billing_usage_events + estimateTenantStorageBytes",
    existingEndpoint:
      "POST /api/billing-usage/reconcile/storage and /reconcile/storage-all",
    requiredEndpoint:
      "already implemented for estimated tenant storage snapshots",
    status: "implemented_estimate",
    notes:
      "This estimates tenant DB/storage footprint from Agently tables. Supabase invoice is project-level, so exact tenant allocation needs snapshots.",
  },
  {
    provider: "supabase",
    service: "database",
    eventType: "database_compute_allocation",
    unit: "seconds_or_share",
    category: "infrastructure.database_compute",
    costType: "monthly_compute_allocation",
    chargeTiming: "monthly_prorated",
    customerChargeType: "platform_fee_or_included",
    internalCostSource:
      "Supabase compute invoice allocated by tenant usage share",
    sourceOfTruth: "billing_usage_events or monthly admin allocation import",
    existingEndpoint: "missing dedicated endpoint",
    requiredEndpoint:
      "POST /api/billing-usage/reconcile/supabase-compute-allocation",
    status: "implemented",
    notes:
      "Storage is estimated; compute/database subscription allocation still needs a monthly allocation event.",
  },
  {
    provider: "knowledge_base",
    service: "scrape_sync_embeddings",
    eventType: "knowledge_sync",
    unit: "pages_or_tokens_or_chunks",
    category: "knowledge.scraping",
    costType: "usage_count_and_token_based",
    chargeTiming: "per_sync",
    customerChargeType: "per_sync_or_included_quota",
    internalCostSource: "scraper runtime + OpenAI tokens + storage bytes",
    sourceOfTruth: "billing_usage_events + knowledge_sources/chunks/products",
    existingEndpoint:
      "credit enforcement exists; detailed event ledger is partial",
    requiredEndpoint:
      "POST /api/billing-usage/record/knowledge-sync-cost and automatic scrapeAndStore metering",
    status: "implemented",
    notes:
      "KB sync should write page count, chunk count, product count, storage bytes, and OpenAI/embedding token usage separately.",
  },
];

function getProductionCatalog() {
  return PRODUCTION_COST_SERVICE_CATALOG.map((item) => ({ ...item }));
}

function dateRangeFromRequest(req) {
  const hours = Number(req.query.hours || req.body?.hours || 24);
  const end = req.query.end || req.body?.end || new Date().toISOString();
  const start =
    req.query.start ||
    req.body?.start ||
    new Date(
      new Date(end).getTime() - Math.max(hours || 24, 1) * 60 * 60 * 1000,
    ).toISOString();
  return { start, end, hours: Math.max(hours || 24, 1) };
}

function estimatePayloadBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
  } catch (_) {
    return 0;
  }
}

function toUsd(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function minutesFromSecondsOrMinutes({ seconds, minutes }) {
  const directMinutes = Number(minutes);
  if (Number.isFinite(directMinutes) && directMinutes > 0) return directMinutes;
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.ceil(sec / 60);
}

async function getCountSafe(sb, table, organizationId) {
  try {
    const { count, error } = await sb
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    if (error) throw error;
    return count || 0;
  } catch (_) {
    return 0;
  }
}

async function liveBillingCoverageCheck({
  organizationId = null,
  hours = 24,
} = {}) {
  const sb = getSupabase();
  const start = new Date(
    Date.now() - Math.max(Number(hours) || 24, 1) * 60 * 60 * 1000,
  ).toISOString();
  const checks = [];
  async function tableExists(table) {
    try {
      const { error } = await sb.from(table).select("id").limit(1);
      return !error;
    } catch (_) {
      return false;
    }
  }
  async function countEventsFor(category) {
    let query = sb
      .from("billing_usage_events")
      .select("id,provider,service,event_type,unit,occurred_at", {
        count: "exact",
        head: false,
      })
      .gte("occurred_at", start)
      .limit(5000);
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query;
    if (error) return { count: 0, lastEventAt: null, error: error.message };
    const matches = (data || []).filter(
      (row) =>
        classifyProductionCost(
          row.provider,
          row.service,
          row.event_type,
          row.unit,
        ) === category,
    );
    matches.sort((a, b) =>
      String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")),
    );
    return {
      count: matches.length,
      lastEventAt: matches[0]?.occurred_at || null,
      error: null,
    };
  }
  const requiredTables = [
    "billing_usage_events",
    "billing_customer_usage_charges",
    "billing_wallet_transactions",
    "billing_rate_cards",
    "billing_customer_rate_cards",
    "billing_provider_resources",
    "call_records",
    "twilio_phone_numbers",
    "voice_agents",
    "knowledge_sources",
    "knowledge_chunks",
    "scraped_products",
    "faqs",
    "leads",
  ];
  const tableStatus = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(table);
  let rateCardsForCoverage = [];
  try {
    const { data } = await sb
      .from("billing_rate_cards")
      .select(
        "id,provider,service,event_type,unit,effective_to,source,metadata",
      )
      .limit(5000);
    rateCardsForCoverage = data || [];
  } catch (_) {
    rateCardsForCoverage = [];
  }

  function rateCardsForCategory(category) {
    return rateCardsForCoverage.filter((row) => {
      if (row.effective_to !== null && row.effective_to !== undefined)
        return false;
      return (
        classifyProductionCost(
          row.provider,
          row.service,
          row.event_type,
          row.unit,
        ) === category
      );
    });
  }

  for (const item of PRODUCTION_COST_SERVICE_CATALOG) {
    const coverage = await countEventsFor(item.category);
    const matchedRateCards = rateCardsForCategory(item.category);
    const rateCount = matchedRateCards.length;
    checks.push({
      category: item.category,
      provider: item.provider,
      service: item.service,
      unit: item.unit,
      chargeTiming: item.chargeTiming,
      costType: item.costType,
      endpoint: item.requiredEndpoint,
      implementationStatus: item.status,
      eventCountLastWindow: coverage.count,
      lastEventAt: coverage.lastEventAt,
      rateCardExactMatches: rateCount,
      rateCardMatchMode: "classified_active_rate_cards_v60",
      status: !tableStatus.billing_usage_events
        ? "billing_usage_events_table_missing"
        : coverage.count > 0
          ? "live_events_recorded"
          : "endpoint_ready_no_events_in_window",
      warning:
        coverage.error ||
        (rateCount === 0
          ? "no active matching rate card found after production-category classification"
          : ""),
    });
  }
  const counts = organizationId
    ? {
        calls: await getCountSafe(sb, "call_records", organizationId),
        leads: await getCountSafe(sb, "leads", organizationId),
        knowledgeSources: await getCountSafe(
          sb,
          "knowledge_sources",
          organizationId,
        ),
        knowledgeChunks: await getCountSafe(
          sb,
          "knowledge_chunks",
          organizationId,
        ),
        faqs: await getCountSafe(sb, "faqs", organizationId),
        products: await getCountSafe(sb, "scraped_products", organizationId),
        phoneNumbers: await getCountSafe(
          sb,
          "twilio_phone_numbers",
          organizationId,
        ),
      }
    : null;
  return {
    organizationId,
    hours: Math.max(Number(hours) || 24, 1),
    start,
    tableStatus,
    counts,
    checks,
  };
}

function classifyProductionCost(provider, service, eventType, unit) {
  const p = String(provider || "").toLowerCase();
  const s = String(service || "").toLowerCase();
  const e = String(eventType || "").toLowerCase();
  const u = String(unit || "").toLowerCase();

  if (
    p === "twilio" &&
    s.includes("phone") &&
    (e.includes("purchase") || e.includes("buy") || e.includes("provision"))
  )
    return "phone_numbers.purchase";
  if (
    p === "twilio" &&
    (e.includes("rental") ||
      e.includes("monthly") ||
      e.includes("number_month") ||
      s.includes("phone_number"))
  )
    return "phone_numbers.rental";
  if (
    (p === "twilio" || p === "supabase") &&
    (s.includes("record") || e.includes("record"))
  )
    return "calls.recordings";
  if (
    (p === "twilio" || p === "openai") &&
    (s.includes("transcript") ||
      e.includes("transcript") ||
      e.includes("transcription"))
  )
    return "calls.transcripts";
  if (
    p === "twilio" &&
    (s.includes("voice") ||
      e.includes("call") ||
      u === "minutes" ||
      u === "seconds")
  )
    return "calls.telephony";
  if (
    p === "openai" &&
    (s.includes("realtime") || e.includes("realtime") || u === "tokens")
  )
    return "ai.brain";
  if (p === "elevenlabs") return "ai.voice";
  if (p === "resend") return "messaging.email";
  if (
    (p === "agently" || p === "supabase") &&
    (s.includes("lead") || e.includes("lead"))
  )
    return "crm.leads";
  if (p === "railway") return "infrastructure.runtime";
  if (
    p === "supabase" &&
    (s.includes("storage") || e.includes("storage") || u.includes("byte"))
  )
    return "infrastructure.storage";
  if (p === "supabase" || p === "postgres")
    return "infrastructure.database_compute";
  if (
    s.includes("knowledge") ||
    e.includes("knowledge") ||
    e.includes("scrape") ||
    e.includes("sync") ||
    e.includes("embedding")
  )
    return "knowledge.scraping";
  return "other.unclassified";
}

function catalogByCategory() {
  const map = new Map();
  for (const item of PRODUCTION_COST_SERVICE_CATALOG) {
    if (!map.has(item.category)) map.set(item.category, item);
  }
  return map;
}

async function getProductionCostRows({
  organizationId,
  start,
  end,
  includeExpected = true,
} = {}) {
  const sb = getSupabase();
  const catalogMap = catalogByCategory();

  const { data: events, error: eventsError } = await sb
    .from("billing_usage_events")
    .select("*")
    .eq("organization_id", organizationId)
    .gte("occurred_at", start)
    .lte("occurred_at", end)
    .order("occurred_at", { ascending: false })
    .limit(50000);
  if (eventsError) throw eventsError;

  const eventIds = (events || []).map((row) => row.id).filter(Boolean);
  const chargesByUsageId = new Map();
  if (eventIds.length) {
    const { data: charges, error: chargesError } = await sb
      .from("billing_customer_usage_charges")
      .select("*")
      .in("usage_event_id", eventIds)
      .limit(50000);
    if (chargesError) throw chargesError;
    for (const charge of charges || [])
      chargesByUsageId.set(charge.usage_event_id, charge);
  }

  const walletsByUsageId = new Map();
  const walletsByChargeId = new Map();
  const { data: wallets, error: walletsError } = await sb
    .from("billing_wallet_transactions")
    .select("*")
    .eq("organization_id", organizationId)
    .gte("created_at", start)
    .lte("created_at", end)
    .limit(50000);
  if (!walletsError) {
    for (const tx of wallets || []) {
      const amount = Number(tx.amount_usd || 0);
      const deduction =
        amount < 0
          ? Math.abs(amount)
          : ["debit", "usage", "charge", "deduction"].includes(
                String(tx.transaction_type || "").toLowerCase(),
              )
            ? Math.abs(amount)
            : 0;
      if (tx.usage_event_id)
        walletsByUsageId.set(
          tx.usage_event_id,
          Number(walletsByUsageId.get(tx.usage_event_id) || 0) + deduction,
        );
      if (tx.usage_charge_id)
        walletsByChargeId.set(
          tx.usage_charge_id,
          Number(walletsByChargeId.get(tx.usage_charge_id) || 0) + deduction,
        );
    }
  }

  const grouped = new Map();
  function addRow({
    provider,
    service,
    eventType,
    unit,
    quantity,
    userBill,
    internalCost,
    eventCount = 1,
    callId,
    voiceAgentId,
    knowledgeBaseId,
    source,
    status,
    metadata = {},
  }) {
    const category = classifyProductionCost(provider, service, eventType, unit);
    const catalog = catalogMap.get(category) || {};
    const key = [
      category,
      provider || catalog.provider || "unknown",
      service || catalog.service || "unknown",
      eventType || catalog.eventType || "usage",
      unit || catalog.unit || "unit",
    ].join("|");
    if (!grouped.has(key)) {
      grouped.set(key, {
        category,
        billingLineItem: catalog.category ? catalog.category : category,
        provider: provider || catalog.provider || "unknown",
        service: service || catalog.service || "unknown",
        eventType: eventType || catalog.eventType || "usage",
        unit: unit || catalog.unit || "unit",
        costType: catalog.costType || "unknown",
        chargeTiming: catalog.chargeTiming || "unknown",
        sourceOfTruth: catalog.sourceOfTruth || "billing_usage_events",
        existingEndpoint:
          catalog.existingEndpoint || "GET /api/billing-usage/events",
        requiredEndpoint: catalog.requiredEndpoint || "review needed",
        implementationStatus: catalog.status || "unknown",
        usageQuantity: 0,
        eventCount: 0,
        linkedCallCount: 0,
        voiceAgentCount: 0,
        knowledgeBaseCount: 0,
        userBillOrWalletDeductionUsd: 0,
        realInternalCostUsd: 0,
        grossProfitUsd: 0,
        statuses: new Set(),
        callIds: new Set(),
        voiceAgentIds: new Set(),
        knowledgeBaseIds: new Set(),
        sources: new Set(),
        sampleMetadata: null,
      });
    }
    const item = grouped.get(key);
    const qty = Number(quantity || 0);
    const billed = Number(userBill || 0);
    const cost = Number(internalCost || 0);
    item.usageQuantity += qty;
    item.eventCount += Number(eventCount || 0);
    item.userBillOrWalletDeductionUsd += billed;
    item.realInternalCostUsd += cost;
    item.grossProfitUsd += billed - cost;
    if (callId) item.callIds.add(callId);
    if (voiceAgentId) item.voiceAgentIds.add(voiceAgentId);
    if (knowledgeBaseId) item.knowledgeBaseIds.add(knowledgeBaseId);
    if (source) item.sources.add(source);
    if (status) item.statuses.add(status);
    if (!item.sampleMetadata && metadata && Object.keys(metadata).length)
      item.sampleMetadata = metadata;
  }

  for (const event of events || []) {
    const charge = chargesByUsageId.get(event.id) || null;
    const walletDeduction = Number(
      walletsByUsageId.get(event.id) ||
        (charge?.id ? walletsByChargeId.get(charge.id) : 0) ||
        0,
    );
    const billed = walletDeduction || Number(charge?.customer_charge_usd || 0);
    const internalCost = Number(
      charge?.internal_cost_usd ?? event.estimated_cost_usd ?? 0,
    );
    let status = "ok";
    if (!charge)
      status = "raw usage recorded, but no customer charge row found";
    else if (!walletDeduction && Number(charge.customer_charge_usd || 0) > 0)
      status = "customer charge exists; wallet deduction not linked";
    else if (billed === 0 && internalCost > 0)
      status = "internal cost exists, but customer was not billed";
    else if (billed > 0 && internalCost === 0)
      status = "customer billed, but internal cost missing";
    addRow({
      provider: event.provider,
      service: event.service,
      eventType: event.event_type,
      unit: event.unit,
      quantity: event.quantity,
      userBill: billed,
      internalCost,
      callId: event.call_id,
      voiceAgentId: event.voice_agent_id,
      knowledgeBaseId: event.knowledge_base_id,
      source: event.source,
      status,
      metadata: event.metadata || {},
    });
  }

  try {
    const { data: numbers } = await sb
      .from("twilio_phone_numbers")
      .select(
        "id,phone_number,phone_sid,created_at,metadata,assigned_voice_agent_id,inbound_voice_agent_id,default_outbound_voice_agent_id",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", start)
      .lte("created_at", end)
      .limit(5000);
    for (const number of numbers || []) {
      const hasLedgerEvent = (events || []).some(
        (event) =>
          event.provider === "twilio" &&
          (event.external_id === number.phone_sid ||
            event.metadata?.phone_sid === number.phone_sid),
      );
      if (!hasLedgerEvent) {
        addRow({
          provider: "twilio",
          service: "phone_number",
          eventType: "number_purchase_detected_no_ledger_event",
          unit: "number",
          quantity: 1,
          userBill: Number(
            number.metadata?.customer_charge_usd ||
              number.metadata?.user_charge_usd ||
              0,
          ),
          internalCost: Number(
            number.metadata?.internal_cost_usd ||
              number.metadata?.twilio_cost_usd ||
              0,
          ),
          voiceAgentId:
            number.assigned_voice_agent_id ||
            number.inbound_voice_agent_id ||
            number.default_outbound_voice_agent_id ||
            null,
          source: "twilio_phone_numbers_fallback",
          status:
            "number row created, but purchase cost event missing unless metadata carries amounts",
          metadata: {
            phone_number: number.phone_number,
            phone_sid: number.phone_sid,
          },
        });
      }
    }
  } catch (_) {}

  try {
    const { data: agents } = await sb
      .from("voice_agents")
      .select(
        "id,name,twilio_phone_number,twilio_phone_sid,twilio_monthly_rental_usd",
      )
      .eq("organization_id", organizationId)
      .gt("twilio_monthly_rental_usd", 0)
      .limit(5000);
    const seenNumbers = new Set();
    for (const agent of agents || []) {
      const key =
        agent.twilio_phone_sid || agent.twilio_phone_number || agent.id;
      if (seenNumbers.has(key)) continue;
      seenNumbers.add(key);
      const dailyCost = Number(agent.twilio_monthly_rental_usd || 0) / 30;
      addRow({
        provider: "twilio",
        service: "phone_number",
        eventType: "daily_prorated_number_rental_estimate",
        unit: "number_day",
        quantity: 1,
        userBill: 0,
        internalCost: dailyCost,
        voiceAgentId: agent.id,
        source: "voice_agents.twilio_monthly_rental_usd_fallback",
        status:
          "rental estimated from voice agent field; create monthly rental ledger event for exact billing",
        metadata: {
          phone_number: agent.twilio_phone_number,
          phone_sid: agent.twilio_phone_sid,
          monthly_rental_usd: agent.twilio_monthly_rental_usd,
        },
      });
    }
  } catch (_) {}

  if (includeExpected) {
    for (const catalog of PRODUCTION_COST_SERVICE_CATALOG) {
      if (
        catalog.status === "implemented" ||
        catalog.status === "implemented_partial" ||
        catalog.status === "implemented_estimate" ||
        catalog.status === "implemented_helper_missing_runtime_wiring" ||
        catalog.status === "missing_dedicated_endpoint"
      ) {
        const hasCategory = Array.from(grouped.values()).some(
          (row) => row.category === catalog.category,
        );
        if (!hasCategory) {
          const key = [
            catalog.category,
            catalog.provider,
            catalog.service,
            catalog.eventType,
            catalog.unit,
          ].join("|");
          if (!grouped.has(key)) {
            grouped.set(key, {
              category: catalog.category,
              billingLineItem: catalog.category,
              provider: catalog.provider,
              service: catalog.service,
              eventType: catalog.eventType,
              unit: catalog.unit,
              costType: catalog.costType,
              chargeTiming: catalog.chargeTiming,
              sourceOfTruth: catalog.sourceOfTruth,
              existingEndpoint: catalog.existingEndpoint,
              requiredEndpoint: catalog.requiredEndpoint,
              implementationStatus: catalog.status,
              usageQuantity: 0,
              eventCount: 0,
              linkedCallCount: 0,
              voiceAgentCount: 0,
              knowledgeBaseCount: 0,
              userBillOrWalletDeductionUsd: 0,
              realInternalCostUsd: 0,
              grossProfitUsd: 0,
              statuses: new Set([
                "no recorded usage/charge found in selected period",
              ]),
              callIds: new Set(),
              voiceAgentIds: new Set(),
              knowledgeBaseIds: new Set(),
              sources: new Set(),
              sampleMetadata: null,
            });
          }
        }
      }
    }
  }

  const rows = Array.from(grouped.values()).map((item) => ({
    category: item.category,
    billingLineItem: item.billingLineItem,
    provider: item.provider,
    service: item.service,
    eventType: item.eventType,
    unit: item.unit,
    costType: item.costType,
    chargeTiming: item.chargeTiming,
    usageQuantity: Math.round(item.usageQuantity * 1000000) / 1000000,
    eventCount: item.eventCount,
    linkedCallCount: item.callIds.size,
    voiceAgentCount: item.voiceAgentIds.size,
    knowledgeBaseCount: item.knowledgeBaseIds.size,
    userBillOrWalletDeductionUsd:
      Math.round(item.userBillOrWalletDeductionUsd * 1000000) / 1000000,
    realInternalCostUsd:
      Math.round(item.realInternalCostUsd * 1000000) / 1000000,
    grossProfitUsd: Math.round(item.grossProfitUsd * 1000000) / 1000000,
    grossMarginPercent:
      item.userBillOrWalletDeductionUsd > 0
        ? Math.round(
            (item.grossProfitUsd / item.userBillOrWalletDeductionUsd) * 10000,
          ) / 100
        : null,
    sourceOfTruth: item.sourceOfTruth,
    existingEndpoint: item.existingEndpoint,
    requiredEndpoint: item.requiredEndpoint,
    implementationStatus: item.implementationStatus,
    billingStatus: Array.from(item.statuses).join("; "),
    sources: Array.from(item.sources),
    sampleMetadata: item.sampleMetadata,
  }));

  rows.sort((a, b) => {
    const aMissing = a.eventCount === 0 ? 1 : 0;
    const bMissing = b.eventCount === 0 ? 1 : 0;
    if (aMissing !== bMissing) return aMissing - bMissing;
    return (
      (b.userBillOrWalletDeductionUsd || 0) -
        (a.userBillOrWalletDeductionUsd || 0) ||
      (b.realInternalCostUsd || 0) - (a.realInternalCostUsd || 0)
    );
  });

  const totals = rows
    .filter((row) => row.eventCount > 0)
    .reduce(
      (acc, row) => {
        acc.eventCount += row.eventCount;
        acc.userBillOrWalletDeductionUsd += Number(
          row.userBillOrWalletDeductionUsd || 0,
        );
        acc.realInternalCostUsd += Number(row.realInternalCostUsd || 0);
        acc.grossProfitUsd += Number(row.grossProfitUsd || 0);
        acc.linkedCallCount += Number(row.linkedCallCount || 0);
        return acc;
      },
      {
        eventCount: 0,
        userBillOrWalletDeductionUsd: 0,
        realInternalCostUsd: 0,
        grossProfitUsd: 0,
        linkedCallCount: 0,
      },
    );
  totals.userBillOrWalletDeductionUsd =
    Math.round(totals.userBillOrWalletDeductionUsd * 1000000) / 1000000;
  totals.realInternalCostUsd =
    Math.round(totals.realInternalCostUsd * 1000000) / 1000000;
  totals.grossProfitUsd = Math.round(totals.grossProfitUsd * 1000000) / 1000000;
  totals.grossMarginPercent =
    totals.userBillOrWalletDeductionUsd > 0
      ? Math.round(
          (totals.grossProfitUsd / totals.userBillOrWalletDeductionUsd) * 10000,
        ) / 100
      : null;

  return { organizationId, start, end, totals, rows };
}

function ctoRoundUsd(value) {
  const n = Number(value || 0);
  return Math.round(n * 1000000) / 1000000;
}

function ctoSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ctoJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
  } catch (_) {
    return 0;
  }
}

function ctoMoney(value) {
  const n = ctoRoundUsd(value);
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function ctoNum(value) {
  const n = Number(value || 0);
  return Number.isInteger(n)
    ? String(n)
    : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function ctoDaysBetween(start, end) {
  const a = new Date(start || 0).getTime();
  const b = new Date(end || new Date()).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.max(0, (b - a) / (24 * 60 * 60 * 1000));
}

function ctoMinutesFromCallRow(row) {
  const candidates = [
    row?.call_duration,
    row?.duration_seconds,
    row?.duration,
    row?.metadata?.duration_seconds,
    row?.metadata?.call_duration,
    row?.raw_status_callback?.CallDuration,
    row?.metadata?.raw_status_callback?.CallDuration,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      if (n > 10) return Math.ceil(n / 60);
      return Math.ceil(n);
    }
  }
  return 0;
}

function ctoPickString(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function ctoRateKey(provider, service, eventType, unit) {
  return [provider || "*", service || "*", eventType || "*", unit || "*"]
    .map((v) => String(v || "*").toLowerCase())
    .join("|");
}

function ctoRateMatches(
  row,
  { provider, service, eventTypes = [], units = [] },
) {
  const p = String(row.provider || "").toLowerCase();
  const s = String(row.service || "").toLowerCase();
  const e = String(row.event_type || row.eventType || "").toLowerCase();
  const u = String(row.unit || "").toLowerCase();
  const wantedEvents = eventTypes
    .map((x) => String(x || "").toLowerCase())
    .filter(Boolean);
  const wantedUnits = units
    .map((x) => String(x || "").toLowerCase())
    .filter(Boolean);
  if (provider && p !== String(provider).toLowerCase() && p !== "*")
    return false;
  if (service && s !== String(service).toLowerCase() && s !== "*") return false;
  if (
    wantedEvents.length &&
    e !== "*" &&
    !wantedEvents.some((x) => e === x || e.includes(x) || x.includes(e))
  )
    return false;
  if (
    wantedUnits.length &&
    u !== "*" &&
    !wantedUnits.some((x) => u === x || u.includes(x) || x.includes(u))
  )
    return false;
  return true;
}

function ctoFindMaxRate(rateCards, spec, fallback = 0) {
  const matches = (rateCards || []).filter((row) => ctoRateMatches(row, spec));
  const values = matches
    .map((row) => ctoSafeNumber(row.unit_cost_usd ?? row.unitCostUsd, 0))
    .filter((n) => n > 0);
  return values.length ? Math.max(...values) : fallback;
}

async function ctoFetchRowsAndCount(
  sb,
  table,
  organizationId,
  { limit = 5000, orgColumn = "organization_id" } = {},
) {
  try {
    const max = Math.min(Math.max(Number(limit) || 5000, 1), 50000);
    const { data, error, count } = await sb
      .from(table)
      .select("*", { count: "exact" })
      .eq(orgColumn, organizationId)
      .limit(max);
    if (error) throw error;
    return {
      ok: true,
      table,
      rows: data || [],
      count: count ?? (data || []).length,
      sampled: (data || []).length,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      table,
      rows: [],
      count: 0,
      sampled: 0,
      error: err.message || String(err),
    };
  }
}

async function ctoFetchOrgProfile(sb, organizationId) {
  try {
    const { data, error } = await sb
      .from("organizations")
      .select("*")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw error;
    return data || { id: organizationId };
  } catch (err) {
    return { id: organizationId, warning: err.message || String(err) };
  }
}

async function ctoFetchActiveRateCards(sb) {
  try {
    const { data, error } = await sb
      .from("billing_rate_cards")
      .select(
        "id,provider,service,event_type,unit,unit_cost_usd,currency,effective_from,effective_to,source,metadata",
      )
      .limit(10000);
    if (error) throw error;
    return (data || []).filter(
      (row) => row.effective_to === null || row.effective_to === undefined,
    );
  } catch (_) {
    return [];
  }
}

function ctoSumProductionRows(rows, predicate, field) {
  return ctoRoundUsd(
    (rows || [])
      .filter(predicate)
      .reduce((sum, row) => sum + ctoSafeNumber(row[field], 0), 0),
  );
}

function ctoGroupByCategory(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = row.category || "uncategorized";
    if (!map.has(key)) {
      map.set(key, {
        category: key,
        customerChargedUsd: 0,
        exactInternalCostUsd: 0,
        grossProfitUsd: 0,
        usageQuantity: 0,
        eventCount: 0,
        billingStatus: new Set(),
      });
    }
    const item = map.get(key);
    item.customerChargedUsd += ctoSafeNumber(
      row.userBillOrWalletDeductionUsd,
      0,
    );
    item.exactInternalCostUsd += ctoSafeNumber(row.realInternalCostUsd, 0);
    item.grossProfitUsd += ctoSafeNumber(row.grossProfitUsd, 0);
    item.usageQuantity += ctoSafeNumber(row.usageQuantity, 0);
    item.eventCount += ctoSafeNumber(row.eventCount, 0);
    if (row.billingStatus) item.billingStatus.add(row.billingStatus);
  }
  return Array.from(map.values())
    .map((item) => ({
      category: item.category,
      customerChargedUsd: ctoRoundUsd(item.customerChargedUsd),
      exactInternalCostUsd: ctoRoundUsd(item.exactInternalCostUsd),
      grossProfitUsd: ctoRoundUsd(item.grossProfitUsd),
      usageQuantity: Math.round(item.usageQuantity * 1000000) / 1000000,
      eventCount: item.eventCount,
      billingStatus: Array.from(item.billingStatus).join("; "),
    }))
    .sort(
      (a, b) =>
        b.exactInternalCostUsd - a.exactInternalCostUsd ||
        b.customerChargedUsd - a.customerChargedUsd,
    );
}

function ctoStorageEstimateFromTables(tableResults) {
  let sampledBytes = 0;
  let estimatedBytes = 0;
  const tables = [];
  for (const result of tableResults || []) {
    if (!result.ok) {
      tables.push({
        table: result.table,
        rows: 0,
        sampled: 0,
        estimatedBytes: 0,
        estimatedMb: 0,
        error: result.error,
      });
      continue;
    }
    const bytes = ctoJsonBytes(result.rows);
    const sampled = Math.max(result.sampled || result.rows.length || 0, 1);
    const count = Number(result.count || result.rows.length || 0);
    const projected = count > sampled ? bytes * (count / sampled) : bytes;
    sampledBytes += bytes;
    estimatedBytes += projected;
    tables.push({
      table: result.table,
      rows: count,
      sampled: result.rows.length,
      sampledBytes: Math.round(bytes),
      estimatedBytes: Math.round(projected),
      estimatedMb: Math.round((projected / 1024 / 1024) * 1000) / 1000,
      error: null,
    });
  }
  return {
    sampledBytes: Math.round(sampledBytes),
    estimatedBytes: Math.round(estimatedBytes),
    estimatedMb: Math.round((estimatedBytes / 1024 / 1024) * 1000) / 1000,
    tables,
  };
}

function ctoBuildMarkdownReport(report) {
  const s = report.summary || {};
  const f = report.accountFootprint || {};
  const lines = [];
  lines.push(`# CTO Exact Cost Baseline Report`);
  lines.push("");
  lines.push(`Organization: ${report.organizationId}`);
  lines.push(
    `Period: ${report.period?.start || ""} to ${report.period?.end || ""}`,
  );
  lines.push("");
  lines.push(`## Executive summary`);
  lines.push("");
  lines.push(
    `- Exact recorded internal cost: **${ctoMoney(s.exactRecordedInternalCostUsd)}**`,
  );
  lines.push(
    `- Current customer billing already recorded: **${ctoMoney(s.customerBillingRecordedUsd)}**`,
  );
  lines.push(
    `- Exact usage ledger events: **${ctoNum(s.exactUsageEventCount)}**`,
  );
  lines.push(
    `- Exact customer charge rows: **${ctoNum(s.customerChargeRowCount)}**`,
  );
  lines.push(`- Profit/margin: **not calculated in this report**`);
  lines.push(`- Estimate policy: **${report.estimatePolicy || "exact_only"}**`);
  lines.push(
    `- Data confidence: **${report.dataConfidence?.level || "exact_ledger_only"}**`,
  );
  lines.push("");
  lines.push(
    `> This report is intentionally exact-only. It does not add estimated costs, suggested profits, markups, or margins to the real billing section.`,
  );
  lines.push("");
  lines.push(`## Account footprint`);
  lines.push("");
  lines.push(`- Phone numbers: ${ctoNum(f.phoneNumbers)}`);
  lines.push(`- Calls: ${ctoNum(f.calls)}`);
  lines.push(
    `- Call minutes from call records: ${ctoNum(f.callRecordMinutes)}`,
  );
  lines.push(
    `- Call minutes recorded in billing ledger: ${ctoNum(f.ledgerCallMinutes)}`,
  );
  lines.push(`- Leads: ${ctoNum(f.leads)}`);
  lines.push(`- Chatbots: ${ctoNum(f.chatbots)}`);
  lines.push(`- Chat messages/responses: ${ctoNum(f.chatMessages)}`);
  lines.push(`- Voice agents: ${ctoNum(f.voiceAgents)}`);
  lines.push(`- Knowledge bases: ${ctoNum(f.knowledgeBases)}`);
  lines.push(`- Knowledge sources: ${ctoNum(f.knowledgeSources)}`);
  lines.push(`- Knowledge chunks: ${ctoNum(f.knowledgeChunks)}`);
  lines.push(`- FAQs: ${ctoNum(f.faqs)}`);
  lines.push(`- Products: ${ctoNum(f.products)}`);
  lines.push(
    `- Current measured database footprint: ${ctoNum(report.storage?.measuredMb)} MB`,
  );
  lines.push("");
  lines.push(`## Exact cost buckets`);
  lines.push("");
  lines.push(
    `| Category | Customer Billing Recorded | Exact Internal Cost Recorded | Usage Qty | Events | Ledger Status | Notes |`,
  );
  lines.push(`|---|---:|---:|---:|---:|---|---|`);
  for (const row of report.costBuckets || []) {
    lines.push(
      `| ${row.category} | ${ctoMoney(row.customerBillingRecordedUsd)} | ${ctoMoney(row.exactInternalCostRecordedUsd)} | ${ctoNum(row.usageQuantity)} | ${ctoNum(row.eventCount)} | ${row.ledgerStatus || ""} | ${(row.notes || "").replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  lines.push(`## Phone numbers`);
  lines.push("");
  lines.push(`- Count: ${ctoNum(report.phoneNumbers?.count)}`);
  lines.push(
    `- Exact recorded purchase cost: ${ctoMoney(report.phoneNumbers?.exactRecordedPurchaseCostUsd)}`,
  );
  lines.push(
    `- Exact recorded rental cost: ${ctoMoney(report.phoneNumbers?.exactRecordedRentalCostUsd)}`,
  );
  lines.push("");
  if ((report.phoneNumbers?.numbers || []).length) {
    lines.push(
      `| Number | SID | Created | Exact Purchase Cost Recorded | Exact Rental Cost Recorded | Ledger Status |`,
    );
    lines.push(`|---|---|---|---:|---:|---|`);
    for (const n of report.phoneNumbers.numbers) {
      lines.push(
        `| ${n.phoneNumber || ""} | ${n.phoneSid || ""} | ${n.createdAt || ""} | ${ctoMoney(n.exactPurchaseCostRecordedUsd)} | ${ctoMoney(n.exactRentalCostRecordedUsd)} | ${n.ledgerStatus || ""} |`,
      );
    }
    lines.push("");
  }
  lines.push(`## Exact-data coverage status`);
  lines.push("");
  if ((report.exactDataCoverage || []).length) {
    lines.push(
      `| Area | Status | Current exact figure | Why this matters | Required action for real figure |`,
    );
    lines.push(`|---|---|---:|---|---|`);
    for (const item of report.exactDataCoverage) {
      lines.push(
        `| ${item.area} | ${item.status} | ${item.currentExactFigure || ""} | ${(item.reason || "").replace(/\|/g, "\\|")} | ${(item.requiredAction || "").replace(/\|/g, "\\|")} |`,
      );
    }
  } else {
    lines.push("No exact-data coverage rows returned.");
  }
  lines.push("");
  lines.push(`## Separate pricing model workspace`);
  lines.push("");
  lines.push(
    `This section is separate from real current billing. It is not applied to totals.`,
  );
  lines.push("");
  if ((report.pricingModelWorkspace?.rules || []).length) {
    lines.push(
      `| Service | Basis | Exact Internal Unit Cost | Markup/Profit % Placeholder | Simulated Customer Price | Active? |`,
    );
    lines.push(`|---|---|---:|---:|---:|---|`);
    for (const rule of report.pricingModelWorkspace.rules) {
      lines.push(
        `| ${rule.service} | ${rule.basis} | ${rule.exactInternalUnitCostUsd === null ? "" : ctoMoney(rule.exactInternalUnitCostUsd)} | ${rule.markupPercent === null ? "" : `${ctoNum(rule.markupPercent)}%`} | ${rule.simulatedCustomerUnitPriceUsd === null ? "" : ctoMoney(rule.simulatedCustomerUnitPriceUsd)} | ${rule.active ? "yes" : "no"} |`,
      );
    }
  } else {
    lines.push("No pricing model rules returned.");
  }
  lines.push("");
  lines.push(`## Notes`);
  lines.push("");
  lines.push(
    `- Exact cost comes only from recorded billing ledger/provider reconciliation events.`,
  );
  lines.push(
    `- If an asset exists but no provider usage/cost event was recorded, the report shows $0 exact cost and marks the area as needing reconciliation.`,
  );
  lines.push(
    `- Profit and final markup rules should be modeled later inside pricingModelWorkspace, not inside the real-cost baseline.`,
  );
  lines.push("");
  return lines.join("\n");
}

function ctoStatusForExactCost({
  assetCount = 0,
  exactCost = 0,
  eventCount = 0,
  observedQuantity = 0,
  ledgerQuantity = 0,
} = {}) {
  if (eventCount > 0 && exactCost > 0) return "exact_cost_recorded";
  if (eventCount > 0 && exactCost === 0)
    return "ledger_event_recorded_zero_cost";
  if (
    observedQuantity > 0 &&
    ledgerQuantity > 0 &&
    ledgerQuantity < observedQuantity
  )
    return "partial_ledger_coverage";
  if (assetCount > 0 || observedQuantity > 0)
    return "asset_or_usage_exists_no_exact_cost_recorded";
  return "no_usage_in_period";
}

function ctoComputeUnitCost(exactCost, quantity) {
  const q = ctoSafeNumber(quantity, 0);
  if (q <= 0) return null;
  return ctoRoundUsd(ctoSafeNumber(exactCost, 0) / q);
}

function ctoBuildPricingWorkspace({ costBuckets = [] } = {}) {
  const byCategory = new Map(
    (costBuckets || []).map((row) => [row.category, row]),
  );
  const rule = (service, category, basis, editableNotes = "") => {
    const row = byCategory.get(category) || {};
    return {
      service,
      category,
      basis,
      exactInternalUnitCostUsd: ctoComputeUnitCost(
        row.exactInternalCostRecordedUsd,
        row.usageQuantity,
      ),
      markupPercent: null,
      simulatedCustomerUnitPriceUsd: null,
      active: false,
      notes:
        editableNotes ||
        "Set markupPercent later; this does not affect current billing totals.",
    };
  };
  return {
    active: false,
    note: "Profit/markup modeling is intentionally separate from real billing. Fill markupPercent later per service; do not use this as actual cost.",
    rules: [
      rule(
        "inbound_calls",
        "calls.telephony",
        "per inbound billed minute",
        "Future CTO rule example: 50% markup on inbound calls.",
      ),
      rule(
        "outbound_calls",
        "calls.telephony",
        "per outbound billed minute",
        "Future CTO rule example: 70% markup on outbound calls.",
      ),
      rule(
        "extra_inbound_minutes",
        "calls.telephony",
        "per extra inbound minute",
        "Separate rule for extra inbound minutes.",
      ),
      rule(
        "extra_outbound_minutes",
        "calls.telephony",
        "per extra outbound minute",
        "Separate rule for extra outbound minutes.",
      ),
      rule(
        "chatbot_responses",
        "ai.openai_and_transcripts",
        "per chatbot response or token unit",
        "Future CTO rule example: 30% markup on chatbot response costs.",
      ),
      rule(
        "knowledge_base_storage",
        "knowledge.scraping",
        "per sync/source/chunk or storage unit",
        "Future CTO rule example: 70% markup on knowledge base/FAQ storage.",
      ),
      rule(
        "faq_storage",
        "knowledge.scraping",
        "per FAQ or storage unit",
        "Separate FAQ pricing model placeholder.",
      ),
      rule(
        "leads",
        "crm.leads",
        "per lead",
        "Future CTO rule example: 60% markup on leads.",
      ),
      rule(
        "voice_ai",
        "ai.elevenlabs_voice",
        "per voice unit",
        "Future CTO rule for ElevenLabs/voice usage.",
      ),
      rule(
        "openai_realtime",
        "ai.openai_and_transcripts",
        "per token/minute unit",
        "Future CTO rule for OpenAI realtime usage.",
      ),
      rule(
        "phone_number_purchase",
        "phone_numbers.purchase",
        "per number",
        "Future CTO setup fee rule for number procurement.",
      ),
      rule(
        "phone_number_rental",
        "phone_numbers.rental",
        "per number/month or number/day",
        "Future CTO monthly phone rental markup rule.",
      ),
      rule(
        "storage",
        "infrastructure.storage",
        "per stored byte/GB-month",
        "Future CTO storage markup rule.",
      ),
      rule(
        "runtime",
        "infrastructure.runtime",
        "per runtime second/minute",
        "Future CTO runtime markup rule.",
      ),
    ],
  };
}

async function buildCtoOrgCostBaseline({ organizationId, start, end } = {}) {
  const sb = getSupabase();
  const organization = await ctoFetchOrgProfile(sb, organizationId);
  const effectiveStart =
    start === "onboarding" || start === "from_onboarding"
      ? organization.created_at ||
        organization.inserted_at ||
        "1970-01-01T00:00:00.000Z"
      : start;
  const production = await getProductionCostRows({
    organizationId,
    start: effectiveStart,
    end,
    includeExpected: true,
  });

  const [
    phoneNumbersResult,
    callRecordsResult,
    leadsResult,
    knowledgeBasesResult,
    knowledgeSourcesResult,
    knowledgeChunksResult,
    faqsResult,
    productsResult,
    chatbotsResult,
    chatMessagesResult,
    voiceAgentsResult,
  ] = await Promise.all([
    ctoFetchRowsAndCount(sb, "twilio_phone_numbers", organizationId),
    ctoFetchRowsAndCount(sb, "call_records", organizationId),
    ctoFetchRowsAndCount(sb, "leads", organizationId),
    ctoFetchRowsAndCount(sb, "knowledge_bases", organizationId),
    ctoFetchRowsAndCount(sb, "knowledge_sources", organizationId),
    ctoFetchRowsAndCount(sb, "knowledge_chunks", organizationId),
    ctoFetchRowsAndCount(sb, "faqs", organizationId),
    ctoFetchRowsAndCount(sb, "scraped_products", organizationId),
    ctoFetchRowsAndCount(sb, "chatbots", organizationId),
    ctoFetchRowsAndCount(sb, "chat_messages", organizationId),
    ctoFetchRowsAndCount(sb, "voice_agents", organizationId),
  ]);

  const storage = ctoStorageEstimateFromTables([
    phoneNumbersResult,
    callRecordsResult,
    leadsResult,
    knowledgeBasesResult,
    knowledgeSourcesResult,
    knowledgeChunksResult,
    faqsResult,
    productsResult,
    chatbotsResult,
    chatMessagesResult,
    voiceAgentsResult,
  ]);

  const productionRows = production.rows || [];
  const exactByCategory = ctoGroupByCategory(productionRows);
  const exactInternalCostUsd = ctoRoundUsd(
    production.totals?.realInternalCostUsd || 0,
  );
  const customerBillingRecordedUsd = ctoRoundUsd(
    production.totals?.userBillOrWalletDeductionUsd || 0,
  );
  const exactUsageEventCount = ctoSafeNumber(
    production.totals?.eventCount,
    productionRows.reduce(
      (sum, row) => sum + ctoSafeNumber(row.eventCount, 0),
      0,
    ),
  );

  const exactPhonePurchase = ctoSumProductionRows(
    productionRows,
    (r) =>
      r.category === "phone_numbers.purchase" &&
      !String(r.eventType || "").includes("detected_no_ledger"),
    "realInternalCostUsd",
  );
  const exactPhoneRental = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "phone_numbers.rental",
    "realInternalCostUsd",
  );
  const callRecordMinutes = (callRecordsResult.rows || []).reduce(
    (sum, row) => sum + ctoMinutesFromCallRow(row),
    0,
  );
  const ledgerCallMinutes = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "calls.telephony",
    "usageQuantity",
  );
  const exactCallCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "calls.telephony",
    "realInternalCostUsd",
  );
  const exactOpenAiCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "ai.brain" || r.category === "calls.transcripts",
    "realInternalCostUsd",
  );
  const exactElevenLabsCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "ai.voice",
    "realInternalCostUsd",
  );
  const exactRuntimeCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "infrastructure.runtime",
    "realInternalCostUsd",
  );
  const exactStorageCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "infrastructure.storage",
    "realInternalCostUsd",
  );
  const exactDatabaseComputeCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "infrastructure.database_compute",
    "realInternalCostUsd",
  );
  const exactLeadCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "crm.leads",
    "realInternalCostUsd",
  );
  const exactKnowledgeCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "knowledge.scraping",
    "realInternalCostUsd",
  );
  const exactEmailCost = ctoSumProductionRows(
    productionRows,
    (r) => r.category === "messaging.email",
    "realInternalCostUsd",
  );

  const categoryRow = (
    category,
    assetCount,
    observedQuantity,
    ledgerQuantity,
    exactCost,
    notes,
    extraPredicate = null,
  ) => {
    const predicate = extraPredicate || ((r) => r.category === category);
    const eventCount = productionRows
      .filter(predicate)
      .reduce((sum, row) => sum + ctoSafeNumber(row.eventCount, 0), 0);
    const usageQuantity = productionRows
      .filter(predicate)
      .reduce((sum, row) => sum + ctoSafeNumber(row.usageQuantity, 0), 0);
    return {
      category,
      customerBillingRecordedUsd: ctoSumProductionRows(
        productionRows,
        predicate,
        "userBillOrWalletDeductionUsd",
      ),
      exactInternalCostRecordedUsd: ctoRoundUsd(exactCost),
      usageQuantity,
      observedQuantity,
      eventCount,
      ledgerStatus: ctoStatusForExactCost({
        assetCount,
        exactCost,
        eventCount,
        observedQuantity,
        ledgerQuantity,
      }),
      notes,
    };
  };

  const costBuckets = [
    categoryRow(
      "phone_numbers.purchase",
      phoneNumbersResult.count,
      phoneNumbersResult.count,
      0,
      exactPhonePurchase,
      `${ctoNum(phoneNumbersResult.count)} phone number asset(s). Exact cost only if procurement events were recorded.`,
    ),
    categoryRow(
      "phone_numbers.rental",
      phoneNumbersResult.count,
      phoneNumbersResult.count,
      0,
      exactPhoneRental,
      `${ctoNum(phoneNumbersResult.count)} phone number asset(s). Exact rental only if rental accrual events were recorded.`,
    ),
    categoryRow(
      "calls.telephony",
      callRecordsResult.count,
      callRecordMinutes,
      ledgerCallMinutes,
      exactCallCost,
      `${ctoNum(callRecordMinutes)} call-record minutes; ${ctoNum(ledgerCallMinutes)} minutes currently in exact billing ledger.`,
    ),
    categoryRow(
      "calls.recordings",
      callRecordsResult.count,
      callRecordMinutes,
      0,
      ctoSumProductionRows(
        productionRows,
        (r) => r.category === "calls.recordings",
        "realInternalCostUsd",
      ),
      "Exact recording cost only if recording usage/storage events were recorded.",
    ),
    categoryRow(
      "calls.transcripts",
      callRecordsResult.count,
      callRecordMinutes,
      0,
      ctoSumProductionRows(
        productionRows,
        (r) => r.category === "calls.transcripts",
        "realInternalCostUsd",
      ),
      "Exact transcript cost only if transcription events were recorded.",
    ),
    categoryRow(
      "ai.openai_and_transcripts",
      callRecordsResult.count + chatMessagesResult.count,
      callRecordsResult.count + chatMessagesResult.count,
      0,
      exactOpenAiCost,
      "Exact OpenAI cost only from token/transcription ledger events.",
      (r) => r.category === "ai.brain" || r.category === "calls.transcripts",
    ),
    categoryRow(
      "ai.elevenlabs_voice",
      callRecordsResult.count,
      callRecordsResult.count,
      0,
      exactElevenLabsCost,
      "Exact ElevenLabs cost only from voice synthesis/agent ledger events.",
      (r) => r.category === "ai.voice",
    ),
    categoryRow(
      "infrastructure.runtime",
      callRecordsResult.count,
      callRecordMinutes * 60,
      0,
      exactRuntimeCost,
      "Exact runtime cost only from runtime allocation/websocket events.",
    ),
    categoryRow(
      "infrastructure.storage",
      storage.estimatedBytes > 0 ? 1 : 0,
      storage.estimatedBytes,
      0,
      exactStorageCost,
      `${ctoNum(storage.estimatedMb)} MB current measured database footprint; cost is exact only if storage snapshot events exist.`,
    ),
    categoryRow(
      "infrastructure.database_compute",
      1,
      1,
      0,
      exactDatabaseComputeCost,
      "Exact database compute cost only from allocation/import events.",
    ),
    categoryRow(
      "crm.leads",
      leadsResult.count,
      leadsResult.count,
      0,
      exactLeadCost,
      `${ctoNum(leadsResult.count)} lead asset(s). Exact lead cost only if lead create/import events were recorded.`,
    ),
    categoryRow(
      "knowledge.scraping",
      knowledgeSourcesResult.count,
      knowledgeSourcesResult.count,
      0,
      exactKnowledgeCost,
      `${ctoNum(knowledgeSourcesResult.count)} source(s), ${ctoNum(knowledgeChunksResult.count)} chunk(s), ${ctoNum(faqsResult.count)} FAQ(s). Exact cost only if sync/storage events were recorded.`,
    ),
    categoryRow(
      "messaging.email",
      0,
      0,
      0,
      exactEmailCost,
      "Recorded through Resend/email ledger events where available.",
    ),
  ];

  const numbers = (phoneNumbersResult.rows || []).map((row) => {
    const phoneSid = ctoPickString(row, [
      "phone_sid",
      "sid",
      "twilio_phone_sid",
    ]);
    const phoneNumber = ctoPickString(row, [
      "phone_number",
      "number",
      "friendly_name",
      "display_phone_number",
    ]);
    return {
      id: row.id || null,
      phoneNumber,
      phoneSid,
      status:
        row.status || row.lifecycle_status || row.metadata?.status || null,
      createdAt:
        row.created_at || row.purchased_at || row.metadata?.created_at || null,
      assignedVoiceAgentId:
        row.assigned_voice_agent_id ||
        row.inbound_voice_agent_id ||
        row.default_outbound_voice_agent_id ||
        null,
      exactPurchaseCostRecordedUsd: 0,
      exactRentalCostRecordedUsd: 0,
      ledgerStatus: "asset_recorded_cost_not_itemized_per_number",
    };
  });

  const exactDataCoverage = [
    {
      area: "phone_numbers.purchase",
      status:
        exactPhonePurchase > 0
          ? "exact_cost_recorded"
          : phoneNumbersResult.count
            ? "needs_exact_reconciliation"
            : "no_phone_numbers",
      currentExactFigure: ctoMoney(exactPhonePurchase),
      reason:
        "Phone number assets exist, but exact procurement dollars must come from Twilio purchase/usage events or invoice backfill.",
      requiredAction:
        "Run/backfill Twilio number purchase reconciliation into billing_usage_events.",
    },
    {
      area: "phone_numbers.rental",
      status:
        exactPhoneRental > 0
          ? "exact_cost_recorded"
          : phoneNumbersResult.count
            ? "needs_exact_reconciliation"
            : "no_phone_numbers",
      currentExactFigure: ctoMoney(exactPhoneRental),
      reason:
        "Rental accrues over time and should be written as daily/monthly ledger events.",
      requiredAction: "Schedule/run Twilio number rental reconciliation.",
    },
    {
      area: "calls.telephony",
      status:
        ledgerCallMinutes >= callRecordMinutes && callRecordMinutes > 0
          ? "exact_coverage_complete"
          : ledgerCallMinutes > 0
            ? "partial_exact_coverage"
            : "needs_exact_reconciliation",
      currentExactFigure: `${ctoMoney(exactCallCost)} / ${ctoNum(ledgerCallMinutes)} ledger minute(s)`,
      reason: `${ctoNum(callRecordMinutes)} minutes exist in call_records; ${ctoNum(ledgerCallMinutes)} minutes exist in billing ledger.`,
      requiredAction:
        "Backfill/reconcile Twilio call usage for missing historical call minutes.",
    },
    {
      area: "openai.realtime_and_transcripts",
      status:
        exactOpenAiCost > 0
          ? "exact_cost_recorded"
          : callRecordsResult.count || chatMessagesResult.count
            ? "needs_exact_usage_events"
            : "no_usage",
      currentExactFigure: ctoMoney(exactOpenAiCost),
      reason:
        "OpenAI exact dollars require token/transcription usage ledger events.",
      requiredAction:
        "Ensure runtime token metering is on and backfill provider usage where available.",
    },
    {
      area: "elevenlabs.voice",
      status:
        exactElevenLabsCost > 0
          ? "exact_cost_recorded"
          : callRecordsResult.count
            ? "needs_exact_usage_events"
            : "no_usage",
      currentExactFigure: ctoMoney(exactElevenLabsCost),
      reason:
        "ElevenLabs exact dollars require voice synthesis/agent usage ledger events.",
      requiredAction:
        "Enable/reconcile ElevenLabs usage into billing_usage_events.",
    },
    {
      area: "railway.runtime",
      status:
        exactRuntimeCost > 0
          ? "exact_cost_recorded"
          : callRecordsResult.count
            ? "needs_runtime_allocation_events"
            : "no_usage",
      currentExactFigure: ctoMoney(exactRuntimeCost),
      reason:
        "Runtime exact dollars require websocket/runtime allocation events.",
      requiredAction: "Run/schedule Railway/runtime allocation reconciliation.",
    },
    {
      area: "supabase.storage",
      status:
        exactStorageCost > 0
          ? "exact_cost_recorded"
          : storage.estimatedBytes > 0
            ? "needs_storage_snapshot_events"
            : "no_storage_footprint",
      currentExactFigure: `${ctoMoney(exactStorageCost)} / ${ctoNum(storage.estimatedMb)} MB measured footprint`,
      reason:
        "Measured footprint is not the same as exact historical storage cost.",
      requiredAction:
        "Schedule daily storage snapshots and cost ledger events.",
    },
    {
      area: "crm.leads",
      status:
        exactLeadCost > 0
          ? "exact_cost_recorded"
          : leadsResult.count
            ? "needs_lead_events"
            : "no_leads",
      currentExactFigure: ctoMoney(exactLeadCost),
      reason:
        "Lead count exists, but cost is exact only when lead create/import ledger rows exist.",
      requiredAction: "Run leads storage/create/import reconciliation.",
    },
    {
      area: "knowledge.scraping_and_storage",
      status:
        exactKnowledgeCost > 0
          ? "exact_cost_recorded"
          : knowledgeSourcesResult.count
            ? "needs_sync_events"
            : "no_knowledge_sources",
      currentExactFigure: ctoMoney(exactKnowledgeCost),
      reason:
        "Sources/chunks/FAQs exist, but exact cost requires per-sync/snapshot ledger rows.",
      requiredAction:
        "Run knowledge sync cost reconciliation and ensure scrapeAndStore meters every sync.",
    },
  ];

  const summary = {
    exactRecordedInternalCostUsd: exactInternalCostUsd,
    customerBillingRecordedUsd,
    exactUsageEventCount,
    customerChargeRowCount: productionRows.reduce(
      (sum, row) => sum + ctoSafeNumber(row.eventCount, 0),
      0,
    ),
    profitOrMarginCalculated: false,
    pricingSimulationApplied: false,
  };

  return {
    ok: true,
    source: "cto_org_exact_cost_baseline_v63",
    organizationId,
    period: { start: effectiveStart, end },
    estimatePolicy: "exact_only_no_estimates_no_profit_margin",
    organization: {
      id: organization.id || organizationId,
      name:
        organization.name ||
        organization.business_name ||
        organization.company_name ||
        null,
      plan:
        organization.plan ||
        organization.plan_key ||
        organization.billing_plan ||
        null,
      createdAt: organization.created_at || null,
      timezone: organization.timezone || null,
    },
    dataConfidence: {
      level: exactDataCoverage.some(
        (row) =>
          String(row.status || "").includes("needs") ||
          String(row.status || "").includes("partial"),
      )
        ? "exact_ledger_with_reconciliation_gaps"
        : "exact_ledger_complete_for_available_assets",
      exactSourceOfTruth:
        "billing_usage_events + billing_customer_usage_charges + billing_wallet_transactions + exact reconciliation events",
      estimatesIncludedInCostTotals: false,
      profitIncludedInCostTotals: false,
      reconciliationGapCount: exactDataCoverage.filter(
        (row) =>
          String(row.status || "").includes("needs") ||
          String(row.status || "").includes("partial"),
      ).length,
    },
    summary,
    accountFootprint: {
      phoneNumbers: phoneNumbersResult.count,
      calls: callRecordsResult.count,
      callRecordMinutes,
      ledgerCallMinutes,
      leads: leadsResult.count,
      chatbots: chatbotsResult.count,
      chatMessages: chatMessagesResult.count,
      voiceAgents: voiceAgentsResult.count,
      knowledgeBases: knowledgeBasesResult.count,
      knowledgeSources: knowledgeSourcesResult.count,
      knowledgeChunks: knowledgeChunksResult.count,
      faqs: faqsResult.count,
      products: productsResult.count,
    },
    phoneNumbers: {
      count: phoneNumbersResult.count,
      exactRecordedPurchaseCostUsd: exactPhonePurchase,
      exactRecordedRentalCostUsd: exactPhoneRental,
      numbers,
    },
    twilio: {
      exactRecordedCostUsd: ctoRoundUsd(
        exactCallCost + exactPhonePurchase + exactPhoneRental,
      ),
      exactRecordedPhonePurchaseUsd: exactPhonePurchase,
      exactRecordedPhoneRentalUsd: exactPhoneRental,
      exactRecordedCallCostUsd: exactCallCost,
      callRecordCount: callRecordsResult.count,
      callRecordMinutes,
      ledgerCallMinutes,
      callMinutesNotYetInLedger: Math.max(
        0,
        callRecordMinutes - ledgerCallMinutes,
      ),
    },
    ai: {
      exactRecordedOpenAiAndTranscriptCostUsd: exactOpenAiCost,
      exactRecordedElevenLabsCostUsd: exactElevenLabsCost,
      chatbotMessageCount: chatMessagesResult.count,
      callCount: callRecordsResult.count,
    },
    infrastructure: {
      exactRecordedRuntimeCostUsd: exactRuntimeCost,
      exactRecordedStorageCostUsd: exactStorageCost,
      exactRecordedDatabaseComputeCostUsd: exactDatabaseComputeCost,
    },
    storage: {
      measuredBytes: storage.estimatedBytes,
      measuredMb: storage.estimatedMb,
      tables: storage.tables,
    },
    knowledge: {
      bases: knowledgeBasesResult.count,
      sources: knowledgeSourcesResult.count,
      chunks: knowledgeChunksResult.count,
      faqs: faqsResult.count,
      products: productsResult.count,
      exactRecordedCostUsd: exactKnowledgeCost,
    },
    crm: {
      leads: leadsResult.count,
      exactRecordedCostUsd: exactLeadCost,
    },
    exactLedgerByCategory: exactByCategory,
    costBuckets,
    exactDataCoverage,
    pricingModelWorkspace: ctoBuildPricingWorkspace({ costBuckets }),
    rawTableReadErrors: [
      phoneNumbersResult,
      callRecordsResult,
      leadsResult,
      knowledgeBasesResult,
      knowledgeSourcesResult,
      knowledgeChunksResult,
      faqsResult,
      productsResult,
      chatbotsResult,
      chatMessagesResult,
      voiceAgentsResult,
    ]
      .filter((r) => !r.ok)
      .map((r) => ({ table: r.table, error: r.error })),
    nextExactDataActions: exactDataCoverage
      .filter(
        (row) =>
          String(row.status || "").includes("needs") ||
          String(row.status || "").includes("partial"),
      )
      .map((row) => ({ area: row.area, action: row.requiredAction })),
  };
}

router.use(requireInternalBillingAccess);

router.get("/plans", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_plan_settings")
      .select("*")
      .order("monthly_price_usd", { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({
      source: "billing_admin_plan_settings",
      mainPlanTable: "billing_plan_catalog",
      note: "Edit billing_plan_catalog.included_usage, or use PATCH /api/billing-usage/plans/:planKey. All plan-limit views read from this table.",
      plans: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/plans/:planKey", async (req, res, next) => {
  try {
    const planKey = String(req.params.planKey || "")
      .trim()
      .toLowerCase();
    if (!planKey) {
      return res
        .status(400)
        .json({ error: { message: "planKey is required." } });
    }

    const body = req.body || {};
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_update_plan_limits", {
      p_plan_key: planKey,
      p_monthly_price_usd:
        body.monthlyPriceUsd === undefined &&
        body.monthly_price_usd === undefined
          ? null
          : Number(body.monthlyPriceUsd ?? body.monthly_price_usd),
      p_included_usage_patch: body.includedUsage || body.included_usage || {},
      p_overage_rates_patch: body.overageRates || body.overage_rates || {},
      p_display_name: body.displayName || body.display_name || null,
      p_metadata_patch: body.metadata || {},
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_update_plan_limits",
      plan: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/user-usage", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_user_usage_overview").select("*");
    const userId = cleanOrgId(req.query.userId || req.query.user_id);
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const email = String(
      req.query.email || req.query.userEmail || req.query.user_email || "",
    ).trim();

    if (userId) query = query.eq("user_id", userId);
    if (organizationId) query = query.eq("organization_id", organizationId);
    if (email) query = query.ilike("user_email", `%${email}%`);

    const { data, error } = await query
      .order("org_estimated_cost_usd", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_user_usage_overview",
      count: (data || []).length,
      rows: data || [],
      exampleQueries: {
        byEmail: "GET /api/billing-usage/user-usage?email=customer@example.com",
        byUserId: "GET /api/billing-usage/user-usage?userId=USER_UUID",
        byOrganization:
          "GET /api/billing-usage/user-usage?organizationId=ORG_UUID",
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/danger-zone/preview-deletion", async (req, res, next) => {
  try {
    const body = req.body || {};
    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_preview_user_or_org_deletion",
      {
        p_user_id: body.userId || body.user_id || null,
        p_user_email: body.userEmail || body.user_email || body.email || null,
        p_organization_id: body.organizationId || body.organization_id || null,
        p_delete_scope: body.deleteScope || body.delete_scope || "user",
      },
    );
    if (error) throw error;
    res.json({
      ok: true,
      warning: "Preview only. No rows were deleted.",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post("/danger-zone/delete", async (req, res, next) => {
  try {
    const body = req.body || {};
    const deleteScope = String(
      body.deleteScope || body.delete_scope || "user",
    ).toLowerCase();
    const requiredConfirm =
      deleteScope === "organization"
        ? "DELETE_ORGANIZATION_DATA"
        : "DELETE_USER_DATA";
    if (String(body.confirm || "") !== requiredConfirm) {
      return res.status(400).json({
        error: {
          message: `Refusing destructive delete. First run /danger-zone/preview-deletion, then pass confirm=${requiredConfirm}.`,
        },
      });
    }

    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_delete_user_or_org_everything",
      {
        p_user_id: body.userId || body.user_id || null,
        p_user_email: body.userEmail || body.user_email || body.email || null,
        p_organization_id: body.organizationId || body.organization_id || null,
        p_delete_scope: deleteScope,
        p_confirm: requiredConfirm,
      },
    );
    if (error) throw error;
    res.json({
      ok: true,
      warning:
        "Destructive delete executed. Review returned errors array if any.",
      result: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    const summary = await summarizeUsage({
      organizationId: cleanOrgId(
        req.query.organizationId || req.query.organization_id,
      ),
      start: req.query.start || null,
      end: req.query.end || null,
      includeUnassigned: parseBool(req.query.includeUnassigned),
    });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/tenant-report", async (req, res, next) => {
  try {
    const report = await buildTenantUsageReport({
      organizationId: cleanOrgId(
        req.query.organizationId || req.query.organization_id,
      ),
      start: req.query.start || null,
      end: req.query.end || null,
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.get("/admin-overview", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_tenant_usage")
      .select("*")
      .order("estimated_cost_usd", { ascending: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) {
      const fallback = await buildTenantUsageReport({
        organizationId,
        start: req.query.start || null,
        end: req.query.end || null,
      });
      return res.json({
        source: "buildTenantUsageReport_fallback",
        warning:
          "billing_admin_tenant_usage view could not be read. Run billing-admin-usage-query-pack.sql after billing-admin-tenant-usage-view.sql.",
        error: error.message,
        ...fallback,
      });
    }
    res.json({
      source: "billing_admin_tenant_usage",
      count: (data || []).length,
      tenants: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/provider-breakdown", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_usage_events")
      .select(
        "provider,service,event_type,unit,quantity,estimated_cost_usd,billable,occurred_at",
      )
      .eq("organization_id", organizationId)
      .gte("occurred_at", req.query.start || "1970-01-01")
      .lte("occurred_at", req.query.end || new Date().toISOString())
      .limit(50000);
    if (error) throw error;

    const totals = new Map();
    for (const row of data || []) {
      const key = [
        row.provider,
        row.service,
        row.event_type,
        row.unit || "unit",
        row.billable === false ? "non_billable" : "billable",
      ].join("|");
      if (!totals.has(key)) {
        totals.set(key, {
          organizationId,
          provider: row.provider,
          service: row.service,
          eventType: row.event_type,
          unit: row.unit,
          billable: row.billable !== false,
          quantity: 0,
          estimatedCostUsd: 0,
          events: 0,
          latestUsageAt: null,
        });
      }
      const item = totals.get(key);
      item.quantity += Number(row.quantity || 0);
      item.estimatedCostUsd += Number(row.estimated_cost_usd || 0);
      item.events += 1;
      if (
        !item.latestUsageAt ||
        String(row.occurred_at) > String(item.latestUsageAt)
      )
        item.latestUsageAt = row.occurred_at;
    }
    res.json({
      organizationId,
      start: req.query.start || null,
      end: req.query.end || null,
      breakdown: Array.from(totals.values()).sort(
        (a, b) => (b.estimatedCostUsd || 0) - (a.estimatedCostUsd || 0),
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/events", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_usage_events")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (organizationId) query = query.eq("organization_id", organizationId);
    if (!organizationId && !parseBool(req.query.includeUnassigned))
      query = query.not("organization_id", "is", null);
    if (req.query.provider) query = query.eq("provider", req.query.provider);
    if (req.query.service) query = query.eq("service", req.query.service);
    if (req.query.start) query = query.gte("occurred_at", req.query.start);
    if (req.query.end) query = query.lte("occurred_at", req.query.end);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post("/events", async (req, res, next) => {
  try {
    const event = req.body || {};
    if (!event.provider || !event.service) {
      return res
        .status(400)
        .json({ error: { message: "provider and service are required." } });
    }
    const inserted = await insertUsageEvent({
      ...event,
      organizationId: cleanOrgId(event.organizationId || event.organization_id),
      source: event.source || "internal_manual_backend_event",
    });
    res.status(201).json({ ok: true, event: inserted });
  } catch (err) {
    next(err);
  }
});

router.post("/resources", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id,
    );
    if (
      !organizationId ||
      !body.provider ||
      !body.resourceType ||
      !body.externalId
    ) {
      return res.status(400).json({
        error: {
          message:
            "organizationId, provider, resourceType, and externalId are required.",
        },
      });
    }
    const resource = await upsertProviderResource({
      organizationId,
      provider: body.provider,
      resourceType: body.resourceType,
      externalId: body.externalId,
      displayValue: body.displayValue,
      metadata: body.metadata || {},
    });
    res.status(201).json({ ok: true, resource });
  } catch (err) {
    next(err);
  }
});

router.post("/resources/sync-twilio", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to sync provider resources.",
        },
      });
    }
    const result = await syncTwilioProviderResources({
      organizationId: cleanOrgId(
        req.body?.organizationId ||
          req.query.organizationId ||
          req.body?.organization_id,
      ),
      limit: req.body?.limit || req.query.limit || 1000,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/smoke-test-event", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const event = await insertUsageEvent({
      organizationId,
      userId: body.userId || body.user_id || null,
      provider: "agently",
      service: "billing_verification",
      eventType: "smoke_test_event",
      source: "internal_billing_smoke_test",
      externalId: body.externalId || `smoke-${Date.now()}`,
      idempotencyKey: body.idempotencyKey || body.idempotency_key || null,
      unit: "event",
      quantity: 1,
      unitCostUsd: 0,
      estimatedCostUsd: 0,
      billable: false,
      metadata: {
        purpose:
          "Verifies record_billing_usage_event and billing_usage_events ingestion without charging the tenant.",
        manually_triggered: true,
        ...(body.metadata || {}),
      },
    });
    res.status(201).json({
      ok: true,
      message:
        "Smoke test billing event recorded. It is non-billable and zero-cost.",
      event,
      checkQueries: {
        rawEvents:
          "SELECT * FROM public.billing_admin_usage_event_audit WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY occurred_at DESC LIMIT 20;",
        health: "SELECT * FROM public.billing_admin_usage_health;",
        orgHealth:
          "SELECT * FROM public.billing_admin_org_cost_health WHERE organization_id = 'YOUR_ORG_UUID';",
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/usage-health", async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_usage_health")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    res.json({ source: "billing_admin_usage_health", health: data || null });
  } catch (err) {
    next(err);
  }
});

router.get("/org-cost-health", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_org_cost_health")
      .select("*")
      .order("estimated_cost_usd", { ascending: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_org_cost_health",
      count: (data || []).length,
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/twilio", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable it.",
        },
      });
    }

    const mode = String(
      req.body?.mode || req.query.mode || "calls",
    ).toLowerCase();
    const accountSid = req.body?.accountSid || req.query.accountSid || null;
    const startDate = req.body?.startDate || req.query.startDate || null;
    const endDate = req.body?.endDate || req.query.endDate || null;

    const result =
      mode === "account_usage" || mode === "usage_records"
        ? await reconcileTwilioAccountUsage({ accountSid, startDate, endDate })
        : await reconcileTwilioCallRecords({ accountSid, startDate, endDate });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/storage", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.body?.organizationId ||
        req.query.organizationId ||
        req.body?.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const result = await estimateTenantStorageBytes(organizationId);
    res.json({ ok: true, storage: result });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/storage-all", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable it.",
        },
      });
    }
    const organizationId = cleanOrgId(
      req.body?.organizationId ||
        req.query.organizationId ||
        req.body?.organization_id,
    );
    const limit = Math.min(
      Math.max(Number(req.body?.limit || req.query.limit) || 500, 1),
      1000,
    );
    const result = await estimateAllTenantStorageBytes({
      organizationId,
      limit,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/rollups/daily", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable rollup rebuilds.",
        },
      });
    }
    const result = await rebuildDailyUsageRollups({
      organizationId: cleanOrgId(
        req.body?.organizationId ||
          req.query.organizationId ||
          req.body?.organization_id,
      ),
      start: req.body?.start || req.query.start || null,
      end: req.body?.end || req.query.end || null,
    });
    res.json({ ok: true, rollup: result });
  } catch (err) {
    next(err);
  }
});

router.post("/costs/recalculate", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage cost recalculation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable it.",
        },
      });
    }
    const result = await recalculateUsageEventCosts({
      organizationId: cleanOrgId(
        req.body?.organizationId ||
          req.query.organizationId ||
          req.body?.organization_id,
      ),
      start: req.body?.start || req.query.start || null,
      end: req.body?.end || req.query.end || null,
      limit: req.body?.limit || req.query.limit || 5000,
      force: parseBool(req.body?.force || req.query.force),
    });
    res.json({ ok: true, recalculation: result });
  } catch (err) {
    next(err);
  }
});

router.get("/plan-cost-overview", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_plan_cost_overview")
      .select("*")
      .order("estimated_margin_usd", { ascending: true, nullsFirst: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_plan_cost_overview",
      count: (data || []).length,
      tenants: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/plan-limit-overview", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_plan_limit_overview")
      .select("*")
      .order("estimated_margin_usd", { ascending: true, nullsFirst: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_plan_limit_overview",
      count: (data || []).length,
      tenants: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/limit-status", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const status = await getPlanLimitStatus({ organizationId });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

router.post("/limit-snapshot", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.body?.organizationId ||
        req.query.organizationId ||
        req.body?.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const status = await createPlanLimitSnapshot({
      organizationId,
      reason: req.body?.reason || req.query.reason || "manual_admin_snapshot",
      metadata: req.body?.metadata || {},
    });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

router.get("/rate-coverage", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_rate_card_coverage")
      .select("*")
      .order("unrated_event_count", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ source: "billing_admin_rate_card_coverage", rows: data || [] });
  } catch (err) {
    next(err);
  }
});

router.get("/production-cost-catalog", async (_req, res, next) => {
  try {
    res.json({
      source: "static_runtime_catalog_v53",
      note: "This catalog defines every production-cost service Agently should meter. It does not expose vendor secrets or raw invoices to tenants.",
      categories: getProductionCatalog(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/production-cost-summary", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const range = dateRangeFromRequest(req);
    const includeExpected =
      req.query.includeExpected === undefined
        ? true
        : parseBool(req.query.includeExpected);
    const report = await getProductionCostRows({
      organizationId,
      start: range.start,
      end: range.end,
      includeExpected,
    });
    res.json({
      ok: true,
      source:
        "billing_usage_events + billing_customer_usage_charges + billing_wallet_transactions + provider fallback tables",
      organizationId,
      period: range,
      ...report,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/org-cost-baseline", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId ||
        req.query.organization_id ||
        req.query.orgId ||
        req.query.org_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const end = req.query.end || new Date().toISOString();
    let start = req.query.start || req.query.from || null;
    if (!start && req.query.hours) {
      start = new Date(
        new Date(end).getTime() -
          Math.max(Number(req.query.hours) || 87600, 1) * 60 * 60 * 1000,
      ).toISOString();
    } else if (
      !start ||
      ["onboarding", "all", "all_time", "from_onboarding"].includes(
        String(start).toLowerCase(),
      )
    ) {
      start = "onboarding";
    }
    if (start !== "onboarding" && Number.isNaN(new Date(start).getTime())) {
      start = new Date(
        new Date(end).getTime() -
          Math.max(Number(req.query.hours) || 87600, 1) * 60 * 60 * 1000,
      ).toISOString();
    }
    const report = await buildCtoOrgCostBaseline({
      organizationId,
      start,
      end,
    });
    const format = String(req.query.format || "json").toLowerCase();
    if (["md", "markdown", "text"].includes(format)) {
      res.type("text/markdown").send(ctoBuildMarkdownReport(report));
      return;
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.post("/record/twilio-number-purchase", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id,
    );
    if (
      !organizationId ||
      (!body.phoneSid &&
        !body.phone_sid &&
        !body.phoneNumber &&
        !body.phone_number)
    ) {
      return res.status(400).json({
        error: {
          message: "organizationId and phoneSid or phoneNumber are required.",
        },
      });
    }
    const phoneSid = body.phoneSid || body.phone_sid || null;
    const phoneNumber = body.phoneNumber || body.phone_number || null;
    const externalId = phoneSid || phoneNumber;
    const event = await insertUsageEvent({
      organizationId,
      provider: "twilio",
      service: "phone_number",
      eventType: body.eventType || body.event_type || "number_purchase",
      source: "twilio_number_purchase_endpoint",
      externalId,
      voiceAgentId: cleanOrgId(body.voiceAgentId || body.voice_agent_id),
      unit: "number",
      quantity: 1,
      estimatedCostUsd:
        body.internalCostUsd ??
        body.internal_cost_usd ??
        body.twilioCostUsd ??
        body.twilio_cost_usd ??
        null,
      metadata: {
        phone_sid: phoneSid,
        phone_number: phoneNumber,
        customer_charge_usd:
          body.customerChargeUsd ?? body.customer_charge_usd ?? null,
        note: "Customer charge is applied by billing_admin_charge_usage_event/customer rate cards after the usage event is recorded.",
        ...(body.metadata || {}),
      },
    });
    res.status(201).json({ ok: true, event });
  } catch (err) {
    next(err);
  }
});

router.post("/record/knowledge-sync-cost", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const rows = [];
    if (body.pages || body.pageCount || body.page_count) {
      rows.push(
        await insertUsageEvent({
          organizationId,
          provider: "knowledge_base",
          service: "scrape_sync",
          eventType: "pages_scraped",
          source: "knowledge_sync_endpoint",
          knowledgeBaseId: cleanOrgId(
            body.knowledgeBaseId || body.knowledge_base_id,
          ),
          unit: "pages",
          quantity: Number(body.pages ?? body.pageCount ?? body.page_count),
          metadata: body.metadata || {},
        }),
      );
    }
    if (body.chunks || body.chunkCount || body.chunk_count) {
      rows.push(
        await insertUsageEvent({
          organizationId,
          provider: "knowledge_base",
          service: "scrape_sync",
          eventType: "chunks_stored",
          source: "knowledge_sync_endpoint",
          knowledgeBaseId: cleanOrgId(
            body.knowledgeBaseId || body.knowledge_base_id,
          ),
          unit: "chunks",
          quantity: Number(body.chunks ?? body.chunkCount ?? body.chunk_count),
          metadata: body.metadata || {},
        }),
      );
    }
    if (body.storageBytes || body.storage_bytes) {
      rows.push(
        await insertUsageEvent({
          organizationId,
          provider: "supabase",
          service: "storage",
          eventType: "knowledge_sync_storage_bytes",
          source: "knowledge_sync_endpoint",
          knowledgeBaseId: cleanOrgId(
            body.knowledgeBaseId || body.knowledge_base_id,
          ),
          unit: "bytes",
          quantity: Number(body.storageBytes ?? body.storage_bytes),
          metadata: body.metadata || {},
        }),
      );
    }
    if (
      body.openaiTokens ||
      body.openai_tokens ||
      body.embeddingTokens ||
      body.embedding_tokens
    ) {
      rows.push(
        await insertUsageEvent({
          organizationId,
          provider: "openai",
          service: "embeddings",
          eventType: "knowledge_sync_embedding_tokens",
          source: "knowledge_sync_endpoint",
          knowledgeBaseId: cleanOrgId(
            body.knowledgeBaseId || body.knowledge_base_id,
          ),
          unit: "tokens",
          quantity: Number(
            body.openaiTokens ??
              body.openai_tokens ??
              body.embeddingTokens ??
              body.embedding_tokens,
          ),
          metadata: body.metadata || {},
        }),
      );
    }
    res.status(201).json({ ok: true, events: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

router.post("/record/railway-runtime", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const seconds = Number(
      body.seconds ?? body.runtimeSeconds ?? body.runtime_seconds ?? 0,
    );
    const event = await insertUsageEvent({
      organizationId,
      provider: "railway",
      service: body.service || "runtime",
      eventType: body.eventType || body.event_type || "websocket_runtime",
      source: "railway_runtime_endpoint",
      externalId:
        body.externalId ||
        body.external_id ||
        body.deploymentId ||
        body.deployment_id ||
        null,
      callId: cleanOrgId(body.callId || body.call_id),
      voiceAgentId: cleanOrgId(body.voiceAgentId || body.voice_agent_id),
      unit: "seconds",
      quantity: seconds,
      estimatedCostUsd: body.internalCostUsd ?? body.internal_cost_usd ?? null,
      metadata: {
        service_name: body.serviceName || body.service_name || null,
        ...(body.metadata || {}),
      },
    });
    res.status(201).json({ ok: true, event });
  } catch (err) {
    next(err);
  }
});

router.get("/production-cost-live-check", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const hours = Number(req.query.hours || 24);
    const result = await liveBillingCoverageCheck({ organizationId, hours });
    res.json({
      ok: true,
      source: "v60_live_billing_coverage_checker",
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/twilio-recordings", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const range = dateRangeFromRequest(req);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("call_records")
      .select(
        "id,organization_id,voice_agent_id,twilio_call_sid,recording_sid,recording_duration,recording_available,recording_file_size,recording_storage_provider,recording_storage_path,recording_public_url,created_at,updated_at",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", range.start)
      .lte("created_at", range.end)
      .limit(5000);
    if (error) throw error;
    const events = [];
    for (const row of data || []) {
      const minutes = minutesFromSecondsOrMinutes({
        seconds: row.recording_duration,
      });
      if (
        !minutes &&
        !Number(row.recording_file_size || 0) &&
        !row.recording_available
      )
        continue;
      const rows = await logRecordingUsage({
        organizationId,
        provider: "twilio",
        minutes,
        storageBytes: Number(row.recording_file_size || 0),
        callId: row.id,
        voiceAgentId: row.voice_agent_id,
        recordingSid: row.recording_sid || row.twilio_call_sid,
        externalId: row.recording_sid || row.twilio_call_sid,
        storageProvider: row.recording_storage_provider || "supabase",
        metadata: {
          source_table: "call_records",
          recording_available: row.recording_available,
          recording_storage_path: row.recording_storage_path || null,
          recording_public_url: row.recording_public_url || null,
        },
      });
      events.push(...rows);
    }
    res.json({
      ok: true,
      organizationId,
      period: range,
      scanned: (data || []).length,
      eventsCreated: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/transcripts", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const range = dateRangeFromRequest(req);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("call_records")
      .select(
        "id,organization_id,voice_agent_id,twilio_call_sid,transcript,duration,call_duration,transcription_provider,transcription_status,transcription_error,created_at",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", range.start)
      .lte("created_at", range.end)
      .limit(5000);
    if (error) throw error;
    const events = [];
    for (const row of data || []) {
      const bytes = estimatePayloadBytes(row.transcript || []);
      const hasTranscript =
        bytes > 2 ||
        String(row.transcription_status || "")
          .toLowerCase()
          .includes("complete");
      if (!hasTranscript) continue;
      const minutes = minutesFromSecondsOrMinutes({
        seconds: row.call_duration || row.duration,
      });
      const rows = await logTranscriptUsage({
        organizationId,
        provider: row.transcription_provider || "openai",
        minutes,
        storageBytes: bytes,
        callId: row.id,
        voiceAgentId: row.voice_agent_id,
        externalId: row.twilio_call_sid || row.id,
        metadata: {
          transcription_status: row.transcription_status || null,
          source_table: "call_records",
        },
      });
      events.push(...rows);
    }
    res.json({
      ok: true,
      organizationId,
      period: range,
      scanned: (data || []).length,
      eventsCreated: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/twilio-number-rentals", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const daily = body.daily !== false;
    const sb = getSupabase();
    const { data: numbers } = await sb
      .from("twilio_phone_numbers")
      .select(
        "id,phone_number,phone_sid,created_at,metadata,assigned_voice_agent_id,inbound_voice_agent_id,default_outbound_voice_agent_id",
      )
      .eq("organization_id", organizationId)
      .limit(5000);
    const { data: agents } = await sb
      .from("voice_agents")
      .select(
        "id,name,twilio_phone_number,twilio_phone_sid,twilio_monthly_rental_usd",
      )
      .eq("organization_id", organizationId)
      .gt("twilio_monthly_rental_usd", 0)
      .limit(5000);
    const rentals = new Map();
    for (const n of numbers || []) {
      const monthly = toUsd(
        n.metadata?.monthly_rental_usd ??
          n.metadata?.twilio_monthly_rental_usd ??
          n.metadata?.rental_usd,
        null,
      );
      rentals.set(n.phone_sid || n.phone_number || n.id, {
        phoneNumber: n.phone_number,
        phoneSid: n.phone_sid,
        monthlyRentalUsd: monthly,
        voiceAgentId:
          n.assigned_voice_agent_id ||
          n.inbound_voice_agent_id ||
          n.default_outbound_voice_agent_id ||
          null,
        source: "twilio_phone_numbers",
      });
    }
    for (const a of agents || []) {
      const key = a.twilio_phone_sid || a.twilio_phone_number || a.id;
      if (!rentals.has(key) || rentals.get(key).monthlyRentalUsd == null) {
        rentals.set(key, {
          phoneNumber: a.twilio_phone_number,
          phoneSid: a.twilio_phone_sid,
          monthlyRentalUsd: toUsd(a.twilio_monthly_rental_usd, null),
          voiceAgentId: a.id,
          source: "voice_agents",
        });
      }
    }
    const events = [];
    for (const r of rentals.values()) {
      const quantity = daily ? 1 : 1;
      const unit = daily ? "number_day" : "number_month";
      const cost =
        r.monthlyRentalUsd == null
          ? null
          : daily
            ? Number(r.monthlyRentalUsd) / 30
            : Number(r.monthlyRentalUsd);
      events.push(
        await insertUsageEvent({
          organizationId,
          provider: "twilio",
          service: "phone_number",
          eventType: daily
            ? "daily_prorated_number_rental"
            : "monthly_number_rental",
          source: "twilio_number_rental_reconcile",
          externalId: `${r.phoneSid || r.phoneNumber || "number"}:${daily ? new Date().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 7)}`,
          voiceAgentId: r.voiceAgentId || null,
          unit,
          quantity,
          estimatedCostUsd: cost,
          metadata: {
            phone_number: r.phoneNumber || null,
            phone_sid: r.phoneSid || null,
            monthly_rental_usd: r.monthlyRentalUsd,
            source_table: r.source,
          },
        }),
      );
    }
    res.json({
      ok: true,
      organizationId,
      mode: daily ? "daily_prorated" : "monthly",
      numbersScanned: rentals.size,
      eventsCreated: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/elevenlabs", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const events = [];
    const items = Array.isArray(body.events) ? body.events : [body];
    for (const item of items) {
      const qty = Number(
        item.credits ?? item.characters ?? item.minutes ?? item.quantity ?? 0,
      );
      if (!qty) continue;
      events.push(
        await insertUsageEvent({
          organizationId,
          provider: "elevenlabs",
          service: item.service || "voice",
          eventType: item.eventType || item.event_type || "tts_or_agent_voice",
          source: "elevenlabs_reconcile_endpoint",
          externalId:
            item.externalId ||
            item.external_id ||
            item.requestId ||
            item.request_id ||
            null,
          callId: cleanOrgId(item.callId || item.call_id),
          voiceAgentId: cleanOrgId(item.voiceAgentId || item.voice_agent_id),
          unit:
            item.credits != null
              ? "credits"
              : item.minutes != null
                ? "minutes"
                : "characters",
          quantity: qty,
          estimatedCostUsd:
            item.internalCostUsd ?? item.internal_cost_usd ?? null,
          metadata: {
            voice_id: item.voiceId || item.voice_id || null,
            model_id: item.modelId || item.model_id || null,
            ...(item.metadata || {}),
          },
        }),
      );
    }
    res.json({
      ok: true,
      organizationId,
      eventsCreated: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/railway-runtime", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const range = dateRangeFromRequest(req);
    const sb = getSupabase();
    const { data } = await sb
      .from("call_records")
      .select(
        "id,voice_agent_id,twilio_call_sid,duration,call_duration,created_at",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", range.start)
      .lte("created_at", range.end)
      .limit(5000);
    const events = [];
    for (const row of data || []) {
      const seconds = Number(row.call_duration || row.duration || 0);
      if (seconds <= 0) continue;
      events.push(
        await logRailwayRuntimeUsage({
          organizationId,
          seconds,
          callId: row.id,
          voiceAgentId: row.voice_agent_id,
          externalId: row.twilio_call_sid || row.id,
          metadata: {
            allocation_method: "call_duration_seconds",
            source_table: "call_records",
          },
        }),
      );
    }
    res.json({
      ok: true,
      organizationId,
      period: range,
      callsScanned: (data || []).length,
      eventsCreated: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/reconcile/supabase-compute-allocation",
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const organizationId = cleanOrgId(
        body.organizationId || body.organization_id || req.query.organizationId,
      );
      const totalCostUsd = toUsd(
        body.totalInternalCostUsd ??
          body.total_internal_cost_usd ??
          body.internalCostUsd ??
          body.internal_cost_usd,
        null,
      );
      if (totalCostUsd == null)
        return res
          .status(400)
          .json({ error: { message: "totalInternalCostUsd is required." } });
      const sb = getSupabase();
      let orgs = [];
      if (organizationId) orgs = [{ id: organizationId }];
      else {
        const { data, error } = await sb
          .from("organizations")
          .select("id")
          .limit(5000);
        if (error) throw error;
        orgs = data || [];
      }
      const weights = [];
      for (const org of orgs) {
        const storage =
          (await getCountSafe(sb, "knowledge_chunks", org.id)) +
          (await getCountSafe(sb, "leads", org.id)) +
          (await getCountSafe(sb, "call_records", org.id));
        weights.push({ organizationId: org.id, weight: Math.max(storage, 1) });
      }
      const totalWeight =
        weights.reduce((sum, row) => sum + row.weight, 0) || 1;
      const events = [];
      for (const row of weights) {
        const allocated =
          Math.round(((totalCostUsd * row.weight) / totalWeight) * 1000000) /
          1000000;
        events.push(
          await insertUsageEvent({
            organizationId: row.organizationId,
            provider: "supabase",
            service: "database",
            eventType: "database_compute_allocation",
            source: "supabase_compute_allocation_endpoint",
            externalId:
              body.externalId ||
              body.external_id ||
              `supabase-compute:${new Date().toISOString().slice(0, 10)}:${row.organizationId}`,
            unit: "allocation",
            quantity: row.weight,
            estimatedCostUsd: allocated,
            metadata: {
              total_internal_cost_usd: totalCostUsd,
              allocation_weight: row.weight,
              total_weight: totalWeight,
              allocation_method: "tenant_activity_weight",
            },
          }),
        );
      }
      res.json({
        ok: true,
        organizationsAllocated: weights.length,
        totalCostUsd,
        eventsCreated: events.length,
        events,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post("/reconcile/leads-storage", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    const range = dateRangeFromRequest(req);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("leads")
      .select("*")
      .eq("organization_id", organizationId)
      .gte("created_at", range.start)
      .lte("created_at", range.end)
      .limit(10000);
    if (error) throw error;
    const events = await logLeadStorageUsage({
      organizationId,
      leadCount: (data || []).length,
      storageBytes: estimatePayloadBytes(data || []),
      source: "lead_storage_reconcile_endpoint",
      metadata: { start: range.start, end: range.end },
    });
    res.json({
      ok: true,
      organizationId,
      period: range,
      leadsScanned: (data || []).length,
      eventsCreated: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/schema-inventory", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_billing_schema_inventory")
      .select("*")
      .order("table_type", { ascending: true })
      .order("table_name", { ascending: true });
    if (error) throw error;
    res.json({
      source: "billing_admin_billing_schema_inventory",
      note: "BASE TABLE rows are stored data. VIEW rows are saved admin queries and do not duplicate billing data.",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/customer-rates", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_customer_rate_settings")
      .select("*")
      .order("plan_key", { ascending: true })
      .order("provider", { ascending: true })
      .order("service", { ascending: true });
    if (error) throw error;
    res.json({
      source: "billing_admin_customer_rate_settings",
      mainCustomerRateTable: "billing_customer_rate_cards",
      note: "Edit this layer to control what the customer wallet is charged. Internal vendor cost remains private in billing_usage_events/billing_rate_cards.",
      rates: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/customer-rates", async (req, res, next) => {
  try {
    const body = req.body || {};
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_update_customer_rate", {
      p_plan_key: body.planKey || body.plan_key || "*",
      p_provider: body.provider || "*",
      p_service: body.service || "*",
      p_event_type: body.eventType || body.event_type || "*",
      p_unit: body.unit || "*",
      p_billing_mode: body.billingMode || body.billing_mode || "target_margin",
      p_customer_unit_price_usd:
        body.customerUnitPriceUsd === undefined &&
        body.customer_unit_price_usd === undefined
          ? null
          : Number(body.customerUnitPriceUsd ?? body.customer_unit_price_usd),
      p_markup_percent:
        body.markupPercent === undefined && body.markup_percent === undefined
          ? null
          : Number(body.markupPercent ?? body.markup_percent),
      p_target_margin_percent:
        body.targetMarginPercent === undefined &&
        body.target_margin_percent === undefined
          ? 50
          : Number(body.targetMarginPercent ?? body.target_margin_percent),
      p_minimum_charge_usd:
        body.minimumChargeUsd === undefined &&
        body.minimum_charge_usd === undefined
          ? 0
          : Number(body.minimumChargeUsd ?? body.minimum_charge_usd),
      p_notes: body.notes || null,
      p_metadata_patch: body.metadata || {},
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_update_customer_rate",
      rate: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/wallets", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_wallet_overview").select("*");
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query
      .order("wallet_balance_usd", { ascending: true })
      .limit(500);
    if (error) throw error;
    res.json({ source: "billing_admin_wallet_overview", rows: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post("/wallets/:organizationId/top-up", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.params.organizationId ||
        req.body?.organizationId ||
        req.body?.organization_id,
    );
    const amountUsd = Number(req.body?.amountUsd ?? req.body?.amount_usd);
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res
        .status(400)
        .json({ error: { message: "amountUsd must be greater than zero." } });
    }
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_top_up_wallet", {
      p_organization_id: organizationId,
      p_amount_usd: amountUsd,
      p_source: req.body?.source || "manual_admin_top_up",
      p_external_id: req.body?.externalId || req.body?.external_id || null,
      p_metadata: req.body?.metadata || {},
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_top_up_wallet",
      transaction: data,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/wallets/:organizationId/balance", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.params.organizationId ||
        req.body?.organizationId ||
        req.body?.organization_id,
    );
    const mode = String(
      req.body?.mode ||
        req.body?.adjustmentMode ||
        req.body?.adjustment_mode ||
        "set_balance",
    ).toLowerCase();
    const amountUsd = Number(
      req.body?.amountUsd ??
        req.body?.amount_usd ??
        req.body?.balanceUsd ??
        req.body?.balance_usd ??
        0,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    if (!Number.isFinite(amountUsd)) {
      return res
        .status(400)
        .json({ error: { message: "amountUsd must be a valid number." } });
    }
    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_adjust_wallet_balance",
      {
        p_organization_id: organizationId,
        p_mode: mode,
        p_amount_usd: amountUsd,
        p_source: req.body?.source || "manual_admin_balance_adjustment",
        p_external_id: req.body?.externalId || req.body?.external_id || null,
        p_metadata: req.body?.metadata || {},
      },
    );
    if (error) throw error;

    const { data: walletRows } = await sb
      .from("billing_admin_wallet_enforcement_status")
      .select("*")
      .eq("organization_id", organizationId)
      .limit(1);

    res.json({
      ok: true,
      source: "billing_admin_adjust_wallet_balance",
      transaction: data,
      wallet: Array.isArray(walletRows) ? walletRows[0] || null : null,
      examples: {
        setToFive: `PATCH /api/billing-usage/wallets/${organizationId}/balance { mode: 'set_balance', amountUsd: 5 }`,
        clearToZero: `PATCH /api/billing-usage/wallets/${organizationId}/balance { mode: 'clear', amountUsd: 0 }`,
        addTen: `PATCH /api/billing-usage/wallets/${organizationId}/balance { mode: 'top_up', amountUsd: 10 }`,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/wallet-enforcement-status", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_wallet_enforcement_status").select("*");
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query
      .order("wallet_balance_usd", { ascending: true })
      .limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_wallet_enforcement_status",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post("/charge-usage-event", async (req, res, next) => {
  try {
    const usageEventId = cleanOrgId(
      req.body?.usageEventId || req.body?.usage_event_id,
    );
    if (!usageEventId)
      return res
        .status(400)
        .json({ error: { message: "usageEventId is required." } });
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_charge_usage_event", {
      p_usage_event_id: usageEventId,
      p_apply_wallet: parseBool(
        req.body?.applyWallet ?? req.body?.apply_wallet,
      ),
      p_force: parseBool(req.body?.force),
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_charge_usage_event",
      result: data,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/recalculate-customer-charges", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Customer charge recalculation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend before bulk recalculation.",
        },
      });
    }
    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_recalculate_customer_charges",
      {
        p_organization_id: cleanOrgId(
          req.body?.organizationId ||
            req.body?.organization_id ||
            req.query.organizationId,
        ),
        p_start_at: req.body?.start || req.query.start || null,
        p_end_at: req.body?.end || req.query.end || null,
        p_apply_wallet: parseBool(
          req.body?.applyWallet ?? req.body?.apply_wallet,
        ),
        p_force: parseBool(req.body?.force),
        p_limit: Math.min(
          Math.max(Number(req.body?.limit || req.query.limit) || 5000, 1),
          50000,
        ),
      },
    );
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_recalculate_customer_charges",
      result: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/customer-margin-overview", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_customer_margin_overview").select("*");
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query
      .order("gross_profit_usd", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_customer_margin_overview",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

async function loadWalletConsoleData({ organizationId = null } = {}) {
  const sb = getSupabase();

  let orgQuery = sb
    .from("organizations")
    .select("id,name,plan,metadata,created_at")
    .order("created_at", { ascending: false })
    .limit(250);
  if (organizationId) orgQuery = orgQuery.eq("id", organizationId);
  const { data: orgs, error: orgError } = await orgQuery;
  if (orgError) throw orgError;

  let walletQuery = sb
    .from("billing_admin_wallet_overview")
    .select("*")
    .limit(500);
  if (organizationId)
    walletQuery = walletQuery.eq("organization_id", organizationId);
  const { data: wallets } = await walletQuery;

  let marginQuery = sb
    .from("billing_admin_customer_margin_overview")
    .select("*")
    .limit(500);
  if (organizationId)
    marginQuery = marginQuery.eq("organization_id", organizationId);
  const { data: margins } = await marginQuery;

  let eventQuery = sb
    .from("billing_usage_events")
    .select(
      "id,organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,occurred_at,billable",
    )
    .order("occurred_at", { ascending: false })
    .limit(30);
  if (organizationId)
    eventQuery = eventQuery.eq("organization_id", organizationId);
  const { data: recentEvents } = await eventQuery;

  let txQuery = sb
    .from("billing_wallet_transactions")
    .select(
      "id,organization_id,transaction_type,amount_usd,balance_after_usd,source,created_at,metadata",
    )
    .order("created_at", { ascending: false })
    .limit(30);
  if (organizationId) txQuery = txQuery.eq("organization_id", organizationId);
  const { data: recentTransactions } = await txQuery;

  let chargeQuery = sb
    .from("billing_customer_usage_charges")
    .select(
      "id,organization_id,provider,service,event_type,unit,quantity,internal_cost_usd,customer_charge_usd,gross_profit_usd,gross_margin_percent,wallet_transaction_id,created_at",
    )
    .order("created_at", { ascending: false })
    .limit(30);
  if (organizationId)
    chargeQuery = chargeQuery.eq("organization_id", organizationId);
  const { data: recentCharges } = await chargeQuery;

  return {
    organizationId,
    organizations: orgs || [],
    wallets: wallets || [],
    margins: margins || [],
    recentEvents: recentEvents || [],
    recentTransactions: recentTransactions || [],
    recentCharges: recentCharges || [],
    env: {
      autoChargeWalletEnabled: parseBool(
        process.env.BILLING_AUTO_CHARGE_WALLET,
      ),
      creditEnforcementMode: String(
        process.env.BILLING_CREDIT_ENFORCEMENT_MODE || "observe",
      ),
      minCallCreditUsd: Number(process.env.BILLING_MIN_CALL_CREDIT_USD || 1),
      minChatCreditUsd: Number(process.env.BILLING_MIN_CHAT_CREDIT_USD || 0.05),
      maxNegativeBalanceUsd: Number(
        process.env.BILLING_MAX_NEGATIVE_BALANCE_USD || 1,
      ),
      hardStopBalanceUsd: -Number(
        process.env.BILLING_MAX_NEGATIVE_BALANCE_USD || 1,
      ),
      reconcileEnabled: parseBool(process.env.USAGE_RECONCILE_ENABLED),
    },
  };
}

router.get("/wallet-console-data", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const data = await loadWalletConsoleData({ organizationId });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/wallets/:organizationId/manual-credit",
  async (req, res, next) => {
    try {
      const organizationId = cleanOrgId(
        req.params.organizationId ||
          req.body?.organizationId ||
          req.body?.organization_id,
      );
      const amountUsd = Number(req.body?.amountUsd ?? req.body?.amount_usd);
      if (!organizationId)
        return res
          .status(400)
          .json({ error: { message: "organizationId is required." } });
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        return res
          .status(400)
          .json({ error: { message: "amountUsd must be greater than zero." } });
      }
      const sb = getSupabase();
      const { data, error } = await sb.rpc("billing_admin_top_up_wallet", {
        p_organization_id: organizationId,
        p_amount_usd: amountUsd,
        p_source: req.body?.source || "manual_backend_credit",
        p_external_id:
          req.body?.externalId ||
          req.body?.external_id ||
          `manual-credit-${Date.now()}`,
        p_metadata: {
          manual_backend_credit: true,
          note:
            req.body?.note ||
            "Internal admin credit. Replace with payment gateway webhook in production.",
          ...(req.body?.metadata || {}),
        },
      });
      if (error) throw error;
      res.json({
        ok: true,
        source: "billing_admin_top_up_wallet",
        transaction: data,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/wallets/:organizationId/manual-balance",
  async (req, res, next) => {
    try {
      const organizationId = cleanOrgId(
        req.params.organizationId ||
          req.body?.organizationId ||
          req.body?.organization_id,
      );
      const mode = String(req.body?.mode || "set_balance")
        .trim()
        .toLowerCase();
      const amountUsd = Number(
        req.body?.amountUsd ??
          req.body?.amount_usd ??
          req.body?.balanceUsd ??
          req.body?.balance_usd ??
          0,
      );
      if (!organizationId)
        return res
          .status(400)
          .json({ error: { message: "organizationId is required." } });
      if (!Number.isFinite(amountUsd))
        return res
          .status(400)
          .json({ error: { message: "amountUsd must be a valid number." } });
      const sb = getSupabase();
      const { data, error } = await sb.rpc(
        "billing_admin_adjust_wallet_balance",
        {
          p_organization_id: organizationId,
          p_mode: mode,
          p_amount_usd: amountUsd,
          p_source: req.body?.source || "manual_backend_wallet_console",
          p_external_id:
            req.body?.externalId ||
            req.body?.external_id ||
            `manual-balance-${Date.now()}`,
          p_metadata: {
            manual_backend_adjustment: true,
            note: req.body?.note || "Internal admin wallet balance adjustment.",
            ...(req.body?.metadata || {}),
          },
        },
      );
      if (error) throw error;
      const { data: statusRows } = await sb
        .from("billing_admin_wallet_enforcement_status")
        .select("*")
        .eq("organization_id", organizationId)
        .limit(1);
      res.json({
        ok: true,
        source: "billing_admin_adjust_wallet_balance",
        transaction: data,
        wallet: statusRows?.[0] || null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post("/simulate-usage-charge", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.body?.organizationId || req.body?.organization_id,
    );
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });

    const provider = String(req.body?.provider || "twilio")
      .trim()
      .toLowerCase();
    const service = String(req.body?.service || "voice")
      .trim()
      .toLowerCase();
    const eventType = String(
      req.body?.eventType || req.body?.event_type || "manual_test_usage",
    )
      .trim()
      .toLowerCase();
    const unit = String(req.body?.unit || "minutes")
      .trim()
      .toLowerCase();
    const quantity = Number(req.body?.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res
        .status(400)
        .json({ error: { message: "quantity must be greater than zero." } });
    }

    const event = await insertUsageEvent({
      organizationId,
      provider,
      service,
      eventType,
      source: "manual_backend_usage_simulation",
      externalId:
        req.body?.externalId ||
        req.body?.external_id ||
        `manual-usage-${Date.now()}`,
      unit,
      quantity,
      estimatedCostUsd:
        req.body?.estimatedCostUsd === undefined &&
        req.body?.estimated_cost_usd === undefined
          ? undefined
          : Number(req.body?.estimatedCostUsd ?? req.body?.estimated_cost_usd),
      metadata: {
        manual_simulation: true,
        apply_wallet_requested:
          req.body?.applyWallet !== false && req.body?.apply_wallet !== false,
        note:
          req.body?.note ||
          "Manual usage event used to verify wallet debit and margin tracking.",
        ...(req.body?.metadata || {}),
      },
    });

    let charge = null;
    if (
      req.body?.applyWallet !== false &&
      req.body?.apply_wallet !== false &&
      event?.id
    ) {
      const sb = getSupabase();
      const { data, error } = await sb.rpc("billing_admin_charge_usage_event", {
        p_usage_event_id: event.id,
        p_apply_wallet: true,
        p_force: false,
      });
      if (error) throw error;
      charge = data || null;
    }

    res.json({ ok: true, event, charge });
  } catch (err) {
    next(err);
  }
});

router.get("/wallet-console", async (req, res, next) => {
  try {
    const key = String(req.query?.key || "").trim();
    const data = await loadWalletConsoleData({
      organizationId: cleanOrgId(
        req.query.organizationId || req.query.organization_id,
      ),
    });
    const orgOptions = data.organizations
      .map(
        (org) =>
          `<option value="${htmlEscape(org.id)}">${htmlEscape(org.name || org.id)} · ${htmlEscape(org.plan || org.metadata?.subscription_plan || "unknown")}</option>`,
      )
      .join("");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agently Internal Wallet Console</title>
<style>
body{font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f4eb;color:#232f3e;margin:0;padding:28px} .wrap{max-width:1180px;margin:auto} .card{background:white;border:1px solid rgba(35,47,62,.12);border-radius:22px;padding:20px;margin:14px 0;box-shadow:0 12px 35px rgba(35,47,62,.06)} h1{font-size:30px;margin:0 0 8px} h2{font-size:18px;margin:0 0 12px} label{font-size:11px;text-transform:uppercase;letter-spacing:.16em;font-weight:800;color:rgba(35,47,62,.55);display:block;margin-bottom:6px} input,select{width:100%;box-sizing:border-box;border:1px solid rgba(35,47,62,.16);border-radius:14px;padding:12px;background:#fffaf1;color:#232f3e;font-weight:700} button{border:0;background:#ff5527;color:white;border-radius:14px;padding:12px 16px;font-weight:900;cursor:pointer} button.dark{background:#232f3e}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.muted{color:rgba(35,47,62,.58);font-size:13px}.pill{display:inline-flex;border-radius:999px;background:#fff0e9;color:#ff5527;padding:6px 10px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.12em} table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid rgba(35,47,62,.08);padding:9px;text-align:left}pre{white-space:pre-wrap;background:#232f3e;color:#fffaf1;border-radius:16px;padding:14px;max-height:280px;overflow:auto}.ok{color:#0f9f6e;font-weight:900}.bad{color:#d92d20;font-weight:900}
</style></head><body><div class="wrap">
<span class="pill">Internal only</span><h1>Agently Wallet + Usage Console</h1>
<p class="muted">Use this to manually credit any organization, simulate usage deduction, and inspect backend cost/profit. Do not expose this URL or key to tenants.</p>
<div class="card"><h2>Environment</h2><p>Auto wallet charge: <b class="${data.env.autoChargeWalletEnabled ? "ok" : "bad"}">${data.env.autoChargeWalletEnabled ? "ON" : "OFF"}</b> · Credit enforcement: <b>${htmlEscape(data.env.creditEnforcementMode || "observe")}</b> · Hard stop: <b>-$${Number(data.env.maxNegativeBalanceUsd || 1).toFixed(2)}</b> · Reconcile enabled: <b>${data.env.reconcileEnabled ? "ON" : "OFF"}</b></p><p class="muted">For real service usage to deduct automatically, set <b>BILLING_AUTO_CHARGE_WALLET=true</b>. For strict service blocking, set <b>BILLING_CREDIT_ENFORCEMENT_MODE=block</b>. The negative hard stop blocks even in observe/warn.</p></div>
<div class="card"><h2>Select organization</h2><div class="grid"><div><label>Organization</label><select id="org">${orgOptions}</select></div><div style="align-self:end"><button class="dark" onclick="reloadOrg()">Load organization</button></div></div></div>
<div class="grid"><div class="card"><h2>Wallet balance controls</h2><label>Amount / target balance USD</label><input id="creditAmount" type="number" step="0.01" value="10"/><br/><br/><button onclick="credit()">Add credit</button> <button onclick="setBalance()">Set balance</button> <button onclick="clearBalance()">Clear to $0</button><p class="muted">Use Add credit for top-ups. Use Set balance when you need to change $10 to exactly $5. Use Clear for a $0 default tenant.</p></div>
<div class="card"><h2>Simulate usage + wallet debit</h2><div class="grid"><div><label>Provider</label><input id="provider" value="twilio"/></div><div><label>Service</label><input id="service" value="voice"/></div><div><label>Unit</label><input id="unit" value="minutes"/></div><div><label>Quantity</label><input id="qty" type="number" step="0.01" value="1"/></div></div><br/><button onclick="simulate()">Create usage and deduct wallet</button></div></div>
<div class="card"><h2>Current wallet / margin</h2><div id="summary" class="muted">Loading...</div></div>
<div class="card"><h2>Recent charges</h2><div id="charges"></div></div>
<div class="card"><h2>Recent wallet transactions</h2><div id="tx"></div></div>
<div class="card"><h2>Result</h2><pre id="out">Ready.</pre></div>
</div><script>
const KEY=${JSON.stringify(key)};
function headers(){return {'content-type':'application/json','x-internal-billing-key':KEY};}
function org(){return document.getElementById('org').value;}
function money(v){return '$'+Number(v||0).toFixed(2)}
function table(rows, cols){ if(!rows||!rows.length) return '<p class="muted">No rows yet.</p>'; return '<table><thead><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+String(c[1](r)??'')+'</td>').join('')+'</tr>').join('')+'</tbody></table>';}
async function load(){const r=await fetch('/api/billing-usage/wallet-console-data?organizationId='+encodeURIComponent(org()),{headers:headers()}); const d=await r.json(); if(!r.ok) throw new Error(d?.error?.message||'Load failed'); render(d)}
function render(d){const w=(d.wallets||[])[0]||{}; const m=(d.margins||[])[0]||{}; document.getElementById('summary').innerHTML='<div class="grid"><div><b>Wallet balance</b><br>'+money(w.wallet_balance_usd||w.balance_usd)+'</div><div><b>Total customer charges</b><br>'+money(m.total_customer_charge_usd)+'</div><div><b>Internal cost</b><br>'+money(m.total_internal_cost_usd)+'</div><div><b>Gross profit</b><br>'+money(m.total_gross_profit_usd)+'</div></div>'; document.getElementById('charges').innerHTML=table(d.recentCharges,[['When',r=>new Date(r.created_at).toLocaleString()],['Provider',r=>r.provider+'/'+r.service],['Qty',r=>Number(r.quantity||0)+' '+(r.unit||'')],['Customer charge',r=>money(r.customer_charge_usd)],['Internal cost',r=>money(r.internal_cost_usd)],['Profit',r=>money(r.gross_profit_usd)]]); document.getElementById('tx').innerHTML=table(d.recentTransactions,[['When',r=>new Date(r.created_at).toLocaleString()],['Type',r=>r.transaction_type],['Amount',r=>money(r.amount_usd)],['Balance after',r=>money(r.balance_after_usd)],['Source',r=>r.source]]);}
async function credit(){const amountUsd=Number(document.getElementById('creditAmount').value||0); const r=await fetch('/api/billing-usage/wallets/'+encodeURIComponent(org())+'/manual-credit',{method:'POST',headers:headers(),body:JSON.stringify({amountUsd})}); const d=await r.json(); document.getElementById('out').textContent=JSON.stringify(d,null,2); await load();}
async function setBalance(){const amountUsd=Number(document.getElementById('creditAmount').value||0); const r=await fetch('/api/billing-usage/wallets/'+encodeURIComponent(org())+'/manual-balance',{method:'PATCH',headers:headers(),body:JSON.stringify({mode:'set_balance',amountUsd})}); const d=await r.json(); document.getElementById('out').textContent=JSON.stringify(d,null,2); await load();}
async function clearBalance(){const r=await fetch('/api/billing-usage/wallets/'+encodeURIComponent(org())+'/manual-balance',{method:'PATCH',headers:headers(),body:JSON.stringify({mode:'clear',amountUsd:0})}); const d=await r.json(); document.getElementById('out').textContent=JSON.stringify(d,null,2); await load();}
async function simulate(){const body={organizationId:org(),provider:document.getElementById('provider').value,service:document.getElementById('service').value,unit:document.getElementById('unit').value,quantity:Number(document.getElementById('qty').value||1),applyWallet:true}; const r=await fetch('/api/billing-usage/simulate-usage-charge',{method:'POST',headers:headers(),body:JSON.stringify(body)}); const d=await r.json(); document.getElementById('out').textContent=JSON.stringify(d,null,2); await load();}
function reloadOrg(){location.href='/api/billing-usage/wallet-console?key='+encodeURIComponent(KEY)+'&organizationId='+encodeURIComponent(org())}
document.getElementById('org').value=${JSON.stringify(data.organizationId || data.organizations[0]?.id || "")}; load().catch(e=>document.getElementById('out').textContent=e.message); setInterval(()=>load().catch(()=>{}),8000);
</script></body></html>`);
  } catch (err) {
    next(err);
  }
});

router.get("/admin-queries", (_req, res) => {
  res.json({
    mainTable: "billing_usage_events",
    canonicalWriter: "public.record_billing_usage_event(...)",
    adminViews: [
      "billing_admin_tenant_usage",
      "billing_admin_user_organization_usage",
      "billing_admin_provider_breakdown",
      "billing_admin_current_month_usage",
      "billing_admin_storage_breakdown",
      "billing_admin_unmatched_usage",
      "billing_admin_daily_rollup_overview",
      "billing_admin_plan_limit_overview",
      "billing_admin_org_limit_status",
      "billing_admin_entitlement_decisions",
      "billing_admin_org_billing_control_center",
      "billing_admin_usage_health",
      "billing_admin_org_cost_health",
      "billing_admin_usage_event_audit",
      "billing_admin_plan_settings",
      "billing_admin_user_usage_overview",
    ],
    queries: {
      allOrganizations:
        "SELECT * FROM billing_admin_tenant_usage ORDER BY estimated_cost_usd DESC;",
      oneOrganization:
        "SELECT * FROM billing_admin_tenant_usage WHERE organization_id = 'YOUR_ORG_UUID';",
      usersInOrganization:
        "SELECT * FROM billing_admin_user_organization_usage WHERE organization_id = 'YOUR_ORG_UUID';",
      findByUserEmail:
        "SELECT * FROM billing_admin_user_organization_usage WHERE user_email ILIKE '%customer@example.com%';",
      currentMonth:
        "SELECT * FROM billing_admin_current_month_usage WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY estimated_cost_usd DESC;",
      storageBreakdown:
        "SELECT * FROM billing_admin_storage_breakdown WHERE organization_id = 'YOUR_ORG_UUID';",
      providerBreakdown:
        "SELECT * FROM billing_admin_provider_breakdown WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY estimated_cost_usd DESC;",
      unmatchedUsage:
        "SELECT * FROM billing_admin_unmatched_usage ORDER BY occurred_at DESC;",
      rawEvents:
        "SELECT occurred_at, provider, service, event_type, unit, quantity, estimated_cost_usd, call_id, voice_agent_id, chatbot_id, metadata FROM billing_usage_events WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY occurred_at DESC LIMIT 200;",
      planCostOverview:
        "SELECT * FROM billing_admin_plan_cost_overview ORDER BY estimated_margin_usd ASC NULLS LAST;",
      oneOrgPlanCost:
        "SELECT * FROM billing_admin_plan_cost_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      rateCoverage:
        "SELECT * FROM billing_admin_rate_card_coverage ORDER BY unrated_event_count DESC;",
      planLimitOverview:
        "SELECT * FROM billing_admin_plan_limit_overview ORDER BY estimated_margin_usd ASC NULLS LAST;",
      oneOrgPlanLimit:
        "SELECT * FROM billing_admin_plan_limit_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      orgLimitStatus:
        "SELECT * FROM billing_admin_org_limit_status ORDER BY limit_status, estimated_cost_usd DESC;",
      billingControlCenter:
        "SELECT * FROM billing_admin_org_billing_control_center ORDER BY limit_status, estimated_margin_usd ASC NULLS LAST;",
      oneOrgBillingControlCenter:
        "SELECT * FROM billing_admin_org_billing_control_center WHERE organization_id = 'YOUR_ORG_UUID';",
      entitlementDecisions:
        "SELECT * FROM billing_admin_entitlement_decisions WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY created_at DESC LIMIT 200;",
      entitlementActionSummary:
        "SELECT action, decision, COUNT(*) FROM billing_admin_entitlement_decisions GROUP BY action, decision ORDER BY COUNT(*) DESC;",
      missingCostEvents:
        "SELECT provider, service, event_type, unit, COUNT(*) AS events, SUM(quantity) AS quantity FROM billing_usage_events WHERE estimated_cost_usd IS NULL GROUP BY provider, service, event_type, unit ORDER BY events DESC;",
      writerFunctionExists:
        "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'record_billing_usage_event') AS record_billing_usage_event_exists;",
      marginInputAudit:
        "SELECT COUNT(*) AS events, SUM(quantity) AS quantity, SUM(estimated_cost_usd) AS estimated_cost_usd, COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL) AS null_cost_events FROM billing_usage_events;",
      usageHealth: "SELECT * FROM billing_admin_usage_health;",
      orgCostHealth:
        "SELECT * FROM billing_admin_org_cost_health ORDER BY estimated_cost_usd DESC;",
      oneOrgCostHealth:
        "SELECT * FROM billing_admin_org_cost_health WHERE organization_id = 'YOUR_ORG_UUID';",
      usageEventAudit:
        "SELECT * FROM billing_admin_usage_event_audit WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY occurred_at DESC LIMIT 200;",
      planSettings:
        "SELECT * FROM billing_admin_plan_settings ORDER BY monthly_price_usd NULLS LAST;",
      changeStarterLeads:
        "SELECT public.billing_admin_update_plan_limits('starter', NULL, '{\"leads\":2000}'::jsonb);",
      changeStarterVoiceMinutes:
        "SELECT public.billing_admin_update_plan_limits('starter', NULL, '{\"voice_minutes\":500}'::jsonb);",
      userUsageByEmail:
        "SELECT * FROM billing_admin_user_usage_overview WHERE user_email ILIKE '%customer@example.com%';",
      userUsageByOrganization:
        "SELECT * FROM billing_admin_user_usage_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      previewDeleteUser:
        "SELECT * FROM public.billing_admin_preview_user_or_org_deletion(p_user_email := 'customer@example.com', p_delete_scope := 'user');",
      previewDeleteOrganization:
        "SELECT * FROM public.billing_admin_preview_user_or_org_deletion(p_organization_id := 'YOUR_ORG_UUID', p_delete_scope := 'organization');",
      deleteUserDanger:
        "SELECT public.billing_admin_delete_user_or_org_everything(p_user_email := 'customer@example.com', p_delete_scope := 'user', p_confirm := 'DELETE_USER_DATA');",
      deleteOrganizationDanger:
        "SELECT public.billing_admin_delete_user_or_org_everything(p_organization_id := 'YOUR_ORG_UUID', p_delete_scope := 'organization', p_confirm := 'DELETE_ORGANIZATION_DATA');",
      schemaInventory:
        "SELECT * FROM billing_admin_billing_schema_inventory ORDER BY table_type, table_name;",
      customerRateSettings:
        "SELECT * FROM billing_admin_customer_rate_settings;",
      setDefaultCustomerMargin50:
        "SELECT public.billing_admin_update_customer_rate('*','*','*','*','*','target_margin',NULL,NULL,50,0,'Default 50 percent gross margin','{}'::jsonb);",
      setStarterVoiceMargin50:
        "SELECT public.billing_admin_update_customer_rate('starter','twilio','voice','*','minutes','target_margin',NULL,NULL,50,0,'Starter voice margin','{}'::jsonb);",
      topUpWallet30:
        "SELECT public.billing_admin_top_up_wallet('YOUR_ORG_UUID', 30, 'manual_test_top_up');",
      recalculateCustomerChargesNoWalletDebit:
        "SELECT public.billing_admin_recalculate_customer_charges('YOUR_ORG_UUID', NULL, NULL, false, false, 5000);",
      walletOverview:
        "SELECT * FROM billing_admin_wallet_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      walletEnforcementStatus:
        "SELECT * FROM billing_admin_wallet_enforcement_status WHERE organization_id = 'YOUR_ORG_UUID';",
      setWalletToFive:
        "SELECT public.billing_admin_adjust_wallet_balance('YOUR_ORG_UUID', 'set_balance', 5, 'manual_backend_set_balance');",
      clearWalletToZero:
        "SELECT public.billing_admin_adjust_wallet_balance('YOUR_ORG_UUID', 'clear', 0, 'manual_backend_clear_balance');",
      addWalletTen:
        "SELECT public.billing_admin_adjust_wallet_balance('YOUR_ORG_UUID', 'top_up', 10, 'manual_backend_top_up');",
      debitWalletTwo:
        "SELECT public.billing_admin_adjust_wallet_balance('YOUR_ORG_UUID', 'debit', 2, 'manual_backend_debit');",
      customerMarginOverview:
        "SELECT * FROM billing_admin_customer_margin_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      customerRatesEndpoint: "GET /api/billing-usage/customer-rates",
      updateCustomerRateEndpoint: "PATCH /api/billing-usage/customer-rates",
      walletEndpoint:
        "GET /api/billing-usage/wallets?organizationId=YOUR_ORG_UUID",
      walletTopUpEndpoint:
        "POST /api/billing-usage/wallets/YOUR_ORG_UUID/top-up",
      walletSetBalanceEndpoint:
        "PATCH /api/billing-usage/wallets/YOUR_ORG_UUID/manual-balance { mode: 'set_balance', amountUsd: 5 }",
      walletClearEndpoint:
        "PATCH /api/billing-usage/wallets/YOUR_ORG_UUID/manual-balance { mode: 'clear', amountUsd: 0 }",
      chargeUsageEventEndpoint: "POST /api/billing-usage/charge-usage-event",
      recalculateCustomerChargesEndpoint:
        "POST /api/billing-usage/recalculate-customer-charges",
      planSettingsEndpoint: "GET /api/billing-usage/plans",
      updatePlanEndpoint: "PATCH /api/billing-usage/plans/starter",
      userUsageEndpoint:
        "GET /api/billing-usage/user-usage?email=customer@example.com",
      syncTwilioResourcesEndpoint:
        "POST /api/billing-usage/resources/sync-twilio",
      smokeTestEndpoint: "POST /api/billing-usage/smoke-test-event",
    },
  });
});

// V55: self-updating vendor cost/rate sync + margin guardrails.
router.get(
  "/vendor-rate-sync/status",
  requireInternalBillingAccess,
  async (req, res, next) => {
    try {
      const status = await getVendorRateSyncStatus();
      res.json({
        ok: true,
        source: "vendor_rate_sync_status_v55",
        requiredEnv: {
          twilio: [
            "TWILIO_ACCOUNT_SID",
            "TWILIO_AUTH_TOKEN",
            "TWILIO_RATE_SYNC_COUNTRIES optional",
          ],
          openai: [
            "OPENAI_ADMIN_KEY preferred",
            "OPENAI_API_KEY fallback",
            "OPENAI_ORG_ID optional",
          ],
          elevenlabs: ["ELEVENLABS_API_KEY"],
          railway: [
            "RAILWAY_API_TOKEN",
            "RAILWAY_PROJECT_ID",
            "RAILWAY_SERVICE_ID optional",
          ],
          supabase: [
            "SUPABASE_ACCESS_TOKEN",
            "SUPABASE_PROJECT_REF",
            "SUPABASE_SERVICE_ROLE_KEY",
          ],
          resend: ["RESEND_API_KEY"],
          fallbackRateCards: [
            "VENDOR_RATE_CARD_JSON",
            "OPENAI_RATE_CARD_JSON",
            "ELEVENLABS_RATE_CARD_JSON",
            "TWILIO_RATE_CARD_JSON",
            "RAILWAY_RATE_CARD_JSON",
            "SUPABASE_RATE_CARD_JSON",
            "RESEND_RATE_CARD_JSON",
          ],
          internalRateCards: [
            "Use VENDOR_RATE_CARD_JSON entries with provider=agently for crm.leads",
            "Use VENDOR_RATE_CARD_JSON entries with provider=knowledge_base for knowledge.scraping",
          ],
        },
        status,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/vendor-rate-sync/run",
  requireInternalBillingAccess,
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const providers =
        body.providers || req.query.providers || DEFAULT_PROVIDERS;
      const result = await runVendorRateSync({
        providers,
        organizationId: cleanOrgId(
          body.organizationId ||
            body.organization_id ||
            req.query.organizationId ||
            req.query.organization_id,
        ),
        hours: Number(body.hours || req.query.hours || 24),
        startAt:
          body.startAt ||
          body.start_at ||
          req.query.startAt ||
          req.query.start_at ||
          null,
        endAt:
          body.endAt ||
          body.end_at ||
          req.query.endAt ||
          req.query.end_at ||
          null,
        dryRun: parseBool(
          body.dryRun ?? body.dry_run ?? req.query.dryRun ?? req.query.dry_run,
        ),
        recalculate:
          body.recalculate !== false &&
          String(req.query.recalculate || "true") !== "false",
        recalculateCustomers:
          body.recalculateCustomers !== false &&
          body.recalculate_customers !== false &&
          String(
            req.query.recalculateCustomers ||
              req.query.recalculate_customers ||
              "true",
          ) !== "false",
        applyWallet: parseBool(
          body.applyWallet ??
            body.apply_wallet ??
            req.query.applyWallet ??
            req.query.apply_wallet,
        ),
        targetMarginPercent: Number(
          body.targetMarginPercent ||
            body.target_margin_percent ||
            req.query.targetMarginPercent ||
            req.query.target_margin_percent ||
            process.env.BILLING_TARGET_GROSS_MARGIN_PERCENT ||
            70,
        ),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/vendor-rate-sync/:provider",
  requireInternalBillingAccess,
  async (req, res, next) => {
    try {
      const provider = String(req.params.provider || "").toLowerCase();
      const body = req.body || {};
      const result = await runVendorRateSync({
        providers: [provider],
        organizationId: cleanOrgId(
          body.organizationId ||
            body.organization_id ||
            req.query.organizationId ||
            req.query.organization_id,
        ),
        hours: Number(body.hours || req.query.hours || 24),
        startAt:
          body.startAt ||
          body.start_at ||
          req.query.startAt ||
          req.query.start_at ||
          null,
        endAt:
          body.endAt ||
          body.end_at ||
          req.query.endAt ||
          req.query.end_at ||
          null,
        dryRun: parseBool(
          body.dryRun ?? body.dry_run ?? req.query.dryRun ?? req.query.dry_run,
        ),
        recalculate:
          body.recalculate !== false &&
          String(req.query.recalculate || "true") !== "false",
        recalculateCustomers:
          body.recalculateCustomers !== false &&
          body.recalculate_customers !== false &&
          String(
            req.query.recalculateCustomers ||
              req.query.recalculate_customers ||
              "true",
          ) !== "false",
        applyWallet: parseBool(
          body.applyWallet ??
            body.apply_wallet ??
            req.query.applyWallet ??
            req.query.apply_wallet,
        ),
        targetMarginPercent: Number(
          body.targetMarginPercent ||
            body.target_margin_percent ||
            req.query.targetMarginPercent ||
            req.query.target_margin_percent ||
            process.env.BILLING_TARGET_GROSS_MARGIN_PERCENT ||
            70,
        ),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/margin-risk-report",
  requireInternalBillingAccess,
  async (req, res, next) => {
    try {
      const result = await getMarginRiskReport({
        organizationId: cleanOrgId(
          req.query.organizationId || req.query.organization_id,
        ),
        hours: Number(req.query.hours || 24),
        startAt: req.query.startAt || req.query.start_at || null,
        endAt: req.query.endAt || req.query.end_at || null,
        targetMarginPercent: Number(
          req.query.targetMarginPercent ||
            req.query.target_margin_percent ||
            process.env.BILLING_TARGET_GROSS_MARGIN_PERCENT ||
            70,
        ),
      });
      res.json({ ok: true, source: "margin_risk_report_v55", ...result });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/recommended-customer-pricing",
  requireInternalBillingAccess,
  async (req, res, next) => {
    try {
      const result = await getRecommendedCustomerPricing({
        organizationId: cleanOrgId(
          req.query.organizationId || req.query.organization_id,
        ),
        hours: Number(req.query.hours || 24),
        startAt: req.query.startAt || req.query.start_at || null,
        endAt: req.query.endAt || req.query.end_at || null,
        targetMarginPercent: Number(
          req.query.targetMarginPercent ||
            req.query.target_margin_percent ||
            process.env.BILLING_TARGET_GROSS_MARGIN_PERCENT ||
            70,
        ),
      });
      res.json({
        ok: true,
        source: "recommended_customer_pricing_v55",
        ...result,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/vendor-rate-sync/env-template",
  requireInternalBillingAccess,
  (_req, res) => {
    res.json({
      ok: true,
      note: "Set provider API keys for exact vendor sync. Use JSON rate-card envs only as fallback/account-specific overrides.",
      env: {
        TWILIO_ACCOUNT_SID: "AC...",
        TWILIO_AUTH_TOKEN: "...",
        TWILIO_RATE_SYNC_COUNTRIES: "US,GB,CA,NG",
        OPENAI_ADMIN_KEY: "sk-admin-... preferred for org cost API",
        OPENAI_API_KEY: "sk-... fallback",
        OPENAI_ORG_ID: "optional",
        ELEVENLABS_API_KEY: "...",
        RAILWAY_API_TOKEN: "...",
        RAILWAY_PROJECT_ID: "...",
        RAILWAY_SERVICE_ID: "optional",
        SUPABASE_ACCESS_TOKEN: "sbp_...",
        SUPABASE_PROJECT_REF: "project ref",
        SUPABASE_SERVICE_ROLE_KEY: "existing backend key",
        RESEND_API_KEY: "re_...",
        BILLING_TARGET_GROSS_MARGIN_PERCENT: "70",
        VENDOR_RATE_CARD_JSON:
          '[{"provider":"openai","service":"transcription","eventType":"transcription_minutes","unit":"minutes","unitCostUsd":0.006},{"provider":"agently","service":"leads","eventType":"lead_created_or_imported","unit":"lead","unitCostUsd":0.00001},{"provider":"knowledge_base","service":"scrape_sync","eventType":"sync_attempt","unit":"sync","unitCostUsd":0.01}]',
      },
    });
  },
);

module.exports = router;
