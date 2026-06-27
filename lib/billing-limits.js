"use strict";

const { getSupabase } = require("./supabase");
const { insertUsageEvent } = require("./usage-ledger");

function cleanOrgId(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePlanKey(plan) {
  const p = String(plan || "unknown").toLowerCase();
  if (p.includes("starter")) return "starter";
  if (p.includes("pro")) return "pro";
  if (p.includes("business")) return "business";
  if (p.includes("enterprise")) return "enterprise";
  return p || "unknown";
}

async function getOrganizationPlan(organizationId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("organizations")
    .select("id,name,plan,metadata")
    .eq("id", organizationId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  const rawPlan = data?.plan || data?.metadata?.subscription_plan || "unknown";
  return {
    organizationId,
    organizationName: data?.name || null,
    plan: rawPlan,
    planKey: normalizePlanKey(rawPlan),
  };
}

async function getPlanCatalog(planKey) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("billing_plan_catalog")
    .select("*")
    .eq("plan_key", planKey)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function countRows(table, organizationId) {
  const sb = getSupabase();
  const { count, error } = await sb
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) return 0;
  return count || 0;
}

async function sumUsage({ organizationId, provider, service, unit, start }) {
  const sb = getSupabase();
  let query = sb
    .from("billing_usage_events")
    .select("quantity")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("unit", unit)
    .limit(50000);
  if (service) query = query.eq("service", service);
  if (start) query = query.gte("occurred_at", start);
  const { data, error } = await query;
  if (error) return 0;
  return (data || []).reduce((sum, row) => sum + safeNumber(row.quantity), 0);
}

function monthStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function limitRow({ key, label, used, included }) {
  const inc = included == null ? null : safeNumber(included);
  const use = safeNumber(used);
  const percent = inc && inc > 0 ? Math.round((use / inc) * 10000) / 100 : null;
  const over = inc == null ? null : Math.max(use - inc, 0);
  let status = "ok";
  if (over != null && over > 0) status = "over_limit";
  else if (percent != null && percent >= 80) status = "warning";
  return { key, label, used: use, included: inc, overLimit: over, usedPercent: percent, status };
}

async function getPlanLimitStatus({ organizationId }) {
  const orgId = cleanOrgId(organizationId);
  if (!orgId) throw new Error("organizationId is required");

  const plan = await getOrganizationPlan(orgId);
  const catalog = await getPlanCatalog(plan.planKey);
  const included = catalog?.included_usage || {};
  const currentMonthStart = monthStartIso();

  const [
    usedVoiceMinutes,
    usedChatbotConversations,
    voiceAgents,
    chatbots,
    knowledgeBases,
    phoneNumbers,
    leads,
  ] = await Promise.all([
    sumUsage({ organizationId: orgId, provider: "twilio", service: "voice", unit: "minutes", start: currentMonthStart }),
    sumUsage({ organizationId: orgId, provider: "chatbot", service: "conversation", unit: "conversation", start: currentMonthStart }),
    countRows("voice_agents", orgId),
    countRows("chatbots", orgId),
    countRows("knowledge_bases", orgId),
    countRows("twilio_phone_numbers", orgId),
    countRows("leads", orgId),
  ]);

  const limits = [
    limitRow({ key: "voice_minutes", label: "Voice minutes", used: usedVoiceMinutes, included: included.voice_minutes }),
    limitRow({ key: "chatbot_conversations", label: "Chatbot conversations", used: usedChatbotConversations, included: included.chatbot_conversations }),
    limitRow({ key: "voice_agents", label: "Voice agents", used: voiceAgents, included: included.voice_agents }),
    limitRow({ key: "chatbots", label: "Chatbots", used: chatbots, included: included.chatbots }),
    limitRow({ key: "knowledge_bases", label: "Knowledge Bases", used: knowledgeBases, included: included.knowledge_bases }),
    limitRow({ key: "phone_numbers", label: "Phone numbers", used: phoneNumbers, included: included.phone_numbers }),
    limitRow({ key: "leads", label: "Leads", used: leads, included: included.leads }),
  ];

  const status = limits.some((l) => l.status === "over_limit")
    ? "over_limit"
    : limits.some((l) => l.status === "warning")
      ? "warning"
      : "ok";

  return {
    organizationId: orgId,
    organizationName: plan.organizationName,
    plan: plan.plan,
    planKey: plan.planKey,
    catalogPlanName: catalog?.display_name || null,
    monthlyPriceUsd: catalog?.monthly_price_usd ?? null,
    currentMonthStart,
    status,
    limits,
  };
}

function getLimit(status, key) {
  return (status?.limits || []).find((item) => item.key === key) || null;
}

async function logChatbotConversationUsage({ organizationId, userId, chatbotId, messageId, metadata }) {
  return insertUsageEvent({
    organizationId,
    userId,
    provider: "chatbot",
    service: "conversation",
    eventType: "chatbot_conversation",
    externalId: messageId || null,
    chatbotId,
    unit: "conversation",
    quantity: 1,
    metadata: {
      counted_as: "assistant_response",
      ...(metadata || {}),
    },
  });
}

async function createPlanLimitSnapshot({ organizationId, reason = "manual", metadata = {} }) {
  const status = await getPlanLimitStatus({ organizationId });
  await insertUsageEvent({
    organizationId: status.organizationId,
    provider: "agently",
    service: "plan_limit_monitoring",
    eventType: `plan_limit_${status.status}`,
    source: "billing_limits",
    unit: "snapshot",
    quantity: 1,
    billable: false,
    metadata: {
      reason,
      status,
      ...metadata,
    },
  });
  return status;
}

module.exports = {
  getPlanLimitStatus,
  createPlanLimitSnapshot,
  logChatbotConversationUsage,
  getLimit,
};
