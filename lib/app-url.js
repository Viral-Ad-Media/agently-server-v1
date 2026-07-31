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
  return String(value || "").trim().replace(/\/+$/, "");
}

function isProductionRuntime() {
  return Boolean(
    process.env.NODE_ENV === "production" ||
      process.env.VERCEL === "1" ||
      process.env.VERCEL_ENV === "production" ||
      process.env.RAILWAY_ENVIRONMENT,
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

function buildAppHashUrl(pathname = "/dashboard") {
  const route = String(pathname || "/dashboard").trim();
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return `${getAppBaseUrl()}/#${normalizedRoute}`;
}

module.exports = {
  CANONICAL_APP_URL,
  LOCAL_APP_URL,
  isProductionRuntime,
  getAppBaseUrl,
  buildAppHashUrl,
};
