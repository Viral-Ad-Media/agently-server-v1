"use strict";

const express = require("express");
const {
  insertUsageEvent,
  summarizeUsage,
  reconcileTwilioAccountUsage,
  reconcileTwilioCallRecords,
  estimateTenantStorageBytes,
  estimateAllTenantStorageBytes,
  rebuildDailyUsageRollups,
  recalculateUsageEventCosts,
  upsertProviderResource,
  buildTenantUsageReport,
} = require("../../lib/usage-ledger");
const { getSupabase } = require("../../lib/supabase");
const {
  getPlanLimitStatus,
  createPlanLimitSnapshot,
} = require("../../lib/billing-limits");
const {
  evaluateEntitlement,
  getEnforcementMode,
} = require("../../lib/billing-entitlements");

const router = express.Router();

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getInternalBillingKey() {
  return String(process.env.INTERNAL_BILLING_ADMIN_KEY || "").trim();
}

function isSafeInternalKey(key) {
  return key && key.length >= 32;
}

function requireInternalBillingAccess(req, res, next) {
  const expected = getInternalBillingKey();
  if (!isSafeInternalKey(expected)) {
    return res.status(503).json({
      error: {
        message:
          "Internal billing usage endpoints are locked. Set INTERNAL_BILLING_ADMIN_KEY to a long random secret on the backend.",
      },
    });
  }

  const provided = String(
    req.headers["x-internal-billing-key"] ||
      req.headers["x-agently-internal-key"] ||
      "",
  ).trim();

  if (provided !== expected) {
    return res
      .status(403)
      .json({ error: { message: "Internal billing access required." } });
  }
  next();
}

function cleanOrgId(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function normalizePhoneForBillingResource(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[\s().-]/g, "");
  return cleaned.startsWith("+") ? cleaned : raw;
}

function pickFirstString(row, keys) {
  for (const key of keys) {
    const value = row && row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function syncTwilioProviderResources({
  organizationId = null,
  limit = 1000,
} = {}) {
  const sb = getSupabase();
  const max = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const results = {
    source: "twilio_phone_numbers_and_twilio_accounts",
    phoneNumbersScanned: 0,
    phoneNumbersMapped: 0,
    accountsScanned: 0,
    accountsMapped: 0,
    skipped: 0,
    warnings: [],
  };

  try {
    let query = sb
      .from("twilio_phone_numbers")
      .select("*")
      .not("organization_id", "is", null)
      .limit(max);
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query;
    if (error) throw error;

    for (const row of data || []) {
      results.phoneNumbersScanned += 1;
      const orgId = row.organization_id;
      const phoneNumber = normalizePhoneForBillingResource(
        pickFirstString(row, [
          "phone_number",
          "number",
          "friendly_name",
          "display_phone_number",
        ]),
      );
      const phoneSid = pickFirstString(row, [
        "phone_sid",
        "sid",
        "twilio_phone_sid",
      ]);
      const accountSid = pickFirstString(row, [
        "account_sid",
        "twilio_account_sid",
        "subaccount_sid",
      ]);

      if (!orgId) {
        results.skipped += 1;
        continue;
      }

      if (phoneNumber) {
        await upsertProviderResource({
          organizationId: orgId,
          provider: "twilio",
          resourceType: "phone_number",
          externalId: phoneNumber,
          displayValue: phoneNumber,
          metadata: {
            source_table: "twilio_phone_numbers",
            row_id: row.id || null,
            phone_sid: phoneSid || null,
            account_sid: accountSid || null,
          },
        });
        results.phoneNumbersMapped += 1;
      }

      if (phoneSid) {
        await upsertProviderResource({
          organizationId: orgId,
          provider: "twilio",
          resourceType: "phone_sid",
          externalId: phoneSid,
          displayValue: phoneNumber || phoneSid,
          metadata: {
            source_table: "twilio_phone_numbers",
            row_id: row.id || null,
            phone_number: phoneNumber || null,
            account_sid: accountSid || null,
          },
        });
      }

      if (accountSid) {
        await upsertProviderResource({
          organizationId: orgId,
          provider: "twilio",
          resourceType: "account_sid",
          externalId: accountSid,
          displayValue: accountSid,
          metadata: {
            source_table: "twilio_phone_numbers",
            row_id: row.id || null,
            phone_number: phoneNumber || null,
            phone_sid: phoneSid || null,
          },
        });
      }
    }
  } catch (err) {
    results.warnings.push(
      `twilio_phone_numbers sync skipped: ${err.message || String(err)}`,
    );
  }

  try {
    let accountQuery = sb
      .from("twilio_accounts")
      .select("*")
      .not("organization_id", "is", null)
      .limit(max);
    if (organizationId)
      accountQuery = accountQuery.eq("organization_id", organizationId);
    const { data, error } = await accountQuery;
    if (error) throw error;

    for (const row of data || []) {
      results.accountsScanned += 1;
      const orgId = row.organization_id;
      const accountSid = pickFirstString(row, [
        "account_sid",
        "sid",
        "twilio_account_sid",
        "subaccount_sid",
      ]);
      if (!orgId || !accountSid) {
        results.skipped += 1;
        continue;
      }
      await upsertProviderResource({
        organizationId: orgId,
        provider: "twilio",
        resourceType: "account_sid",
        externalId: accountSid,
        displayValue: row.friendly_name || row.name || accountSid,
        metadata: { source_table: "twilio_accounts", row_id: row.id || null },
      });
      results.accountsMapped += 1;
    }
  } catch (err) {
    results.warnings.push(
      `twilio_accounts sync skipped: ${err.message || String(err)}`,
    );
  }

  return results;
}

router.use(requireInternalBillingAccess);

router.get("/plans", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_plan_settings")
      .select("*")
      .order("monthly_price_usd", { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({
      source: "billing_admin_plan_settings",
      mainPlanTable: "billing_plan_catalog",
      note: "Edit billing_plan_catalog.included_usage, or use PATCH /api/billing-usage/plans/:planKey. All plan-limit views read from this table.",
      plans: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/plans/:planKey", async (req, res, next) => {
  try {
    const planKey = String(req.params.planKey || "")
      .trim()
      .toLowerCase();
    if (!planKey) {
      return res
        .status(400)
        .json({ error: { message: "planKey is required." } });
    }

    const body = req.body || {};
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_update_plan_limits", {
      p_plan_key: planKey,
      p_monthly_price_usd:
        body.monthlyPriceUsd === undefined &&
        body.monthly_price_usd === undefined
          ? null
          : Number(body.monthlyPriceUsd ?? body.monthly_price_usd),
      p_included_usage_patch: body.includedUsage || body.included_usage || {},
      p_overage_rates_patch: body.overageRates || body.overage_rates || {},
      p_display_name: body.displayName || body.display_name || null,
      p_metadata_patch: body.metadata || {},
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_update_plan_limits",
      plan: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/user-usage", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_user_usage_overview").select("*");
    const userId = cleanOrgId(req.query.userId || req.query.user_id);
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const email = String(
      req.query.email || req.query.userEmail || req.query.user_email || "",
    ).trim();

    if (userId) query = query.eq("user_id", userId);
    if (organizationId) query = query.eq("organization_id", organizationId);
    if (email) query = query.ilike("user_email", `%${email}%`);

    const { data, error } = await query
      .order("org_estimated_cost_usd", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_user_usage_overview",
      count: (data || []).length,
      rows: data || [],
      exampleQueries: {
        byEmail: "GET /api/billing-usage/user-usage?email=customer@example.com",
        byUserId: "GET /api/billing-usage/user-usage?userId=USER_UUID",
        byOrganization:
          "GET /api/billing-usage/user-usage?organizationId=ORG_UUID",
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/danger-zone/preview-deletion", async (req, res, next) => {
  try {
    const body = req.body || {};
    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_preview_user_or_org_deletion",
      {
        p_user_id: body.userId || body.user_id || null,
        p_user_email: body.userEmail || body.user_email || body.email || null,
        p_organization_id: body.organizationId || body.organization_id || null,
        p_delete_scope: body.deleteScope || body.delete_scope || "user",
      },
    );
    if (error) throw error;
    res.json({
      ok: true,
      warning: "Preview only. No rows were deleted.",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post("/danger-zone/delete", async (req, res, next) => {
  try {
    const body = req.body || {};
    const deleteScope = String(
      body.deleteScope || body.delete_scope || "user",
    ).toLowerCase();
    const requiredConfirm =
      deleteScope === "organization"
        ? "DELETE_ORGANIZATION_DATA"
        : "DELETE_USER_DATA";
    if (String(body.confirm || "") !== requiredConfirm) {
      return res.status(400).json({
        error: {
          message: `Refusing destructive delete. First run /danger-zone/preview-deletion, then pass confirm=${requiredConfirm}.`,
        },
      });
    }

    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_delete_user_or_org_everything",
      {
        p_user_id: body.userId || body.user_id || null,
        p_user_email: body.userEmail || body.user_email || body.email || null,
        p_organization_id: body.organizationId || body.organization_id || null,
        p_delete_scope: deleteScope,
        p_confirm: requiredConfirm,
      },
    );
    if (error) throw error;
    res.json({
      ok: true,
      warning:
        "Destructive delete executed. Review returned errors array if any.",
      result: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    const summary = await summarizeUsage({
      organizationId: cleanOrgId(
        req.query.organizationId || req.query.organization_id,
      ),
      start: req.query.start || null,
      end: req.query.end || null,
      includeUnassigned: parseBool(req.query.includeUnassigned),
    });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/tenant-report", async (req, res, next) => {
  try {
    const report = await buildTenantUsageReport({
      organizationId: cleanOrgId(
        req.query.organizationId || req.query.organization_id,
      ),
      start: req.query.start || null,
      end: req.query.end || null,
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.get("/admin-overview", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_tenant_usage")
      .select("*")
      .order("estimated_cost_usd", { ascending: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) {
      const fallback = await buildTenantUsageReport({
        organizationId,
        start: req.query.start || null,
        end: req.query.end || null,
      });
      return res.json({
        source: "buildTenantUsageReport_fallback",
        warning:
          "billing_admin_tenant_usage view could not be read. Run billing-admin-usage-query-pack.sql after billing-admin-tenant-usage-view.sql.",
        error: error.message,
        ...fallback,
      });
    }
    res.json({
      source: "billing_admin_tenant_usage",
      count: (data || []).length,
      tenants: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/provider-breakdown", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_usage_events")
      .select(
        "provider,service,event_type,unit,quantity,estimated_cost_usd,billable,occurred_at",
      )
      .eq("organization_id", organizationId)
      .gte("occurred_at", req.query.start || "1970-01-01")
      .lte("occurred_at", req.query.end || new Date().toISOString())
      .limit(50000);
    if (error) throw error;

    const totals = new Map();
    for (const row of data || []) {
      const key = [
        row.provider,
        row.service,
        row.event_type,
        row.unit || "unit",
        row.billable === false ? "non_billable" : "billable",
      ].join("|");
      if (!totals.has(key)) {
        totals.set(key, {
          organizationId,
          provider: row.provider,
          service: row.service,
          eventType: row.event_type,
          unit: row.unit,
          billable: row.billable !== false,
          quantity: 0,
          estimatedCostUsd: 0,
          events: 0,
          latestUsageAt: null,
        });
      }
      const item = totals.get(key);
      item.quantity += Number(row.quantity || 0);
      item.estimatedCostUsd += Number(row.estimated_cost_usd || 0);
      item.events += 1;
      if (
        !item.latestUsageAt ||
        String(row.occurred_at) > String(item.latestUsageAt)
      )
        item.latestUsageAt = row.occurred_at;
    }
    res.json({
      organizationId,
      start: req.query.start || null,
      end: req.query.end || null,
      breakdown: Array.from(totals.values()).sort(
        (a, b) => (b.estimatedCostUsd || 0) - (a.estimatedCostUsd || 0),
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/events", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_usage_events")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (organizationId) query = query.eq("organization_id", organizationId);
    if (!organizationId && !parseBool(req.query.includeUnassigned))
      query = query.not("organization_id", "is", null);
    if (req.query.provider) query = query.eq("provider", req.query.provider);
    if (req.query.service) query = query.eq("service", req.query.service);
    if (req.query.start) query = query.gte("occurred_at", req.query.start);
    if (req.query.end) query = query.lte("occurred_at", req.query.end);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post("/events", async (req, res, next) => {
  try {
    const event = req.body || {};
    if (!event.provider || !event.service) {
      return res
        .status(400)
        .json({ error: { message: "provider and service are required." } });
    }
    const inserted = await insertUsageEvent({
      ...event,
      organizationId: cleanOrgId(event.organizationId || event.organization_id),
      source: event.source || "internal_manual_backend_event",
    });
    res.status(201).json({ ok: true, event: inserted });
  } catch (err) {
    next(err);
  }
});

router.post("/resources", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id,
    );
    if (
      !organizationId ||
      !body.provider ||
      !body.resourceType ||
      !body.externalId
    ) {
      return res.status(400).json({
        error: {
          message:
            "organizationId, provider, resourceType, and externalId are required.",
        },
      });
    }
    const resource = await upsertProviderResource({
      organizationId,
      provider: body.provider,
      resourceType: body.resourceType,
      externalId: body.externalId,
      displayValue: body.displayValue,
      metadata: body.metadata || {},
    });
    res.status(201).json({ ok: true, resource });
  } catch (err) {
    next(err);
  }
});

router.post("/resources/sync-twilio", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to sync provider resources.",
        },
      });
    }
    const result = await syncTwilioProviderResources({
      organizationId: cleanOrgId(
        req.body?.organizationId ||
          req.query.organizationId ||
          req.body?.organization_id,
      ),
      limit: req.body?.limit || req.query.limit || 1000,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/smoke-test-event", async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = cleanOrgId(
      body.organizationId || body.organization_id || req.query.organizationId,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const event = await insertUsageEvent({
      organizationId,
      userId: body.userId || body.user_id || null,
      provider: "agently",
      service: "billing_verification",
      eventType: "smoke_test_event",
      source: "internal_billing_smoke_test",
      externalId: body.externalId || `smoke-${Date.now()}`,
      idempotencyKey: body.idempotencyKey || body.idempotency_key || null,
      unit: "event",
      quantity: 1,
      unitCostUsd: 0,
      estimatedCostUsd: 0,
      billable: false,
      metadata: {
        purpose:
          "Verifies record_billing_usage_event and billing_usage_events ingestion without charging the tenant.",
        manually_triggered: true,
        ...(body.metadata || {}),
      },
    });
    res.status(201).json({
      ok: true,
      message:
        "Smoke test billing event recorded. It is non-billable and zero-cost.",
      event,
      checkQueries: {
        rawEvents:
          "SELECT * FROM public.billing_admin_usage_event_audit WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY occurred_at DESC LIMIT 20;",
        health: "SELECT * FROM public.billing_admin_usage_health;",
        orgHealth:
          "SELECT * FROM public.billing_admin_org_cost_health WHERE organization_id = 'YOUR_ORG_UUID';",
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/usage-health", async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_usage_health")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    res.json({ source: "billing_admin_usage_health", health: data || null });
  } catch (err) {
    next(err);
  }
});

router.get("/org-cost-health", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_org_cost_health")
      .select("*")
      .order("estimated_cost_usd", { ascending: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_org_cost_health",
      count: (data || []).length,
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/twilio", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable it.",
        },
      });
    }

    const mode = String(
      req.body?.mode || req.query.mode || "calls",
    ).toLowerCase();
    const accountSid = req.body?.accountSid || req.query.accountSid || null;
    const startDate = req.body?.startDate || req.query.startDate || null;
    const endDate = req.body?.endDate || req.query.endDate || null;

    const result =
      mode === "account_usage" || mode === "usage_records"
        ? await reconcileTwilioAccountUsage({ accountSid, startDate, endDate })
        : await reconcileTwilioCallRecords({ accountSid, startDate, endDate });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/storage", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.body?.organizationId ||
        req.query.organizationId ||
        req.body?.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const result = await estimateTenantStorageBytes(organizationId);
    res.json({ ok: true, storage: result });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile/storage-all", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable it.",
        },
      });
    }
    const organizationId = cleanOrgId(
      req.body?.organizationId ||
        req.query.organizationId ||
        req.body?.organization_id,
    );
    const limit = Math.min(
      Math.max(Number(req.body?.limit || req.query.limit) || 500, 1),
      1000,
    );
    const result = await estimateAllTenantStorageBytes({
      organizationId,
      limit,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/rollups/daily", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage reconciliation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable rollup rebuilds.",
        },
      });
    }
    const result = await rebuildDailyUsageRollups({
      organizationId: cleanOrgId(
        req.body?.organizationId ||
          req.query.organizationId ||
          req.body?.organization_id,
      ),
      start: req.body?.start || req.query.start || null,
      end: req.body?.end || req.query.end || null,
    });
    res.json({ ok: true, rollup: result });
  } catch (err) {
    next(err);
  }
});

router.post("/costs/recalculate", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Usage cost recalculation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend to enable it.",
        },
      });
    }
    const result = await recalculateUsageEventCosts({
      organizationId: cleanOrgId(
        req.body?.organizationId ||
          req.query.organizationId ||
          req.body?.organization_id,
      ),
      start: req.body?.start || req.query.start || null,
      end: req.body?.end || req.query.end || null,
      limit: req.body?.limit || req.query.limit || 5000,
      force: parseBool(req.body?.force || req.query.force),
    });
    res.json({ ok: true, recalculation: result });
  } catch (err) {
    next(err);
  }
});

router.get("/plan-cost-overview", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_plan_cost_overview")
      .select("*")
      .order("estimated_margin_usd", { ascending: true, nullsFirst: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_plan_cost_overview",
      count: (data || []).length,
      tenants: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/plan-limit-overview", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    const sb = getSupabase();
    let query = sb
      .from("billing_admin_plan_limit_overview")
      .select("*")
      .order("estimated_margin_usd", { ascending: true, nullsFirst: false });
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_plan_limit_overview",
      count: (data || []).length,
      tenants: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/limit-status", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const status = await getPlanLimitStatus({ organizationId });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

router.post("/limit-snapshot", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.body?.organizationId ||
        req.query.organizationId ||
        req.body?.organization_id,
    );
    if (!organizationId) {
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    }
    const status = await createPlanLimitSnapshot({
      organizationId,
      reason: req.body?.reason || req.query.reason || "manual_admin_snapshot",
      metadata: req.body?.metadata || {},
    });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

router.get("/rate-coverage", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_rate_card_coverage")
      .select("*")
      .order("unrated_event_count", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ source: "billing_admin_rate_card_coverage", rows: data || [] });
  } catch (err) {
    next(err);
  }
});

router.get("/schema-inventory", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_billing_schema_inventory")
      .select("*")
      .order("table_type", { ascending: true })
      .order("table_name", { ascending: true });
    if (error) throw error;
    res.json({
      source: "billing_admin_billing_schema_inventory",
      note: "BASE TABLE rows are stored data. VIEW rows are saved admin queries and do not duplicate billing data.",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/customer-rates", async (_req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("billing_admin_customer_rate_settings")
      .select("*")
      .order("plan_key", { ascending: true })
      .order("provider", { ascending: true })
      .order("service", { ascending: true });
    if (error) throw error;
    res.json({
      source: "billing_admin_customer_rate_settings",
      mainCustomerRateTable: "billing_customer_rate_cards",
      note: "Edit this layer to control what the customer wallet is charged. Internal vendor cost remains private in billing_usage_events/billing_rate_cards.",
      rates: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/customer-rates", async (req, res, next) => {
  try {
    const body = req.body || {};
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_update_customer_rate", {
      p_plan_key: body.planKey || body.plan_key || "*",
      p_provider: body.provider || "*",
      p_service: body.service || "*",
      p_event_type: body.eventType || body.event_type || "*",
      p_unit: body.unit || "*",
      p_billing_mode: body.billingMode || body.billing_mode || "target_margin",
      p_customer_unit_price_usd:
        body.customerUnitPriceUsd === undefined &&
        body.customer_unit_price_usd === undefined
          ? null
          : Number(body.customerUnitPriceUsd ?? body.customer_unit_price_usd),
      p_markup_percent:
        body.markupPercent === undefined && body.markup_percent === undefined
          ? null
          : Number(body.markupPercent ?? body.markup_percent),
      p_target_margin_percent:
        body.targetMarginPercent === undefined &&
        body.target_margin_percent === undefined
          ? 50
          : Number(body.targetMarginPercent ?? body.target_margin_percent),
      p_minimum_charge_usd:
        body.minimumChargeUsd === undefined &&
        body.minimum_charge_usd === undefined
          ? 0
          : Number(body.minimumChargeUsd ?? body.minimum_charge_usd),
      p_notes: body.notes || null,
      p_metadata_patch: body.metadata || {},
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_update_customer_rate",
      rate: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/wallets", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_wallet_overview").select("*");
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query
      .order("wallet_balance_usd", { ascending: true })
      .limit(500);
    if (error) throw error;
    res.json({ source: "billing_admin_wallet_overview", rows: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post("/wallets/:organizationId/top-up", async (req, res, next) => {
  try {
    const organizationId = cleanOrgId(
      req.params.organizationId ||
        req.body?.organizationId ||
        req.body?.organization_id,
    );
    const amountUsd = Number(req.body?.amountUsd ?? req.body?.amount_usd);
    if (!organizationId)
      return res
        .status(400)
        .json({ error: { message: "organizationId is required." } });
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res
        .status(400)
        .json({ error: { message: "amountUsd must be greater than zero." } });
    }
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_top_up_wallet", {
      p_organization_id: organizationId,
      p_amount_usd: amountUsd,
      p_source: req.body?.source || "manual_admin_top_up",
      p_external_id: req.body?.externalId || req.body?.external_id || null,
      p_metadata: req.body?.metadata || {},
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_top_up_wallet",
      transaction: data,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/charge-usage-event", async (req, res, next) => {
  try {
    const usageEventId = cleanOrgId(
      req.body?.usageEventId || req.body?.usage_event_id,
    );
    if (!usageEventId)
      return res
        .status(400)
        .json({ error: { message: "usageEventId is required." } });
    const sb = getSupabase();
    const { data, error } = await sb.rpc("billing_admin_charge_usage_event", {
      p_usage_event_id: usageEventId,
      p_apply_wallet: parseBool(
        req.body?.applyWallet ?? req.body?.apply_wallet,
      ),
      p_force: parseBool(req.body?.force),
    });
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_charge_usage_event",
      result: data,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/recalculate-customer-charges", async (req, res, next) => {
  try {
    if (!parseBool(process.env.USAGE_RECONCILE_ENABLED)) {
      return res.status(403).json({
        error: {
          message:
            "Customer charge recalculation is disabled. Set USAGE_RECONCILE_ENABLED=true on the backend before bulk recalculation.",
        },
      });
    }
    const sb = getSupabase();
    const { data, error } = await sb.rpc(
      "billing_admin_recalculate_customer_charges",
      {
        p_organization_id: cleanOrgId(
          req.body?.organizationId ||
            req.body?.organization_id ||
            req.query.organizationId,
        ),
        p_start: req.body?.start || req.query.start || null,
        p_end: req.body?.end || req.query.end || null,
        p_apply_wallet: parseBool(
          req.body?.applyWallet ?? req.body?.apply_wallet,
        ),
        p_force: parseBool(req.body?.force),
        p_limit: Math.min(
          Math.max(Number(req.body?.limit || req.query.limit) || 5000, 1),
          50000,
        ),
      },
    );
    if (error) throw error;
    res.json({
      ok: true,
      source: "billing_admin_recalculate_customer_charges",
      result: data,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/customer-margin-overview", async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from("billing_admin_customer_margin_overview").select("*");
    const organizationId = cleanOrgId(
      req.query.organizationId || req.query.organization_id,
    );
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query
      .order("gross_profit_usd", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      source: "billing_admin_customer_margin_overview",
      rows: data || [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/admin-queries", (_req, res) => {
  res.json({
    mainTable: "billing_usage_events",
    canonicalWriter: "public.record_billing_usage_event(...)",
    adminViews: [
      "billing_admin_tenant_usage",
      "billing_admin_user_organization_usage",
      "billing_admin_provider_breakdown",
      "billing_admin_current_month_usage",
      "billing_admin_storage_breakdown",
      "billing_admin_unmatched_usage",
      "billing_admin_daily_rollup_overview",
      "billing_admin_plan_limit_overview",
      "billing_admin_org_limit_status",
      "billing_admin_entitlement_decisions",
      "billing_admin_org_billing_control_center",
      "billing_admin_usage_health",
      "billing_admin_org_cost_health",
      "billing_admin_usage_event_audit",
      "billing_admin_plan_settings",
      "billing_admin_user_usage_overview",
    ],
    queries: {
      allOrganizations:
        "SELECT * FROM billing_admin_tenant_usage ORDER BY estimated_cost_usd DESC;",
      oneOrganization:
        "SELECT * FROM billing_admin_tenant_usage WHERE organization_id = 'YOUR_ORG_UUID';",
      usersInOrganization:
        "SELECT * FROM billing_admin_user_organization_usage WHERE organization_id = 'YOUR_ORG_UUID';",
      findByUserEmail:
        "SELECT * FROM billing_admin_user_organization_usage WHERE user_email ILIKE '%customer@example.com%';",
      currentMonth:
        "SELECT * FROM billing_admin_current_month_usage WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY estimated_cost_usd DESC;",
      storageBreakdown:
        "SELECT * FROM billing_admin_storage_breakdown WHERE organization_id = 'YOUR_ORG_UUID';",
      providerBreakdown:
        "SELECT * FROM billing_admin_provider_breakdown WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY estimated_cost_usd DESC;",
      unmatchedUsage:
        "SELECT * FROM billing_admin_unmatched_usage ORDER BY occurred_at DESC;",
      rawEvents:
        "SELECT occurred_at, provider, service, event_type, unit, quantity, estimated_cost_usd, call_id, voice_agent_id, chatbot_id, metadata FROM billing_usage_events WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY occurred_at DESC LIMIT 200;",
      planCostOverview:
        "SELECT * FROM billing_admin_plan_cost_overview ORDER BY estimated_margin_usd ASC NULLS LAST;",
      oneOrgPlanCost:
        "SELECT * FROM billing_admin_plan_cost_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      rateCoverage:
        "SELECT * FROM billing_admin_rate_card_coverage ORDER BY unrated_event_count DESC;",
      planLimitOverview:
        "SELECT * FROM billing_admin_plan_limit_overview ORDER BY estimated_margin_usd ASC NULLS LAST;",
      oneOrgPlanLimit:
        "SELECT * FROM billing_admin_plan_limit_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      orgLimitStatus:
        "SELECT * FROM billing_admin_org_limit_status ORDER BY limit_status, estimated_cost_usd DESC;",
      billingControlCenter:
        "SELECT * FROM billing_admin_org_billing_control_center ORDER BY limit_status, estimated_margin_usd ASC NULLS LAST;",
      oneOrgBillingControlCenter:
        "SELECT * FROM billing_admin_org_billing_control_center WHERE organization_id = 'YOUR_ORG_UUID';",
      entitlementDecisions:
        "SELECT * FROM billing_admin_entitlement_decisions WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY created_at DESC LIMIT 200;",
      entitlementActionSummary:
        "SELECT action, decision, COUNT(*) FROM billing_admin_entitlement_decisions GROUP BY action, decision ORDER BY COUNT(*) DESC;",
      missingCostEvents:
        "SELECT provider, service, event_type, unit, COUNT(*) AS events, SUM(quantity) AS quantity FROM billing_usage_events WHERE estimated_cost_usd IS NULL GROUP BY provider, service, event_type, unit ORDER BY events DESC;",
      writerFunctionExists:
        "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'record_billing_usage_event') AS record_billing_usage_event_exists;",
      marginInputAudit:
        "SELECT COUNT(*) AS events, SUM(quantity) AS quantity, SUM(estimated_cost_usd) AS estimated_cost_usd, COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL) AS null_cost_events FROM billing_usage_events;",
      usageHealth: "SELECT * FROM billing_admin_usage_health;",
      orgCostHealth:
        "SELECT * FROM billing_admin_org_cost_health ORDER BY estimated_cost_usd DESC;",
      oneOrgCostHealth:
        "SELECT * FROM billing_admin_org_cost_health WHERE organization_id = 'YOUR_ORG_UUID';",
      usageEventAudit:
        "SELECT * FROM billing_admin_usage_event_audit WHERE organization_id = 'YOUR_ORG_UUID' ORDER BY occurred_at DESC LIMIT 200;",
      planSettings:
        "SELECT * FROM billing_admin_plan_settings ORDER BY monthly_price_usd NULLS LAST;",
      changeStarterLeads:
        "SELECT public.billing_admin_update_plan_limits('starter', NULL, '{\"leads\":2000}'::jsonb);",
      changeStarterVoiceMinutes:
        "SELECT public.billing_admin_update_plan_limits('starter', NULL, '{\"voice_minutes\":500}'::jsonb);",
      userUsageByEmail:
        "SELECT * FROM billing_admin_user_usage_overview WHERE user_email ILIKE '%customer@example.com%';",
      userUsageByOrganization:
        "SELECT * FROM billing_admin_user_usage_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      previewDeleteUser:
        "SELECT * FROM public.billing_admin_preview_user_or_org_deletion(p_user_email := 'customer@example.com', p_delete_scope := 'user');",
      previewDeleteOrganization:
        "SELECT * FROM public.billing_admin_preview_user_or_org_deletion(p_organization_id := 'YOUR_ORG_UUID', p_delete_scope := 'organization');",
      deleteUserDanger:
        "SELECT public.billing_admin_delete_user_or_org_everything(p_user_email := 'customer@example.com', p_delete_scope := 'user', p_confirm := 'DELETE_USER_DATA');",
      deleteOrganizationDanger:
        "SELECT public.billing_admin_delete_user_or_org_everything(p_organization_id := 'YOUR_ORG_UUID', p_delete_scope := 'organization', p_confirm := 'DELETE_ORGANIZATION_DATA');",
      schemaInventory:
        "SELECT * FROM billing_admin_billing_schema_inventory ORDER BY table_type, table_name;",
      customerRateSettings:
        "SELECT * FROM billing_admin_customer_rate_settings;",
      setDefaultCustomerMargin50:
        "SELECT public.billing_admin_update_customer_rate('*','*','*','*','*','target_margin',NULL,NULL,50,0,'Default 50 percent gross margin','{}'::jsonb);",
      setStarterVoiceMargin50:
        "SELECT public.billing_admin_update_customer_rate('starter','twilio','voice','*','minutes','target_margin',NULL,NULL,50,0,'Starter voice margin','{}'::jsonb);",
      topUpWallet30:
        "SELECT public.billing_admin_top_up_wallet('YOUR_ORG_UUID', 30, 'manual_test_top_up');",
      recalculateCustomerChargesNoWalletDebit:
        "SELECT public.billing_admin_recalculate_customer_charges('YOUR_ORG_UUID', NULL, NULL, false, false, 5000);",
      walletOverview:
        "SELECT * FROM billing_admin_wallet_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      customerMarginOverview:
        "SELECT * FROM billing_admin_customer_margin_overview WHERE organization_id = 'YOUR_ORG_UUID';",
      customerRatesEndpoint: "GET /api/billing-usage/customer-rates",
      updateCustomerRateEndpoint: "PATCH /api/billing-usage/customer-rates",
      walletEndpoint:
        "GET /api/billing-usage/wallets?organizationId=YOUR_ORG_UUID",
      walletTopUpEndpoint:
        "POST /api/billing-usage/wallets/YOUR_ORG_UUID/top-up",
      chargeUsageEventEndpoint: "POST /api/billing-usage/charge-usage-event",
      recalculateCustomerChargesEndpoint:
        "POST /api/billing-usage/recalculate-customer-charges",
      planSettingsEndpoint: "GET /api/billing-usage/plans",
      updatePlanEndpoint: "PATCH /api/billing-usage/plans/starter",
      userUsageEndpoint:
        "GET /api/billing-usage/user-usage?email=customer@example.com",
      syncTwilioResourcesEndpoint:
        "POST /api/billing-usage/resources/sync-twilio",
      smokeTestEndpoint: "POST /api/billing-usage/smoke-test-event",
    },
  });
});

module.exports = router;
