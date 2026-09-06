"use strict";

/**
 * ACTIVATION GATE — signup credit + "add a card before you commit us to cost".
 *
 * Two jobs, deliberately kept in one place because they are two halves of the
 * same decision:
 *
 *  1. Every new organization is granted a small amount of usage credit at
 *     signup so it can test a voice agent immediately, without a card.
 *
 *  2. Anything that commits Agently to a RECURRING or externally-billed cost
 *     — buying a phone number, putting a chatbot live — first requires a card
 *     on file. Nothing is charged at that point: a SetupIntent saves the card
 *     and the signup grant is still spent first. What the gate prevents is a
 *     tenant provisioning a cost we keep paying and leaving us no way to bill
 *     for it.
 *
 * The gate is enforced server-side. The dashboard modal is a courtesy that
 * explains the rule early; it is not what enforces it.
 */

const { getBillingPlatformSettings } = require("./billing-settings");

const DEFAULT_SIGNUP_GRANT_USD = 5;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Amount granted to a brand-new organization. Set to 0 to disable entirely. */
function signupGrantUsd() {
  const raw = process.env.BILLING_SIGNUP_GRANT_USD;
  if (raw === undefined || raw === "") return DEFAULT_SIGNUP_GRANT_USD;
  return Math.min(Math.max(safeNumber(raw, DEFAULT_SIGNUP_GRANT_USD), 0), 1000);
}

const grantExternalId = (organizationId) => `signup-grant:${organizationId}`;

/**
 * Credit the signup grant exactly once per organization.
 *
 * Idempotency is anchored on a deterministic external_id rather than on "did
 * we just create this org", so a retried registration, a replayed webhook or a
 * manual backfill cannot double-credit. Never throws: a failed grant must not
 * take down registration — the tenant simply starts at zero and tops up.
 */
async function grantSignupCredit(db, organizationId, { source = "signup_grant" } = {}) {
  const amount = signupGrantUsd();
  if (!db || !organizationId || amount <= 0) {
    return { granted: false, reason: "disabled", amountUsd: 0 };
  }

  const externalId = grantExternalId(organizationId);

  try {
    const { data: existing, error: existingError } = await db
      .from("billing_wallet_transactions")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("external_id", externalId)
      .maybeSingle();
    if (existingError && existingError.code !== "PGRST116") throw existingError;
    if (existing?.id) {
      return { granted: false, reason: "already_granted", amountUsd: amount };
    }

    const { error } = await db.rpc("billing_admin_top_up_wallet", {
      p_organization_id: organizationId,
      p_amount_usd: amount,
      p_source: source,
      p_external_id: externalId,
    });
    if (error) throw error;

    return { granted: true, amountUsd: amount };
  } catch (error) {
    console.warn(
      "[activation-gate] signup grant failed:",
      error?.message || String(error),
    );
    return { granted: false, reason: "error", amountUsd: amount };
  }
}

/**
 * Does this organization have a card on file?
 *
 * The gate is card-on-file, NOT "has paid us". A tenant should be able to
 * provision with their signup credit still unspent — what we need is a
 * payment method we can charge when that credit runs out, so a phone number
 * cannot be left running against an empty balance with no way to bill it.
 *
 * Stripe is the source of truth: a card can be removed there, and a local
 * "they paid once" flag would keep the gate open after it was.
 */
async function hasCardOnFile(db, organizationId) {
  if (!db || !organizationId) return false;
  try {
    const { listSavedCards } = require("./stripe-billing");
    const cards = await listSavedCards(db, organizationId);
    return Array.isArray(cards) && cards.length > 0;
  } catch (error) {
    console.warn(
      "[activation-gate] card lookup failed:",
      error?.message || String(error),
    );
    // Fail OPEN on an infrastructure error. Blocking a paying tenant because
    // Stripe blipped is worse than briefly allowing an ungated purchase.
    return true;
  }
}

/** Everything the dashboard needs to decide whether to show the modal. */
async function getActivationState(db, organizationId) {
  const settings = await getBillingPlatformSettings(db).catch(() => ({
    minimumTopUpUsd: 10,
  }));
  const cardOnFile = await hasCardOnFile(db, organizationId);
  return {
    signupGrantUsd: signupGrantUsd(),
    minimumTopUpUsd: safeNumber(settings.minimumTopUpUsd, 10),
    hasCardOnFile: cardOnFile,
    requiresCard: !cardOnFile,
    gatedActions: ["purchase_number", "deploy_chatbot"],
  };
}

const ACTION_LABELS = {
  purchase_number: "buy a phone number",
  deploy_chatbot: "put a chatbot live",
};

/**
 * Throws a 402 when the organization has no card on file. Route handlers call
 * this before doing any provisioning work.
 */
async function assertCanActivate(db, organizationId, action) {
  const state = await getActivationState(db, organizationId);
  if (!state.requiresCard) return state;

  const label = ACTION_LABELS[action] || "use this feature";
  const error = new Error(
    `Add a card before you ${label}. Nothing is charged now — your $${state.signupGrantUsd.toFixed(
      2,
    )} of free credit is spent first, and the card only covers usage beyond it.`,
  );
  error.status = 402;
  error.code = "CARD_REQUIRED";
  error.details = { ...state, action };
  throw error;
}

module.exports = {
  DEFAULT_SIGNUP_GRANT_USD,
  signupGrantUsd,
  grantSignupCredit,
  hasCardOnFile,
  getActivationState,
  assertCanActivate,
};
