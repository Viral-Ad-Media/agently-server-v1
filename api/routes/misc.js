"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const {
  requireAuth,
  requireAdmin,
  requireOwner,
} = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeUser } = require("../../lib/serializers");
const {
  sendTeamInviteEmail,
  sendContactEmail,
  sendOrganizationDeletionRequestEmail,
} = require("../../lib/email");
const {
  reconcileOrganizationNumberRetention,
  getNumberRetentionStatus,
} = require("../../lib/number-retention");
const { isAutoWalletChargeEnabled } = require("../../lib/usage-ledger");

const router = express.Router();
const dashboardSelectCache = new Map();
const warningThrottle = new Map();

function warnThrottled(key, ...args) {
  const now = Date.now();
  const previous = warningThrottle.get(key) || 0;
  if (now - previous < 15000) return;
  warningThrottle.set(key, now);
  console.warn(...args);
}

function parseBillingDemoBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function currentCreditEnforcementMode() {
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

function maxNegativeBalanceUsd() {
  const n = Number(process.env.BILLING_MAX_NEGATIVE_BALANCE_USD || 1);
  return Number.isFinite(n) ? Math.max(0, n) : 1;
}

async function loadCustomerWalletSummary(db, organizationId, limit = 150) {
  const emptyWallet = {
    enabled: true,
    currency: "USD",
    balanceUsd: 0,
    minimumRechargeUsd: 30,
    status: "not_created",
    latestTransactionAt: null,
    recentTransactions: [],
  };

  if (!organizationId) return emptyWallet;

  try {
    // The navbar must use the authoritative wallet row. Do not read the
    // reporting view first: a view or future materialized summary can lag the
    // transaction that just posted. Totals may still be read from the view,
    // but balance_usd always comes directly from billing_wallets.
    const { data: rawWallet, error: rawWalletError } = await db
      .from("billing_wallets")
      .select("id,currency,balance_usd,minimum_recharge_usd,status,updated_at")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (rawWalletError) throw rawWalletError;

    let wallet = rawWallet
      ? {
          enabled: true,
          walletId: rawWallet.id,
          currency: rawWallet.currency || "USD",
          balanceUsd: Number(rawWallet.balance_usd || 0),
          minimumRechargeUsd: Number(rawWallet.minimum_recharge_usd || 30),
          status: rawWallet.status || "active",
          latestTransactionAt: rawWallet.updated_at || null,
          recentTransactions: [],
        }
      : { ...emptyWallet };

    const { data: walletRows, error: walletViewError } = await db
      .from("billing_admin_wallet_overview")
      .select("*")
      .eq("organization_id", organizationId)
      .limit(1);

    if (!walletViewError && Array.isArray(walletRows) && walletRows.length) {
      const row = walletRows[0];
      wallet = {
        ...wallet,
        totalCreditsUsd: Number(
          row.total_credit_usd ?? row.total_credits_usd ?? 0,
        ),
        totalDebitsUsd: Number(
          row.total_debit_usd ?? row.total_debits_usd ?? 0,
        ),
      };
    }

    const { data: txRows } = await db
      .from("billing_wallet_transactions")
      .select(
        "id,organization_id,transaction_type,amount_usd,balance_before_usd,balance_after_usd,source,external_id,reference_id,created_at,metadata",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 150, 1), 250));

    const scopedTxRows = Array.isArray(txRows)
      ? txRows.filter(
          (tx) => String(tx.organization_id || "") === String(organizationId),
        )
      : [];
    if (Array.isArray(txRows) && scopedTxRows.length !== txRows.length) {
      warnThrottled(
        `billing-wallet-cross-org-${organizationId}`,
        "[billing] discarded cross-organization wallet transaction rows from customer summary",
        {
          organizationId,
          returned: txRows.length,
          accepted: scopedTxRows.length,
        },
      );
    }

    wallet.recentTransactions = scopedTxRows.map((tx) => ({
      id: tx.id,
      organizationId: tx.organization_id,
      type: tx.transaction_type,
      amountUsd: Number(tx.amount_usd || 0),
      balanceBeforeUsd:
        tx.balance_before_usd === null
          ? null
          : Number(tx.balance_before_usd || 0),
      balanceAfterUsd:
        tx.balance_after_usd === null
          ? null
          : Number(tx.balance_after_usd || 0),
      source: tx.source || "wallet",
      externalId: tx.external_id || tx.reference_id || null,
      referenceId: tx.reference_id || tx.external_id || null,
      createdAt: tx.created_at,
      metadata: tx.metadata || {},
    }));

    const { data: chargeRows } = await db
      .from("billing_customer_usage_charges")
      .select(
        "id,organization_id,provider,service,event_type,unit,quantity,internal_cost_usd,customer_charge_usd,gross_profit_usd,gross_margin_percent,wallet_transaction_id,created_at,metadata",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 150, 1), 250));

    const scopedChargeRows = Array.isArray(chargeRows)
      ? chargeRows.filter(
          (charge) =>
            String(charge.organization_id || "") === String(organizationId),
        )
      : [];
    if (
      Array.isArray(chargeRows) &&
      scopedChargeRows.length !== chargeRows.length
    ) {
      warnThrottled(
        `billing-charge-cross-org-${organizationId}`,
        "[billing] discarded cross-organization usage charge rows from customer summary",
        {
          organizationId,
          returned: chargeRows.length,
          accepted: scopedChargeRows.length,
        },
      );
    }

    const recentUsageCharges = scopedChargeRows.map((charge) => ({
      id: charge.id,
      organizationId: charge.organization_id,
      provider: charge.provider || "usage",
      service: charge.service || "usage",
      eventType: charge.event_type || "usage",
      unit: charge.unit || "unit",
      quantity: Number(charge.quantity || 0),
      customerChargeUsd: Number(charge.customer_charge_usd || 0),
      walletTransactionId: charge.wallet_transaction_id || null,
      createdAt: charge.created_at,
      metadata: charge.metadata || {},
    }));

    wallet.organizationId = organizationId;
    wallet.recentUsageCharges = recentUsageCharges;
    wallet.totalUsageChargesUsd = recentUsageCharges.reduce(
      (sum, charge) => sum + Number(charge.customerChargeUsd || 0),
      0,
    );

    return wallet;
  } catch (err) {
    return {
      ...emptyWallet,
      enabled: false,
      warning: `Wallet tables/views are not available yet: ${err.message || String(err)}`,
    };
  }
}

// ============================================================
// TEAM
// ============================================================

// ── GET /api/team/members ───────────────────────────────────
router.get(
  "/team/members",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: members = [], error } = await db
      .from("users")
      .select("id,name,email,role,avatar,created_at,updated_at")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: true });

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Unable to load team members." } });
    }

    const serialized = members.map(serializeUser);
    res.json({
      success: true,
      organizationId: req.orgId,
      members: serialized,
      metrics: {
        total: serialized.length,
        owners: serialized.filter((member) => member.role === "Owner").length,
        admins: serialized.filter((member) => member.role === "Admin").length,
        viewers: serialized.filter((member) => member.role === "Viewer").length,
      },
    });
  }),
);

// ── PATCH /api/team/members/:id/role ─────────────────────────
router.patch(
  "/team/members/:id/role",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    if (!["Admin", "Viewer"].includes(role)) {
      return res
        .status(400)
        .json({ error: { message: "Role must be Admin or Viewer." } });
    }

    if (id === req.user.id && req.user.role !== "Owner") {
      return res
        .status(400)
        .json({ error: { message: "You cannot change your own role." } });
    }

    const db = getSupabase();
    const { data: target } = await db
      .from("users")
      .select("id,role")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!target) {
      return res
        .status(404)
        .json({ error: { message: "Team member not found." } });
    }

    if (target.role === "Owner") {
      return res
        .status(403)
        .json({ error: { message: "Owner role cannot be changed." } });
    }

    const { data: member, error } = await db
      .from("users")
      .update({ role, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Unable to update member role." } });
    }

    res.json({ success: true, member: serializeUser(member) });
  }),
);

// ── POST /api/team/invitations ───────────────────────────────
router.post(
  "/team/invitations",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { email, role, name } = req.body;

    if (!email || !role) {
      return res
        .status(400)
        .json({ error: { message: "Email and role are required." } });
    }

    if (!["Admin", "Viewer"].includes(role)) {
      return res
        .status(400)
        .json({ error: { message: "Role must be Admin or Viewer." } });
    }

    const db = getSupabase();
    const normalizedEmail = email.toLowerCase().trim();
    const memberName = (name || "").trim() || normalizedEmail.split("@")[0];

    // Check if already a member
    const { data: existing } = await db
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .eq("organization_id", req.orgId)
      .single();

    if (existing) {
      return res.status(409).json({
        error: {
          message: "This user is already a member of your organization.",
        },
      });
    }

    // Create placeholder user
    const { data: member, error } = await db
      .from("users")
      .insert({
        organization_id: req.orgId,
        name: memberName,
        email: normalizedEmail,
        role,
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to invite team member." } });
    }

    // Generate a magic link so they can sign in immediately
    try {
      const { v4: uuidv4 } = require("uuid");
      const token = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(); // 7 days
      await db
        .from("magic_link_tokens")
        .insert({ email: normalizedEmail, token, expires_at: expiresAt });

      const appUrl = (
        process.env.APP_URL || "https://agently.vercel.app"
      ).replace(/\/$/, "");
      const magicLinkUrl = `${appUrl}/#/login?magic=${token}`;

      await sendTeamInviteEmail(
        normalizedEmail,
        memberName,
        req.user.name,
        req.organization.name,
        role,
        magicLinkUrl,
        {
          organizationId: req.orgId,
          userId: req.user?.id,
          route: "team.invite",
        },
      );
    } catch (e) {
      console.warn("Invite email failed:", e.message);
    }

    res.status(201).json({ member: serializeUser(member) });
  }),
);

// ── DELETE /api/team/members/:id ─────────────────────────────
router.delete(
  "/team/members/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    // Cannot remove yourself or the owner
    const { data: target } = await db
      .from("users")
      .select("role")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!target) {
      return res
        .status(404)
        .json({ error: { message: "Team member not found." } });
    }

    if (target.role === "Owner") {
      return res
        .status(403)
        .json({ error: { message: "Cannot remove the organization owner." } });
    }

    if (id === req.user.id) {
      return res
        .status(400)
        .json({ error: { message: "You cannot remove yourself." } });
    }

    await db
      .from("users")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    res.json({ success: true });
  }),
);

// ============================================================
// BILLING
// ============================================================

// ── GET /api/billing/summary ─────────────────────────────────
router.get(
  "/billing/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: org } = await db
      .from("organizations")
      .select(
        "plan,subscription_status,subscription_period_end,usage_calls,usage_minutes,call_limit,minute_limit",
      )
      .eq("id", req.orgId)
      .single();

    const { data: invoiceRows, error: invoicesError } = await db
      .from("invoices")
      .select("id,amount,status,pdf_url,date,created_at")
      .eq("organization_id", req.orgId)
      .order("date", { ascending: false });
    if (invoicesError) throw invoicesError;
    const invoices = Array.isArray(invoiceRows) ? invoiceRows : [];

    const serializedInvoices = invoices.map((invoice) => ({
      id: invoice.id,
      amount: Number(invoice.amount || 0),
      status: invoice.status || "Paid",
      pdfUrl: invoice.pdf_url || "",
      date: invoice.date || invoice.created_at,
    }));

    const paidAmount = serializedInvoices
      .filter((invoice) => invoice.status === "Paid")
      .reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
    const pendingAmount = serializedInvoices
      .filter((invoice) => invoice.status !== "Paid")
      .reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);

    const wallet = await loadCustomerWalletSummary(db, req.orgId, 150);
    wallet.creditEnforcementMode = currentCreditEnforcementMode();
    wallet.autoChargeWalletEnabled = isAutoWalletChargeEnabled();
    wallet.minimums = {
      callUsd: Number(process.env.BILLING_MIN_CALL_CREDIT_USD || 1),
      chatUsd: Number(process.env.BILLING_MIN_CHAT_CREDIT_USD || 0.05),
      voicePreviewUsd: Number(
        process.env.BILLING_MIN_VOICE_PREVIEW_CREDIT_USD || 0.05,
      ),
      knowledgeSyncUsd: Number(
        process.env.BILLING_MIN_KNOWLEDGE_SYNC_CREDIT_USD || 0.25,
      ),
      activeUsd: Number(process.env.BILLING_MIN_ACTIVE_CREDIT_USD || 1),
      hardStopBalanceUsd: -maxNegativeBalanceUsd(),
      maxNegativeBalanceUsd: maxNegativeBalanceUsd(),
    };
    let numberRetention = null;
    try {
      // This is idempotent: it starts or resolves the warning state immediately
      // when the authenticated workspace loads. Only the secured cron route may
      // perform the irreversible number release.
      await reconcileOrganizationNumberRetention({
        organizationId: req.orgId,
        allowRelease: false,
      });
      numberRetention = await getNumberRetentionStatus(req.orgId);
    } catch (retentionError) {
      warnThrottled(
        "number-retention-billing-summary",
        "[number-retention] billing summary sync skipped:",
        retentionError?.message || String(retentionError),
      );
    }

    const plan = org?.plan || req.organization?.plan || "Starter";
    const minuteLimit =
      plan === "Starter" ? 500 : Number(org?.minute_limit || 2500);
    const callLimit = plan === "Starter" ? 100 : Number(org?.call_limit || 500);

    res.json({
      success: true,
      organizationId: req.orgId,
      plan,
      status:
        org?.subscription_status ||
        req.organization?.subscription_status ||
        "trialing",
      currentPeriodEnd:
        org?.subscription_period_end ||
        req.organization?.subscription_period_end,
      usage: {
        calls: Number(org?.usage_calls || 0),
        minutes: Number(org?.usage_minutes || 0),
        callLimit,
        minuteLimit,
      },
      invoices: serializedInvoices,
      totals: {
        paidAmount,
        pendingAmount,
        invoiceCount: serializedInvoices.length,
      },
      wallet: {
        ...wallet,
        demoTopUpEnabled: parseBillingDemoBool(
          process.env.BILLING_DEMO_TOPUP_ENABLED,
        ),
        creditEnforcementMode: currentCreditEnforcementMode(),
        autoChargeWalletEnabled: isAutoWalletChargeEnabled(),
        numberRetention,
        minimums: {
          callUsd: Number(process.env.BILLING_MIN_CALL_CREDIT_USD || 1),
          chatUsd: Number(process.env.BILLING_MIN_CHAT_CREDIT_USD || 0.05),
          voicePreviewUsd: Number(
            process.env.BILLING_MIN_VOICE_PREVIEW_CREDIT_USD || 0.05,
          ),
          knowledgeSyncUsd: Number(
            process.env.BILLING_MIN_KNOWLEDGE_SYNC_CREDIT_USD || 0.25,
          ),
          activeUsd: Number(process.env.BILLING_MIN_ACTIVE_CREDIT_USD || 1),
          voicePreviewUsd: Number(
            process.env.BILLING_MIN_VOICE_PREVIEW_CREDIT_USD || 0.05,
          ),
          knowledgeSyncUsd: Number(
            process.env.BILLING_MIN_KNOWLEDGE_SYNC_CREDIT_USD || 0.25,
          ),
          maxNegativeBalanceUsd: maxNegativeBalanceUsd(),
          hardStopBalanceUsd: -maxNegativeBalanceUsd(),
        },
      },
    });
  }),
);

// ── POST /api/billing/wallet/demo-top-up ─────────────────────
router.post(
  "/billing/wallet/demo-top-up",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!parseBillingDemoBool(process.env.BILLING_DEMO_TOPUP_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Demo wallet top-up is disabled. Set BILLING_DEMO_TOPUP_ENABLED=true on the backend to use this manual test mode.",
        },
      });
    }

    const amountUsd = Number(req.body?.amountUsd ?? req.body?.amount_usd ?? 30);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res
        .status(400)
        .json({ error: { message: "amountUsd must be greater than zero." } });
    }
    if (amountUsd > 500) {
      return res.status(400).json({
        error: { message: "Demo wallet top-up is capped at $500 per request." },
      });
    }

    const db = getSupabase();
    const { data, error } = await db.rpc("billing_admin_top_up_wallet", {
      p_organization_id: req.orgId,
      p_amount_usd: amountUsd,
      p_source: "manual_demo_top_up",
      p_external_id: req.body?.externalId || `demo-top-up-${Date.now()}`,
      p_metadata: {
        manual_demo: true,
        performed_by_user_id: req.user?.id || null,
        performed_by_user_email: req.user?.email || null,
        note: "Manual wallet credit used for billing-system demonstration. Replace with payment-gateway webhook when live.",
        ...(req.body?.metadata || {}),
      },
    });

    if (error) {
      return res.status(500).json({
        error: {
          message:
            error.message ||
            "Unable to add demo wallet credit. Confirm the V41 wallet migration has been run.",
        },
      });
    }

    const wallet = await loadCustomerWalletSummary(db, req.orgId, 150);
    res.json({
      success: true,
      source: "billing_admin_top_up_wallet",
      mode: "manual_demo_top_up",
      transaction: data,
      wallet: {
        ...wallet,
        demoTopUpEnabled: true,
      },
      note: "This simulates a real top-up. It is not payment-verified and should be replaced by gateway webhook crediting before production billing.",
    });
  }),
);

// ── PATCH /api/billing/plan ──────────────────────────────────
router.patch(
  "/billing/plan",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { plan } = req.body;

    if (!["Starter", "Pro"].includes(plan)) {
      return res
        .status(400)
        .json({ error: { message: "Plan must be Starter or Pro." } });
    }

    const db = getSupabase();
    const planLimits = {
      Starter: { call_limit: 100, minute_limit: 500 },
      Pro: { call_limit: 500, minute_limit: 2500 },
    };

    const { data: org } = await db
      .from("organizations")
      .update({
        plan,
        subscription_status: "active",
        subscription_period_end: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        ...planLimits[plan],
      })
      .eq("id", req.orgId)
      .select()
      .single();

    // Create an invoice entry
    const amount = plan === "Pro" ? 99 : 49;
    await db.from("invoices").insert({
      id: `INV-${Date.now()}`,
      organization_id: req.orgId,
      amount,
      status: "Paid",
      date: new Date().toISOString(),
    });

    res.json({
      plan: org.plan,
      status: org.subscription_status,
      currentPeriodEnd: org.subscription_period_end,
      usage: {
        calls: org.usage_calls || 0,
        minutes: org.usage_minutes || 0,
        callLimit: org.call_limit || 100,
        minuteLimit: org.minute_limit || 500,
      },
    });
  }),
);

// ── POST /api/billing/cancel ─────────────────────────────────
router.post(
  "/billing/cancel",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = getSupabase();

    const { data: org } = await db
      .from("organizations")
      .update({ subscription_status: "canceled" })
      .eq("id", req.orgId)
      .select()
      .single();

    res.json({
      plan: org.plan,
      status: org.subscription_status,
      currentPeriodEnd: org.subscription_period_end,
      usage: {
        calls: org.usage_calls || 0,
        minutes: org.usage_minutes || 0,
        callLimit: org.call_limit || 100,
        minuteLimit: org.minute_limit || 500,
      },
    });
  }),
);

// ── GET /api/billing/invoices/:id/download ───────────────────
router.get(
  "/billing/invoices/:id/download",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: invoice } = await db
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!invoice) {
      return res.status(404).json({ error: { message: "Invoice not found." } });
    }

    const content = `AGENTLY INVOICE
===============
Invoice ID:   ${invoice.id}
Date:         ${new Date(invoice.date || invoice.created_at).toLocaleDateString()}
Organization: ${req.organization.name}
Amount:       $${parseFloat(invoice.amount || 0).toFixed(2)}
Status:       ${invoice.status || "Paid"}
Plan:         ${req.organization.plan}

Thank you for using Agently.
For questions, contact billing@agently.ai
`;

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.txt"`);
    res.send(content);
  }),
);

// ============================================================
// SETTINGS
// ============================================================

// ── GET /api/settings ────────────────────────────────────────
router.get(
  "/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: org } = await db
      .from("organizations")
      .select("timezone,phone_number")
      .eq("id", req.orgId)
      .single();

    res.json({
      timezone: org?.timezone || req.organization?.timezone || "Africa/Lagos",
      phoneNumber: org?.phone_number || req.organization?.phone_number || "",
      twilio: {
        webhookBaseUrl: process.env.API_URL || "",
      },
    });
  }),
);

// ── PATCH /api/settings ──────────────────────────────────────
router.patch(
  "/settings",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { timezone, phoneNumber, twilio } = req.body;

    const db = getSupabase();
    const updates = {};

    if (timezone !== undefined) updates.timezone = timezone;
    if (phoneNumber !== undefined) updates.phone_number = phoneNumber;

    if (twilio) {
      if (twilio.clearCredentials) {
        updates.twilio_account_sid = "";
        updates.twilio_auth_token_encrypted = "";
        updates.twilio_auth_token_last_four = "";
      } else {
        if (twilio.accountSid !== undefined)
          updates.twilio_account_sid = twilio.accountSid;
        if (twilio.authToken) {
          // In production you'd encrypt this; for now store with last 4
          updates.twilio_auth_token_encrypted = twilio.authToken; // Store securely in prod
          updates.twilio_auth_token_last_four = twilio.authToken.slice(-4);
        }
        if (twilio.validateRequests !== undefined)
          updates.twilio_validate_requests = twilio.validateRequests;
      }
    }

    updates.updated_at = new Date().toISOString();

    const { data: org } = await db
      .from("organizations")
      .update(updates)
      .eq("id", req.orgId)
      .select()
      .single();

    res.json({
      timezone: org.timezone,
      phoneNumber: org.phone_number,
      twilio: {
        accountSid: org.twilio_account_sid || "",
        authTokenConfigured: !!org.twilio_auth_token_encrypted,
        authTokenLastFour: org.twilio_auth_token_last_four || "",
        validateRequests: org.twilio_validate_requests ?? true,
        webhookBaseUrl:
          org.twilio_webhook_base_url || process.env.API_URL || "",
      },
    });
  }),
);

// ============================================================
// CONTACT
// ============================================================

// ── POST /api/contact ────────────────────────────────────────
router.post(
  "/contact",
  asyncHandler(async (req, res) => {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res
        .status(400)
        .json({ error: { message: "Name, email, and message are required." } });
    }

    const db = getSupabase();

    await db.from("contact_submissions").insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      subject: subject || "",
      message: message.trim(),
      type: "contact",
    });

    try {
      await sendContactEmail(
        { name, email, subject, message },
        { route: "contact.form" },
      );
    } catch (e) {
      console.warn("Contact email failed:", e.message);
    }

    res.json({
      success: true,
      message: "Your message has been sent successfully.",
    });
  }),
);

// ── POST /api/contact-sales ──────────────────────────────────
router.post(
  "/contact-sales",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, email, companyName, expectedVolume, message } = req.body;

    const db = getSupabase();

    await db.from("contact_submissions").insert({
      name: name || req.user.name,
      email: email || req.user.email,
      subject: "Sales Inquiry",
      message: message || `Interested in enterprise plan for ${companyName}.`,
      type: "sales",
      company_name: companyName || req.organization.name,
      expected_volume: expectedVolume || "",
    });

    try {
      await sendContactEmail({
        name: name || req.user.name,
        email: email || req.user.email,
        subject: "Sales Inquiry",
        message: `Company: ${companyName}\nVolume: ${expectedVolume}\n${message || ""}`,
        companyName,
        expectedVolume,
      });
    } catch (e) {
      console.warn("Sales contact email failed:", e.message);
    }

    res.json({
      success: true,
      message:
        "Sales inquiry submitted. Our team will be in touch within 24 hours.",
    });
  }),
);

// ============================================================
// ORGANIZATION DELETION REQUEST
// ============================================================

router.post(
  "/organization/delete-request",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { organizationName, acknowledgeNoRefund } = req.body || {};
    const expectedName =
      req.organization && req.organization.name ? req.organization.name : "";

    if (!organizationName || organizationName.trim() !== expectedName) {
      return res.status(400).json({
        error: {
          message: "Enter your organization name exactly to confirm deletion.",
        },
      });
    }

    if (acknowledgeNoRefund !== true) {
      return res.status(400).json({
        error: {
          message:
            "You must acknowledge that paid and ongoing subscriptions are not refunded upon deletion.",
        },
      });
    }

    const db = getSupabase();
    const requestedAt = new Date();
    const scheduledDeletionAt = new Date(
      requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const currentLimits =
      req.organization &&
      req.organization.outbound_call_limits &&
      typeof req.organization.outbound_call_limits === "object"
        ? req.organization.outbound_call_limits
        : {};
    const deletionMeta = {
      ...(currentLimits || {}),
      organization_deletion: {
        requested: true,
        requested_at: requestedAt.toISOString(),
        scheduled_deletion_at: scheduledDeletionAt,
        requested_by_user_id: req.user.id,
        requested_by_email: req.user.email,
        status: "pending_manual_deletion",
      },
    };

    const { error } = await db
      .from("organizations")
      .update({
        outbound_call_limits: deletionMeta,
        subscription_status: "canceled",
        updated_at: requestedAt.toISOString(),
      })
      .eq("id", req.orgId);

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Unable to submit deletion request." } });
    }

    await db
      .from("tenant_notifications")
      .insert({
        organization_id: req.orgId,
        user_id: req.user.id,
        type: "organization_deletion_requested",
        title: "Organization deletion requested",
        body: `${expectedName} requested deletion. Scheduled within 30 days.`,
        entity_type: "organization",
        entity_id: req.orgId,
        is_read: false,
        metadata: deletionMeta.organization_deletion,
      })
      .then(
        () => null,
        () => null,
      );

    await db
      .from("contact_submissions")
      .insert({
        name: req.user.name,
        email: req.user.email,
        subject: "Organization deletion request",
        message: `Organization deletion requested for ${expectedName} (${req.orgId}). Requested by ${req.user.name} <${req.user.email}>. Scheduled deletion by ${scheduledDeletionAt}.`,
        type: "contact",
        company_name: expectedName,
      })
      .then(
        () => null,
        () => null,
      );

    try {
      await sendContactEmail({
        name: req.user.name,
        email: req.user.email,
        subject: "Organization deletion request",
        message: `Organization deletion requested for ${expectedName} (${req.orgId}).\nRequested by: ${req.user.name} <${req.user.email}>\nScheduled deletion by: ${scheduledDeletionAt}\nPaid subscriptions are not refunded.`,
        companyName: expectedName,
      });
    } catch (mailError) {
      console.warn(
        "[organization deletion] owner notification email failed:",
        mailError.message,
      );
    }

    try {
      await sendOrganizationDeletionRequestEmail(
        req.user.email,
        req.user.name,
        expectedName,
        scheduledDeletionAt,
      );
    } catch (mailError) {
      console.warn(
        "[organization deletion] user confirmation email failed:",
        mailError.message,
      );
    }

    await db
      .from("sessions")
      .delete()
      .eq("user_id", req.user.id)
      .then(
        () => null,
        () => null,
      );

    res.json({
      success: true,
      deletionRequested: true,
      scheduledDeletionAt,
      accessDisabled: true,
    });
  }),
);

// ── GET /api/dashboard/metrics ───────────────────────────────
// Live dashboard metrics used by the frontend cards. Kept defensive because
// some tenant databases may be ahead/behind local migrations.
router.get(
  "/dashboard/metrics",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const orgId = req.orgId;

    const safeRows = async (table, selectCandidates = ["*"]) => {
      const candidates = Array.isArray(selectCandidates)
        ? [...selectCandidates]
        : [selectCandidates];
      const cachedSelect = dashboardSelectCache.get(table);

      if (cachedSelect) {
        const cachedIndex = candidates.indexOf(cachedSelect);
        if (cachedIndex >= 0) candidates.splice(cachedIndex, 1);
        candidates.unshift(cachedSelect);
      }

      let lastError = null;

      for (const select of candidates) {
        const { data, error } = await db
          .from(table)
          .select(select)
          .eq("organization_id", orgId);

        if (!error) {
          dashboardSelectCache.set(table, select);
          return Array.isArray(data) ? data : [];
        }

        lastError = error;
        const message = String(error.message || "").toLowerCase();
        const isSchemaMismatch =
          message.includes("does not exist") ||
          message.includes("schema cache") ||
          message.includes("could not find the");

        if (cachedSelect === select) dashboardSelectCache.delete(table);
        if (!isSchemaMismatch) break;
      }

      warnThrottled(
        `dashboard-metrics-${table}`,
        `[dashboard/metrics] ${table} unavailable:`,
        lastError?.message || "Unknown query error",
      );
      return [];
    };

    const [leads, chatMessages, calls, chunks] = await Promise.all([
      safeRows("leads", [
        "id,status,source,lead_source,channel,metadata,created_at",
        "id,status,source,channel,metadata,created_at",
        "id,status,source,created_at",
        "id,status,created_at",
      ]),
      safeRows("chat_messages", [
        "id,role,sender,source,created_at",
        "id,role,source,created_at",
        "id,role,created_at",
      ]),
      safeRows("call_records", [
        "id,duration,duration_seconds,recording_duration,status,outcome,created_at,timestamp",
        "id,duration,recording_duration,status,outcome,created_at,timestamp",
        "id,duration,outcome,created_at,timestamp",
        "id,duration,outcome,created_at",
      ]),
      safeRows("knowledge_chunks", ["id,content,created_at"]),
    ]);

    const normalizeSource = (row) => {
      const metadata =
        row && typeof row.metadata === "object" ? row.metadata : {};
      return String(
        row.source ||
          row.lead_source ||
          row.channel ||
          metadata.source ||
          metadata.channel ||
          metadata.capture_source ||
          "",
      ).toLowerCase();
    };
    const sourceIncludes = (row, value) => normalizeSource(row).includes(value);
    const statusIs = (row, value) =>
      String(row.status || "").toLowerCase() === value;
    const durationSeconds = (row) => {
      const value = Number(
        row.duration || row.duration_seconds || row.recording_duration || 0,
      );
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };

    const chatbotLeadsCaptured = leads.filter((lead) => {
      const source = normalizeSource(lead);
      return (
        source.includes("chat") ||
        source.includes("bot") ||
        source.includes("widget") ||
        source.includes("messenger")
      );
    }).length;
    const callLeadsCaptured = leads.filter((lead) => {
      const source = normalizeSource(lead);
      return (
        source.includes("call") ||
        source.includes("voice") ||
        source.includes("phone") ||
        source.includes("twilio")
      );
    }).length;
    const convertedLeads = leads.filter((lead) =>
      ["closed", "converted", "won"].includes(
        String(lead.status || "").toLowerCase(),
      ),
    ).length;
    const chatbotMessagesAnswered = chatMessages.filter((message) =>
      ["assistant", "bot", "agent"].includes(
        String(message.role || message.sender || "").toLowerCase(),
      ),
    ).length;
    const totalCallSeconds = calls.reduce(
      (sum, call) => sum + durationSeconds(call),
      0,
    );
    const estimatedStorageBytes = chunks.reduce(
      (sum, chunk) =>
        sum + Buffer.byteLength(String(chunk.content || ""), "utf8"),
      0,
    );

    res.json({
      success: true,
      organizationId: orgId,
      metrics: {
        usage: {
          totalCallSeconds,
          totalCallMinutes: totalCallSeconds / 60,
        },
        chatbot: {
          messagesAnswered: chatbotMessagesAnswered,
          totalMessages: chatMessages.length,
          leadsCaptured: chatbotLeadsCaptured,
        },
        leads: {
          totalCaptured: leads.length,
          totalLeads: leads.length,
          converted: convertedLeads,
          chatbotLeadsCaptured,
          chatbotLeads: chatbotLeadsCaptured,
          callLeadsCaptured,
          callLeads: callLeadsCaptured,
        },
        knowledge: {
          chunks: chunks.length,
          estimatedStorageBytes,
        },
      },
    });
  }),
);

module.exports = router;
