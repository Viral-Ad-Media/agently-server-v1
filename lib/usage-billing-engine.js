"use strict";

/**
 * USAGE BILLING ENGINE — periodic cost-plus-margin metering.
 *
 * DISABLED BY DEFAULT. Nothing debits a wallet unless BILLING_ENGINE_ENABLED=true
 * AND the caller passes { dryRun: false }. Run scripts/billing-run-cycle.js with
 * --dry-run first and read the report.
 *
 * ── What this does and does NOT charge ───────────────────────────────────
 *
 * DIRECT provider cost (Twilio minutes/SMS, ElevenLabs characters, OpenAI
 * tokens + realtime audio, storage, email, recordings, transcripts) is ALREADY
 * charged per event: insertUsageEvent -> billing_customer_usage_charges ->
 * postWalletDebitForChargeDirectly, with margin applied, and
 * isAutoWalletChargeEnabled() returns true unconditionally. This engine
 * therefore READS direct cost but never re-charges it. Doing so would bill
 * every tenant twice for the same call.
 *
 * SHARED infrastructure is what nothing charges today:
 *   AWS Lightsail   flat per-bundle monthly price, billed to us regardless of
 *                   tenant activity (Lightsail bundles are fixed-price, not
 *                   metered, so there is no per-tenant figure to fetch)
 *   Supabase        plan base + metered disk / egress / storage overage
 * Neither can be attributed to a single call, so each pool is split across orgs
 * by the usage that actually drives it (see COST_MODEL), marked up, and debited
 * once per period. This is the only debit the engine makes.
 *
 * ── Margin ───────────────────────────────────────────────────────────────
 *
 * "70% profit" is gross margin: cost / (1 - 0.70) ~= cost x 3.33, NOT cost x 1.7.
 * Same 100/(100-margin) form already used by
 * billing_customer_rates.target_margin_percent and api/routes/super-admin.js,
 * so period charges and per-event charges cannot drift apart.
 */

const { getBillingPlatformSettings } = require("./billing-settings");

const PERIOD_TABLE = "billing_period_charges";
const WALLET_TX_TABLE = "billing_wallet_transactions";
const DEBIT_SOURCE = "usage_billing_engine_shared_infra";

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round = (value, places = 6) => {
  const f = 10 ** places;
  return Math.round(safeNumber(value) * f) / f;
};

const money = (value) => Math.round(safeNumber(value) * 100) / 100;

const nowIso = () => new Date().toISOString();

/** Gross-margin markup. 70 => 3.333...  Clamped below 100; cost/(1-1) is infinite. */
function marginMultiplier(marginPercent) {
  const m = Math.min(Math.max(safeNumber(marginPercent, 70), 0), 95);
  return 100 / (100 - m);
}

function applyMargin(costUsd, marginPercent) {
  return round(safeNumber(costUsd) * marginMultiplier(marginPercent));
}

/* ═════════════════════════════════════════════════════════════════════════
 * THE COST MODEL — how a shared bill is split between tenants
 * ═════════════════════════════════════════════════════════════════════════
 *
 * The naive approach is to pick one number ("split by call minutes") and live
 * with it being wrong for anyone whose usage does not look like calls. That is
 * a guess dressed up as a policy, and it is unfair in both directions: a
 * chat-only tenant with a huge knowledge base pays nothing toward the database
 * they fill, and a call-heavy tenant subsidises them.
 *
 * Instead, each pooled bill is split by the usage that actually causes it.
 * A tenant's share of a bill = their share of that bill's cost drivers.
 *
 *   Lightsail is one box running websocket audio. What consumes it is time
 *   spent processing a live session, so it splits on compute seconds alone.
 *
 *   Supabase is a database plus disk. Its Pro bill is roughly $10 of compute
 *   against ~$15 of disk/egress/storage, so it splits ~40/60 between database
 *   activity and bytes stored. Those weights are declared here rather than
 *   buried in arithmetic so they can be corrected against a real invoice.
 *
 * Two properties this has to preserve, both enforced by tests:
 *   - the split always sums to 100% of the pool (no cost quietly vanishes)
 *   - an org with no usage of a driver pays nothing toward it
 */

/**
 * A driver is one measurable thing that makes a shared bill bigger.
 *
 * `kind` matters more than it looks. A FLOW accumulates over the period, so
 * summing it is correct: two 30-second calls are a minute of compute. A LEVEL
 * is a standing measurement, so summing it is nonsense: three storage snapshots
 * of 5GB is 5GB held, not 15GB. Levels take the largest reading in the window.
 */
const DRIVERS = {
  // Seconds of live session work. Sources: the websocket runtime meter
  // (unit "seconds") and voice minutes (unit "minutes", converted).
  computeSeconds: {
    kind: "flow",
    label: "compute seconds",
    measure: (row) => {
      if (row.unit === "seconds") return safeNumber(row.quantity);
      if (row.unit === "minutes") return safeNumber(row.quantity) * 60;
      return 0;
    },
  },

  // Bytes the tenant is holding in Supabase. A level, not a flow.
  storageBytes: {
    kind: "level",
    label: "stored bytes",
    measure: (row) => (row.unit === "bytes" ? safeNumber(row.quantity) : 0),
  },

  // Platform activity, measured in dollars of work done, as a proxy for
  // database load.
  //
  // This deliberately does NOT count rows. Counting events made one sent email
  // weigh the same as an hour-long call, which handed a near-idle tenant a real
  // slice of the database bill — a per-month way of thinking, and we do not
  // bill per month. Weighing by the size of the work means a tenant who did
  // almost nothing pays almost nothing, which is what a prepaid usage product
  // has to do.
  activityCostUsd: {
    kind: "flow",
    label: "activity (usd of work)",
    measure: (row) =>
      row.billable === false ? 0 : Math.max(safeNumber(row.estimated_cost_usd), 0),
  },
};

/**
 * Which drivers each shared bill splits on, and in what proportion.
 * Weights per provider are normalised, so they need not sum to 1.
 */
const COST_MODEL = {
  lightsail: { computeSeconds: 1 },
  supabase: { storageBytes: 0.6, activityCostUsd: 0.4 },
  // Anything set via SHARED_INFRA_MONTHLY_USD: no better information than
  // "it serves both", so it splits evenly between working and storing.
  other: { computeSeconds: 0.5, activityCostUsd: 0.5 },
};

/* ─────────────────────────────────────────────────────────────────────────
 * Shared infrastructure cost
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The flat bills, per hour, so any window can be priced without waiting for a
 * month-end invoice.
 *
 * These are CONFIGURATION, not measurements, and deliberately so: Lightsail
 * bundles are a fixed monthly price, so no API can report a per-tenant figure
 * — the number is whichever bundle we run. Supabase base is likewise fixed;
 * only its overages vary, and those come off the invoice. Unset means zero,
 * which charges nothing rather than inventing a figure.
 */
function sharedMonthlyCostUsd(env = process.env) {
  const pools = {
    lightsail: safeNumber(env.AWS_LIGHTSAIL_MONTHLY_USD, 0),
    supabase: safeNumber(env.SUPABASE_MONTHLY_USD, 0),
    other: safeNumber(env.SHARED_INFRA_MONTHLY_USD, 0),
  };
  const total = pools.lightsail + pools.supabase + pools.other;
  return { pools, total, configured: total > 0 };
}

const HOURS_PER_MONTH = 730; // 365*24/12 — the convention AWS itself prices on

function sharedHourlyCostUsd(env = process.env) {
  const monthly = sharedMonthlyCostUsd(env);
  return {
    ...monthly,
    hourlyUsd: monthly.total / HOURS_PER_MONTH,
    monthlyTotalUsd: monthly.total,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Apportionment
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Each org's share of one driver, as a fraction of everyone's total.
 * Returns null when nobody used the driver at all — the caller redistributes
 * that weight rather than dropping the money on the floor.
 */
function driverShares(orgs, driverName) {
  const total = orgs.reduce(
    (sum, o) => sum + safeNumber(o.drivers?.[driverName]),
    0,
  );
  if (total <= 0) return null;
  const shares = new Map();
  for (const org of orgs) {
    shares.set(org.organizationId, safeNumber(org.drivers?.[driverName]) / total);
  }
  return shares;
}

/**
 * Split ONE pooled bill across orgs using that pool's weighted drivers.
 *
 * If a driver has no usage this period (nobody stored anything, say), its
 * weight is redistributed across the drivers that do have usage. Without that,
 * part of a real bill would silently go unallocated and we would absorb it
 * without ever being told.
 *
 * Returns per-org dollars plus the reasoning, so a charge can be explained.
 */
function apportionPool(orgs, pooledCostUsd, weights) {
  const empty = {
    allocations: new Map(orgs.map((o) => [o.organizationId, 0])),
    effectiveWeights: {},
    unallocatedUsd: round(pooledCostUsd),
  };
  // No bill to split is not the same as a bill nobody can be charged for. With
  // no active orgs the cost is real and we absorb it, so it has to be reported
  // as unallocated rather than silently reading as zero.
  if (safeNumber(pooledCostUsd) <= 0) return { ...empty, unallocatedUsd: 0 };
  if (!orgs.length) return empty;

  // Keep only drivers somebody actually used, then renormalise their weights.
  const live = [];
  for (const [driverName, weight] of Object.entries(weights)) {
    if (safeNumber(weight) <= 0) continue;
    const shares = driverShares(orgs, driverName);
    if (shares) live.push({ driverName, weight: safeNumber(weight), shares });
  }
  if (!live.length) return empty; // nobody used anything: we absorb the bill

  const weightTotal = live.reduce((s, d) => s + d.weight, 0);
  const allocations = new Map(orgs.map((o) => [o.organizationId, 0]));
  const effectiveWeights = {};

  for (const { driverName, weight, shares } of live) {
    const normalised = weight / weightTotal;
    effectiveWeights[driverName] = round(normalised, 4);
    for (const org of orgs) {
      const share = shares.get(org.organizationId) || 0;
      allocations.set(
        org.organizationId,
        allocations.get(org.organizationId) + pooledCostUsd * normalised * share,
      );
    }
  }

  for (const [orgId, usd] of allocations) allocations.set(orgId, round(usd));
  return { allocations, effectiveWeights, unallocatedUsd: 0 };
}

/** Split every pool, then total each org's shared cost. */
function apportionShared(orgs, pools, costModel = COST_MODEL) {
  const perPool = {};
  const totals = new Map(orgs.map((o) => [o.organizationId, 0]));
  let unallocatedUsd = 0;

  for (const [poolName, poolUsd] of Object.entries(pools)) {
    const weights = costModel[poolName];
    if (!weights || safeNumber(poolUsd) <= 0) continue;
    const result = apportionPool(orgs, poolUsd, weights);
    perPool[poolName] = {
      poolUsd: round(poolUsd),
      drivers: result.effectiveWeights,
      unallocatedUsd: result.unallocatedUsd,
      byOrg: Object.fromEntries(result.allocations),
    };
    unallocatedUsd += result.unallocatedUsd;
    for (const [orgId, usd] of result.allocations) {
      totals.set(orgId, round(totals.get(orgId) + usd));
    }
  }

  return { perPool, totals, unallocatedUsd: round(unallocatedUsd) };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Usage collection
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Per-org usage for the period, from billing_usage_events.
 *
 * Two things come out of one pass:
 *   directCostUsd — billable rows only, for the audit record. These are
 *     `estimated_cost_usd`, what our meters computed at event time, not a
 *     reconciled invoice; reconcile-org-cost.js trues them up.
 *   drivers — computed over ALL rows, billable or not, because a row that we
 *     do not charge the tenant for (a non-billable runtime measurement, say)
 *     still describes load they put on the shared box.
 */
async function collectUsage(db, { from, to, pageSize = 1000 }) {
  const byOrg = new Map();
  let offset = 0;

  const blankDrivers = () =>
    Object.fromEntries(Object.keys(DRIVERS).map((name) => [name, 0]));

  for (;;) {
    const { data, error } = await db
      .from("billing_usage_events")
      .select(
        "organization_id,provider,unit,quantity,estimated_cost_usd,billable",
      )
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = data || [];

    for (const row of rows) {
      const orgId = row.organization_id;
      if (!orgId) continue;
      if (!byOrg.has(orgId)) {
        byOrg.set(orgId, {
          organizationId: orgId,
          directCostUsd: 0,
          eventCount: 0,
          providers: {},
          drivers: blankDrivers(),
        });
      }
      const org = byOrg.get(orgId);

      if (row.billable !== false) {
        const cost = safeNumber(row.estimated_cost_usd);
        const provider = row.provider || "unknown";
        org.directCostUsd = round(org.directCostUsd + cost);
        org.providers[provider] = round(
          safeNumber(org.providers[provider]) + cost,
        );
      }
      org.eventCount += 1;

      for (const [name, driver] of Object.entries(DRIVERS)) {
        const value = driver.measure(row);
        if (!value) continue;
        // Flows accumulate; levels take the high-water mark in the window.
        org.drivers[name] =
          driver.kind === "level"
            ? Math.max(org.drivers[name], value)
            : org.drivers[name] + value;
      }
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  for (const org of byOrg.values()) {
    for (const name of Object.keys(org.drivers)) {
      org.drivers[name] = round(org.drivers[name], 3);
    }
  }
  return [...byOrg.values()];
}

/* ─────────────────────────────────────────────────────────────────────────
 * The cycle
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Price one period.
 *
 * CADENCE: hourly.
 *
 * Daily was the alternative and loses on one specific point: the wallet is a
 * prepaid balance that gates live calls, so a daily cycle lets a tenant run up
 * to 24 hours of shared-infra usage past an empty balance before anything
 * debits — the exact leak the credit system exists to close. Hourly also lines
 * up with how Lightsail bills (per node-hour), so apportionment matches the
 * real invoice instead of being a monthly figure retro-fitted to a window.
 */
async function runBillingCycle(db, options = {}) {
  const {
    from,
    to = nowIso(),
    dryRun = true,
    marginPercent: marginOverride,
    costModel = COST_MODEL,
    env = process.env,
    // "absorb" is the Vapi/Bland model and the default: infrastructure is a
    // cost of doing business, priced into the unit rate, never a line item on
    // a tenant's bill. "passthrough" bills each tenant their apportioned share
    // directly and exists only because it is occasionally the right answer for
    // a large dedicated customer.
    mode = String(env.BILLING_INFRA_MODE || "absorb"),
  } = options;

  if (!from) throw new Error("runBillingCycle requires a `from` timestamp.");
  if (!["absorb", "passthrough"].includes(mode)) {
    throw new Error(
      `Unknown infra mode: ${mode}. Use "absorb" (default) or "passthrough".`,
    );
  }

  const settings = await getBillingPlatformSettings(db);
  const marginPercent = safeNumber(
    marginOverride ?? settings.defaultTargetMarginPercent,
    70,
  );

  const hours = Math.max(
    (new Date(to).getTime() - new Date(from).getTime()) / 3600000,
    0,
  );
  const shared = sharedMonthlyCostUsd(env);
  const hourFraction = hours / HOURS_PER_MONTH;
  const pools = Object.fromEntries(
    Object.entries(shared.pools).map(([name, monthly]) => [
      name,
      round(monthly * hourFraction),
    ]),
  );
  const pooledSharedCostUsd = round(shared.total * hourFraction);

  const orgs = await collectUsage(db, { from, to });
  const { perPool, totals, unallocatedUsd } = apportionShared(
    orgs,
    pools,
    costModel,
  );

  const rows = orgs.map((org) => {
    const sharedCostUsd = round(totals.get(org.organizationId) || 0);
    return {
      ...org,
      sharePercent:
        pooledSharedCostUsd > 0
          ? round((sharedCostUsd / pooledSharedCostUsd) * 100, 4)
          : 0,
      sharedCostUsd,
      marginPercent,
      marginMultiplier: round(marginMultiplier(marginPercent), 4),
      // What this tenant is actually charged for infrastructure. In absorb
      // mode that is zero by design — infra is in the unit rate, not on the
      // bill. The apportioned cost above is still computed and stored, because
      // it is what tells us whether the unit rate is high enough.
      sharedBillableUsd:
        mode === "passthrough"
          ? money(applyMargin(sharedCostUsd, marginPercent))
          : 0,
      // Revenue we actually collect from this tenant: their direct usage,
      // marked up. This is the only thing a tenant sees.
      revenueUsd: money(applyMargin(org.directCostUsd, marginPercent)),
      trueCostUsd: round(org.directCostUsd + sharedCostUsd),
      directChargedElsewhere: true,
    };
  });

  // ── Are we actually making money? ──────────────────────────────────────
  //
  // In absorb mode the tenant's bill no longer mentions infrastructure, which
  // makes it very easy to run at a loss without noticing: the unit rate looks
  // like it carries a 70% margin while the flat server bill quietly eats it.
  // These figures exist so that cannot happen silently.
  const totalDirectCostUsd = round(rows.reduce((s, r) => s + r.directCostUsd, 0));
  const allocatedSharedUsd = round(rows.reduce((s, r) => s + r.sharedCostUsd, 0));
  const totalCostUsd = round(totalDirectCostUsd + pooledSharedCostUsd);
  const revenueUsd =
    mode === "passthrough"
      ? money(
          rows.reduce((s, r) => s + r.revenueUsd + r.sharedBillableUsd, 0),
        )
      : money(rows.reduce((s, r) => s + r.revenueUsd, 0));
  const grossProfitUsd = money(revenueUsd - totalCostUsd);

  const economics = {
    mode,
    totalCostUsd,
    directCostUsd: totalDirectCostUsd,
    sharedCostUsd: pooledSharedCostUsd,
    revenueUsd,
    grossProfitUsd,
    profitable: grossProfitUsd >= 0,
    // Margin we are ACTUALLY achieving once infrastructure is counted.
    actualMarginPercent:
      revenueUsd > 0 ? round(((revenueUsd - totalCostUsd) / revenueUsd) * 100, 2) : null,
    // Multiplier on direct provider cost at which we merely break even.
    breakEvenMultiplier:
      totalDirectCostUsd > 0 ? round(totalCostUsd / totalDirectCostUsd, 3) : null,
    // Multiplier on direct provider cost needed to hit the target margin with
    // infrastructure absorbed. This is the number that should set unit prices.
    requiredMultiplier:
      totalDirectCostUsd > 0
        ? round(
            (totalCostUsd / totalDirectCostUsd) * marginMultiplier(marginPercent),
            3,
          )
        : null,
    currentMultiplier: round(marginMultiplier(marginPercent), 3),
    infraShareOfCostPercent:
      totalCostUsd > 0 ? round((pooledSharedCostUsd / totalCostUsd) * 100, 2) : 0,
  };

  const summary = {
    from,
    to,
    hours: round(hours, 4),
    mode,
    economics,
    marginPercent,
    marginSource: settings.source,
    orgCount: rows.length,
    sharedConfigured: shared.configured,
    sharedMonthlyUsd: shared.total,
    sharedMonthlyPools: shared.pools,
    pooledSharedCostUsd,
    unallocatedUsd,
    pools: perPool,
    totalDirectCostUsd: round(rows.reduce((s, r) => s + r.directCostUsd, 0)),
    totalSharedBillableUsd: money(
      rows.reduce((s, r) => s + r.sharedBillableUsd, 0),
    ),
    engineEnabled: String(env.BILLING_ENGINE_ENABLED) === "true",
    dryRun,
    warnings: [],
  };

  if (!shared.configured) {
    summary.warnings.push(
      "No shared infrastructure cost configured (AWS_LIGHTSAIL_MONTHLY_USD / SUPABASE_MONTHLY_USD are unset), so nothing is apportioned. Set them from the real invoices.",
    );
  }
  if (unallocatedUsd > 0 && mode === "passthrough") {
    summary.warnings.push(
      `$${unallocatedUsd.toFixed(6)} of shared cost could not be allocated (no org used any of its cost drivers this period) and is absorbed, not billed.`,
    );
  }
  if (shared.configured && !economics.profitable) {
    summary.warnings.push(
      `RUNNING AT A LOSS: revenue $${revenueUsd.toFixed(2)} against true cost $${totalCostUsd.toFixed(2)} ` +
        `(loss $${Math.abs(grossProfitUsd).toFixed(2)}). Unit rates need a ${economics.requiredMultiplier}x multiplier on ` +
        `provider cost to hold ${marginPercent}% margin; they are currently at ${economics.currentMultiplier}x.`,
    );
  }

  if (dryRun || !summary.engineEnabled) {
    summary.skippedReason = dryRun
      ? "dryRun"
      : "BILLING_ENGINE_ENABLED is not 'true'";
    return { summary, rows, persisted: 0, debited: 0 };
  }

  const persisted = await persistPeriodCharges(db, { summary, rows });
  // Absorb mode never debits. Infrastructure is priced into the unit rate, so
  // charging it again here would bill the tenant for it twice.
  const debited =
    mode === "passthrough"
      ? await debitSharedInfra(db, { summary, rows })
      : 0;
  return { summary, rows, persisted, debited };
}

/**
 * Store raw usage AND the computed charge, so a charge can be recomputed from
 * first principles months later. A debit alone is unauditable: "we charged you
 * $12.40" is not an answer to a dispute. The driver measurements, the
 * per-provider breakdown, the share, the margin and the multiplier all go in
 * the row.
 */
async function persistPeriodCharges(db, { summary, rows }) {
  if (!rows.length) return 0;
  const stamp = nowIso();
  const payload = rows.map((r) => ({
    organization_id: r.organizationId,
    period_start: summary.from,
    period_end: summary.to,
    basis: "cost_drivers",
    direct_cost_usd: r.directCostUsd,
    direct_charged_elsewhere: true,
    shared_cost_usd: r.sharedCostUsd,
    shared_share_percent: r.sharePercent,
    shared_billable_usd: r.sharedBillableUsd,
    margin_percent: r.marginPercent,
    margin_multiplier: r.marginMultiplier,
    call_seconds: r.drivers.computeSeconds,
    event_count: r.eventCount,
    provider_breakdown: r.providers,
    usage_drivers: r.drivers,
    created_at: stamp,
  }));

  const { error } = await db
    .from(PERIOD_TABLE)
    .upsert(payload, { onConflict: "organization_id,period_start,period_end" });
  if (error) {
    if (/does not exist|schema cache/i.test(error.message || "")) {
      throw new Error(
        `${PERIOD_TABLE} does not exist. Apply migrations/billing_period_charges.sql before running with --commit.`,
      );
    }
    throw error;
  }
  return payload.length;
}

/**
 * Debit the marked-up shared-infra slice.
 *
 * Written as a wallet transaction the same way lib/usage-ledger.js posts usage
 * debits (negative amount_usd, balance_before/after, then update the wallet) —
 * NOT through billing_admin_top_up_wallet, whose callers all assert
 * amountUsd > 0 and which is a credit path.
 *
 * `external_id` is deterministic per (org, period), so a re-run of the same
 * window is a no-op rather than a second charge.
 */
async function debitSharedInfra(db, { summary, rows }) {
  let debited = 0;

  for (const row of rows) {
    if (row.sharedBillableUsd <= 0) continue;
    const externalId = `period-shared:${row.organizationId}:${summary.from}:${summary.to}`;

    try {
      const { data: existing, error: existingError } = await db
        .from(WALLET_TX_TABLE)
        .select("id")
        .eq("organization_id", row.organizationId)
        .eq("external_id", externalId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing?.id) continue; // already charged for this window

      const { data: wallet, error: walletError } = await db
        .from("billing_wallets")
        .select("balance_usd")
        .eq("organization_id", row.organizationId)
        .maybeSingle();
      if (walletError) throw walletError;

      const balanceBefore = round(safeNumber(wallet?.balance_usd, 0), 8);
      const balanceAfter = round(balanceBefore - row.sharedBillableUsd, 8);

      const { error: insertError } = await db.from(WALLET_TX_TABLE).insert({
        organization_id: row.organizationId,
        transaction_type: "usage_debit",
        amount_usd: -row.sharedBillableUsd,
        balance_before_usd: balanceBefore,
        balance_after_usd: balanceAfter,
        source: DEBIT_SOURCE,
        external_id: externalId,
        reference_id: externalId,
        metadata: {
          billing_source: DEBIT_SOURCE,
          period_start: summary.from,
          period_end: summary.to,
          share_percent: row.sharePercent,
          shared_cost_usd: row.sharedCostUsd,
          usage_drivers: row.drivers,
          margin_percent: row.marginPercent,
        },
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      if (insertError) throw insertError;

      const { error: syncError } = await db
        .from("billing_wallets")
        .update({ balance_usd: balanceAfter, updated_at: nowIso() })
        .eq("organization_id", row.organizationId);
      if (syncError) throw syncError;

      debited += 1;
    } catch (error) {
      // One org's failure must not abort the cycle for everyone else.
      console.warn(
        `[billing-engine] shared-infra debit failed for ${row.organizationId}:`,
        error?.message || String(error),
      );
    }
  }

  return debited;
}

module.exports = {
  PERIOD_TABLE,
  DEBIT_SOURCE,
  DRIVERS,
  COST_MODEL,
  HOURS_PER_MONTH,
  marginMultiplier,
  applyMargin,
  driverShares,
  apportionPool,
  apportionShared,
  sharedMonthlyCostUsd,
  sharedHourlyCostUsd,
  collectUsage,
  runBillingCycle,
  persistPeriodCharges,
  debitSharedInfra,
};
