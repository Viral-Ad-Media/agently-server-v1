"use strict";

const { getSupabase } = require("./supabase");

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function enforcementMode() {
  const mode = String(
    process.env.BILLING_CREDIT_ENFORCEMENT_MODE || "block",
  ).toLowerCase();
  const normalized = ["observe", "warn", "block"].includes(mode)
    ? mode
    : "block";
  if (
    normalized !== "block" &&
    String(
      process.env.BILLING_ALLOW_CREDIT_OBSERVE_MODE || "",
    ).toLowerCase() !== "true"
  ) {
    return "block";
  }
  return normalized;
}

function isOrgExempt(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return false;
  const raw = String(process.env.BILLING_CREDIT_EXEMPT_ORG_IDS || "");
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(orgId);
}

function minimumForAction(action, override) {
  const activeFloor = Math.max(
    0,
    safeNumber(process.env.BILLING_MIN_ACTIVE_CREDIT_USD, 1),
  );
  if (
    override !== undefined &&
    override !== null &&
    Number.isFinite(Number(override))
  ) {
    return Math.max(activeFloor, 0, Number(override));
  }
  const key = String(action || "usage").toLowerCase();
  const defaults = {
    voice_call: safeNumber(process.env.BILLING_MIN_CALL_CREDIT_USD, 1),
    inbound_call: safeNumber(
      process.env.BILLING_MIN_INBOUND_CALL_CREDIT_USD,
      process.env.BILLING_MIN_CALL_CREDIT_USD || 1,
    ),
    outbound_call: safeNumber(
      process.env.BILLING_MIN_OUTBOUND_CALL_CREDIT_USD,
      process.env.BILLING_MIN_CALL_CREDIT_USD || 1,
    ),
    chatbot_message: safeNumber(process.env.BILLING_MIN_CHAT_CREDIT_USD, 0.05),
    voice_preview: safeNumber(
      process.env.BILLING_MIN_VOICE_PREVIEW_CREDIT_USD,
      0.05,
    ),
    knowledge_sync: safeNumber(
      process.env.BILLING_MIN_KNOWLEDGE_SYNC_CREDIT_USD,
      0.25,
    ),
    number_purchase: safeNumber(
      process.env.BILLING_MIN_NUMBER_PURCHASE_CREDIT_USD ||
        process.env.BILLING_DEFAULT_MINIMUM_RECHARGE_USD,
      30,
    ),
    usage: safeNumber(
      process.env.BILLING_MIN_ACTIVE_CREDIT_USD ||
        process.env.BILLING_MIN_USAGE_CREDIT_USD,
      1,
    ),
  };
  return Math.max(activeFloor, defaults[key] ?? defaults.usage);
}

function maxNegativeBalanceUsd() {
  const configured = safeNumber(
    process.env.BILLING_MAX_NEGATIVE_BALANCE_USD,
    1,
  );
  return Math.max(0, configured);
}

function hardStopBalanceUsd() {
  return -maxNegativeBalanceUsd();
}

async function getOrCreateWallet(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return null;
  const sb = getSupabase();

  try {
    const { data, error } = await sb.rpc("billing_admin_get_or_create_wallet", {
      p_organization_id: orgId,
      p_minimum_recharge_usd: safeNumber(
        process.env.BILLING_DEFAULT_MINIMUM_RECHARGE_USD,
        30,
      ),
    });
    if (!error && data) return Array.isArray(data) ? data[0] || null : data;
  } catch (_) {}

  const { data } = await sb
    .from("billing_wallets")
    .select("*")
    .eq("organization_id", orgId)
    .maybeSingle();
  return data || null;
}

async function getWalletCreditStatus({
  organizationId,
  action = "usage",
  minimumUsd = null,
} = {}) {
  const orgId = String(organizationId || "").trim();
  const mode = enforcementMode();
  const minimumRequiredUsd = minimumForAction(action, minimumUsd);

  if (!orgId) {
    return {
      ok: false,
      decision: "unresolved_organization",
      enforcementMode: mode,
      organizationId: null,
      action,
      balanceUsd: 0,
      minimumRequiredUsd,
    };
  }

  if (isOrgExempt(orgId)) {
    return {
      ok: true,
      decision: "exempt",
      enforcementMode: mode,
      organizationId: orgId,
      action,
      balanceUsd: null,
      minimumRequiredUsd,
    };
  }

  let wallet = null;
  let warning = null;
  try {
    wallet = await getOrCreateWallet(orgId);
  } catch (err) {
    warning = err?.message || String(err);
  }

  const balanceUsd = safeNumber(wallet?.balance_usd, 0);
  const walletStatus = wallet?.status || (wallet ? "active" : "missing");
  const maxNegativeUsd = maxNegativeBalanceUsd();
  const stopAtUsd = hardStopBalanceUsd();
  const hasEnoughCredit =
    walletStatus === "active" && balanceUsd >= minimumRequiredUsd;
  const hasReachedHardStop =
    walletStatus !== "active" || balanceUsd <= stopAtUsd;
  // Enforcement is staged by BILLING_CREDIT_ENFORCEMENT_MODE:
  //  - "observe": never block. Status is still computed/logged/shown in the
  //    UI (wallet badge, admin overview) but no action is stopped. This is
  //    the default so new billing rules can be verified against real
  //    traffic before anything is actually blocked.
  //  - "warn": block only once the hard stop (max negative balance) is
  //    reached; being merely under the per-action minimum only surfaces a
  //    warning, it does not stop the action.
  //  - "block": full enforcement — any organization under the minimum
  //    required credit for the action, or past the hard stop, is blocked.
  const shouldBlock =
    mode === "block"
      ? hasReachedHardStop || !hasEnoughCredit
      : mode === "warn"
        ? hasReachedHardStop
        : false;
  const decision = hasEnoughCredit
    ? "allow"
    : hasReachedHardStop
      ? "block_credit_hard_stop"
      : "block_insufficient_credit";

  if (shouldBlock) {
    try {
      // Start the five-day number-retention warning as soon as a depleted
      // workspace attempts a billable action. The daily reconciliation job is
      // still the only path allowed to perform an irreversible number release.
      const {
        reconcileOrganizationNumberRetention,
      } = require("./number-retention");
      await reconcileOrganizationNumberRetention({
        organizationId: orgId,
        allowRelease: false,
      });
    } catch (retentionError) {
      // Credit enforcement must remain available while the retention migration
      // is being rolled out or if an email/notification dependency is degraded.
      console.warn(
        "[number-retention] warning sync skipped:",
        retentionError?.message || String(retentionError),
      );
    }
  }

  return {
    ok: !shouldBlock,
    hasEnoughCredit,
    hasReachedHardStop,
    shouldBlock,
    decision,
    enforcementMode: mode,
    organizationId: orgId,
    action,
    balanceUsd,
    minimumRequiredUsd,
    maxNegativeBalanceUsd: maxNegativeUsd,
    hardStopBalanceUsd: stopAtUsd,
    walletStatus,
    walletId: wallet?.id || null,
    topUpPath: "#/billing",
    warning,
  };
}

function insufficientCreditPayload(status) {
  const balance = safeNumber(status?.balanceUsd, 0).toFixed(2);
  const required = safeNumber(status?.minimumRequiredUsd, 0).toFixed(2);
  const hardStop = safeNumber(status?.hardStopBalanceUsd, -1).toFixed(2);
  const isHardStop =
    status?.decision === "block_credit_hard_stop" || status?.hasReachedHardStop;
  return {
    error: {
      code: "INSUFFICIENT_CREDIT",
      message: isHardStop
        ? `Your usage wallet balance is $${balance}. Usage is paused because the balance has reached the allowed negative limit of $${hardStop}. Add credit to continue.`
        : `Your usage wallet balance is $${balance}. Add credit before using this service. Minimum required for this action is $${required}.`,
      details: {
        ...status,
        code: "INSUFFICIENT_CREDIT",
        title: "Usage credit required",
        ctaLabel: "Go to billing",
        topUpPath: "#/billing",
      },
    },
  };
}

async function ensureWalletCreditOrRespond(req, res, options = {}) {
  const organizationId =
    options.organizationId || req.orgId || req.organization?.id || null;
  const status = await getWalletCreditStatus({
    organizationId,
    action: options.action || "usage",
    minimumUsd: options.minimumUsd,
  });

  req.billingCreditStatus = status;

  if (status.shouldBlock) {
    return res.status(402).json(insufficientCreditPayload(status));
  }

  return true;
}

function requireWalletCredit(options = {}) {
  return async (req, res, next) => {
    try {
      const allowed = await ensureWalletCreditOrRespond(req, res, options);
      if (allowed === true) return next();
      return undefined;
    } catch (err) {
      return next(err);
    }
  };
}

function creditStatusToTwimlMessage(status) {
  if (!status?.shouldBlock) return null;
  return "This number is temporarily unavailable because usage credit is required. Please try again later.";
}

module.exports = {
  enforcementMode,
  getWalletCreditStatus,
  ensureWalletCreditOrRespond,
  requireWalletCredit,
  insufficientCreditPayload,
  creditStatusToTwimlMessage,
  maxNegativeBalanceUsd,
  hardStopBalanceUsd,
};
