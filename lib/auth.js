"use strict";

const jwt = require("jsonwebtoken");
const { getSupabase } = require("./supabase");

const JWT_EXPIRES_IN =
  "8h";
const AUTH_DEPENDENCY_COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.AUTH_DEPENDENCY_COOLDOWN_MS || 5000),
);

let dependencyUnavailableUntil = 0;

function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET is not set. Check your .env file.");
  return secret;
}

/**
 * Sign a full session token.
 *
 * `sid` (the auth_sessions row) and `sev` (the user's session_epoch) are what
 * turned this from a bearer token nobody could revoke into one the server
 * controls. Callers should not build these claims by hand — go through
 * createSession() in lib/auth-sessions.js, which writes the row first.
 *
 * The expiry is pinned to the session's own absolute ceiling rather than the
 * blanket JWT_EXPIRES_IN, so the token and the row it points at die together
 * instead of the token outliving its session by days.
 */
function signToken(payload, options = {}) {
  const expiresIn = options.expiresIn || JWT_EXPIRES_IN;
  return jwt.sign({ ...payload, typ: payload.typ || "session" }, getJwtSecret(), {
    expiresIn,
  });
}

// Additive: short-lived, purpose-scoped tokens for narrow, non-session use
// cases (e.g. the webcall widget's ~10-minute test-call token). Verified by
// agently-ws-server using the same JWT_SECRET. Does not affect signToken,
// login sessions, or resolveSession in any way.
function signScopedToken(payload, expiresIn = "10m") {
  return jwt.sign({ ...payload }, getJwtSecret(), { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
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

// Compatibility exports for settings routes; authorization is never cached.
function primeSessionCache() {}
function clearSessionCache() {}

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

  // Only revocable account-session tokens enter this boundary.
  if (payload.typ !== "session" || payload.purpose || !payload.sid || !payload.orgId || !Number.isInteger(payload.sev)) return null;

  // Legacy sid-less tokens are deliberately rejected, including before expiry.
  if (payload.sid) {
    const { loadSession, touchSession } = require("./auth-sessions");
    let sessionState;
    try {
      sessionState = await loadSession(payload.sid);
    } catch (error) {
      throw createAuthLookupError(error, "load session");
    }
    if (!sessionState.valid) return null;
    if (sessionState.session.user_id !== payload.userId || sessionState.session.organization_id !== payload.orgId) return null;

    // Fire-and-forget: the idle clock does not need to be exact to the second,
    // and making every authenticated request wait on a write would be a poor
    // trade for that precision.
    void touchSession(payload.sid, sessionState.session.last_seen_at).catch(
      (error) =>
        console.warn(
          "[auth] session touch failed:",
          error?.message || String(error),
        ),
    );
  }

  // Roles, tenant membership and revocation epochs are authorization data.
  // Read them live; a profile cache must never override a security change.

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
          .select(
          "id, name, email, role, avatar, organization_id, email_verified, session_epoch",
        )
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
        .select(
          "id, name, email, role, avatar, organization_id, email_verified, session_epoch",
        )
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

  /*
   * Epoch check: the cheap half of "sign out everywhere".
   *
   * revokeAllSessionsForUser() marks the rows AND increments this counter. The
   * counter is the belt to the row's braces — it rejects a token even if its
   * session row has already been swept by purgeDeadSessions, or if the rows
   * update partially. Pre-migration tokens carry no `sev` and are compared
   * against 0, which is what every existing user starts at.
   */
  if (Number(payload.sev || 0) !== Number(user.session_epoch || 0)) return null;
  if (String(user.organization_id || "") !== String(org.id || "")) return null;
  if (payload.orgId && String(payload.orgId) !== String(org.id)) return null;

  const deletionState =
    org.outbound_call_limits && typeof org.outbound_call_limits === "object"
      ? org.outbound_call_limits.organization_deletion
      : null;
  if (deletionState && deletionState.requested === true) return null;

  // sessionId rides along so requireAuth can expose it and logout can revoke
  // exactly this session. Null for pre-migration tokens, which have no row.
  const session = { user, organization: org, sessionId: payload.sid || null };

  return session;
}

async function getDevSeedSession() {
  const db = getSupabase();
  const userResult = await runAuthQuery(
    db
      .from("users")
      .select(
          "id, name, email, role, avatar, organization_id, email_verified, session_epoch",
        )
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
  signScopedToken,
  verifyToken,
  resolveSession,
  primeSessionCache,
  clearSessionCache,
  isMissingRowError,
  isTransientDependencyError,
};
