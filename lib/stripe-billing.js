"use strict";

const crypto = require("crypto");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const { getSupabase } = require("./supabase");
const { buildAppHashUrl } = require("./app-url");
const { getBillingPlatformSettings } = require("./billing-settings");
const { settleAfterTopUp } = require("./wallet-settlement");

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const DEFAULT_MAX_TOP_UP_USD = 5000;

function cleanString(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(safeNumber(value) * factor) / factor;
}

function stripeSecretKey() {
  return cleanString(process.env.STRIPE_SECRET_KEY, 300);
}

function stripeWebhookSecret() {
  return cleanString(process.env.STRIPE_WEBHOOK_SECRET, 300);
}

function stripeConfigured() {
  return Boolean(stripeSecretKey() && stripeWebhookSecret());
}

function stripeCheckoutConfigured() {
  return Boolean(stripeSecretKey());
}

function maxTopUpUsd() {
  const value = safeNumber(
    process.env.BILLING_MAX_TOP_UP_USD,
    DEFAULT_MAX_TOP_UP_USD,
  );
  return Math.min(Math.max(value, 10), 100000);
}

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  return params;
}

async function stripeApiRequest(
  path,
  { method = "GET", fields = null, idempotencyKey = null } = {},
) {
  const key = stripeSecretKey();
  if (!key) {
    const error = new Error(
      "Stripe payments are not configured. Set STRIPE_SECRET_KEY on the backend.",
    );
    error.status = 503;
    error.code = "STRIPE_NOT_CONFIGURED";
    throw error;
  }

  const headers = {
    Authorization: `Bearer ${key}`,
  };
  const configuredVersion = cleanString(process.env.STRIPE_API_VERSION, 80);
  if (configuredVersion) headers["Stripe-Version"] = configuredVersion;
  if (idempotencyKey) {
    headers["Idempotency-Key"] = cleanString(idempotencyKey, 255);
  }

  const request = { method, headers };
  if (fields) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    request.body = formBody(fields).toString();
  }

  let response;
  try {
    response = await fetch(`${STRIPE_API_BASE}${path}`, request);
  } catch (cause) {
    const error = new Error("Agently could not reach Stripe. Please retry.");
    error.status = 503;
    error.code = "STRIPE_NETWORK_ERROR";
    error.cause = cause;
    throw error;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    const stripeError = payload?.error || {};
    const error = new Error(
      cleanString(stripeError.message, 1000) ||
        `Stripe returned HTTP ${response.status}.`,
    );
    error.status = response.status >= 500 ? 503 : 400;
    error.code = cleanString(stripeError.code || stripeError.type, 120);
    error.stripeRequestId = response.headers.get("request-id") || null;
    throw error;
  }

  return payload;
}

function parseStripeSignature(header) {
  const parts = String(header || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = { t: null, v1: [] };
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (key === "t") values.t = value;
    if (key === "v1") values.v1.push(value);
  }
  return values;
}

function timingSafeHexEqual(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left || ""), "hex");
    const rightBuffer = Buffer.from(String(right || ""), "hex");
    return (
      leftBuffer.length > 0 &&
      leftBuffer.length === rightBuffer.length &&
      crypto.timingSafeEqual(leftBuffer, rightBuffer)
    );
  } catch (_) {
    return false;
  }
}

function verifyStripeWebhook(rawBody, signatureHeader) {
  const secret = stripeWebhookSecret();
  if (!secret) {
    const error = new Error(
      "Stripe webhook verification is not configured. Set STRIPE_WEBHOOK_SECRET.",
    );
    error.status = 503;
    error.code = "STRIPE_WEBHOOK_NOT_CONFIGURED";
    throw error;
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    const error = new Error("Stripe webhook raw body is unavailable.");
    error.status = 400;
    error.code = "STRIPE_RAW_BODY_REQUIRED";
    throw error;
  }

  const signature = parseStripeSignature(signatureHeader);
  const timestamp = Number(signature.t);
  const tolerance = Math.max(
    60,
    safeNumber(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300),
  );
  if (!Number.isFinite(timestamp) || !signature.v1.length) {
    const error = new Error("Invalid Stripe-Signature header.");
    error.status = 400;
    error.code = "STRIPE_SIGNATURE_INVALID";
    throw error;
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) {
    const error = new Error("Stripe webhook timestamp is outside tolerance.");
    error.status = 400;
    error.code = "STRIPE_SIGNATURE_EXPIRED";
    throw error;
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  if (!signature.v1.some((value) => timingSafeHexEqual(value, expected))) {
    const error = new Error("Stripe webhook signature verification failed.");
    error.status = 400;
    error.code = "STRIPE_SIGNATURE_INVALID";
    throw error;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (_) {
    const error = new Error("Stripe webhook payload is not valid JSON.");
    error.status = 400;
    error.code = "STRIPE_PAYLOAD_INVALID";
    throw error;
  }
  return event;
}

async function getOrCreateStripeCustomer(db, { organizationId, user }) {
  const { data: existing, error: existingError } = await db
    .from("billing_stripe_customers")
    .select("organization_id,stripe_customer_id,email,name")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripeApiRequest("/customers", {
    method: "POST",
    fields: {
      email: cleanString(user?.email, 320),
      name: cleanString(user?.name, 300),
      "metadata[organization_id]": organizationId,
      "metadata[agently_user_id]": cleanString(user?.id, 100),
    },
    idempotencyKey: `agently-customer-${organizationId}`,
  });

  const { error: insertError } = await db
    .from("billing_stripe_customers")
    .upsert(
      {
        organization_id: organizationId,
        stripe_customer_id: customer.id,
        email: cleanString(user?.email, 320) || null,
        name: cleanString(user?.name, 300) || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
  if (insertError) throw insertError;
  return customer.id;
}

async function createWalletTopUpCheckout({ organizationId, user, amountUsd }) {
  if (!stripeConfigured()) {
    const error = new Error(
      "Stripe top-ups require both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET before customer payments can be accepted.",
    );
    error.status = 503;
    error.code = "STRIPE_NOT_CONFIGURED";
    throw error;
  }

  const db = getSupabase();
  const settings = await getBillingPlatformSettings(db);
  const minimumTopUpUsd = roundMoney(settings.minimumTopUpUsd, 2);
  const maximumTopUpUsd = roundMoney(maxTopUpUsd(), 2);
  const amount = roundMoney(amountUsd, 2);
  if (!Number.isFinite(amount) || amount < minimumTopUpUsd) {
    const error = new Error(
      `Minimum top-up is $${minimumTopUpUsd.toFixed(2)}.`,
    );
    error.status = 400;
    error.code = "TOP_UP_BELOW_MINIMUM";
    throw error;
  }
  if (amount > maximumTopUpUsd) {
    const error = new Error(
      `Maximum top-up per payment is $${maximumTopUpUsd.toFixed(2)}.`,
    );
    error.status = 400;
    error.code = "TOP_UP_ABOVE_MAXIMUM";
    throw error;
  }

  const amountCents = Math.round(amount * 100);
  const topUpId = uuidv4();
  const stripeCustomerId = await getOrCreateStripeCustomer(db, {
    organizationId,
    user,
  });

  const { error: topUpInsertError } = await db
    .from("billing_wallet_topups")
    .insert({
      id: topUpId,
      organization_id: organizationId,
      user_id: user?.id || null,
      amount_usd: amount,
      currency: "usd",
      status: "creating_checkout",
      stripe_customer_id: stripeCustomerId,
      metadata: {
        initiated_by_email: user?.email || null,
        minimum_top_up_usd: minimumTopUpUsd,
      },
    });
  if (topUpInsertError) throw topUpInsertError;

  let session;
  try {
    session = await stripeApiRequest("/checkout/sessions", {
      method: "POST",
      idempotencyKey: `agently-wallet-topup-${topUpId}`,
      fields: {
        mode: "payment",
        customer: stripeCustomerId,
        client_reference_id: organizationId,
        "payment_method_types[0]": "card",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": amountCents,
        "line_items[0][price_data][product_data][name]":
          "Agently usage credit",
        "line_items[0][price_data][product_data][description]":
          "Prepaid credit for Agently calls, agents, Knowledge Bases and platform usage.",
        "line_items[0][quantity]": 1,
        "metadata[purpose]": "wallet_top_up",
        "metadata[top_up_id]": topUpId,
        "metadata[organization_id]": organizationId,
        "metadata[user_id]": user?.id || "",
        "metadata[amount_cents]": amountCents,
        "payment_intent_data[metadata][purpose]": "wallet_top_up",
        "payment_intent_data[metadata][top_up_id]": topUpId,
        "payment_intent_data[metadata][organization_id]": organizationId,
        "payment_intent_data[metadata][amount_cents]": amountCents,
        success_url: buildAppHashUrl(
          "/billing?stripe=success&session_id={CHECKOUT_SESSION_ID}",
        ),
        cancel_url: buildAppHashUrl("/billing?stripe=cancelled"),
      },
    });
  } catch (error) {
    await db
      .from("billing_wallet_topups")
      .update({
        status: "checkout_failed",
        failure_message: cleanString(error?.message, 1000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", topUpId);
    throw error;
  }

  const { error: updateError } = await db
    .from("billing_wallet_topups")
    .update({
      stripe_checkout_session_id: session.id,
      status: "checkout_open",
      checkout_url: session.url || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", topUpId);
  if (updateError) throw updateError;

  return {
    topUpId,
    sessionId: session.id,
    checkoutUrl: session.url,
    amountUsd: amount,
    minimumTopUpUsd,
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null,
  };
}

async function retrieveCheckoutSession(sessionId) {
  return stripeApiRequest(
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
}

async function retrievePaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  return stripeApiRequest(
    `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand%5B%5D=latest_charge.balance_transaction`,
  );
}

async function recordWebhookEvent(db, event) {
  const payload = {
    stripe_event_id: cleanString(event?.id, 255),
    event_type: cleanString(event?.type, 255),
    livemode: Boolean(event?.livemode),
    api_version: cleanString(event?.api_version, 100) || null,
    payload: event,
    status: "received",
    received_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("billing_stripe_webhook_events")
    .upsert(payload, {
      onConflict: "stripe_event_id",
      ignoreDuplicates: true,
    })
    .select("id,stripe_event_id,status")
    .maybeSingle();
  if (error) throw error;
  return {
    duplicate: !data,
    row: data || null,
  };
}

async function updateWebhookEvent(db, eventId, patch) {
  if (!eventId) return;
  await db
    .from("billing_stripe_webhook_events")
    .update({ ...patch, processed_at: new Date().toISOString() })
    .eq("stripe_event_id", eventId);
}

function sessionOrganizationId(session) {
  return cleanString(
    session?.metadata?.organization_id || session?.client_reference_id,
    100,
  );
}

async function enrichTopUpWithStripeCosts(db, topUpId, paymentIntentId) {
  try {
    const intent = await retrievePaymentIntent(paymentIntentId);
    const charge = intent?.latest_charge || null;
    const balanceTransaction = charge?.balance_transaction || null;
    const feeUsd = balanceTransaction?.fee
      ? roundMoney(balanceTransaction.fee / 100, 2)
      : null;
    const netUsd = Number.isFinite(Number(balanceTransaction?.net))
      ? roundMoney(balanceTransaction.net / 100, 2)
      : null;
    await db
      .from("billing_wallet_topups")
      .update({
        stripe_payment_intent_id: intent?.id || paymentIntentId || null,
        stripe_charge_id: charge?.id || null,
        stripe_balance_transaction_id: balanceTransaction?.id || null,
        stripe_fee_usd: feeUsd,
        net_received_usd: netUsd,
        updated_at: new Date().toISOString(),
      })
      .eq("id", topUpId);
  } catch (error) {
    console.warn(
      "[stripe-billing] payment cost enrichment skipped:",
      error?.message || error,
    );
  }
}

async function creditPaidCheckoutSession(sessionId, eventId = null) {
  const db = getSupabase();
  const session = await retrieveCheckoutSession(sessionId);
  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return { credited: false, pending: true, sessionId };
  }
  if (String(session.currency || "").toLowerCase() !== "usd") {
    throw new Error("Only USD wallet top-ups are supported.");
  }
  if (session?.metadata?.purpose !== "wallet_top_up") {
    return { credited: false, ignored: true, sessionId };
  }

  const organizationId = sessionOrganizationId(session);
  const topUpId = cleanString(session?.metadata?.top_up_id, 100);
  const amountUsd = roundMoney(safeNumber(session.amount_total) / 100, 2);
  const metadataAmountCents = safeNumber(session?.metadata?.amount_cents, -1);
  if (!organizationId || !topUpId || amountUsd <= 0) {
    throw new Error("Stripe top-up metadata is incomplete.");
  }
  if (
    metadataAmountCents >= 0 &&
    Math.round(amountUsd * 100) !== Math.round(metadataAmountCents)
  ) {
    throw new Error("Stripe top-up amount does not match its signed metadata.");
  }

  const { data: topUp, error: topUpError } = await db
    .from("billing_wallet_topups")
    .select("*")
    .eq("id", topUpId)
    .eq("organization_id", organizationId)
    .eq("stripe_checkout_session_id", session.id)
    .maybeSingle();
  if (topUpError) throw topUpError;
  if (!topUp) throw new Error("Stripe top-up record was not found.");

  if (topUp.wallet_transaction_id && topUp.status === "credited") {
    return {
      credited: true,
      duplicate: true,
      organizationId,
      topUpId,
      walletTransactionId: topUp.wallet_transaction_id,
      amountUsd,
    };
  }

  const { data, error } = await db.rpc("billing_credit_wallet_from_stripe", {
    p_top_up_id: topUpId,
    p_organization_id: organizationId,
    p_amount_usd: amountUsd,
    p_checkout_session_id: session.id,
    p_payment_intent_id:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null,
    p_customer_id:
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id || null,
    p_event_id: eventId,
    p_metadata: {
      stripe_payment_status: session.payment_status,
      stripe_livemode: Boolean(session.livemode),
      customer_email: session.customer_details?.email || null,
    },
  });
  if (error) throw error;

  const result = Array.isArray(data) ? data[0] || {} : data || {};
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || null;
  await enrichTopUpWithStripeCosts(db, topUpId, paymentIntentId);
  const settlement = await settleAfterTopUp(organizationId, {
    reason: "stripe_topup_settlement",
  });

  return {
    credited: true,
    organizationId,
    topUpId,
    amountUsd,
    walletTransactionId:
      result.wallet_transaction_id || result.walletTransactionId || null,
    balanceAfterUsd:
      result.balance_after_usd ?? result.balanceAfterUsd ?? null,
    settlement,
  };
}

async function markCheckoutStatus(sessionId, status, extra = {}) {
  const db = getSupabase();
  const { error } = await db
    .from("billing_wallet_topups")
    .update({
      status,
      ...extra,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_checkout_session_id", sessionId);
  if (error) throw error;
}

async function processStripeWebhook(event) {
  const db = getSupabase();
  const recorded = await recordWebhookEvent(db, event);
  if (recorded.duplicate) {
    return { duplicate: true, eventId: event.id };
  }

  try {
    let result = { handled: false, type: event.type };
    const object = event?.data?.object || {};
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      result = await creditPaidCheckoutSession(object.id, event.id);
    } else if (event.type === "checkout.session.expired") {
      await markCheckoutStatus(object.id, "expired", {
        failure_message: "Stripe Checkout session expired before payment.",
      });
      result = { handled: true, expired: true };
    } else if (
      event.type === "payment_intent.payment_failed" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      const topUpId = cleanString(object?.metadata?.top_up_id, 100);
      if (topUpId) {
        await db
          .from("billing_wallet_topups")
          .update({
            status: "payment_failed",
            stripe_payment_intent_id:
              event.type === "payment_intent.payment_failed"
                ? object.id || null
                : object.payment_intent || null,
            failure_message:
              cleanString(object?.last_payment_error?.message, 1000) ||
              "Card payment failed.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", topUpId);
      }
      result = { handled: true, failed: true };
    } else if (
      event.type === "charge.refunded" ||
      event.type === "charge.dispute.created"
    ) {
      const paymentIntentId =
        typeof object.payment_intent === "string"
          ? object.payment_intent
          : object.payment_intent?.id || null;
      if (paymentIntentId) {
        await db
          .from("billing_wallet_topups")
          .update({
            status:
              event.type === "charge.refunded" ? "refund_review" : "dispute_review",
            metadata: {
              stripe_follow_up_required: true,
              stripe_last_event_id: event.id,
              stripe_last_event_type: event.type,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_payment_intent_id", paymentIntentId);
      }
      result = { handled: true, reviewRequired: true };
    }

    await updateWebhookEvent(db, event.id, {
      status: "processed",
      processing_result: result,
      error_message: null,
    });
    return result;
  } catch (error) {
    await updateWebhookEvent(db, event.id, {
      status: "failed",
      error_message: cleanString(error?.message, 1500),
    });
    throw error;
  }
}

async function getWalletTopUpStatus({ organizationId, sessionId }) {
  const db = getSupabase();

  const loadRow = async () => {
    const { data, error } = await db
      .from("billing_wallet_topups")
      .select(
        "id,organization_id,amount_usd,currency,status,stripe_checkout_session_id,stripe_payment_intent_id,wallet_transaction_id,stripe_fee_usd,net_received_usd,failure_message,created_at,credited_at,updated_at",
      )
      .eq("organization_id", organizationId)
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  };

  let data = await loadRow();
  if (!data) {
    const notFound = new Error("Top-up session was not found for this workspace.");
    notFound.status = 404;
    notFound.code = "TOP_UP_NOT_FOUND";
    throw notFound;
  }

  // The webhook is the primary fulfillment path. This authenticated recovery
  // path asks Stripe directly for the session and runs the same idempotent
  // credit function if the webhook is delayed. The browser return query is
  // never trusted as proof of payment.
  if (
    !data.wallet_transaction_id &&
    !["payment_failed", "checkout_failed", "expired"].includes(data.status) &&
    stripeConfigured()
  ) {
    try {
      const recovered = await creditPaidCheckoutSession(sessionId, null);
      if (recovered?.credited) data = (await loadRow()) || data;
    } catch (error) {
      console.warn(
        "[stripe-billing] authenticated status recovery skipped:",
        error?.message || error,
      );
    }
  }

  return {
    id: data.id,
    amountUsd: safeNumber(data.amount_usd),
    currency: String(data.currency || "usd").toUpperCase(),
    status: data.status,
    credited: Boolean(data.wallet_transaction_id && data.status === "credited"),
    walletTransactionId: data.wallet_transaction_id || null,
    failureMessage: data.failure_message || null,
    createdAt: data.created_at,
    creditedAt: data.credited_at || null,
    updatedAt: data.updated_at,
  };
}

module.exports = {
  stripeConfigured,
  stripeCheckoutConfigured,
  maxTopUpUsd,
  verifyStripeWebhook,
  createWalletTopUpCheckout,
  processStripeWebhook,
  getWalletTopUpStatus,
};
