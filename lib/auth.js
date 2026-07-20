"use strict";

const jwt = require("jsonwebtoken");
const { getSupabase } = require("./supabase");

const JWT_EXPIRES_IN =
  String(process.env.JWT_EXPIRES_IN || "30d").trim() || "30d";
const SESSION_CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.AUTH_SESSION_CACHE_SECONDS || 45) * 1000,
);
const AUTH_DEPENDENCY_COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.AUTH_DEPENDENCY_COOLDOWN_MS || 5000),
);
const MAX_SESSION_CACHE_ENTRIES = Math.max(
  100,
  Number(process.env.AUTH_SESSION_CACHE_MAX_ENTRIES || 2000),
);

const sessionCache = new Map();
let dependencyUnavailableUntil = 0;

function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET is not set. Check your .env file.");
  return secret;
}

function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

function isMissingRowError(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  const text = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    code === "PGRST116" ||
    text.includes("0 rows") ||
    text.includes("no rows") ||
    text.includes("json object requested, multiple (or no) rows returned")
  );
}

function isTransientDependencyError(error) {
  if (!error) return false;
  const text =
    `${error.message || ""} ${error.details || ""} ${error.cause?.message || ""}`.toLowerCase();
  const code = String(error.code || error.cause?.code || "").toUpperCase();
  return (
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("eai_again") ||
    text.includes("enotfound") ||
    text.includes("socket") ||
    text.includes("aborted") ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function createAuthLookupError(error, context) {
  const transient = isTransientDependencyError(error);
  if (transient) {
    dependencyUnavailableUntil = Date.now() + AUTH_DEPENDENCY_COOLDOWN_MS;
  }

  const wrapped = new Error(
    transient
      ? "Authentication data service is temporarily unavailable. Please retry."
      : "Authentication lookup failed.",
  );
  wrapped.name = "AuthLookupError";
  wrapped.status = transient ? 503 : 500;
  wrapped.code = transient
    ? "AUTH_DEPENDENCY_UNAVAILABLE"
    : "AUTH_LOOKUP_FAILED";
  wrapped.context = context;
  wrapped.cause = error;
  return wrapped;
}

function pruneSessionCache() {
  const now = Date.now();
  for (const [key, entry] of sessionCache.entries()) {
    if (!entry || entry.expiresAt <= now) sessionCache.delete(key);
  }

  while (sessionCache.size > MAX_SESSION_CACHE_ENTRIES) {
    const oldestKey = sessionCache.keys().next().value;
    if (!oldestKey) break;
    sessionCache.delete(oldestKey);
  }
}

function getCachedSession(token) {
  if (!SESSION_CACHE_TTL_MS) return null;
  const entry = sessionCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessionCache.delete(token);
    return null;
  }
  return entry.session;
}

function primeSessionCache(token, session) {
  if (!token || !session || !SESSION_CACHE_TTL_MS) return;
  pruneSessionCache();
  sessionCache.set(token, {
    session,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

function clearSessionCache(token) {
  if (token) sessionCache.delete(token);
}

async function runAuthQuery(queryPromise, context) {
  try {
    const result = await queryPromise;
    if (result?.error) {
      if (isMissingRowError(result.error)) return { data: null, error: null };
      throw createAuthLookupError(result.error, context);
    }
    return result || { data: null, error: null };
  } catch (error) {
    if (error?.name === "AuthLookupError") throw error;
    throw createAuthLookupError(error, context);
  }
}

/**
 * Resolves a token into a full { user, organization } session.
 * Returns null only when the JWT or referenced account is genuinely invalid.
 * Database/network failures are thrown as 503/500 errors so callers never
 * mislabel an outage as an expired user session.
 */
async function resolveSession(token) {
  if (!token) return null;

  if (
    process.env.NODE_ENV !== "production" &&
    token === (process.env.DEV_SEED_TOKEN || "").trim()
  ) {
    return getDevSeedSession();
  }

  const payload = verifyToken(token);
  if (!payload || !payload.userId) return null;

  const cached = getCachedSession(token);
  if (cached) return cached;

  if (Date.now() < dependencyUnavailableUntil) {
    const error = new Error(
      "Authentication data service is temporarily unavailable. Please retry.",
    );
    error.name = "AuthLookupError";
    error.status = 503;
    error.code = "AUTH_DEPENDENCY_UNAVAILABLE";
    throw error;
  }

  const db = getSupabase();
  let userResult;
  let orgResult;

  if (payload.orgId) {
    [userResult, orgResult] = await Promise.all([
      runAuthQuery(
        db
          .from("users")
          .select("id, name, email, role, avatar, organization_id")
          .eq("id", payload.userId)
          .maybeSingle(),
        "load user",
      ),
      runAuthQuery(
        db
          .from("organizations")
          .select("*")
          .eq("id", payload.orgId)
          .maybeSingle(),
        "load organization",
      ),
    ]);
  } else {
    userResult = await runAuthQuery(
      db
        .from("users")
        .select("id, name, email, role, avatar, organization_id")
        .eq("id", payload.userId)
        .maybeSingle(),
      "load user",
    );

    if (!userResult.data?.organization_id) return null;
    orgResult = await runAuthQuery(
      db
        .from("organizations")
        .select("*")
        .eq("id", userResult.data.organization_id)
        .maybeSingle(),
      "load organization",
    );
  }

  const user = userResult?.data || null;
  const org = orgResult?.data || null;
  if (!user || !org) return null;
  if (String(user.organization_id || "") !== String(org.id || "")) return null;
  if (payload.orgId && String(payload.orgId) !== String(org.id)) return null;

  const deletionState =
    org.outbound_call_limits && typeof org.outbound_call_limits === "object"
      ? org.outbound_call_limits.organization_deletion
      : null;
  if (deletionState && deletionState.requested === true) return null;

  const session = { user, organization: org };
  primeSessionCache(token, session);
  return session;
}

async function getDevSeedSession() {
  const db = getSupabase();
  const userResult = await runAuthQuery(
    db
      .from("users")
      .select("id, name, email, role, avatar, organization_id")
      .limit(1)
      .maybeSingle(),
    "load development user",
  );
  const user = userResult.data;
  if (!user) return null;

  const orgResult = await runAuthQuery(
    db
      .from("organizations")
      .select("*")
      .eq("id", user.organization_id)
      .maybeSingle(),
    "load development organization",
  );
  const org = orgResult.data;
  if (!org) return null;

  return { user, organization: org };
}

module.exports = {
  signToken,
  verifyToken,
  resolveSession,
  primeSessionCache,
  clearSessionCache,
  isMissingRowError,
  isTransientDependencyError,
};
