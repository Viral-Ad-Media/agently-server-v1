"use strict";

/**
 * Single source of truth for every customer-facing Agently application link.
 *
 * Change CANONICAL_APP_URL here once when the production frontend domain
 * changes. Production emails and invitations intentionally do not read
 * APP_URL/FRONTEND_URL because stale deployment environment variables can
 * silently send customers to an obsolete Vercel hostname.
 */
const CANONICAL_APP_URL = "https://www.agentlycall.com";
const LOCAL_APP_URL = "http://localhost:3000";

function cleanBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function isProductionRuntime() {
  return Boolean(
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    process.env.VERCEL_ENV === "production",
  );
}

function getAppBaseUrl() {
  if (!isProductionRuntime()) {
    const localOverride = cleanBaseUrl(
      process.env.AGENTLY_LOCAL_APP_URL || process.env.LOCAL_APP_URL,
    );
    return localOverride || LOCAL_APP_URL;
  }

  return CANONICAL_APP_URL;
}

/*
 * One switch for the frontend's URL shape.
 *
 * The frontend routed on the fragment (/#/billing) and now routes on real
 * paths (/billing). Those cannot be deployed at the same instant: the API and
 * the frontend are separate deploys, and whichever lands first is briefly
 * emitting links the other cannot serve. A link in the wrong shape does not
 * error — it renders the marketing page with a 200 — so a password-reset or
 * Stripe-return URL in the wrong shape is a silent dead end for a real
 * customer.
 *
 * So the shape is configuration, not code. The API ships the new routing
 * work whenever it is ready and keeps emitting fragment links; the moment the
 * frontend goes live, APP_HASH_ROUTES=false flips every link at once — no
 * rebuild, no image push, and reversible in one env change if the frontend
 * has to be rolled back.
 *
 * The default is the fragment, because that is what production serves today
 * and an unset variable must never be the setting that breaks live links.
 */
function usesHashRoutes(env = process.env) {
  return String(env.APP_HASH_ROUTES ?? "true").toLowerCase() !== "false";
}

/* The path portion only — for payloads the frontend consumes as an href
   (billing enforcement's topUpPath), rather than a full URL in an email. */
function buildAppPath(pathname = "/dashboard") {
  const route = String(pathname || "/dashboard").trim();
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return usesHashRoutes() ? `#${normalizedRoute}` : normalizedRoute;
}

function buildAppUrl(pathname = "/dashboard") {
  return `${getAppBaseUrl()}/${buildAppPath(pathname).replace(/^\//, "")}`;
}

module.exports = {
  CANONICAL_APP_URL,
  LOCAL_APP_URL,
  isProductionRuntime,
  getAppBaseUrl,
  usesHashRoutes,
  buildAppPath,
  buildAppUrl,
  /* Former name. Kept so nothing that still imports it silently gets
     undefined and emits "undefined" into a customer's email. */
  buildAppHashUrl: buildAppUrl,
};
