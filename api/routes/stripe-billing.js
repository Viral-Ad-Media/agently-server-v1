"use strict";

const express = require("express");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { getSupabase } = require("../../lib/supabase");
const { getBillingPlatformSettings } = require("../../lib/billing-settings");
const {
  stripeConfigured,
  stripeCheckoutConfigured,
  maxTopUpUsd,
  verifyStripeWebhook,
  createWalletTopUpCheckout,
  processStripeWebhook,
  getWalletTopUpStatus,
  createCardSetupIntent,
  listSavedCards,
  chargeSavedCard,
} = require("../../lib/stripe-billing");

const router = express.Router();

router.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const event = verifyStripeWebhook(
      req.rawBody,
      req.headers["stripe-signature"],
    );
    const result = await processStripeWebhook(event);
    res.json({ received: true, result });
  }),
);

router.get(
  "/config",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const settings = await getBillingPlatformSettings(getSupabase());
    res.json({
      enabled: stripeConfigured(),
      checkoutConfigured: stripeCheckoutConfigured(),
      webhookConfigured: stripeConfigured(),
      minimumTopUpUsd: settings.minimumTopUpUsd,
      maximumTopUpUsd: maxTopUpUsd(),
      currency: "USD",
      collectionMode: "stripe_hosted_checkout",
    });
  }),
);

/* ── D2: save a card without charging it ───────────────────────────────── */
router.post(
  "/setup-intent",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await createCardSetupIntent({
      organizationId: req.orgId,
      user: req.user,
    });
    res.status(201).json({ success: true, ...result });
  }),
);

/* ── Cards currently on file, so the UI can show "Visa ending 4242" ────── */
router.get(
  "/payment-methods",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const cards = await listSavedCards(getSupabase(), req.orgId);
    res.json({ success: true, cards, hasCardOnFile: cards.length > 0 });
  }),
);

/* ── D3: one-click top-up against the saved card, no redirect ───────────── */
router.post(
  "/charge",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await chargeSavedCard({
      organizationId: req.orgId,
      user: req.user,
      amountUsd: req.body?.amountUsd ?? req.body?.amount_usd,
      paymentMethodId: req.body?.paymentMethodId,
    });
    res.status(202).json({ success: true, ...result });
  }),
);

router.post(
  "/checkout-session",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await createWalletTopUpCheckout({
      organizationId: req.orgId,
      user: req.user,
      amountUsd: req.body?.amountUsd ?? req.body?.amount_usd,
    });
    res.status(201).json({ success: true, ...result });
  }),
);

router.get(
  "/sessions/:sessionId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const topUp = await getWalletTopUpStatus({
      organizationId: req.orgId,
      sessionId: String(req.params.sessionId || "").trim(),
    });
    res.json({ success: true, topUp });
  }),
);

module.exports = router;
