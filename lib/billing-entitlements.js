"use strict";

const { getSupabase } = require("./supabase");
const { insertUsageEvent } = require("./usage-ledger");
const { getPlanLimitStatus, getLimit } = require("./billing-limits");

function clean(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getEnforcementMode() {
  const raw = String(process.env.BILLING_ENFORCEMENT_MODE || "observe").toLowerCase().trim();
  if (["block", "enforce", "hard"].includes(raw)) return "block";
  if (["warn", "soft"].includes(raw)) return "warn";
  return "observe";
}

function actionRequirement(action) {
  const key = String(action || "").toLowerCase().trim();
  const map = {
    create_voice_agent: { limitKey: "voice_agents", label: "Voice agents", quantity: 1 },
    activate_voice_agent: { limitKey: "voice_agents", label: "Voice agents", quantity: 1 },
    create_chatbot: { limitKey: "chatbots", label: "Chatbots", quantity: 1 },
    create_knowledge_base: { limitKey: "knowledge_bases", label: "Knowledge Bases", quantity: 1 },
    create_kb: { limitKey: "knowledge_bases", label: "Knowledge Bases", quantity: 1 },
    buy_phone_number: { limitKey: "phone_numbers", label: "Phone numbers", quantity: 1 },
    assign_phone_number: { limitKey: "phone_numbers", label: "Phone numbers", quantity: 1 },
    create_lead: { limitKey: "leads", label: "Leads", quantity: 1 },
    chatbot_message: { limitKey: "chatbot_conversations", label: "Chatbot conversations", quantity: 1 },
    chatbot_conversation: { limitKey: "chatbot_conversations", label: "Chatbot conversations", quantity: 1 },
    start_voice_call: { limitKey: "voice_minutes", label: "Voice minutes", quantity: 1 },
    schedule_outbound_call: { limitKey: "voice_minutes", label: "Voice minutes", quantity: 1 },
    start_campaign: { limitKey: "voice_minutes", label: "Voice minutes", quantity: 1 },
    rerun_campaign: { limitKey: "voice_minutes", label: "Voice minutes", quantity: 1 },
    sync_knowledge_base: { limitKey: "knowledge_bases", label: "Knowledge Bases", quantity: 0 },
  };
  return map[key] || null;
}

async function writeEntitlementDecision(decision) {
  const sb = getSupabase();
  const payload = {
    organization_id: decision.organizationId || null,
    user_id: decision.userId || null,
    action: decision.action,
    limit_key: decision.limitKey || null,
    requested_quantity: decision.requestedQuantity || 0,
    used_quantity: decision.usedQuantity || 0,
    included_quantity: decision.includedQuantity,
    projected_quantity: decision.projectedQuantity || 0,
    decision: decision.decision,
    enforcement_mode: decision.enforcementMode,
    plan_key: decision.planKey || null,
    plan_name: decision.planName || null,
    reason: decision.reason || null,
    metadata: decision.metadata || {},
    created_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from("billing_entitlement_decisions").insert(payload).select("*").single();
  if (!error) return data;

  await insertUsageEvent({
    organizationId: decision.organizationId || null,
    userId: decision.userId || null,
    provider: "agently",
    service: "billing_entitlement",
    eventType: `entitlement_${decision.decision || "unknown"}`,
    unit: "decision",
    quantity: 1,
    billable: false,
    source: "billing_entitlements",
    metadata: {
      ...payload,
      table_insert_error: error.message,
    },
  });
  return null;
}

async function evaluateEntitlement({ organizationId, userId, action, requestedQuantity, metadata, writeDecision = true }) {
  const orgId = clean(organizationId);
  if (!orgId) throw new Error("organizationId is required");
  const normalizedAction = String(action || "").toLowerCase().trim();
  if (!normalizedAction) throw new Error("action is required");

  const requirement = actionRequirement(normalizedAction);
  const status = await getPlanLimitStatus({ organizationId: orgId });
  const enforcementMode = getEnforcementMode();
  const qty = safeNumber(requestedQuantity, requirement?.quantity ?? 1);

  let decision = {
    organizationId: orgId,
    userId: clean(userId),
    action: normalizedAction,
    requestedQuantity: qty,
    limitKey: requirement?.limitKey || null,
    limitLabel: requirement?.label || null,
    usedQuantity: null,
    includedQuantity: null,
    projectedQuantity: null,
    usedPercent: null,
    planKey: status.planKey,
    planName: status.catalogPlanName || status.plan || status.planKey,
    enforcementMode,
    decision: "allow",
    reason: "No matching plan limit for this action.",
    status,
    metadata: metadata || {},
  };

  if (requirement?.limitKey) {
    const limit = getLimit(status, requirement.limitKey);
    const used = safeNumber(limit?.used);
    const included = limit?.included == null ? null : safeNumber(limit.included);
    const projected = used + qty;
    const wouldExceed = included != null && included >= 0 && projected > included;
    const alreadyOver = limit?.status === "over_limit";
    const nearLimit = !wouldExceed && limit?.status === "warning";

    decision = {
      ...decision,
      usedQuantity: used,
      includedQuantity: included,
      projectedQuantity: projected,
      usedPercent: included && included > 0 ? Math.round((projected / included) * 10000) / 100 : null,
      limitStatus: limit?.status || "unknown",
      overBy: included == null ? null : Math.max(projected - included, 0),
    };

    if (wouldExceed || alreadyOver) {
      if (enforcementMode === "block") {
        decision.decision = "block";
        decision.reason = `${requirement.label} limit would be exceeded for this plan.`;
      } else if (enforcementMode === "warn") {
        decision.decision = "warn";
        decision.reason = `${requirement.label} limit would be exceeded, but enforcement is soft.`;
      } else {
        decision.decision = "allow_observe_over_limit";
        decision.reason = `${requirement.label} limit would be exceeded, but enforcement is observe-only.`;
      }
    } else if (nearLimit) {
      decision.decision = enforcementMode === "observe" ? "allow_observe_warning" : "warn";
      decision.reason = `${requirement.label} is above the warning threshold.`;
    } else {
      decision.reason = `${requirement.label} is within plan allowance.`;
    }
  }

  if (writeDecision) {
    try {
      decision.record = await writeEntitlementDecision(decision);
    } catch (err) {
      decision.recordError = err.message;
    }
  }

  return decision;
}

async function assertEntitlement(options) {
  const decision = await evaluateEntitlement(options);
  if (decision.decision === "block") {
    const err = new Error(decision.reason || "Plan limit exceeded.");
    err.status = 402;
    err.code = "plan_limit_exceeded";
    err.billingDecision = decision;
    throw err;
  }
  return decision;
}

module.exports = {
  actionRequirement,
  evaluateEntitlement,
  assertEntitlement,
  getEnforcementMode,
};
