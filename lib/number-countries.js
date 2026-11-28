"use strict";

/**
 * PLATFORM COUNTRY SWITCHES
 *
 * The Super Admin decides which countries tenants may buy numbers in and place
 * outbound calls to. Inbound calls are never affected: anyone anywhere can
 * call a tenant's number.
 *
 * Stored in platform_number_countries. Until that table exists (or if it
 * cannot be read) only the US and Canada are available — the two countries
 * that need no business paperwork — so a broken read can never open a
 * country that was switched off.
 *
 * The env lists (TWILIO_SUPPORTED_COUNTRIES etc.) remain the outer limit of
 * what the platform can ever offer; this table narrows it.
 */

const { getSupabase } = require("./supabase");

const SAFE_DEFAULT_COUNTRIES = ["US", "CA"];
const CACHE_MS = 30 * 1000;

const COUNTRY_NAMES = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  AU: "Australia",
  IE: "Ireland",
  NZ: "New Zealand",
  NG: "Nigeria",
};

let cache = null; // { at, rows }

function countryName(iso) {
  return COUNTRY_NAMES[String(iso || "").toUpperCase()] || String(iso || "");
}

function normalizeIso(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isTableMissing(error) {
  return Boolean(error && ["42P01", "PGRST205"].includes(error.code));
}

async function loadRows(db = getSupabase(), { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    const { data, error } = await db
      .from("platform_number_countries")
      .select("iso_country,enabled,updated_by,updated_at")
      .order("iso_country", { ascending: true });
    if (error) throw error;
    cache = { at: Date.now(), rows: data || [], source: "table" };
    return cache.rows;
  } catch (error) {
    if (!isTableMissing(error)) {
      console.warn(
        "[number-countries] could not read country switches, using US/CA only:",
        error?.message || String(error),
      );
    }
    const rows = SAFE_DEFAULT_COUNTRIES.map((iso) => ({
      iso_country: iso,
      enabled: true,
      updated_by: null,
      updated_at: null,
      fallback: true,
    }));
    cache = { at: Date.now(), rows, source: "fallback" };
    return rows;
  }
}

/** ISO codes the Super Admin has switched on. */
async function enabledCountries(db) {
  const rows = await loadRows(db);
  return rows.filter((row) => row.enabled).map((row) => normalizeIso(row.iso_country));
}

async function isCountryEnabled(iso, db) {
  return (await enabledCountries(db)).includes(normalizeIso(iso));
}

/** Narrow any platform list (e.g. sellableCountries()) to the switched-on ones. */
async function filterEnabled(list, db) {
  const enabled = new Set(await enabledCountries(db));
  return (list || []).map(normalizeIso).filter((iso) => enabled.has(iso));
}

function clearCache() {
  cache = null;
}

/**
 * Turn a country on or off. Turning one ON also switches on outbound calling
 * to it at the carrier, so "on" means it actually works. Turning one OFF is
 * enforced by Agently alone (searches, purchases and every outbound call are
 * refused); the carrier setting is left as is so it is easy to turn back on.
 */
async function setCountryEnabled(iso, enabled, { adminEmail, db = getSupabase(), applyCarrierPermission } = {}) {
  const country = normalizeIso(iso);
  if (!/^[A-Z]{2}$/.test(country)) {
    throw Object.assign(new Error("Unknown country."), { status: 400 });
  }
  let carrier = null;
  if (enabled && typeof applyCarrierPermission === "function") {
    try {
      carrier = await applyCarrierPermission(country);
    } catch (error) {
      carrier = { success: false, error: error?.message || String(error) };
    }
  }
  const { error } = await db.from("platform_number_countries").upsert(
    {
      iso_country: country,
      enabled: Boolean(enabled),
      updated_by: adminEmail || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "iso_country" },
  );
  if (error) {
    if (isTableMissing(error)) {
      throw Object.assign(
        new Error(
          "Country switches need the 20261126 database migration before they can be saved.",
        ),
        { status: 503, code: "MIGRATION_REQUIRED" },
      );
    }
    throw error;
  }
  clearCache();
  return { iso: country, enabled: Boolean(enabled), carrier };
}

/** The error every gated path returns, so the message is the same everywhere. */
function countryUnavailableError(iso, action = "numbers") {
  const name = countryName(iso);
  const error = new Error(
    action === "calls"
      ? `Calls to ${name} aren't available yet.`
      : `Phone numbers in ${name} aren't available yet.`,
  );
  error.status = 400;
  error.code = "COUNTRY_NOT_AVAILABLE";
  error.details = { country: normalizeIso(iso), countryName: name };
  return error;
}

module.exports = {
  SAFE_DEFAULT_COUNTRIES,
  COUNTRY_NAMES,
  countryName,
  loadRows,
  enabledCountries,
  isCountryEnabled,
  filterEnabled,
  setCountryEnabled,
  countryUnavailableError,
  clearCache,
};
