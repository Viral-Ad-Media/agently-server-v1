"use strict";

const fetch = require("node-fetch");
const crypto = require("crypto");
const { getSupabase } = require("./supabase");
const {
  insertUsageEvent,
  upsertProviderResource,
  recalculateUsageEventCosts,
  rebuildDailyUsageRollups,
  estimateTenantStorageBytes,
  logLeadStorageUsage,
  logKnowledgeSyncUsage,
  logRailwayRuntimeUsage,
  logRecordingUsage,
  logTranscriptUsage,
} = require("./usage-ledger");

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  return String(value || "").trim();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundUsd(value) {
  return Math.round(safeNumber(value) * 1000000) / 1000000;
}

function normalizePhone(value) {
  const raw = safeString(value);
  if (!raw) return "";
  const cleaned = raw.replace(/[\s().-]/g, "");
  return cleaned.startsWith("+") ? cleaned : raw;
}

function validIso(value, fallback = null) {
  const raw = safeString(value);
  if (!raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function dateOnly(value) {
  const iso = validIso(value, nowIso());
  return String(iso).slice(0, 10);
}

function asPositiveMoney(value) {
  const n = safeNumber(value, 0);
  return Math.abs(n);
}

function sha(parts) {
  return crypto
    .createHash("sha256")
    .update(
      (parts || [])
        .filter((v) => v !== undefined && v !== null)
        .map(String)
        .join("|"),
    )
    .digest("hex");
}

function twilioAuthHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function twilioSid() {
  return safeString(process.env.TWILIO_ACCOUNT_SID);
}

function twilioToken() {
  return safeString(process.env.TWILIO_AUTH_TOKEN);
}

function requireTwilioAuth() {
  const accountSid = twilioSid();
  const authToken = twilioToken();
  if (!accountSid || !authToken) {
    throw new Error(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for exact Twilio reconciliation.",
    );
  }
  return { accountSid, authToken };
}

function safeJson(value) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = { raw: text };
  }
  if (!res.ok) {
    const message =
      body?.message ||
      body?.error?.message ||
      body?.detail?.message ||
      body?.raw ||
      `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchTwilioPaged({ accountSid, authToken, path, query = {} }) {
  const rows = [];
  let url = new URL(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/${path}`,
  );
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(key, String(value));
  }
  url.searchParams.set("PageSize", String(query.PageSize || 1000));

  const auth = { Authorization: twilioAuthHeader(twilioSid(), authToken) };
  for (let page = 0; page < 1000 && url; page += 1) {
    const body = await fetchJson(url.toString(), { headers: auth });
    const list =
      body.calls ||
      body.incoming_phone_numbers ||
      body.recordings ||
      body.usage_records ||
      [];
    rows.push(...list);
    url = body.next_page_uri
      ? new URL(`https://api.twilio.com${body.next_page_uri}`)
      : null;
  }
  return rows;
}

async function fetchOpenAiCosts({
  start,
  end,
  groupBy = ["project_id", "line_item", "api_key_id"],
}) {
  const key = safeString(
    process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_ADMIN_KEY,
  );
  if (!key)
    return { skipped: true, reason: "OPENAI_ADMIN_KEY missing", buckets: [] };
  const startTime = Math.floor(new Date(start).getTime() / 1000);
  const endTime = Math.floor(new Date(end).getTime() / 1000);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime))
    return { skipped: true, reason: "invalid_start_or_end", buckets: [] };

  const buckets = [];
  let page = null;
  for (let i = 0; i < 100; i += 1) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("end_time", String(endTime));
    url.searchParams.set("limit", "180");
    for (const field of groupBy) url.searchParams.append("group_by[]", field);
    if (page) url.searchParams.set("page", page);
    const body = await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${key}` },
    });
    buckets.push(...(body.data || []));
    page = body.next_page || body.next_page_token || null;
    if (!page) break;
  }
  return { skipped: false, buckets };
}

async function fetchElevenLabsUsage({ start, end }) {
  const key = safeString(process.env.ELEVENLABS_API_KEY);
  if (!key)
    return { skipped: true, reason: "ELEVENLABS_API_KEY missing", usage: null };
  const startUnix = Math.floor(new Date(start).getTime() / 1000);
  const endUnix = Math.floor(new Date(end).getTime() / 1000);
  const url = new URL("https://api.elevenlabs.io/v1/usage/character-stats");
  if (Number.isFinite(startUnix))
    url.searchParams.set("start_unix", String(startUnix));
  if (Number.isFinite(endUnix))
    url.searchParams.set("end_unix", String(endUnix));
  try {
    const usage = await fetchJson(url.toString(), {
      headers: { "xi-api-key": key, Accept: "application/json" },
    });
    return { skipped: false, usage };
  } catch (err) {
    return { skipped: true, reason: err.message || String(err), usage: null };
  }
}

async function upsertUsageEventExact(event) {
  const sb = getSupabase();
  const externalId = safeString(event.externalId || event.external_id);
  const organizationId = safeString(
    event.organizationId || event.organization_id,
  );
  const provider = event.provider;
  const service = event.service;
  const eventType = event.eventType || event.event_type || "usage";
  const unit = event.unit || null;
  const quantity = event.quantity == null ? null : safeNumber(event.quantity);
  const estimatedCostUsd =
    event.estimatedCostUsd == null ? null : roundUsd(event.estimatedCostUsd);
  const unitCostUsd =
    event.unitCostUsd == null && estimatedCostUsd != null && quantity > 0
      ? roundUsd(estimatedCostUsd / quantity)
      : event.unitCostUsd;
  const idempotencyKey =
    event.idempotencyKey ||
    sha([
      "exact-reconcile",
      provider,
      service,
      eventType,
      externalId,
      organizationId,
      unit,
    ]);

  let existing = null;
  try {
    let query = sb
      .from("billing_usage_events")
      .select("id,metadata")
      .eq("provider", provider)
      .eq("service", service)
      .eq("external_id", externalId)
      .limit(1);
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query;
    if (error) throw error;
    existing = Array.isArray(data) ? data[0] || null : null;
  } catch (_) {}

  if (existing?.id) {
    const { data, error } = await sb
      .from("billing_usage_events")
      .update({
        event_type: eventType,
        unit,
        quantity,
        unit_cost_usd: unitCostUsd == null ? null : safeNumber(unitCostUsd),
        estimated_cost_usd: estimatedCostUsd,
        billable: event.billable !== false,
        call_id: event.callId || event.call_id || null,
        chatbot_id: event.chatbotId || event.chatbot_id || null,
        voice_agent_id: event.voiceAgentId || event.voice_agent_id || null,
        knowledge_base_id:
          event.knowledgeBaseId || event.knowledge_base_id || null,
        lead_id: event.leadId || event.lead_id || null,
        occurred_at: event.occurredAt || event.occurred_at || nowIso(),
        metadata: {
          ...(existing.metadata || {}),
          ...(event.metadata || {}),
          exact_reconciled_at: nowIso(),
          exact_reconciliation_version: "v65",
        },
      })
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return { row: data || existing, action: "updated_existing_external_id" };
  }

  const row = await insertUsageEvent({
    ...event,
    eventType,
    idempotencyKey,
    unitCostUsd,
    estimatedCostUsd,
    metadata: {
      ...(event.metadata || {}),
      exact_reconciled_at: nowIso(),
      exact_reconciliation_version: "v65",
    },
  });
  return { row, action: "inserted" };
}

async function fetchRows(table, organizationId, options = {}) {
  const sb = getSupabase();
  const orgColumn = options.orgColumn || "organization_id";
  const select = options.select || "*";
  const limit = Math.min(Math.max(Number(options.limit) || 10000, 1), 100000);
  try {
    let query = sb
      .from(table)
      .select(select, { count: "exact" })
      .eq(orgColumn, organizationId)
      .limit(limit);
    if (options.startColumn && options.start)
      query = query.gte(options.startColumn, options.start);
    if (options.endColumn && options.end)
      query = query.lte(options.endColumn, options.end);
    const { data, error, count } = await query;
    if (error) throw error;
    return {
      ok: true,
      table,
      rows: data || [],
      count: count ?? (data || []).length,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      table,
      rows: [],
      count: 0,
      error: err.message || String(err),
    };
  }
}

function buildMapper({
  organizationId,
  phoneNumbers = [],
  callRecords = [],
  twilioAccounts = [],
}) {
  const callSidToOwner = new Map();
  const phoneToOwner = new Map();
  const phoneSidToOwner = new Map();
  const accountSidToOwner = new Map();

  for (const call of callRecords || []) {
    const sid = safeString(
      call.twilio_call_sid ||
        call.call_sid ||
        call.metadata?.call_sid ||
        call.raw_status_callback?.CallSid ||
        call.metadata?.raw_status_callback?.CallSid,
    );
    if (!sid) continue;
    callSidToOwner.set(sid, {
      organizationId: call.organization_id || organizationId,
      callId: call.id || null,
      voiceAgentId: call.voice_agent_id || null,
      source: "call_records.twilio_call_sid",
    });
  }

  for (const row of phoneNumbers || []) {
    const owner = {
      organizationId: row.organization_id || organizationId,
      phoneNumber: normalizePhone(
        row.phone_number ||
          row.number ||
          row.friendly_name ||
          row.display_phone_number,
      ),
      phoneSid: safeString(row.phone_sid || row.sid || row.twilio_phone_sid),
      accountSid: safeString(
        row.account_sid || row.twilio_account_sid || row.subaccount_sid,
      ),
      source: "twilio_phone_numbers",
    };
    if (owner.phoneNumber) phoneToOwner.set(owner.phoneNumber, owner);
    if (owner.phoneSid) phoneSidToOwner.set(owner.phoneSid, owner);
    if (owner.accountSid) accountSidToOwner.set(owner.accountSid, owner);
  }

  for (const row of twilioAccounts || []) {
    const sid = safeString(
      row.account_sid ||
        row.sid ||
        row.twilio_account_sid ||
        row.subaccount_sid,
    );
    if (!sid) continue;
    accountSidToOwner.set(sid, {
      organizationId: row.organization_id || organizationId,
      accountSid: sid,
      source: "twilio_accounts.account_sid",
    });
  }

  function resolveTwilio({
    callSid,
    parentCallSid,
    accountSid,
    to,
    from,
    phoneSid,
  }) {
    const sid = safeString(callSid);
    if (sid && callSidToOwner.has(sid)) return callSidToOwner.get(sid);
    const parent = safeString(parentCallSid);
    if (parent && callSidToOwner.has(parent)) return callSidToOwner.get(parent);
    const psid = safeString(phoneSid);
    if (psid && phoneSidToOwner.has(psid)) return phoneSidToOwner.get(psid);
    const acct = safeString(accountSid);
    if (acct && accountSidToOwner.has(acct)) return accountSidToOwner.get(acct);
    for (const number of [normalizePhone(to), normalizePhone(from)].filter(
      Boolean,
    )) {
      if (phoneToOwner.has(number)) return phoneToOwner.get(number);
    }
    return { organizationId: null, source: "unmatched" };
  }

  return {
    callSidToOwner,
    phoneToOwner,
    phoneSidToOwner,
    accountSidToOwner,
    resolveTwilio,
  };
}

async function syncProviderMappings({
  organizationId,
  phoneNumbers,
  callRecords,
  twilioAccounts,
}) {
  const results = { provider: "mappings", mapped: 0, skipped: 0, details: [] };
  for (const row of phoneNumbers || []) {
    const orgId = row.organization_id || organizationId;
    const phoneNumber = normalizePhone(
      row.phone_number ||
        row.number ||
        row.friendly_name ||
        row.display_phone_number,
    );
    const phoneSid = safeString(
      row.phone_sid || row.sid || row.twilio_phone_sid,
    );
    const accountSid = safeString(
      row.account_sid || row.twilio_account_sid || row.subaccount_sid,
    );
    if (phoneNumber) {
      await upsertProviderResource({
        organizationId: orgId,
        provider: "twilio",
        resourceType: "phone_number",
        externalId: phoneNumber,
        displayValue: phoneNumber,
        metadata: {
          source_table: "twilio_phone_numbers",
          phone_sid: phoneSid || null,
          account_sid: accountSid || null,
        },
      });
      results.mapped += 1;
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
          phone_number: phoneNumber || null,
          account_sid: accountSid || null,
        },
      });
      results.mapped += 1;
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
          phone_number: phoneNumber || null,
          phone_sid: phoneSid || null,
        },
      });
      results.mapped += 1;
    }
  }

  for (const row of callRecords || []) {
    const sid = safeString(
      row.twilio_call_sid ||
        row.call_sid ||
        row.metadata?.call_sid ||
        row.raw_status_callback?.CallSid ||
        row.metadata?.raw_status_callback?.CallSid,
    );
    if (!sid) continue;
    await upsertProviderResource({
      organizationId: row.organization_id || organizationId,
      provider: "twilio",
      resourceType: "call_sid",
      externalId: sid,
      displayValue: sid,
      metadata: {
        source_table: "call_records",
        call_id: row.id || null,
        voice_agent_id: row.voice_agent_id || null,
      },
    });
    results.mapped += 1;
  }

  for (const row of twilioAccounts || []) {
    const sid = safeString(
      row.account_sid ||
        row.sid ||
        row.twilio_account_sid ||
        row.subaccount_sid,
    );
    if (!sid) continue;
    await upsertProviderResource({
      organizationId: row.organization_id || organizationId,
      provider: "twilio",
      resourceType: "account_sid",
      externalId: sid,
      displayValue: sid,
      metadata: { source_table: "twilio_accounts", row_id: row.id || null },
    });
    results.mapped += 1;
  }

  const runtimeMappings = await syncProviderMappingsFromUsageEvents({
    organizationId,
  });
  results.mapped += runtimeMappings.mapped;
  results.skipped += runtimeMappings.skipped;
  results.details.push(...runtimeMappings.details);
  return results;
}

function addRuntimeMappingCandidate(
  candidates,
  provider,
  resourceType,
  externalId,
  metadata = {},
) {
  const id = safeString(externalId);
  if (!provider || !resourceType || !id) return;
  candidates.push({
    provider,
    resourceType,
    externalId: id,
    displayValue: id,
    metadata,
  });
}

async function syncProviderMappingsFromUsageEvents({ organizationId }) {
  const results = { mapped: 0, skipped: 0, details: [] };
  const sb = getSupabase();
  let rows = [];
  try {
    const { data, error } = await sb
      .from("billing_usage_events")
      .select(
        "organization_id,provider,service,event_type,external_id,call_id,chatbot_id,voice_agent_id,knowledge_base_id,lead_id,metadata",
      )
      .eq("organization_id", organizationId)
      .limit(100000);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    results.details.push({
      source: "billing_usage_events",
      status: "mapping_query_failed",
      message: err.message || String(err),
    });
    return results;
  }

  for (const row of rows) {
    const provider = safeString(row.provider).toLowerCase();
    const metadata = row.metadata || {};
    const candidates = [];
    if (provider === "twilio") {
      addRuntimeMappingCandidate(
        candidates,
        "twilio",
        "call_sid",
        metadata.call_sid || metadata.raw_call?.sid || row.external_id,
        { source: "billing_usage_events", event_type: row.event_type },
      );
      addRuntimeMappingCandidate(
        candidates,
        "twilio",
        "recording_sid",
        metadata.recording_sid || metadata.raw_recording?.sid,
        { source: "billing_usage_events", event_type: row.event_type },
      );
      addRuntimeMappingCandidate(
        candidates,
        "twilio",
        "media_stream_sid",
        metadata.stream_sid,
        { source: "billing_usage_events", event_type: row.event_type },
      );
      addRuntimeMappingCandidate(
        candidates,
        "twilio",
        "account_sid",
        metadata.account_sid ||
          metadata.raw_call?.account_sid ||
          metadata.raw_status_callback?.AccountSid,
        { source: "billing_usage_events", event_type: row.event_type },
      );
      addRuntimeMappingCandidate(
        candidates,
        "twilio",
        "phone_number",
        normalizePhone(
          metadata.to ||
            metadata.raw_call?.to ||
            metadata.raw_status_callback?.To,
        ),
        { source: "billing_usage_events", direction: "to" },
      );
      addRuntimeMappingCandidate(
        candidates,
        "twilio",
        "phone_number",
        normalizePhone(
          metadata.from ||
            metadata.raw_call?.from ||
            metadata.raw_status_callback?.From,
        ),
        { source: "billing_usage_events", direction: "from" },
      );
    } else if (provider === "openai") {
      addRuntimeMappingCandidate(
        candidates,
        "openai",
        "usage_event",
        row.external_id,
        {
          source: "billing_usage_events",
          service: row.service,
          event_type: row.event_type,
        },
      );
      addRuntimeMappingCandidate(
        candidates,
        "openai",
        "realtime_response",
        metadata.response_id || metadata.openai_response_id || row.external_id,
        {
          source: "billing_usage_events",
          service: row.service,
          event_type: row.event_type,
        },
      );
      addRuntimeMappingCandidate(
        candidates,
        "openai",
        "realtime_session",
        metadata.session_id ||
          metadata.openai_session_id ||
          metadata.realtime_session_id,
        { source: "billing_usage_events" },
      );
      addRuntimeMappingCandidate(
        candidates,
        "openai",
        "project_id",
        metadata.project_id || metadata.openai_project_id,
        { source: "billing_usage_events" },
      );
      addRuntimeMappingCandidate(
        candidates,
        "openai",
        "api_key_id",
        metadata.api_key_id || metadata.openai_api_key_id,
        { source: "billing_usage_events" },
      );
      addRuntimeMappingCandidate(
        candidates,
        "openai",
        "request_id",
        metadata.request_id || metadata.openai_request_id,
        { source: "billing_usage_events" },
      );
    } else if (provider === "elevenlabs") {
      addRuntimeMappingCandidate(
        candidates,
        "elevenlabs",
        "request_id",
        metadata.request_id ||
          metadata.elevenlabs_request_id ||
          row.external_id,
        {
          source: "billing_usage_events",
          service: row.service,
          event_type: row.event_type,
        },
      );
      addRuntimeMappingCandidate(
        candidates,
        "elevenlabs",
        "history_item_id",
        metadata.history_item_id,
        { source: "billing_usage_events" },
      );
      addRuntimeMappingCandidate(
        candidates,
        "elevenlabs",
        "voice_id",
        metadata.voice_id,
        { source: "billing_usage_events" },
      );
    } else if (provider === "railway") {
      addRuntimeMappingCandidate(
        candidates,
        "railway",
        "runtime_session",
        row.external_id,
        {
          source: "billing_usage_events",
          service: row.service,
          event_type: row.event_type,
          call_id: row.call_id || null,
        },
      );
      addRuntimeMappingCandidate(
        candidates,
        "railway",
        "service_id",
        metadata.service_id || metadata.railway_service_id,
        { source: "billing_usage_events" },
      );
      addRuntimeMappingCandidate(
        candidates,
        "railway",
        "project_id",
        metadata.project_id || metadata.railway_project_id,
        { source: "billing_usage_events" },
      );
    } else if (provider === "supabase") {
      addRuntimeMappingCandidate(
        candidates,
        "supabase",
        "storage_snapshot",
        row.external_id,
        {
          source: "billing_usage_events",
          service: row.service,
          event_type: row.event_type,
        },
      );
      addRuntimeMappingCandidate(
        candidates,
        "supabase",
        "storage_prefix",
        metadata.storage_prefix || metadata.prefix,
        { source: "billing_usage_events" },
      );
    }

    for (const item of candidates) {
      await upsertProviderResource({
        organizationId,
        provider: item.provider,
        resourceType: item.resourceType,
        externalId: item.externalId,
        displayValue: item.displayValue,
        metadata: {
          ...(item.metadata || {}),
          usage_event_external_id: row.external_id || null,
          call_id: row.call_id || null,
          chatbot_id: row.chatbot_id || null,
          voice_agent_id: row.voice_agent_id || null,
          knowledge_base_id: row.knowledge_base_id || null,
          source_version: "v65_dynamic_runtime_mapping",
        },
      });
      results.mapped += 1;
    }
    if (!candidates.length) results.skipped += 1;
  }
  return results;
}

async function lookupProviderResource(provider, resourceType, externalId) {
  const id = safeString(externalId);
  if (!id) return null;
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("billing_provider_resources")
      .select("*")
      .eq("provider", provider)
      .eq("resource_type", resourceType)
      .eq("external_id", id)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    return data || null;
  } catch (_) {
    return null;
  }
}

async function reconcileTwilioExact({ organizationId, start, end, mapper }) {
  const result = {
    provider: "twilio",
    calls: {
      scanned: 0,
      imported: 0,
      updated: 0,
      skippedUnmatched: 0,
      exactPriceMissing: 0,
    },
    recordings: {
      scanned: 0,
      imported: 0,
      updated: 0,
      skippedUnmatched: 0,
      exactPriceMissing: 0,
    },
    phoneNumbers: { scanned: 0, mapped: 0 },
    accountUsage: { scanned: 0, imported: 0, skippedNotOrgSpecific: 0 },
    providerLimitations: [],
  };
  const { accountSid, authToken } = requireTwilioAuth();

  const incomingNumbers = await fetchTwilioPaged({
    accountSid,
    authToken,
    path: "IncomingPhoneNumbers.json",
    query: {},
  });
  for (const number of incomingNumbers || []) {
    result.phoneNumbers.scanned += 1;
    const owner = mapper.resolveTwilio({
      phoneSid: number.sid,
      phoneNumber: number.phone_number,
      accountSid: number.account_sid || accountSid,
    });
    if (owner.organizationId === organizationId)
      result.phoneNumbers.mapped += 1;
  }

  const calls = await fetchTwilioPaged({
    accountSid,
    authToken,
    path: "Calls.json",
    query: { "StartTime>=": start, "StartTime<=": end },
  });
  for (const call of calls || []) {
    result.calls.scanned += 1;
    const owner = mapper.resolveTwilio({
      callSid: call.sid,
      parentCallSid: call.parent_call_sid,
      accountSid: call.account_sid || accountSid,
      from: call.from,
      to: call.to,
    });
    if (owner.organizationId !== organizationId) {
      result.calls.skippedUnmatched += 1;
      continue;
    }
    const durationSeconds = safeNumber(call.duration, 0);
    const minutes = Math.ceil(Math.max(0, durationSeconds) / 60);
    const exactCost = call.price == null ? null : asPositiveMoney(call.price);
    if (exactCost == null) result.calls.exactPriceMissing += 1;
    const { action } = await upsertUsageEventExact({
      organizationId,
      provider: "twilio",
      service: "voice",
      eventType: "twilio_call",
      source: "twilio_calls_api_exact_reconcile",
      externalId: call.sid,
      callId: owner.callId || null,
      voiceAgentId: owner.voiceAgentId || null,
      unit: "minutes",
      quantity: minutes,
      estimatedCostUsd: exactCost,
      billable: true,
      occurredAt: validIso(
        call.start_time || call.date_created || call.end_time,
        nowIso(),
      ),
      metadata: {
        raw_call: safeJson(call),
        owner_resolution: owner,
        exact_provider_price_available: exactCost != null,
        duration_seconds: durationSeconds,
        price_unit: call.price_unit || "USD",
      },
    });
    if (action === "updated_existing_external_id") result.calls.updated += 1;
    else result.calls.imported += 1;
  }

  const recordings = await fetchTwilioPaged({
    accountSid,
    authToken,
    path: "Recordings.json",
    query: { "DateCreated>=": start, "DateCreated<=": end },
  });
  for (const recording of recordings || []) {
    result.recordings.scanned += 1;
    const owner = mapper.resolveTwilio({
      callSid: recording.call_sid,
      accountSid: recording.account_sid || accountSid,
    });
    if (owner.organizationId !== organizationId) {
      result.recordings.skippedUnmatched += 1;
      continue;
    }
    const seconds = safeNumber(recording.duration, 0);
    const minutes = Math.ceil(Math.max(0, seconds) / 60);
    const exactCost =
      recording.price == null ? null : asPositiveMoney(recording.price);
    if (exactCost == null) result.recordings.exactPriceMissing += 1;
    const { action } = await upsertUsageEventExact({
      organizationId,
      provider: "twilio",
      service: "recordings",
      eventType: "recording_minutes",
      source: "twilio_recordings_api_exact_reconcile",
      externalId: recording.sid,
      callId: owner.callId || null,
      voiceAgentId: owner.voiceAgentId || null,
      unit: "minutes",
      quantity: minutes,
      estimatedCostUsd: exactCost,
      billable: true,
      occurredAt: validIso(recording.date_created, nowIso()),
      metadata: {
        raw_recording: safeJson(recording),
        owner_resolution: owner,
        exact_provider_price_available: exactCost != null,
        duration_seconds: seconds,
        price_unit: recording.price_unit || "USD",
      },
    });
    if (action === "updated_existing_external_id")
      result.recordings.updated += 1;
    else result.recordings.imported += 1;
  }

  await reconcileTwilioUsageRecordsIfOrgSpecific({
    organizationId,
    accountSid,
    authToken,
    start,
    end,
    mapper,
    result,
  });

  if (result.calls.exactPriceMissing) {
    result.providerLimitations.push({
      area: "twilio.calls",
      status: "provider_price_missing_on_some_call_resources",
      count: result.calls.exactPriceMissing,
    });
  }
  if (result.recordings.exactPriceMissing) {
    result.providerLimitations.push({
      area: "twilio.recordings",
      status: "provider_price_missing_on_some_recording_resources",
      count: result.recordings.exactPriceMissing,
    });
  }
  return result;
}

async function reconcileTwilioUsageRecordsIfOrgSpecific({
  organizationId,
  accountSid,
  authToken,
  start,
  end,
  mapper,
  result,
}) {
  const owner = mapper.accountSidToOwner.get(accountSid);
  const accountIsExplicitTenantSubaccount =
    owner?.organizationId === organizationId &&
    owner?.source === "twilio_accounts.account_sid";
  if (!accountIsExplicitTenantSubaccount) {
    result.accountUsage.skippedNotOrgSpecific += 1;
    result.providerLimitations.push({
      area: "twilio.account_usage",
      status:
        "twilio_usage_records_are_account_level_not_imported_without_org_specific_subaccount",
      accountSid,
      requiredMapping:
        "twilio_accounts.account_sid must map this AccountSid to exactly one organization before account-level phone-number purchase/rental usage can be imported as exact tenant cost",
    });
    return;
  }
  const records = await fetchTwilioPaged({
    accountSid,
    authToken,
    path: "Usage/Records.json",
    query: { StartDate: dateOnly(start), EndDate: dateOnly(end) },
  });
  for (const record of records || []) {
    result.accountUsage.scanned += 1;
    const category = String(record.category || "unknown").toLowerCase();
    const price = record.price == null ? null : asPositiveMoney(record.price);
    const quantity = safeNumber(record.usage, 0);
    let service = category;
    let eventType = "twilio_account_usage_record";
    let unit = record.usage_unit || "unit";
    if (
      category.includes("phonenumber") ||
      category.includes("phone-number") ||
      category.includes("number")
    ) {
      service = "phone_number";
      eventType = "monthly_rental";
      unit = record.usage_unit || "number_month";
    } else if (category.includes("recording")) {
      service = "recordings";
      eventType = "recording_storage_or_minutes";
    }
    await upsertUsageEventExact({
      organizationId,
      provider: "twilio",
      service,
      eventType,
      source: "twilio_usage_records_api_exact_reconcile",
      externalId: `${accountSid}:${record.start_date || dateOnly(start)}:${record.end_date || dateOnly(end)}:${category}`,
      unit,
      quantity,
      estimatedCostUsd: price,
      billable: true,
      occurredAt: validIso(record.end_date || end, nowIso()),
      metadata: {
        raw_usage_record: safeJson(record),
        account_sid: accountSid,
        owner_resolution: owner,
        exact_provider_price_available: price != null,
      },
    });
    result.accountUsage.imported += 1;
  }
}

async function reconcileOpenAiExact({ organizationId, start, end }) {
  const result = {
    provider: "openai",
    costsScanned: 0,
    imported: 0,
    skippedUnmapped: 0,
    skipped: false,
    reason: null,
    providerLimitations: [],
  };
  const fetched = await fetchOpenAiCosts({ start, end });
  if (fetched.skipped)
    return { ...result, skipped: true, reason: fetched.reason };
  for (const bucket of fetched.buckets || []) {
    for (const item of bucket.results ||
      bucket.line_items ||
      bucket.data ||
      []) {
      result.costsScanned += 1;
      const projectId =
        item.project_id ||
        item.project?.id ||
        bucket.project_id ||
        bucket.project?.id ||
        null;
      const apiKeyId =
        item.api_key_id ||
        item.api_key?.id ||
        bucket.api_key_id ||
        bucket.api_key?.id ||
        null;
      const lineItem =
        item.line_item || item.name || item.line_item_name || "openai_cost";
      let owner = null;
      if (projectId)
        owner = await lookupProviderResource("openai", "project_id", projectId);
      if (!owner && apiKeyId)
        owner = await lookupProviderResource("openai", "api_key_id", apiKeyId);
      if (!owner || owner.organization_id !== organizationId) {
        result.skippedUnmapped += 1;
        continue;
      }
      const amount = safeNumber(
        item.amount?.value ?? item.amount ?? item.cost ?? item.cost_usd,
        0,
      );
      await upsertUsageEventExact({
        organizationId,
        provider: "openai",
        service: "admin_costs",
        eventType: lineItem,
        source: "openai_admin_costs_api_exact_reconcile",
        externalId: `openai:${projectId || "no-project"}:${apiKeyId || "no-key"}:${bucket.start_time || start}:${bucket.end_time || end}:${lineItem}`,
        unit: "usd_cost_bucket",
        quantity: 1,
        estimatedCostUsd: amount,
        billable: true,
        occurredAt: validIso(
          bucket.end_time
            ? new Date(bucket.end_time * 1000).toISOString()
            : end,
          nowIso(),
        ),
        metadata: {
          raw_cost_item: safeJson(item),
          raw_bucket: safeJson(bucket),
          project_id: projectId,
          api_key_id: apiKeyId,
          owner_resolution: owner,
          exact_provider_price_available: true,
        },
      });
      result.imported += 1;
    }
  }
  if (result.skippedUnmapped)
    result.providerLimitations.push({
      area: "openai.costs",
      status:
        "unmapped_project_or_api_key_costs_skipped_use_runtime_or_db_provider_resource_mapping_not_env",
      count: result.skippedUnmapped,
    });
  return result;
}

async function reconcileElevenLabsRuntimeAttribution({
  organizationId,
  start,
  end,
}) {
  const result = {
    provider: "elevenlabs",
    usageApiChecked: false,
    existingRuntimeEvents: 0,
    importedFromRuntimeEvents: 0,
    skipped: false,
    providerLimitations: [],
  };
  const usage = await fetchElevenLabsUsage({ start, end });
  result.usageApiChecked = !usage.skipped;
  if (usage.skipped) {
    result.providerLimitations.push({
      area: "elevenlabs.usage_api",
      status: usage.reason,
    });
  }

  const sb = getSupabase();
  const { data } = await sb
    .from("billing_usage_events")
    .select(
      "id,external_id,organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,occurred_at,metadata",
    )
    .eq("organization_id", organizationId)
    .eq("provider", "elevenlabs")
    .gte("occurred_at", start)
    .lte("occurred_at", end)
    .limit(100000);
  result.existingRuntimeEvents = (data || []).length;
  if (!result.existingRuntimeEvents) {
    result.providerLimitations.push({
      area: "elevenlabs.runtime",
      status:
        "no_org_attributed_runtime_synthesis_events_found_enable_runtime_mapping",
    });
  }
  return result;
}

async function reconcileRailwayRuntimeAllocation({
  organizationId,
  start,
  end,
  callRecords,
}) {
  const result = {
    provider: "railway",
    callsScanned: 0,
    imported: 0,
    allocationMethod: "call_duration_seconds",
  };
  for (const call of callRecords || []) {
    const created = validIso(
      call.created_at || call.timestamp || call.started_at,
      null,
    );
    if (created && (created < start || created > end)) continue;
    result.callsScanned += 1;
    const seconds = safeNumber(
      call.call_duration ||
        call.duration ||
        call.duration_seconds ||
        call.metadata?.duration_seconds ||
        call.raw_status_callback?.CallDuration,
      0,
    );
    if (seconds <= 0) continue;
    await logRailwayRuntimeUsage({
      organizationId,
      seconds,
      callId: call.id || null,
      voiceAgentId: call.voice_agent_id || null,
      externalId: call.twilio_call_sid || call.id,
      metadata: {
        allocation_method: "call_duration_seconds",
        source_table: "call_records",
        exact_attribution_source: "agently_call_record",
      },
    });
    result.imported += 1;
  }
  return result;
}

async function reconcileSupabaseStorageAndDb({ organizationId }) {
  const result = {
    provider: "supabase",
    storageSnapshotInserted: false,
    databaseAllocationInserted: false,
    storage: null,
  };
  const storage = await estimateTenantStorageBytes(organizationId);
  result.storage = storage;
  result.storageSnapshotInserted = true;
  const sb = getSupabase();
  try {
    const activityWeight = safeNumber(storage.totalBytes, 0) || 1;
    await upsertUsageEventExact({
      organizationId,
      provider: "supabase",
      service: "database",
      eventType: "database_compute_allocation",
      source: "supabase_org_activity_allocation_reconcile",
      externalId: `supabase-db-allocation:${organizationId}:${dateOnly(nowIso())}`,
      unit: "allocation",
      quantity: activityWeight,
      estimatedCostUsd: null,
      billable: true,
      occurredAt: nowIso(),
      metadata: {
        allocation_method: "org_activity_weight_pending_invoice_cost",
        storage_bytes: storage.totalBytes,
        note: "Exact dollar allocation requires monthly Supabase invoice amount; org attribution is recorded now.",
      },
    });
    result.databaseAllocationInserted = true;
  } catch (err) {
    result.databaseAllocationError = err.message || String(err);
  }
  try {
    await sb.from("billing_provider_resources").select("id").limit(1);
  } catch (_) {}
  return result;
}

async function reconcileInternalAgentlyAssets({
  organizationId,
  start,
  end,
  leads,
  knowledgeSources,
  knowledgeChunks,
  faqs,
  chatMessages,
}) {
  const result = {
    provider: "agently_internal",
    leads: { scanned: leads.length, imported: 0 },
    knowledge: {
      sources: knowledgeSources.length,
      chunks: knowledgeChunks.length,
      faqs: faqs.length,
      imported: 0,
    },
    chatbot: { messages: chatMessages.length, imported: 0 },
  };

  if (leads.length) {
    const rows = await logLeadStorageUsage({
      organizationId,
      leadCount: leads.length,
      storageBytes: Buffer.byteLength(JSON.stringify(leads), "utf8"),
      source: "org_full_cost_reconcile_leads",
      metadata: {
        start,
        end,
        exact_attribution_source: "leads.organization_id",
      },
    });
    result.leads.imported += rows.length;
  }

  for (const source of knowledgeSources || []) {
    const chunksForSource = knowledgeChunks.filter(
      (row) =>
        row.source_id === source.id || row.knowledge_source_id === source.id,
    ).length;
    const faqsForKb = faqs.filter(
      (row) =>
        row.knowledge_base_id &&
        row.knowledge_base_id === source.knowledge_base_id,
    ).length;
    const rows = await logKnowledgeSyncUsage({
      organizationId,
      knowledgeBaseId: source.knowledge_base_id || null,
      knowledgeSourceId: source.id || null,
      pagesAttempted: 1,
      pagesScraped:
        source.status && String(source.status).toLowerCase().includes("fail")
          ? 0
          : 1,
      pagesFailed:
        source.status && String(source.status).toLowerCase().includes("fail")
          ? 1
          : 0,
      chunksStored: chunksForSource,
      faqsStored: faqsForKb,
      storageBytes: Buffer.byteLength(
        JSON.stringify({ source, chunks: chunksForSource, faqs: faqsForKb }),
        "utf8",
      ),
      externalId: source.id,
      metadata: {
        start,
        end,
        exact_attribution_source: "knowledge_sources.organization_id",
      },
    });
    result.knowledge.imported += rows.length;
  }

  if (chatMessages.length) {
    await upsertUsageEventExact({
      organizationId,
      provider: "agently",
      service: "chatbot",
      eventType: "chatbot_response_recorded",
      source: "org_full_cost_reconcile_chatbot_messages",
      externalId: `chatbot-messages:${organizationId}:${dateOnly(start)}:${dateOnly(end)}`,
      unit: "message",
      quantity: chatMessages.length,
      estimatedCostUsd: null,
      billable: true,
      occurredAt: end,
      metadata: {
        exact_attribution_source: "chat_messages.organization_id",
        note: "Message count is exact; OpenAI token cost requires runtime token ledger events.",
      },
    });
    result.chatbot.imported += 1;
  }
  return result;
}

async function recalculateCustomerCharges({
  organizationId,
  start,
  end,
  force = true,
  applyWallet = false,
  limit = 50000,
}) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc(
      "billing_admin_recalculate_customer_charges",
      {
        p_organization_id: organizationId,
        p_start_at: start,
        p_end_at: end,
        p_apply_wallet: !!applyWallet,
        p_force: !!force,
        p_limit: Math.min(Math.max(Number(limit) || 50000, 1), 100000),
      },
    );
    if (error) throw error;
    return { ok: true, result: data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function loadOrgAndRange({ organizationId, start, end }) {
  const sb = getSupabase();
  let organization = { id: organizationId };
  try {
    const { data } = await sb
      .from("organizations")
      .select("*")
      .eq("id", organizationId)
      .maybeSingle();
    organization = data || organization;
  } catch (_) {}
  const effectiveEnd = validIso(end, nowIso());
  let effectiveStart = start;
  if (
    !effectiveStart ||
    ["onboarding", "all", "all_time", "from_onboarding"].includes(
      String(effectiveStart).toLowerCase(),
    )
  ) {
    effectiveStart =
      organization.created_at ||
      organization.inserted_at ||
      "1970-01-01T00:00:00.000Z";
  }
  effectiveStart = validIso(effectiveStart, "1970-01-01T00:00:00.000Z");
  return { organization, start: effectiveStart, end: effectiveEnd };
}

async function loadProviderResourcesForOrg(organizationId) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("billing_provider_resources")
      .select(
        "provider,resource_type,external_id,display_value,metadata,organization_id",
      )
      .eq("organization_id", organizationId)
      .limit(100000);
    if (error) throw error;
    return data || [];
  } catch (_) {
    return [];
  }
}

function enrichMapperFromProviderResources(
  mapper,
  providerResources,
  organizationId,
) {
  for (const row of providerResources || []) {
    if (safeString(row.provider).toLowerCase() !== "twilio") continue;
    const resourceType = safeString(row.resource_type).toLowerCase();
    const externalId = safeString(row.external_id);
    const owner = {
      organizationId: row.organization_id || organizationId,
      source: `billing_provider_resources.${resourceType}`,
      phoneNumber:
        resourceType === "phone_number" ? normalizePhone(externalId) : null,
      phoneSid: resourceType === "phone_sid" ? externalId : null,
      accountSid: resourceType === "account_sid" ? externalId : null,
    };
    if (resourceType === "call_sid" && externalId)
      mapper.callSidToOwner.set(externalId, owner);
    if (resourceType === "parent_call_sid" && externalId)
      mapper.callSidToOwner.set(externalId, owner);
    if (resourceType === "phone_number" && externalId)
      mapper.phoneToOwner.set(normalizePhone(externalId), owner);
    if (resourceType === "phone_sid" && externalId)
      mapper.phoneSidToOwner.set(externalId, owner);
    if (resourceType === "account_sid" && externalId)
      mapper.accountSidToOwner.set(externalId, owner);
  }
  return mapper;
}

async function runOrgFullCostReconciliation({
  organizationId,
  start = "onboarding",
  end = nowIso(),
  force = true,
  applyWallet = false,
} = {}) {
  if (!organizationId) throw new Error("organizationId is required.");
  const sb = getSupabase();
  const range = await loadOrgAndRange({ organizationId, start, end });
  const effectiveStart = range.start;
  const effectiveEnd = range.end;

  const [
    phoneNumbersResult,
    callRecordsResult,
    twilioAccountsResult,
    leadsResult,
    knowledgeSourcesResult,
    knowledgeChunksResult,
    faqsResult,
    chatMessagesResult,
  ] = await Promise.all([
    fetchRows("twilio_phone_numbers", organizationId, { limit: 50000 }),
    fetchRows("call_records", organizationId, { limit: 100000 }),
    fetchRows("twilio_accounts", organizationId, { limit: 50000 }),
    fetchRows("leads", organizationId, { limit: 100000 }),
    fetchRows("knowledge_sources", organizationId, { limit: 100000 }),
    fetchRows("knowledge_chunks", organizationId, { limit: 100000 }),
    fetchRows("faqs", organizationId, { limit: 100000 }),
    fetchRows("chat_messages", organizationId, { limit: 100000 }),
  ]);

  const mapper = buildMapper({
    organizationId,
    phoneNumbers: phoneNumbersResult.rows,
    callRecords: callRecordsResult.rows,
    twilioAccounts: twilioAccountsResult.rows,
  });

  const steps = [];
  steps.push(
    await syncProviderMappings({
      organizationId,
      phoneNumbers: phoneNumbersResult.rows,
      callRecords: callRecordsResult.rows,
      twilioAccounts: twilioAccountsResult.rows,
    }),
  );
  const providerResources = await loadProviderResourcesForOrg(organizationId);
  enrichMapperFromProviderResources(mapper, providerResources, organizationId);
  steps.push({
    provider: "provider_resource_mapping",
    ok: true,
    source: "billing_provider_resources",
    loaded: providerResources.length,
    mode: "dynamic_db_mapping_v65",
    envMappingsRequired: false,
  });

  try {
    steps.push(
      await reconcileTwilioExact({
        organizationId,
        start: effectiveStart,
        end: effectiveEnd,
        mapper,
      }),
    );
  } catch (err) {
    steps.push({
      provider: "twilio",
      ok: false,
      error: err.message || String(err),
    });
  }

  try {
    steps.push(
      await reconcileOpenAiExact({
        organizationId,
        start: effectiveStart,
        end: effectiveEnd,
      }),
    );
  } catch (err) {
    steps.push({
      provider: "openai",
      ok: false,
      error: err.message || String(err),
    });
  }

  try {
    steps.push(
      await reconcileElevenLabsRuntimeAttribution({
        organizationId,
        start: effectiveStart,
        end: effectiveEnd,
      }),
    );
  } catch (err) {
    steps.push({
      provider: "elevenlabs",
      ok: false,
      error: err.message || String(err),
    });
  }

  try {
    steps.push(
      await reconcileRailwayRuntimeAllocation({
        organizationId,
        start: effectiveStart,
        end: effectiveEnd,
        callRecords: callRecordsResult.rows,
      }),
    );
  } catch (err) {
    steps.push({
      provider: "railway",
      ok: false,
      error: err.message || String(err),
    });
  }

  try {
    steps.push(await reconcileSupabaseStorageAndDb({ organizationId }));
  } catch (err) {
    steps.push({
      provider: "supabase",
      ok: false,
      error: err.message || String(err),
    });
  }

  try {
    steps.push(
      await reconcileInternalAgentlyAssets({
        organizationId,
        start: effectiveStart,
        end: effectiveEnd,
        leads: leadsResult.rows,
        knowledgeSources: knowledgeSourcesResult.rows,
        knowledgeChunks: knowledgeChunksResult.rows,
        faqs: faqsResult.rows,
        chatMessages: chatMessagesResult.rows,
      }),
    );
  } catch (err) {
    steps.push({
      provider: "agently_internal",
      ok: false,
      error: err.message || String(err),
    });
  }

  const costRecalc = await recalculateUsageEventCosts({
    organizationId,
    start: effectiveStart,
    end: effectiveEnd,
    limit: 50000,
    force,
  });
  const customerRecalc = await recalculateCustomerCharges({
    organizationId,
    start: effectiveStart,
    end: effectiveEnd,
    force,
    applyWallet,
    limit: 50000,
  });
  const rollup = await rebuildDailyUsageRollups({
    organizationId,
    start: effectiveStart,
    end: effectiveEnd,
  });

  const providerLimitations = steps.flatMap(
    (step) => step.providerLimitations || [],
  );
  const hardErrors = steps.filter((step) => step && step.ok === false);

  return {
    ok: hardErrors.length === 0,
    source: "org_full_cost_reconciliation_v65",
    organizationId,
    period: { start: effectiveStart, end: effectiveEnd },
    force: !!force,
    applyWallet: !!applyWallet,
    organization: {
      id: range.organization.id || organizationId,
      name:
        range.organization.name ||
        range.organization.business_name ||
        range.organization.company_name ||
        null,
      createdAt: range.organization.created_at || null,
    },
    mappingInputs: {
      phoneNumbers: phoneNumbersResult.count,
      callRecords: callRecordsResult.count,
      twilioAccounts: twilioAccountsResult.count,
      leads: leadsResult.count,
      knowledgeSources: knowledgeSourcesResult.count,
      knowledgeChunks: knowledgeChunksResult.count,
      faqs: faqsResult.count,
      chatMessages: chatMessagesResult.count,
    },
    steps,
    costRecalc,
    customerRecalc,
    rollup,
    providerLimitations,
    mappingMode: "dynamic_db_provider_resource_mapping_v65_no_per_org_env",
    envMappingsRequired: false,
    errors: hardErrors,
    next: {
      exactCostReport: `/api/billing-usage/org-cost-baseline?organizationId=${organizationId}&from=onboarding`,
      markdownReport: `/api/billing-usage/org-cost-baseline?organizationId=${organizationId}&from=onboarding&format=markdown`,
    },
  };
}

module.exports = {
  runOrgFullCostReconciliation,
};
