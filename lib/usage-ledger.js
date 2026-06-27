"use strict";

const fetch = require("node-fetch");
const crypto = require("crypto");
const { getSupabase } = require("./supabase");

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeJson(value) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return {};
  }
}

function stableKey(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).map(String).join("|"))
    .digest("hex");
}

function normalizeDirection(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("inbound")) return "inbound";
  if (raw.includes("outbound")) return "outbound";
  return raw || null;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[\s().-]/g, "");
  return cleaned.startsWith("+") ? cleaned : raw;
}

function safeSid(value) {
  return String(value || "").trim();
}

function validDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function twilioAuthHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function masterTwilioSid() {
  return safeSid(process.env.TWILIO_ACCOUNT_SID);
}

function masterTwilioToken() {
  return safeSid(process.env.TWILIO_AUTH_TOKEN);
}

async function lookupProviderResource({ provider, resourceType, externalId }) {
  const id = String(externalId || "").trim();
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
  } catch (err) {
    // Keep the ledger non-breaking while migrations roll out.
    return null;
  }
}

async function upsertProviderResource({
  organizationId,
  provider,
  resourceType,
  externalId,
  displayValue,
  metadata,
}) {
  if (!organizationId || !provider || !resourceType || !externalId) return null;
  const sb = getSupabase();
  const payload = {
    organization_id: organizationId,
    provider,
    resource_type: resourceType,
    external_id: String(externalId),
    display_value: displayValue || String(externalId),
    metadata: safeJson(metadata),
  };
  try {
    const { data, error } = await sb
      .from("billing_provider_resources")
      .upsert(payload, { onConflict: "provider,resource_type,external_id" })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (err) {
    console.warn("[usage-ledger] provider resource upsert skipped", err.message || String(err));
    return null;
  }
}

async function findOrganizationByTwilioAccountSid(accountSid) {
  const sid = safeSid(accountSid);
  if (!sid) return null;

  const mapped = await lookupProviderResource({
    provider: "twilio",
    resourceType: "account_sid",
    externalId: sid,
  });
  if (mapped?.organization_id) return { organizationId: mapped.organization_id, source: "billing_provider_resources.account_sid" };

  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("twilio_accounts")
      .select("organization_id, account_sid, parent_account_sid, is_primary")
      .eq("account_sid", sid)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    if (data?.organization_id) {
      await upsertProviderResource({
        organizationId: data.organization_id,
        provider: "twilio",
        resourceType: "account_sid",
        externalId: sid,
        metadata: { source: "twilio_accounts" },
      });
      return { organizationId: data.organization_id, source: "twilio_accounts.account_sid" };
    }
  } catch (_) {}
  return null;
}

async function findOrganizationByTwilioNumber(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  const mapped = await lookupProviderResource({
    provider: "twilio",
    resourceType: "phone_number",
    externalId: normalized,
  });
  if (mapped?.organization_id) return { organizationId: mapped.organization_id, source: "billing_provider_resources.phone_number" };

  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("twilio_phone_numbers")
      .select("organization_id, phone_number, phone_sid")
      .eq("phone_number", normalized)
      .limit(1)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    if (data?.organization_id) {
      await upsertProviderResource({
        organizationId: data.organization_id,
        provider: "twilio",
        resourceType: "phone_number",
        externalId: normalized,
        displayValue: data.phone_number || normalized,
        metadata: { source: "twilio_phone_numbers", phone_sid: data.phone_sid || null },
      });
      if (data.phone_sid) {
        await upsertProviderResource({
          organizationId: data.organization_id,
          provider: "twilio",
          resourceType: "phone_sid",
          externalId: data.phone_sid,
          displayValue: data.phone_number || normalized,
          metadata: { source: "twilio_phone_numbers", phone_number: normalized },
        });
      }
      return { organizationId: data.organization_id, source: "twilio_phone_numbers.phone_number" };
    }
  } catch (_) {}
  return null;
}

async function findOrganizationByCallSid(callSid) {
  const sid = safeSid(callSid);
  if (!sid) return null;
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("call_records")
      .select("id, organization_id, voice_agent_id, twilio_call_sid")
      .eq("twilio_call_sid", sid)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    if (data?.organization_id) {
      return {
        organizationId: data.organization_id,
        callId: data.id || null,
        voiceAgentId: data.voice_agent_id || null,
        source: "call_records.twilio_call_sid",
      };
    }
  } catch (_) {}
  return null;
}

async function resolveTwilioOwner({ accountSid, callSid, from, to, organizationId }) {
  if (organizationId) return { organizationId, source: "explicit" };

  const byCall = await findOrganizationByCallSid(callSid);
  if (byCall?.organizationId) return byCall;

  const byAccount = await findOrganizationByTwilioAccountSid(accountSid);
  if (byAccount?.organizationId) return byAccount;

  const candidates = [to, from].map(normalizePhone).filter(Boolean);
  for (const number of candidates) {
    const byNumber = await findOrganizationByTwilioNumber(number);
    if (byNumber?.organizationId) return byNumber;
  }

  return { organizationId: null, source: "unmatched" };
}


async function findRateCard({ provider, service, eventType, unit, occurredAt }) {
  if (!provider || !service || !unit) return null;
  const sb = getSupabase();
  const when = validDate(occurredAt) || nowIso();
  const candidates = [
    { provider, service, event_type: eventType || "usage", unit },
    { provider, service, event_type: "*", unit },
    { provider, service: "*", event_type: "*", unit },
  ];

  for (const c of candidates) {
    try {
      const { data, error } = await sb
        .from("billing_rate_cards")
        .select("id,provider,service,event_type,unit,unit_cost_usd,effective_from,effective_to,metadata")
        .eq("provider", c.provider)
        .eq("service", c.service)
        .eq("event_type", c.event_type)
        .eq("unit", c.unit)
        .lte("effective_from", when)
        .or(`effective_to.is.null,effective_to.gte.${when}`)
        .order("effective_from", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (Array.isArray(data) && data[0]) return data[0];
    } catch (_) {
      return null;
    }
  }
  return null;
}

async function estimateUsageEventCost({ provider, service, eventType, unit, quantity, occurredAt }) {
  const rate = await findRateCard({ provider, service, eventType, unit, occurredAt });
  if (!rate || rate.unit_cost_usd == null) return null;
  const unitCostUsd = safeNumber(rate.unit_cost_usd);
  const estimatedCostUsd = Math.round(safeNumber(quantity) * unitCostUsd * 100000000) / 100000000;
  return {
    unitCostUsd,
    estimatedCostUsd,
    rateCard: {
      id: rate.id,
      provider: rate.provider,
      service: rate.service,
      eventType: rate.event_type,
      unit: rate.unit,
      unitCostUsd,
    },
  };
}

async function recalculateUsageEventCosts({ organizationId = null, start = null, end = null, limit = 5000, force = false } = {}) {
  const sb = getSupabase();
  let query = sb
    .from("billing_usage_events")
    .select("id,organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,occurred_at,metadata")
    .not("quantity", "is", null)
    .not("unit", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 5000, 1), 20000));
  if (organizationId) query = query.eq("organization_id", organizationId);
  if (!force) query = query.is("estimated_cost_usd", null);
  if (start) query = query.gte("occurred_at", start);
  if (end) query = query.lte("occurred_at", end);

  const { data, error } = await query;
  if (error) throw error;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of data || []) {
    scanned += 1;
    const rated = await estimateUsageEventCost({
      provider: row.provider,
      service: row.service,
      eventType: row.event_type,
      unit: row.unit,
      quantity: row.quantity,
      occurredAt: row.occurred_at,
    });
    if (!rated || rated.estimatedCostUsd == null) {
      skipped += 1;
      continue;
    }
    const nextMetadata = {
      ...(row.metadata || {}),
      rate_card: rated.rateCard,
      cost_source: "billing_rate_cards_recalculation",
      cost_recalculated_at: nowIso(),
    };
    const { error: updateErr } = await sb
      .from("billing_usage_events")
      .update({
        unit_cost_usd: rated.unitCostUsd,
        estimated_cost_usd: rated.estimatedCostUsd,
        metadata: nextMetadata,
      })
      .eq("id", row.id);
    if (updateErr) throw updateErr;
    updated += 1;
  }

  return { organizationId, start, end, force: !!force, scanned, updated, skipped };
}

async function insertUsageEvent(event) {
  const sb = getSupabase();
  const quantityForCost = event.quantity == null ? null : safeNumber(event.quantity);
  let resolvedUnitCostUsd =
    event.unitCostUsd == null && event.unit_cost_usd == null
      ? null
      : safeNumber(event.unitCostUsd || event.unit_cost_usd);
  let resolvedEstimatedCostUsd =
    event.estimatedCostUsd == null && event.estimated_cost_usd == null
      ? null
      : safeNumber(event.estimatedCostUsd || event.estimated_cost_usd);

  if (resolvedEstimatedCostUsd == null && quantityForCost != null && event.provider && event.service && event.unit) {
    try {
      const rated = await estimateUsageEventCost({
        provider: event.provider,
        service: event.service,
        eventType: event.eventType || event.event_type || "usage",
        unit: event.unit,
        quantity: quantityForCost,
        occurredAt: event.occurredAt || event.occurred_at || nowIso(),
      });
      if (rated && rated.estimatedCostUsd != null) {
        resolvedUnitCostUsd = rated.unitCostUsd;
        resolvedEstimatedCostUsd = rated.estimatedCostUsd;
        event.metadata = {
          ...(event.metadata || {}),
          rate_card: rated.rateCard || null,
          cost_source: "billing_rate_cards",
        };
      }
    } catch (err) {
      // Costing must never block product usage. Missing rate cards simply leave cost null.
    }
  }

  const payload = {
    organization_id: event.organizationId || event.organization_id || null,
    user_id: event.userId || event.user_id || null,
    provider: event.provider,
    service: event.service,
    event_type: event.eventType || event.event_type || "usage",
    source: event.source || "agently_backend",
    external_id: event.externalId || event.external_id || null,
    idempotency_key:
      event.idempotencyKey ||
      event.idempotency_key ||
      stableKey([
        event.provider,
        event.service,
        event.eventType || event.event_type,
        event.externalId || event.external_id,
        event.callId || event.call_id,
        event.organizationId || event.organization_id || event.metadata?.owner_resolution?.organizationId,
        event.occurredAt || event.occurred_at,
      ]),
    call_id: event.callId || event.call_id || null,
    chatbot_id: event.chatbotId || event.chatbot_id || null,
    voice_agent_id: event.voiceAgentId || event.voice_agent_id || null,
    knowledge_base_id: event.knowledgeBaseId || event.knowledge_base_id || null,
    lead_id: event.leadId || event.lead_id || null,
    unit: event.unit || null,
    quantity: quantityForCost,
    unit_cost_usd: resolvedUnitCostUsd,
    estimated_cost_usd: resolvedEstimatedCostUsd,
    billable: event.billable !== false,
    occurred_at: event.occurredAt || event.occurred_at || nowIso(),
    metadata: safeJson(event.metadata),
  };

  // Prefer the DB writer when the V38 migration has been run. It gives us one canonical
  // ingestion path for validation, idempotency, and rate-card cost lookup.
  try {
    const { data, error } = await sb.rpc("record_billing_usage_event", {
      p_organization_id: payload.organization_id,
      p_provider: payload.provider,
      p_service: payload.service,
      p_unit: payload.unit,
      p_quantity: payload.quantity,
      p_occurred_at: payload.occurred_at,
      p_event_type: payload.event_type,
      p_source: payload.source,
      p_external_id: payload.external_id,
      p_idempotency_key: payload.idempotency_key,
      p_user_id: payload.user_id,
      p_call_id: payload.call_id,
      p_chatbot_id: payload.chatbot_id,
      p_voice_agent_id: payload.voice_agent_id,
      p_knowledge_base_id: payload.knowledge_base_id,
      p_lead_id: payload.lead_id,
      p_unit_cost_usd: payload.unit_cost_usd,
      p_estimated_cost_usd: payload.estimated_cost_usd,
      p_billable: payload.billable,
      p_metadata: payload.metadata,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] || null : data || null;
    await maybeChargeCustomerWalletForUsageEvent(row, payload);
    return row;
  } catch (rpcError) {
    const message = rpcError?.message || String(rpcError);
    const missingFunction = /record_billing_usage_event|function .* does not exist|Could not find the function/i.test(message);
    if (!missingFunction) {
      console.error("[usage-ledger] rpc insert failed", message, payload.provider, payload.service);
      throw rpcError;
    }
    console.warn("[usage-ledger] record_billing_usage_event missing; falling back to direct insert");
  }

  const { data, error } = await sb
    .from("billing_usage_events")
    .upsert(payload, { onConflict: "idempotency_key" })
    .select("id")
    .single();

  if (error) {
    console.error("[usage-ledger] insert failed", error.message, payload.provider, payload.service);
    throw error;
  }
  await maybeChargeCustomerWalletForUsageEvent(data, payload);
  return data;
}

function isAutoWalletChargeEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.BILLING_AUTO_CHARGE_WALLET || "").toLowerCase());
}

async function maybeChargeCustomerWalletForUsageEvent(row, payload) {
  const usageEventId = row?.id || row?.usage_event_id || null;
  const organizationId = payload?.organization_id || row?.organization_id || null;
  if (!usageEventId || !organizationId) return null;
  if (payload?.billable === false) return null;
  if (!isAutoWalletChargeEnabled()) return null;

  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc("billing_admin_charge_usage_event", {
      p_usage_event_id: usageEventId,
      p_apply_wallet: true,
      p_force: false,
    });
    if (error) throw error;
    return data || null;
  } catch (err) {
    // Product usage must never fail because the billing-wallet layer has not been
    // migrated yet. This warning tells us the event was logged but not deducted.
    console.warn(
      "[usage-ledger] automatic wallet charge skipped",
      usageEventId,
      err?.message || String(err),
    );
    return null;
  }
}

async function logOpenAIUsage({
  organizationId,
  userId,
  service,
  eventType = "openai_tokens",
  model,
  usage,
  inputTokens,
  outputTokens,
  cachedInputTokens,
  audioInputTokens,
  audioOutputTokens,
  estimatedCostUsd,
  callId,
  chatbotId,
  voiceAgentId,
  knowledgeBaseId,
  leadId,
  externalId,
  metadata,
}) {
  const normalized = {
    input_tokens: safeNumber(inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens),
    output_tokens: safeNumber(outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens),
    cached_input_tokens: safeNumber(cachedInputTokens ?? usage?.input_token_details?.cached_tokens),
    audio_input_tokens: safeNumber(audioInputTokens ?? usage?.input_token_details?.audio_tokens),
    audio_output_tokens: safeNumber(audioOutputTokens ?? usage?.output_token_details?.audio_tokens),
  };
  const total =
    normalized.input_tokens +
    normalized.output_tokens +
    normalized.cached_input_tokens +
    normalized.audio_input_tokens +
    normalized.audio_output_tokens;
  return insertUsageEvent({
    organizationId,
    userId,
    provider: "openai",
    service,
    eventType,
    externalId,
    callId,
    chatbotId,
    voiceAgentId,
    knowledgeBaseId,
    leadId,
    unit: "tokens",
    quantity: total,
    estimatedCostUsd,
    metadata: { model, usage: safeJson(usage), ...normalized, ...(metadata || {}) },
  });
}

async function logElevenLabsUsage({
  organizationId,
  userId,
  service = "tts",
  eventType = "elevenlabs_synthesis",
  voiceId,
  modelId,
  characters,
  credits,
  estimatedCostUsd,
  callId,
  voiceAgentId,
  externalId,
  metadata,
}) {
  return insertUsageEvent({
    organizationId,
    userId,
    provider: "elevenlabs",
    service,
    eventType,
    externalId,
    callId,
    voiceAgentId,
    unit: credits != null ? "credits" : "characters",
    quantity: safeNumber(credits ?? characters),
    estimatedCostUsd,
    metadata: { voice_id: voiceId, model_id: modelId, characters, credits, ...(metadata || {}) },
  });
}

async function logTwilioCallUsage({
  organizationId,
  userId,
  accountSid,
  callSid,
  parentCallSid,
  direction,
  status,
  durationSeconds,
  price,
  priceUnit,
  from,
  to,
  callId,
  voiceAgentId,
  eventType = "twilio_call",
  metadata,
}) {
  const owner = await resolveTwilioOwner({ accountSid, callSid, from, to, organizationId });
  const minutes = Math.ceil(Math.max(0, safeNumber(durationSeconds)) / 60);
  return insertUsageEvent({
    organizationId: owner.organizationId,
    userId,
    provider: "twilio",
    service: "voice",
    eventType,
    externalId: callSid,
    callId: callId || owner.callId || null,
    voiceAgentId: voiceAgentId || owner.voiceAgentId || null,
    unit: "minutes",
    quantity: minutes,
    estimatedCostUsd: price == null ? null : Math.abs(safeNumber(price)),
    billable: !!owner.organizationId,
    metadata: {
      call_sid: callSid,
      account_sid: accountSid || null,
      parent_call_sid: parentCallSid || null,
      direction: normalizeDirection(direction),
      status,
      duration_seconds: safeNumber(durationSeconds),
      price,
      price_unit: priceUnit,
      from: normalizePhone(from),
      to: normalizePhone(to),
      owner_resolution: owner,
      unmatched_usage: !owner.organizationId,
      ...(metadata || {}),
    },
  });
}

async function logStorageUsage({
  organizationId,
  provider = "supabase",
  service,
  bytes,
  eventType = "storage_snapshot",
  source = "usage_reconcile",
  metadata,
}) {
  return insertUsageEvent({
    organizationId,
    provider,
    service,
    eventType,
    source,
    unit: "bytes",
    quantity: safeNumber(bytes),
    estimatedCostUsd: null,
    metadata,
  });
}

async function logEmailUsage({
  organizationId,
  userId,
  service = "transactional_email",
  eventType = "email_sent",
  emailType,
  providerMessageId,
  to,
  subject,
  estimatedCostUsd,
  metadata,
}) {
  return insertUsageEvent({
    organizationId,
    userId,
    provider: "resend",
    service,
    eventType,
    externalId: providerMessageId || null,
    unit: "email",
    quantity: 1,
    estimatedCostUsd,
    metadata: {
      email_type: emailType || eventType,
      to_domain: String(to || "").split("@").pop() || null,
      subject: subject || null,
      provider_message_id: providerMessageId || null,
      ...(metadata || {}),
    },
  });
}

async function buildTenantUsageReport({ organizationId = null, start = null, end = null } = {}) {
  const sb = getSupabase();
  let orgQuery = sb
    .from("organizations")
    .select("id,name,plan,metadata,created_at,onboarded,timezone,location")
    .order("created_at", { ascending: false })
    .limit(500);
  if (organizationId) orgQuery = orgQuery.eq("id", organizationId);

  const { data: orgs, error: orgErr } = await orgQuery;
  if (orgErr) throw orgErr;

  let usageQuery = sb
    .from("billing_usage_events")
    .select("organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,billable,occurred_at")
    .not("organization_id", "is", null)
    .limit(50000);
  if (organizationId) usageQuery = usageQuery.eq("organization_id", organizationId);
  if (start) usageQuery = usageQuery.gte("occurred_at", start);
  if (end) usageQuery = usageQuery.lte("occurred_at", end);

  const { data: usageRows, error: usageErr } = await usageQuery;
  if (usageErr) throw usageErr;

  const usageByOrg = new Map();
  for (const row of usageRows || []) {
    const id = row.organization_id;
    if (!usageByOrg.has(id)) {
      usageByOrg.set(id, {
        eventCount: 0,
        estimatedCostUsd: 0,
        twilioVoiceMinutes: 0,
        twilioMediaStreamSeconds: 0,
        openaiTokens: 0,
        elevenlabsCharacters: 0,
        elevenlabsCredits: 0,
        resendEmails: 0,
        supabaseStorageBytes: 0,
        railwayRuntimeSeconds: 0,
        byProvider: {},
      });
    }
    const item = usageByOrg.get(id);
    const qty = safeNumber(row.quantity);
    const cost = safeNumber(row.estimated_cost_usd);
    item.eventCount += 1;
    item.estimatedCostUsd += cost;
    const provider = row.provider || "unknown";
    const unit = row.unit || "unit";
    item.byProvider[provider] = item.byProvider[provider] || { quantityByUnit: {}, estimatedCostUsd: 0, eventCount: 0 };
    item.byProvider[provider].quantityByUnit[unit] = safeNumber(item.byProvider[provider].quantityByUnit[unit]) + qty;
    item.byProvider[provider].estimatedCostUsd += cost;
    item.byProvider[provider].eventCount += 1;

    if (provider === "twilio" && row.service === "voice" && unit === "minutes") item.twilioVoiceMinutes += qty;
    if (provider === "twilio" && row.service === "media_stream" && unit === "seconds") item.twilioMediaStreamSeconds += qty;
    if (provider === "openai" && unit === "tokens") item.openaiTokens += qty;
    if (provider === "elevenlabs" && unit === "characters") item.elevenlabsCharacters += qty;
    if (provider === "elevenlabs" && unit === "credits") item.elevenlabsCredits += qty;
    if (provider === "resend" && unit === "email") item.resendEmails += qty;
    if (provider === "supabase" && unit === "bytes") item.supabaseStorageBytes += qty;
    if (provider === "railway" && unit === "seconds") item.railwayRuntimeSeconds += qty;
  }

  const reports = [];
  for (const org of orgs || []) {
    let userCount = 0;
    try {
      const { count } = await sb
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      userCount = count || 0;
    } catch (_) {}
    let numberCount = 0;
    try {
      const { count } = await sb
        .from("twilio_phone_numbers")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      numberCount = count || 0;
    } catch (_) {}
    const usage = usageByOrg.get(org.id) || {
      eventCount: 0,
      estimatedCostUsd: 0,
      twilioVoiceMinutes: 0,
      twilioMediaStreamSeconds: 0,
      openaiTokens: 0,
      elevenlabsCharacters: 0,
      elevenlabsCredits: 0,
      resendEmails: 0,
      supabaseStorageBytes: 0,
      railwayRuntimeSeconds: 0,
      byProvider: {},
    };
    reports.push({
      organizationId: org.id,
      organizationName: org.name || "Untitled workspace",
      plan: org.plan || (org.metadata && org.metadata.subscription_plan) || "unknown",
      onboarded: !!org.onboarded,
      timezone: org.timezone || null,
      businessLocation: org.location || null,
      createdAt: org.created_at || null,
      users: userCount,
      phoneNumbers: numberCount,
      usage: {
        ...usage,
        estimatedCostUsd: Math.round(safeNumber(usage.estimatedCostUsd) * 10000) / 10000,
        supabaseStorageMb: Math.round((safeNumber(usage.supabaseStorageBytes) / 1024 / 1024) * 1000) / 1000,
      },
    });
  }
  return { start: start || null, end: end || null, organizationId, tenants: reports };
}

async function summarizeUsage({ organizationId, start, end, includeUnassigned = false }) {
  const sb = getSupabase();
  let query = sb
    .from("billing_usage_events")
    .select("organization_id,provider,service,event_type,unit,quantity,estimated_cost_usd,billable,occurred_at")
    .order("occurred_at", { ascending: false });
  if (organizationId) query = query.eq("organization_id", organizationId);
  if (!organizationId && !includeUnassigned) query = query.not("organization_id", "is", null);
  if (start) query = query.gte("occurred_at", start);
  if (end) query = query.lte("occurred_at", end);
  const { data, error } = await query.limit(10000);
  if (error) throw error;
  const rows = data || [];
  const totals = new Map();
  for (const row of rows) {
    const key = [row.organization_id || "unassigned", row.provider, row.service, row.event_type, row.unit || "unit"].join("|");
    if (!totals.has(key)) {
      totals.set(key, {
        organizationId: row.organization_id || null,
        provider: row.provider,
        service: row.service,
        eventType: row.event_type,
        unit: row.unit,
        quantity: 0,
        estimatedCostUsd: 0,
        events: 0,
      });
    }
    const item = totals.get(key);
    item.quantity += safeNumber(row.quantity);
    item.estimatedCostUsd += safeNumber(row.estimated_cost_usd);
    item.events += 1;
  }
  return {
    organizationId: organizationId || null,
    start: start || null,
    end: end || null,
    eventCount: rows.length,
    totals: Array.from(totals.values()).map((x) => ({
      ...x,
      quantity: Math.round(x.quantity * 1000) / 1000,
      estimatedCostUsd: Math.round(x.estimatedCostUsd * 10000) / 10000,
    })),
  };
}

async function createReconciliationRun({ provider, accountSid, startDate, endDate, mode }) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from("billing_reconciliation_runs")
      .insert({
        provider,
        account_sid: accountSid || null,
        start_date: startDate || null,
        end_date: endDate || null,
        mode: mode || null,
        status: "running",
        started_at: nowIso(),
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    return null;
  }
}

async function finishReconciliationRun(id, patch) {
  if (!id) return null;
  const sb = getSupabase();
  try {
    await sb
      .from("billing_reconciliation_runs")
      .update({ ...patch, finished_at: nowIso() })
      .eq("id", id);
  } catch (_) {}
  return null;
}

async function fetchTwilioUsageRecords({ accountSid, startDate, endDate }) {
  const sid = safeSid(accountSid || masterTwilioSid());
  const authToken = masterTwilioToken();
  if (!sid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for Twilio usage reconciliation.");
  }
  const params = new URLSearchParams();
  if (startDate) params.set("StartDate", startDate);
  if (endDate) params.set("EndDate", endDate);
  params.set("PageSize", "1000");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records.json?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: twilioAuthHeader(masterTwilioSid(), authToken) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio usage request failed (${res.status})`);
  return body.usage_records || [];
}

async function fetchTwilioCalls({ accountSid, startDate, endDate }) {
  const sid = safeSid(accountSid || masterTwilioSid());
  const authToken = masterTwilioToken();
  if (!sid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for Twilio call reconciliation.");
  }
  const params = new URLSearchParams();
  if (startDate) params.set("StartTime>=", startDate);
  if (endDate) params.set("StartTime<=", endDate);
  params.set("PageSize", "1000");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: twilioAuthHeader(masterTwilioSid(), authToken) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio calls request failed (${res.status})`);
  return body.calls || [];
}

async function reconcileTwilioAccountUsage({ accountSid, startDate, endDate }) {
  const sid = safeSid(accountSid || masterTwilioSid());
  const owner = await findOrganizationByTwilioAccountSid(sid);
  if (!owner?.organizationId) {
    return {
      count: 0,
      skipped: 0,
      mode: "account_usage_records",
      reason:
        "Account-level Twilio usage records are aggregate. They are only imported when the AccountSid maps to exactly one organization/subaccount.",
      accountSid: sid,
    };
  }

  const runId = await createReconciliationRun({ provider: "twilio", accountSid: sid, startDate, endDate, mode: "account_usage_records" });
  try {
    const records = await fetchTwilioUsageRecords({ accountSid: sid, startDate, endDate });
    const inserted = [];
    for (const record of records) {
      const category = record.category || "unknown";
      const usage = safeNumber(record.usage);
      const price = record.price == null ? null : Math.abs(safeNumber(record.price));
      inserted.push(
        await insertUsageEvent({
          organizationId: owner.organizationId,
          provider: "twilio",
          service: category,
          eventType: "twilio_account_usage_record",
          source: "twilio_usage_api",
          externalId: `${sid}:${record.start_date || startDate || "start"}:${record.end_date || endDate || "end"}:${category}`,
          unit: record.usage_unit || null,
          quantity: usage,
          estimatedCostUsd: price,
          metadata: { ...safeJson(record), account_sid: sid, owner_resolution: owner },
        }),
      );
    }
    await finishReconciliationRun(runId, { status: "success", records_imported: inserted.length, unmatched_records: 0, metadata: { account_sid: sid } });
    return { count: inserted.length, skipped: 0, accountSid: sid, mode: "account_usage_records" };
  } catch (err) {
    await finishReconciliationRun(runId, { status: "failed", error_message: err.message || String(err) });
    throw err;
  }
}

async function reconcileTwilioCallRecords({ accountSid, startDate, endDate }) {
  const sid = safeSid(accountSid || masterTwilioSid());
  const runId = await createReconciliationRun({ provider: "twilio", accountSid: sid, startDate, endDate, mode: "call_records" });
  let imported = 0;
  let skipped = 0;
  try {
    const calls = await fetchTwilioCalls({ accountSid: sid, startDate, endDate });
    for (const call of calls) {
      const owner = await resolveTwilioOwner({
        accountSid: call.account_sid || sid,
        callSid: call.sid,
        from: call.from,
        to: call.to,
      });
      if (!owner?.organizationId) {
        skipped += 1;
        await insertUsageEvent({
          provider: "twilio",
          service: "voice",
          eventType: "twilio_call_unmatched",
          source: "twilio_calls_api",
          externalId: call.sid,
          unit: "minutes",
          quantity: Math.ceil(Math.max(0, safeNumber(call.duration)) / 60),
          billable: false,
          metadata: { account_sid: call.account_sid || sid, from: call.from, to: call.to, status: call.status, owner_resolution: owner },
        });
        continue;
      }
      await logTwilioCallUsage({
        organizationId: owner.organizationId,
        accountSid: call.account_sid || sid,
        callSid: call.sid,
        direction: call.direction,
        status: call.status,
        durationSeconds: call.duration,
        price: call.price,
        priceUnit: call.price_unit,
        from: call.from,
        to: call.to,
        eventType: "twilio_call_reconciled",
        metadata: { raw_call: call, owner_resolution: owner },
      });
      imported += 1;
    }
    await finishReconciliationRun(runId, { status: "success", records_imported: imported, unmatched_records: skipped, metadata: { account_sid: sid } });
    return { count: imported, skipped, accountSid: sid, mode: "call_records" };
  } catch (err) {
    await finishReconciliationRun(runId, { status: "failed", records_imported: imported, unmatched_records: skipped, error_message: err.message || String(err) });
    throw err;
  }
}


function estimateJsonBytes(rows) {
  try {
    return Buffer.byteLength(JSON.stringify(rows || []), "utf8");
  } catch (_) {
    return 0;
  }
}

async function fetchRowsForStorageEstimate(sb, spec, organizationId) {
  const select = spec.select || "*";
  const limit = spec.limit || 10000;
  let query = sb.from(spec.table).select(select).limit(limit);

  if (spec.orgColumn) {
    query = query.eq(spec.orgColumn, organizationId);
  } else if (spec.filter) {
    query = spec.filter(query, organizationId);
  } else {
    query = query.eq("organization_id", organizationId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function listStoragePrefixBytes({ bucket, prefix, maxDepth = 4 }) {
  const sb = getSupabase();
  const files = [];
  async function walk(path, depth) {
    if (depth > maxDepth) return;
    const { data, error } = await sb.storage.from(bucket).list(path, { limit: 1000, offset: 0 });
    if (error) throw error;
    for (const item of data || []) {
      const name = item.name || "";
      const fullPath = path ? `${path}/${name}` : name;
      const isFolder = !item.id && !item.metadata?.size && !item.updated_at;
      if (isFolder) {
        await walk(fullPath, depth + 1);
      } else {
        const bytes = safeNumber(item.metadata?.size ?? item.size, 0);
        files.push({ path: fullPath, bytes, updated_at: item.updated_at || item.created_at || null });
      }
    }
  }
  await walk(prefix.replace(/^\/+|\/+$/g, ""), 0);
  return {
    bucket,
    prefix,
    files: files.length,
    bytes: files.reduce((sum, item) => sum + safeNumber(item.bytes), 0),
    sample: files.slice(0, 25),
  };
}

async function estimateTenantStorageBytes(organizationId) {
  if (!organizationId) throw new Error("organizationId is required for storage reconciliation.");
  const sb = getSupabase();
  const tables = [
    { table: "knowledge_bases", select: "id,name,description,metadata,created_at,updated_at", orgColumn: "organization_id" },
    { table: "knowledge_sources", select: "id,knowledge_base_id,title,url,status,metadata,created_at,updated_at", orgColumn: "organization_id" },
    { table: "knowledge_chunks", select: "id,content,metadata,knowledge_base_id,source_id,created_at,updated_at", orgColumn: "organization_id" },
    { table: "faqs", select: "id,question,answer,metadata,knowledge_base_id,voice_agent_id,created_at,updated_at", orgColumn: "organization_id" },
    { table: "scraped_products", select: "id,name,description,metadata,knowledge_base_id,created_at,updated_at", orgColumn: "organization_id" },
    { table: "call_records", select: "id,caller_name,caller_phone,duration,outcome,summary,transcript,metadata,recording_url,recording_storage_path,created_at,timestamp", orgColumn: "organization_id" },
    { table: "leads", select: "id,name,email,phone,reason,status,source,notes,metadata,created_at,updated_at", orgColumn: "organization_id" },
    { table: "chat_messages", select: "id,chatbot_id,role,text,created_at", orgColumn: "organization_id" },
    { table: "chatbots", select: "id,name,custom_prompt,suggested_prompts,faqs,metadata,created_at,updated_at", orgColumn: "organization_id" },
    { table: "voice_agents", select: "id,name,greeting,system_prompt,custom_instructions,call_purpose,metadata,created_at,updated_at", orgColumn: "organization_id" },
    { table: "invoices", select: "id,amount,status,pdf_url,date,created_at", orgColumn: "organization_id" },
  ];

  const tableResults = [];
  let tableBytes = 0;
  for (const spec of tables) {
    try {
      const rows = await fetchRowsForStorageEstimate(sb, spec, organizationId);
      const bytes = estimateJsonBytes(rows);
      tableBytes += bytes;
      tableResults.push({ table: spec.table, rows: rows.length, bytes, mb: Math.round((bytes / 1024 / 1024) * 1000) / 1000 });
    } catch (err) {
      tableResults.push({ table: spec.table, error: err.message || String(err), rows: 0, bytes: 0, mb: 0 });
    }
  }

  const bucketResults = [];
  const buckets = [
    { bucket: process.env.SUPABASE_RECORDINGS_BUCKET || "call-recordings", prefix: organizationId },
    { bucket: process.env.SUPABASE_ATTACHMENTS_BUCKET || "attachments", prefix: organizationId },
    { bucket: process.env.SUPABASE_KNOWLEDGE_BUCKET || "knowledge", prefix: organizationId },
  ];
  let bucketBytes = 0;
  for (const spec of buckets) {
    try {
      const result = await listStoragePrefixBytes(spec);
      bucketBytes += safeNumber(result.bytes);
      bucketResults.push({ ...result, mb: Math.round((safeNumber(result.bytes) / 1024 / 1024) * 1000) / 1000 });
    } catch (err) {
      bucketResults.push({ bucket: spec.bucket, prefix: spec.prefix, error: err.message || String(err), files: 0, bytes: 0, mb: 0 });
    }
  }

  const totalBytes = tableBytes + bucketBytes;
  await logStorageUsage({
    organizationId,
    service: "tenant_storage_estimate",
    bytes: totalBytes,
    metadata: {
      method: "json_row_bytes_plus_storage_prefix_listing",
      table_bytes: tableBytes,
      bucket_bytes: bucketBytes,
      tables: tableResults,
      buckets: bucketResults,
    },
  });

  return {
    organizationId,
    totalBytes,
    tableBytes,
    bucketBytes,
    totalMb: Math.round((totalBytes / 1024 / 1024) * 1000) / 1000,
    tableMb: Math.round((tableBytes / 1024 / 1024) * 1000) / 1000,
    bucketMb: Math.round((bucketBytes / 1024 / 1024) * 1000) / 1000,
    tables: tableResults,
    buckets: bucketResults,
  };
}

async function estimateAllTenantStorageBytes({ organizationId = null, limit = 500 } = {}) {
  const sb = getSupabase();
  let query = sb.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(Math.min(Math.max(Number(limit) || 500, 1), 1000));
  if (organizationId) query = query.eq("id", organizationId);
  const { data, error } = await query;
  if (error) throw error;
  const results = [];
  for (const org of data || []) {
    try {
      const storage = await estimateTenantStorageBytes(org.id);
      results.push({ organizationId: org.id, organizationName: org.name || null, ok: true, storage });
    } catch (err) {
      results.push({ organizationId: org.id, organizationName: org.name || null, ok: false, error: err.message || String(err) });
    }
  }
  return { count: results.length, results };
}

function toDateOnly(value, fallback) {
  const raw = String(value || "").trim();
  const d = raw ? new Date(raw) : new Date(fallback);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

async function rebuildDailyUsageRollups({ organizationId = null, start = null, end = null } = {}) {
  const sb = getSupabase();
  const startDate = toDateOnly(start, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const endDate = toDateOnly(end, new Date().toISOString());
  let query = sb
    .from("billing_usage_events")
    .select("organization_id,provider,service,unit,quantity,estimated_cost_usd,occurred_at,billable")
    .gte("occurred_at", `${startDate}T00:00:00.000Z`)
    .lte("occurred_at", `${endDate}T23:59:59.999Z`)
    .not("organization_id", "is", null)
    .limit(100000);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query;
  if (error) throw error;

  const groups = new Map();
  for (const row of data || []) {
    const usageDate = String(row.occurred_at || "").slice(0, 10);
    const key = [row.organization_id, usageDate, row.provider, row.service, row.unit || "unit"].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        organization_id: row.organization_id,
        usage_date: usageDate,
        provider: row.provider || "unknown",
        service: row.service || "unknown",
        unit: row.unit || "unit",
        quantity: 0,
        estimated_cost_usd: 0,
        event_count: 0,
        metadata: { rebuilt_by: "agently_usage_ledger", start_date: startDate, end_date: endDate },
        updated_at: nowIso(),
      });
    }
    const item = groups.get(key);
    item.quantity += safeNumber(row.quantity);
    item.estimated_cost_usd += safeNumber(row.estimated_cost_usd);
    item.event_count += 1;
  }

  const rows = Array.from(groups.values()).map((row) => ({
    ...row,
    quantity: Math.round(row.quantity * 1000000) / 1000000,
    estimated_cost_usd: Math.round(row.estimated_cost_usd * 1000000) / 1000000,
  }));

  if (rows.length) {
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error: upsertErr } = await sb
        .from("billing_usage_daily_rollups")
        .upsert(chunk, { onConflict: "organization_id,usage_date,provider,service,unit" });
      if (upsertErr) throw upsertErr;
    }
  }

  return { organizationId, startDate, endDate, sourceEvents: (data || []).length, rollupRows: rows.length };
}

module.exports = {
  insertUsageEvent,
  logOpenAIUsage,
  logElevenLabsUsage,
  logTwilioCallUsage,
  logStorageUsage,
  logEmailUsage,
  buildTenantUsageReport,
  summarizeUsage,
  reconcileTwilioAccountUsage,
  reconcileTwilioCallRecords,
  estimateTenantStorageBytes,
  estimateAllTenantStorageBytes,
  rebuildDailyUsageRollups,
  recalculateUsageEventCosts,
  estimateUsageEventCost,
  resolveTwilioOwner,
  upsertProviderResource,
};
