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
    source: "environment_fallback",
  };

  if (!db) return fallback;

  try {
    const { data, error } = await db
      .from("billing_platform_settings")
      .select(
        "settings_key,minimum_top_up_usd,default_target_margin_percent,updated_at",
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
  getBillingPlatformSettings,
  getMinimumTopUpUsd,
};
