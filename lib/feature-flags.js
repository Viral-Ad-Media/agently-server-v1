"use strict";

/*
 * Platform feature kill switches, flipped from the Super Admin.
 *
 * A feature that is not finished (Gmail sending, calendar/Calendly booking,
 * SMS) can be switched OFF for the live app without a redeploy. The switch
 * applies to PRODUCTION only: a local/dev API always reports every feature as
 * on, so it can keep being built and tested against the same database. Set
 * FEATURE_FLAGS_ENFORCE_LOCALLY=true to see the production behaviour locally.
 *
 * Storage: table platform_feature_flags (migrations/20261124_platform_feature_flags.sql).
 * If the table is missing or unreadable the DEFAULTS below apply, so a fresh
 * environment never breaks on it.
 */

const { getSupabase } = require("./supabase");
const { isProductionRuntime } = require("./app-url");

const FEATURES = {
  gmail: {
    label: "Gmail sending",
    description:
      "Connect Gmail, email leads from the Leads inbox, and automatic confirmation emails.",
    defaultEnabled: true,
  },
  calendar: {
    label: "Calendar & Calendly booking",
    description:
      "Google Calendar / Calendly connections, the Bookings page, and booking from calls and chat.",
    defaultEnabled: true,
  },
  sms: {
    label: "SMS messaging",
    description:
      "Texting leads from the tenant's Agently number, charged per message against their credit.",
    // Not finished: stays off in production until someone turns it on.
    defaultEnabled: false,
  },
};

const CACHE_MS = 15 * 1000;
let cache = { at: 0, flags: null };

function defaults() {
  return Object.fromEntries(
    Object.entries(FEATURES).map(([key, def]) => [key, def.defaultEnabled]),
  );
}

function enforced() {
  return (
    isProductionRuntime() ||
    String(process.env.FEATURE_FLAGS_ENFORCE_LOCALLY || "").toLowerCase() === "true"
  );
}

/** Stored switches merged over defaults, ignoring the environment. */
async function getStoredFeatureFlags({ fresh = false } = {}) {
  if (!fresh && cache.flags && Date.now() - cache.at < CACHE_MS) return cache.flags;
  const flags = defaults();
  try {
    const { data, error } = await getSupabase()
      .from("platform_feature_flags")
      .select("key,enabled");
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        if (Object.prototype.hasOwnProperty.call(FEATURES, row.key)) {
          flags[row.key] = row.enabled === true;
        }
      }
    }
  } catch {
    /* table missing: defaults */
  }
  cache = { at: Date.now(), flags };
  return flags;
}

/** What the running app should obey: everything on outside production. */
async function getFeatureFlags() {
  if (!enforced()) {
    return Object.fromEntries(Object.keys(FEATURES).map((key) => [key, true]));
  }
  return { ...(await getStoredFeatureFlags()) };
}

async function isFeatureEnabled(key) {
  const flags = await getFeatureFlags();
  return flags[key] !== false;
}

/**
 * Express guard. Responds 403 FEATURE_DISABLED when the feature is switched
 * off for this environment.
 */
function requireFeature(key) {
  return async (req, res, next) => {
    try {
      if (await isFeatureEnabled(key)) return next();
    } catch {
      return next();
    }
    return res.status(403).json({
      error: {
        code: "FEATURE_DISABLED",
        feature: key,
        message: `${FEATURES[key]?.label || "This feature"} is not available yet.`,
      },
    });
  };
}

async function setFeatureFlag(key, enabled, updatedBy) {
  if (!Object.prototype.hasOwnProperty.call(FEATURES, key)) {
    const error = new Error(`Unknown feature: ${key}`);
    error.status = 400;
    throw error;
  }
  const { error } = await getSupabase()
    .from("platform_feature_flags")
    .upsert(
      {
        key,
        enabled: enabled === true,
        updated_by: updatedBy || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) throw error;
  cache = { at: 0, flags: null };
  return getStoredFeatureFlags({ fresh: true });
}

function describeFeatures(stored) {
  return Object.entries(FEATURES).map(([key, def]) => ({
    key,
    label: def.label,
    description: def.description,
    defaultEnabled: def.defaultEnabled,
    enabled: stored[key] !== false,
  }));
}

module.exports = {
  FEATURES,
  getFeatureFlags,
  getStoredFeatureFlags,
  isFeatureEnabled,
  requireFeature,
  setFeatureFlag,
  describeFeatures,
  featureFlagsEnforced: enforced,
};
