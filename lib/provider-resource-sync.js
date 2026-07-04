"use strict";

const { getSupabase } = require("./supabase");
const { upsertProviderResource, insertUsageEvent, reconcileTwilioCallRecords, reconcileTwilioAccountUsage, rebuildDailyUsageRollups } = require("./usage-ledger");

function safeString(value) {
  return String(value == null ? "" : value).trim();
}

function safeNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(value) {
  const raw = safeString(value);
  if (!raw || raw === "all" || raw === "onboarding") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizePhone(value) {
  const raw = safeString(value);
  if (!raw) return "";
  const cleaned = raw.replace(/[\s().-]/g, "");
  return cleaned.startsWith("+") ? cleaned : raw;
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] != null && row[key] !== "") return row[key];
  }
  return null;
}

function jsonSizeBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
  } catch (_) {
    return 0;
  }
}

async function fetchRowsByOrg(table, organizationId, { limit = 50000 } = {}) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .eq("organization_id", organizationId)
      .limit(limit);
    if (error) throw error;
    return { table, rows: data || [], error: null };
  } catch (err) {
    return { table, rows: [], error: err.message || String(err) };
  }
}

async function fetchOrganization(organizationId) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("organizations")
      .select("*")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw error;
    return data || { id: organizationId };
  } catch (_) {
    return { id: organizationId };
  }
}

async function syncTwilioProviderResources({ organizationId }) {
  const org = await fetchOrganization(organizationId);
  const results = [];

  const orgAccountSid = safeString(firstValue(org, ["twilio_account_sid", "account_sid"]));
  if (orgAccountSid) {
    await upsertProviderResource({
      organizationId,
      provider: "twilio",
      resourceType: "account_sid",
      externalId: orgAccountSid,
      displayValue: orgAccountSid,
      metadata: { source_table: "organizations", source_id: org.id || organizationId },
    });
    results.push({ provider: "twilio", resourceType: "account_sid", externalId: orgAccountSid, source: "organizations" });
  }

  const tables = [
    await fetchRowsByOrg("twilio_accounts", organizationId),
    await fetchRowsByOrg("twilio_phone_numbers", organizationId),
    await fetchRowsByOrg("voice_agents", organizationId),
    await fetchRowsByOrg("call_records", organizationId),
  ];

  for (const row of tables[0].rows) {
    const sid = safeString(firstValue(row, ["account_sid", "twilio_account_sid", "subaccount_sid"]));
    if (!sid) continue;
    await upsertProviderResource({
      organizationId,
      provider: "twilio",
      resourceType: "account_sid",
      externalId: sid,
      displayValue: sid,
      metadata: { source_table: "twilio_accounts", source_id: row.id || null, is_primary: row.is_primary ?? null },
    });
    results.push({ provider: "twilio", resourceType: "account_sid", externalId: sid, source: "twilio_accounts" });
  }

  for (const row of tables[1].rows) {
    const phoneSid = safeString(firstValue(row, ["phone_sid", "twilio_phone_sid", "incoming_phone_number_sid", "sid"]));
    const phoneNumber = normalizePhone(firstValue(row, ["phone_number", "number", "twilio_phone_number"]));
    const accountSid = safeString(firstValue(row, ["account_sid", "twilio_account_sid", "subaccount_sid"]));
    if (phoneSid) {
      await upsertProviderResource({
        organizationId,
        provider: "twilio",
        resourceType: "phone_sid",
        externalId: phoneSid,
        displayValue: phoneNumber || phoneSid,
        metadata: { source_table: "twilio_phone_numbers", source_id: row.id || null, phone_number: phoneNumber || null, account_sid: accountSid || null },
      });
      results.push({ provider: "twilio", resourceType: "phone_sid", externalId: phoneSid, source: "twilio_phone_numbers" });
    }
    if (phoneNumber) {
      await upsertProviderResource({
        organizationId,
        provider: "twilio",
        resourceType: "phone_number",
        externalId: phoneNumber,
        displayValue: phoneNumber,
        metadata: { source_table: "twilio_phone_numbers", source_id: row.id || null, phone_sid: phoneSid || null, account_sid: accountSid || null },
      });
      results.push({ provider: "twilio", resourceType: "phone_number", externalId: phoneNumber, source: "twilio_phone_numbers" });
    }
  }

  for (const row of tables[2].rows) {
    const phoneSid = safeString(firstValue(row, ["twilio_phone_sid", "phone_sid"]));
    const phoneNumber = normalizePhone(firstValue(row, ["twilio_phone_number", "phone_number"]));
    if (phoneSid) {
      await upsertProviderResource({
        organizationId,
        provider: "twilio",
        resourceType: "phone_sid",
        externalId: phoneSid,
        displayValue: phoneNumber || phoneSid,
        metadata: { source_table: "voice_agents", source_id: row.id || null, phone_number: phoneNumber || null },
      });
      results.push({ provider: "twilio", resourceType: "phone_sid", externalId: phoneSid, source: "voice_agents" });
    }
    if (phoneNumber) {
      await upsertProviderResource({
        organizationId,
        provider: "twilio",
        resourceType: "phone_number",
        externalId: phoneNumber,
        displayValue: phoneNumber,
        metadata: { source_table: "voice_agents", source_id: row.id || null, phone_sid: phoneSid || null },
      });
      results.push({ provider: "twilio", resourceType: "phone_number", externalId: phoneNumber, source: "voice_agents" });
    }
  }

  for (const row of tables[3].rows) {
    const callSid = safeString(firstValue(row, ["twilio_call_sid", "provider_call_sid", "call_sid"]));
    if (!callSid) continue;
    await upsertProviderResource({
      organizationId,
      provider: "twilio",
      resourceType: "call_sid",
      externalId: callSid,
      displayValue: callSid,
      metadata: { source_table: "call_records", source_id: row.id || null, voice_agent_id: row.voice_agent_id || null },
    });
    results.push({ provider: "twilio", resourceType: "call_sid", externalId: callSid, source: "call_records" });
  }

  return {
    provider: "twilio",
    ok: true,
    resourcesSynced: results.length,
    skippedTables: tables.filter((t) => t.error).map((t) => ({ table: t.table, error: t.error })),
    resources: results,
  };
}

async function syncAgentlyOwnedResources({ organizationId }) {
  const map = [
    { table: "voice_agents", resourceType: "voice_agent" },
    { table: "chatbots", resourceType: "chatbot" },
    { table: "leads", resourceType: "lead" },
    { table: "knowledge_bases", resourceType: "knowledge_base" },
    { table: "knowledge_sources", resourceType: "knowledge_source" },
    { table: "knowledge_chunks", resourceType: "knowledge_chunk" },
    { table: "faqs", resourceType: "faq" },
    { table: "chat_messages", resourceType: "chat_message" },
    { table: "call_records", resourceType: "call_record" },
  ];
  const resources = [];
  const skippedTables = [];
  for (const item of map) {
    const result = await fetchRowsByOrg(item.table, organizationId);
    if (result.error) {
      skippedTables.push({ table: item.table, error: result.error });
      continue;
    }
    for (const row of result.rows) {
      if (!row.id) continue;
      await upsertProviderResource({
        organizationId,
        provider: "agently",
        resourceType: item.resourceType,
        externalId: row.id,
        displayValue: firstValue(row, ["name", "title", "question", "phone", "text"]) || row.id,
        metadata: { source_table: item.table, source_id: row.id },
      });
      resources.push({ provider: "agently", resourceType: item.resourceType, externalId: row.id, source: item.table });
    }
  }
  return { provider: "agently", ok: true, resourcesSynced: resources.length, skippedTables, resources };
}

function getKnownCost(row, keys) {
  for (const key of keys) {
    const n = safeNumber(row[key], null);
    if (n != null) return { value: Math.abs(n), field: key };
  }
  return null;
}

async function backfillTwilioNumberLedger({ organizationId, billingPeriod = null }) {
  const result = await fetchRowsByOrg("twilio_phone_numbers", organizationId);
  if (result.error) return { provider: "twilio", service: "phone_number", ok: false, error: result.error, inserted: 0, missingExactCost: 0 };
  const period = billingPeriod || new Date().toISOString().slice(0, 7);
  let inserted = 0;
  let missingExactCost = 0;
  for (const row of result.rows) {
    const phoneSid = safeString(firstValue(row, ["phone_sid", "twilio_phone_sid", "incoming_phone_number_sid", "sid"]));
    const phoneNumber = normalizePhone(firstValue(row, ["phone_number", "number", "twilio_phone_number"]));
    const accountSid = safeString(firstValue(row, ["account_sid", "twilio_account_sid", "subaccount_sid"]));
    const externalId = phoneSid || phoneNumber || row.id;
    if (!externalId) continue;
    await insertUsageEvent({
      organizationId,
      provider: "twilio",
      service: "phone_number",
      eventType: "twilio_number_inventory",
      source: "phase2_twilio_number_backfill",
      externalId: `inventory:${externalId}`,
      unit: "number",
      quantity: 1,
      estimatedCostUsd: null,
      metadata: { phone_sid: phoneSid || null, phone_number: phoneNumber || null, account_sid: accountSid || null, row_id: row.id || null, billing_period: period, cost_status: "inventory_no_cost" },
    });
    inserted += 1;

    const monthly = getKnownCost(row, ["monthly_price_usd", "monthly_rental_usd", "rental_cost_usd", "monthly_cost_usd", "recurring_cost_usd"]);
    if (monthly) {
      await insertUsageEvent({
        organizationId,
        provider: "twilio",
        service: "phone_number",
        eventType: "twilio_number_monthly_rental",
        source: "phase2_twilio_number_backfill",
        externalId: `rental:${period}:${externalId}`,
        unit: "number_month",
        quantity: 1,
        estimatedCostUsd: monthly.value,
        metadata: { phone_sid: phoneSid || null, phone_number: phoneNumber || null, account_sid: accountSid || null, row_id: row.id || null, billing_period: period, cost_source_field: monthly.field, cost_status: "exact_from_db_field" },
      });
      inserted += 1;
    } else {
      missingExactCost += 1;
      await insertUsageEvent({
        organizationId,
        provider: "twilio",
        service: "phone_number",
        eventType: "twilio_number_monthly_rental_missing_cost",
        source: "phase2_twilio_number_backfill",
        externalId: `rental_missing:${period}:${externalId}`,
        unit: "number_month",
        quantity: 1,
        estimatedCostUsd: null,
        billable: false,
        metadata: { phone_sid: phoneSid || null, phone_number: phoneNumber || null, account_sid: accountSid || null, row_id: row.id || null, billing_period: period, cost_status: "missing_exact_twilio_rental_cost" },
      });
      inserted += 1;
    }

    const purchase = getKnownCost(row, ["purchase_price_usd", "purchase_cost_usd", "setup_cost_usd", "initial_cost_usd"]);
    if (purchase) {
      await insertUsageEvent({
        organizationId,
        provider: "twilio",
        service: "phone_number",
        eventType: "twilio_number_purchase",
        source: "phase2_twilio_number_backfill",
        externalId: `purchase:${externalId}`,
        unit: "number",
        quantity: 1,
        estimatedCostUsd: purchase.value,
        metadata: { phone_sid: phoneSid || null, phone_number: phoneNumber || null, account_sid: accountSid || null, row_id: row.id || null, cost_source_field: purchase.field, cost_status: "exact_from_db_field" },
      });
      inserted += 1;
    }
  }
  return { provider: "twilio", service: "phone_number", ok: true, sourceRows: result.rows.length, inserted, missingExactCost, billingPeriod: period };
}

async function backfillAppOwnedUsage({ organizationId }) {
  const definitions = [
    { table: "leads", provider: "agently", service: "leads", eventType: "lead_created_or_imported", unit: "lead" },
    { table: "call_records", provider: "agently", service: "calls", eventType: "business_call_record", unit: "call" },
    { table: "chat_messages", provider: "agently", service: "chatbot_messages", eventType: "chat_message_stored", unit: "message" },
    { table: "knowledge_sources", provider: "knowledge_base", service: "scrape_sync", eventType: "knowledge_source_record", unit: "source" },
    { table: "knowledge_chunks", provider: "knowledge_base", service: "scrape_sync", eventType: "knowledge_chunk_stored", unit: "chunk" },
    { table: "faqs", provider: "knowledge_base", service: "faq", eventType: "faq_stored", unit: "faq" },
  ];
  const results = [];
  for (const def of definitions) {
    const result = await fetchRowsByOrg(def.table, organizationId);
    if (result.error) {
      results.push({ table: def.table, ok: false, error: result.error, inserted: 0 });
      continue;
    }
    let inserted = 0;
    let bytes = 0;
    for (const row of result.rows) {
      const occurredAt = firstValue(row, ["created_at", "timestamp", "updated_at"]) || nowIso();
      const externalId = `${def.table}:${row.id || Buffer.from(JSON.stringify(row).slice(0, 64)).toString("hex")}`;
      const rowBytes = jsonSizeBytes(row);
      bytes += rowBytes;
      await insertUsageEvent({
        organizationId,
        provider: def.provider,
        service: def.service,
        eventType: def.eventType,
        source: "phase2_app_usage_backfill",
        externalId,
        unit: def.unit,
        quantity: 1,
        estimatedCostUsd: null,
        occurredAt,
        leadId: def.table === "leads" ? row.id || null : null,
        callId: def.table === "call_records" ? row.id || null : null,
        chatbotId: row.chatbot_id || null,
        voiceAgentId: row.voice_agent_id || null,
        knowledgeBaseId: row.knowledge_base_id || row.knowledge_base || null,
        metadata: { source_table: def.table, row_id: row.id || null, row_bytes: rowBytes, cost_status: "usage_counter_no_provider_cost" },
      });
      inserted += 1;
    }
    if (bytes > 0) {
      await insertUsageEvent({
        organizationId,
        provider: "supabase",
        service: "database",
        eventType: `${def.table}_row_bytes_snapshot`,
        source: "phase2_app_usage_backfill",
        externalId: `db_snapshot:${def.table}:${organizationId}`,
        unit: "bytes",
        quantity: bytes,
        estimatedCostUsd: null,
        billable: false,
        metadata: { source_table: def.table, source_rows: result.rows.length, cost_status: "storage_size_snapshot_not_supabase_bill" },
      });
      inserted += 1;
    }
    results.push({ table: def.table, ok: true, sourceRows: result.rows.length, inserted, approxRowBytes: bytes });
  }
  return { provider: "agently_internal", ok: true, tables: results };
}

async function runPhase2ProviderSync({ organizationId, startDate = null, endDate = null, providers = ["mapping", "twilio", "app"], billingPeriod = null } = {}) {
  if (!organizationId) throw new Error("organizationId is required");
  const selected = new Set((Array.isArray(providers) ? providers : String(providers || "").split(",")).map((x) => safeString(x).toLowerCase()).filter(Boolean));
  if (selected.has("all")) {
    selected.add("mapping");
    selected.add("twilio");
    selected.add("app");
  }
  const steps = [];

  if (selected.has("mapping")) {
    steps.push(await syncTwilioProviderResources({ organizationId }));
    steps.push(await syncAgentlyOwnedResources({ organizationId }));
  }

  if (selected.has("twilio")) {
    steps.push(await backfillTwilioNumberLedger({ organizationId, billingPeriod }));
    try {
      steps.push(await reconcileTwilioCallRecords({ accountSid: process.env.TWILIO_ACCOUNT_SID, startDate: dateOnly(startDate), endDate: dateOnly(endDate) }));
    } catch (err) {
      steps.push({ provider: "twilio", service: "voice", ok: false, error: err.message || String(err), reason: "Twilio call import requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." });
    }
    try {
      steps.push(await reconcileTwilioAccountUsage({ accountSid: process.env.TWILIO_ACCOUNT_SID, startDate: dateOnly(startDate), endDate: dateOnly(endDate) }));
    } catch (err) {
      steps.push({ provider: "twilio", service: "account_usage", ok: false, error: err.message || String(err), reason: "Account-level usage is only exact if the Twilio AccountSid maps to this organization or a tenant-specific subaccount." });
    }
  }

  if (selected.has("app")) {
    steps.push(await backfillAppOwnedUsage({ organizationId }));
  }

  let rollup = null;
  try {
    rollup = await rebuildDailyUsageRollups({ organizationId, start: startDate, end: endDate });
  } catch (err) {
    rollup = { ok: false, error: err.message || String(err) };
  }

  return {
    ok: steps.every((s) => s && s.ok !== false),
    source: "agently_usage_ledger_phase2_exact_provider_sync",
    organizationId,
    period: { startDate: startDate || null, endDate: endDate || null, billingPeriod: billingPeriod || null },
    selectedProviders: Array.from(selected),
    generatedAt: nowIso(),
    steps,
    rollup,
    important: [
      "Twilio call rows with provider price are exact provider cost.",
      "Twilio number rental/purchase is exact only when the DB has exact purchase/monthly cost fields or the org has a dedicated Twilio subaccount for account-level usage import.",
      "OpenAI, ElevenLabs, Railway, and Supabase provider bills still require live runtime usage capture; provider dashboards alone cannot reliably split a shared account by organization.",
    ],
  };
}

module.exports = {
  runPhase2ProviderSync,
  syncTwilioProviderResources,
  syncAgentlyOwnedResources,
  backfillTwilioNumberLedger,
  backfillAppOwnedUsage,
};
