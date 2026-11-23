"use strict";

/**
 * Auto top-up with a monthly cap — the "card on file" plan.
 *
 * A tenant with a saved card turns this on and picks three numbers:
 *   - threshold: when credit drops below this, top up
 *   - amount:    how much each top-up adds (never below the platform minimum)
 *   - cap:       the most Agently may charge automatically per calendar month
 *
 * The wallet stays prepaid. Each top-up is an ordinary off-session charge on
 * the saved card (chargeSavedCard), and the wallet only moves when Stripe's
 * payment_intent.succeeded webhook lands — so a declined card never credits.
 *
 * At the cap, automatic top-ups stop for the rest of the month and the owner
 * is emailed once; they can raise the cap or add credit by hand. A declined
 * card pauses auto top-up (so we don't retry a dead card every minute) and the
 * owner is emailed; saving the settings again resumes it.
 *
 * Storage: billing_wallets already carries auto_recharge_enabled,
 * auto_recharge_threshold_usd and auto_recharge_amount_usd. The cap and the
 * small amount of run state live in billing_wallets.metadata.auto_top_up.
 * Month-to-date spend is derived from billing_wallet_topups (flow =
 * auto_top_up), so it can never drift from what was actually charged.
 */

const { getSupabase } = require("./supabase");
const { getMinimumTopUpUsd } = require("./billing-settings");
const {
  stripeCheckoutConfigured,
  listSavedCards,
  chargeSavedCard,
  maxTopUpUsd,
} = require("./stripe-billing");

const DEFAULTS = Object.freeze({
  thresholdUsd: 5,
  amountUsd: 20,
  monthlyCapUsd: 100,
});

const MAX_THRESHOLD_USD = 1000;
const MAX_MONTHLY_CAP_USD = 100000;
// A charge that has not been confirmed (or failed) within this window no
// longer blocks the next attempt.
const PENDING_WINDOW_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Statuses that never took money, so they don't count against the cap.
const NOT_CHARGED = new Set([
  "payment_failed",
  "expired",
  "canceled",
  "cancelled",
  "requires_payment_method",
  "requires_action",
]);
const PENDING = new Set([
  "payment_pending",
  "awaiting_webhook",
  "processing",
  "requires_confirmation",
]);

// Stripe codes that mean "this card will not work off-session".
const CARD_FAILURE_CODES = new Set([
  "card_declined",
  "authentication_required",
  "expired_card",
  "incorrect_cvc",
  "insufficient_funds",
  "processing_error",
  "payment_intent_authentication_failure",
  "payment_method_unactivated",
  "CARD_REQUIRED",
]);

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function monthStartIso(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  ).toISOString();
}

async function loadWallet(db, organizationId) {
  const { data, error } = await db
    .from("billing_wallets")
    .select(
      "id,organization_id,balance_usd,auto_recharge_enabled," +
        "auto_recharge_threshold_usd,auto_recharge_amount_usd,metadata",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function readSettings(wallet) {
  const meta = (wallet?.metadata && wallet.metadata.auto_top_up) || {};
  return {
    enabled: Boolean(wallet?.auto_recharge_enabled),
    thresholdUsd: round2(
      toNumber(wallet?.auto_recharge_threshold_usd, DEFAULTS.thresholdUsd),
    ),
    amountUsd: round2(
      toNumber(wallet?.auto_recharge_amount_usd, DEFAULTS.amountUsd),
    ),
    monthlyCapUsd: round2(toNumber(meta.monthly_cap_usd, DEFAULTS.monthlyCapUsd)),
    pausedReason: meta.paused_reason || null,
    lastError: meta.last_error || null,
    lastChargedAt: meta.last_charged_at || null,
    capNotifiedMonth: meta.cap_notified_month || null,
  };
}

async function writeRunState(db, wallet, patch) {
  const metadata = { ...(wallet.metadata || {}) };
  metadata.auto_top_up = { ...(metadata.auto_top_up || {}), ...patch };
  const { error } = await db
    .from("billing_wallets")
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq("id", wallet.id);
  if (error) throw error;
  wallet.metadata = metadata;
}

/** Auto top-ups this calendar month (UTC). */
async function monthToDate(db, organizationId) {
  const { data, error } = await db
    .from("billing_wallet_topups")
    .select("amount_usd,status,created_at")
    .eq("organization_id", organizationId)
    .eq("metadata->>flow", "auto_top_up")
    .gte("created_at", monthStartIso());
  if (error) throw error;

  const rows = data || [];
  const now = Date.now();
  let spentUsd = 0;
  let pending = false;
  for (const row of rows) {
    const status = String(row.status || "");
    if (NOT_CHARGED.has(status)) continue;
    spentUsd += Number(row.amount_usd || 0);
    if (
      PENDING.has(status) &&
      now - new Date(row.created_at).getTime() < PENDING_WINDOW_MS
    ) {
      pending = true;
    }
  }
  return { spentUsd: round2(spentUsd), attempts: rows.length, pending };
}

async function loadOwnerRecipients(db, organizationId) {
  const [{ data: org }, { data: users }] = await Promise.all([
    db.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
    db
      .from("users")
      .select("email,role,created_at")
      .eq("organization_id", organizationId)
      .in("role", ["Owner", "Admin"])
      .order("created_at", { ascending: true }),
  ]);
  return {
    organizationName: org?.name || "your workspace",
    emails: [...new Set((users || []).map((u) => u.email).filter(Boolean))],
  };
}

async function notifyOwners(db, organizationId, kind, details) {
  try {
    const { sendAutoTopUpNoticeEmail } = require("./email");
    const { organizationName, emails } = await loadOwnerRecipients(
      db,
      organizationId,
    );
    if (!emails.length) return;
    await sendAutoTopUpNoticeEmail({
      toEmails: emails,
      organizationName,
      kind,
      ...details,
      usageContext: { organizationId },
    });
  } catch (error) {
    console.warn(
      `[auto-topup] ${kind} email failed for ${organizationId}:`,
      error?.message || String(error),
    );
  }
}

/* ── Read / write settings (Billing page) ──────────────────────────────── */

async function getAutoTopUpStatus(organizationId) {
  const db = getSupabase();
  const [wallet, minimumTopUpUsd, cards, mtd] = await Promise.all([
    loadWallet(db, organizationId),
    getMinimumTopUpUsd(db),
    stripeCheckoutConfigured()
      ? listSavedCards(db, organizationId).catch(() => [])
      : Promise.resolve([]),
    monthToDate(db, organizationId),
  ]);
  const settings = readSettings(wallet);
  return {
    ...settings,
    available: stripeCheckoutConfigured(),
    hasCard: cards.length > 0,
    card: cards[0] || null,
    minimumTopUpUsd,
    defaults: DEFAULTS,
    spentThisMonthUsd: mtd.spentUsd,
    remainingThisMonthUsd: round2(
      Math.max(0, settings.monthlyCapUsd - mtd.spentUsd),
    ),
    month: monthKey(),
  };
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "AUTO_TOP_UP_INVALID";
  return error;
}

async function updateAutoTopUpSettings(organizationId, input = {}) {
  const db = getSupabase();
  const wallet = await loadWallet(db, organizationId);
  if (!wallet) {
    const error = new Error(
      "Add credit once with your card first; auto top-up uses the card you save.",
    );
    error.status = 409;
    error.code = "WALLET_REQUIRED";
    throw error;
  }

  const current = readSettings(wallet);
  const minimum = await getMinimumTopUpUsd(db);
  const enabled =
    input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const thresholdUsd = round2(toNumber(input.thresholdUsd, current.thresholdUsd));
  const amountUsd = round2(toNumber(input.amountUsd, current.amountUsd));
  const monthlyCapUsd = round2(
    toNumber(input.monthlyCapUsd, current.monthlyCapUsd),
  );

  if (thresholdUsd < 0 || thresholdUsd > MAX_THRESHOLD_USD)
    throw invalid(`Top up when credit falls below $0–$${MAX_THRESHOLD_USD}.`);
  if (amountUsd < minimum)
    throw invalid(`Each top-up must be at least $${minimum.toFixed(2)}.`);
  if (amountUsd > maxTopUpUsd())
    throw invalid(`Each top-up can be at most $${maxTopUpUsd().toFixed(2)}.`);
  if (monthlyCapUsd < amountUsd)
    throw invalid("The monthly cap must be at least one top-up amount.");
  if (monthlyCapUsd > MAX_MONTHLY_CAP_USD)
    throw invalid(`The monthly cap can be at most $${MAX_MONTHLY_CAP_USD}.`);

  if (enabled) {
    if (!stripeCheckoutConfigured()) {
      const error = new Error("Card payments are unavailable right now.");
      error.status = 503;
      error.code = "STRIPE_NOT_CONFIGURED";
      throw error;
    }
    const cards = await listSavedCards(db, organizationId);
    if (!cards.length) {
      const error = new Error(
        "Add credit once with your card first; auto top-up charges the card you save.",
      );
      error.status = 402;
      error.code = "CARD_REQUIRED";
      throw error;
    }
  }

  const metadata = { ...(wallet.metadata || {}) };
  metadata.auto_top_up = {
    ...(metadata.auto_top_up || {}),
    monthly_cap_usd: monthlyCapUsd,
    // Saving is the owner saying "try again": clear a card-failure pause, and
    // let a raised cap notify again if it is reached later this month.
    paused_reason: null,
    last_error: null,
    cap_notified_month:
      monthlyCapUsd > current.monthlyCapUsd
        ? null
        : (metadata.auto_top_up || {}).cap_notified_month || null,
  };

  const { error } = await db
    .from("billing_wallets")
    .update({
      auto_recharge_enabled: enabled,
      auto_recharge_threshold_usd: thresholdUsd,
      auto_recharge_amount_usd: amountUsd,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", wallet.id);
  if (error) throw error;

  // Already below the threshold? Top up now rather than at the next sweep.
  if (enabled) {
    maybeAutoTopUp(organizationId, { reason: "settings_saved" }).catch((e) =>
      console.warn("[auto-topup] immediate check failed:", e?.message || e),
    );
  }

  return getAutoTopUpStatus(organizationId);
}

/* ── The decision ───────────────────────────────────────────────────────── */

const inFlight = new Set();

async function maybeAutoTopUp(organizationId, { reason = "sweep" } = {}) {
  if (!organizationId || inFlight.has(organizationId)) {
    return { skipped: "in_flight" };
  }
  inFlight.add(organizationId);
  try {
    const db = getSupabase();
    const wallet = await loadWallet(db, organizationId);
    if (!wallet) return { skipped: "no_wallet" };

    const settings = readSettings(wallet);
    if (!settings.enabled) return { skipped: "disabled" };
    if (settings.pausedReason) return { skipped: settings.pausedReason };
    if (Number(wallet.balance_usd || 0) >= settings.thresholdUsd) {
      return { skipped: "above_threshold" };
    }

    const mtd = await monthToDate(db, organizationId);
    // The last top-up has not been confirmed yet; its credit is on the way.
    if (mtd.pending) return { skipped: "pending" };

    const minimum = await getMinimumTopUpUsd(db);
    const remaining = round2(settings.monthlyCapUsd - mtd.spentUsd);
    const charge = round2(Math.min(settings.amountUsd, remaining));
    const month = monthKey();

    if (charge < minimum) {
      if (settings.capNotifiedMonth !== month) {
        await writeRunState(db, wallet, { cap_notified_month: month });
        await notifyOwners(db, organizationId, "cap_reached", {
          monthlyCapUsd: settings.monthlyCapUsd,
          spentUsd: mtd.spentUsd,
        });
      }
      return { skipped: "cap_reached" };
    }

    try {
      const result = await chargeSavedCard({
        organizationId,
        user: null,
        amountUsd: charge,
        flow: "auto_top_up",
        idempotencyKey: `agently-auto-topup-${organizationId}-${month}-${mtd.attempts + 1}`,
      });
      const ok = ["succeeded", "processing"].includes(result.status);
      if (!ok) {
        // Off-session charges that need the customer (3-D Secure) cannot
        // complete without them. Pause and ask.
        const message = `Your bank needs you to confirm payments (status: ${result.status}).`;
        await writeRunState(db, wallet, {
          paused_reason: "card_failed",
          last_error: message,
        });
        await notifyOwners(db, organizationId, "card_failed", { message });
        return { charged: false, status: result.status };
      }
      await writeRunState(db, wallet, {
        last_charged_at: new Date().toISOString(),
        last_error: null,
      });
      console.log(
        `[auto-topup] charged $${charge.toFixed(2)} for ${organizationId} (${reason})`,
      );
      return { charged: true, amountUsd: charge, status: result.status };
    } catch (error) {
      const code = String(error?.code || "");
      // Another process (or a click) is already charging: not a card problem.
      if (code === "TOP_UP_IN_PROGRESS" || code === "idempotency_error") {
        return { skipped: "in_flight" };
      }
      if (CARD_FAILURE_CODES.has(code) || error?.status === 400 || error?.status === 402) {
        const message = error?.message || "The card was declined.";
        await writeRunState(db, wallet, {
          paused_reason: "card_failed",
          last_error: message,
        });
        await notifyOwners(db, organizationId, "card_failed", { message });
        return { charged: false, error: message };
      }
      // Stripe outage / timeout: leave it on and let the next sweep retry.
      console.warn(
        `[auto-topup] transient failure for ${organizationId}:`,
        error?.message || String(error),
      );
      return { charged: false, transient: true };
    }
  } finally {
    inFlight.delete(organizationId);
  }
}

/* ── Background sweep ───────────────────────────────────────────────────── */

let timer = null;
let sweeping = false;

async function sweepOnce() {
  if (sweeping) return;
  sweeping = true;
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("billing_wallets")
      .select("organization_id,balance_usd,auto_recharge_threshold_usd,metadata")
      .eq("auto_recharge_enabled", true);
    if (error) throw error;
    for (const row of data || []) {
      const threshold = toNumber(
        row.auto_recharge_threshold_usd,
        DEFAULTS.thresholdUsd,
      );
      if (Number(row.balance_usd || 0) >= threshold) continue;
      if (row.metadata?.auto_top_up?.paused_reason) continue;
      await maybeAutoTopUp(row.organization_id, { reason: "sweep" });
    }
  } catch (error) {
    console.warn("[auto-topup] sweep failed:", error?.message || String(error));
  } finally {
    sweeping = false;
  }
}

/**
 * Off unless AUTO_TOPUP_ENABLED=true. Local .env files point at the
 * production database, so a laptop must never start charging real cards by
 * accident; production sets the flag explicitly.
 */
function start() {
  if (timer) return;
  if (process.env.AUTO_TOPUP_ENABLED !== "true") {
    console.log(
      "[auto-topup] disabled; set AUTO_TOPUP_ENABLED=true to charge saved cards automatically.",
    );
    return;
  }
  if (!stripeCheckoutConfigured()) {
    console.log("[auto-topup] disabled: Stripe is not configured.");
    return;
  }
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(sweepOnce, 5000);
  console.log("[auto-topup] sweeping every 60s");
}

module.exports = {
  DEFAULTS,
  getAutoTopUpStatus,
  updateAutoTopUpSettings,
  maybeAutoTopUp,
  sweepOnce,
  start,
};
