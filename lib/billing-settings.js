"use strict";

const DEFAULT_MINIMUM_TOP_UP_USD = 10;
const DEFAULT_TARGET_MARGIN_PERCENT = 70;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(
    Math.max(finiteNumber(value, fallback), minimum),
    maximum,
  );
}

function environmentMinimumTopUpUsd() {
  return clamp(
    process.env.BILLING_MINIMUM_RECHARGE_USD,
    0.5,
    100000,
    DEFAULT_MINIMUM_TOP_UP_USD,
  );
}

/**
 * A configured monthly bill, or null when it is not configured at all.
 *
 * null and 0 are deliberately different: null means "nobody has set this, fall
 * back to the environment", 0 means "we have looked and we pay nothing here".
 * Collapsing them would make an unset value silently free.
 */
function optionalMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function environmentInfraCosts() {
  return {
    lightsail: optionalMoney(process.env.AWS_LIGHTSAIL_MONTHLY_USD),
    supabase: optionalMoney(process.env.SUPABASE_MONTHLY_USD),
    other: optionalMoney(process.env.SHARED_INFRA_MONTHLY_USD),
  };
}

function environmentDefaultMarginPercent() {
  return clamp(
    process.env.BILLING_TARGET_GROSS_MARGIN_PERCENT,
    0,
    95,
    DEFAULT_TARGET_MARGIN_PERCENT,
  );
}

async function getBillingPlatformSettings(db) {
  const fallback = {
    minimumTopUpUsd: environmentMinimumTopUpUsd(),
    defaultTargetMarginPercent: environmentDefaultMarginPercent(),
    infraCosts: environmentInfraCosts(),
    infraCostNotes: null,
    infraCostSource: "environment",
    source: "environment_fallback",
  };

  if (!db) return fallback;

  try {
    const { data, error } = await db
      .from("billing_platform_settings")
      .select(
        "settings_key,minimum_top_up_usd,default_target_margin_percent," +
          "aws_lightsail_monthly_usd,supabase_monthly_usd," +
          "other_infra_monthly_usd,infra_cost_notes,updated_at",
      )
      .eq("settings_key", "global")
      .maybeSingle();

    if (error) throw error;
    if (!data) return fallback;

    return {
      minimumTopUpUsd: clamp(
        data.minimum_top_up_usd,
        0.5,
        100000,
        fallback.minimumTopUpUsd,
      ),
      defaultTargetMarginPercent: clamp(
        data.default_target_margin_percent,
        0,
        95,
        fallback.defaultTargetMarginPercent,
      ),
      // Per pool, not all-or-nothing: a row that sets Lightsail but leaves
      // Supabase null should still pick the Supabase figure up from the
      // environment rather than silently pricing it at zero.
      infraCosts: {
        lightsail:
          optionalMoney(data.aws_lightsail_monthly_usd) ??
          fallback.infraCosts.lightsail,
        supabase:
          optionalMoney(data.supabase_monthly_usd) ??
          fallback.infraCosts.supabase,
        other:
          optionalMoney(data.other_infra_monthly_usd) ??
          fallback.infraCosts.other,
      },
      infraCostNotes: data.infra_cost_notes || null,
      infraCostSource:
        optionalMoney(data.aws_lightsail_monthly_usd) === null &&
        optionalMoney(data.supabase_monthly_usd) === null &&
        optionalMoney(data.other_infra_monthly_usd) === null
          ? "environment"
          : "billing_platform_settings",
      updatedAt: data.updated_at || null,
      source: "billing_platform_settings",
    };
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!/billing_platform_settings|does not exist|schema cache/i.test(message)) {
      console.warn("[billing-settings] platform settings lookup failed:", message);
    }
    return fallback;
  }
}

async function getMinimumTopUpUsd(db) {
  const settings = await getBillingPlatformSettings(db);
  return settings.minimumTopUpUsd;
}

module.exports = {
  DEFAULT_MINIMUM_TOP_UP_USD,
  DEFAULT_TARGET_MARGIN_PERCENT,
  environmentMinimumTopUpUsd,
  environmentDefaultMarginPercent,
  environmentInfraCosts,
  getBillingPlatformSettings,
  getMinimumTopUpUsd,
};
