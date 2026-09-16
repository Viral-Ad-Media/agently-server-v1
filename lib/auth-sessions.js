"use strict";

/**
 * Sessions the server actually owns.
 *
 * WHAT WAS WRONG
 *
 * Authentication was a bare stateless JWT with a 30-day expiry. That has three
 * consequences people assumed were not true:
 *
 *   - POST /api/auth/logout could not log anyone out. It cleared an in-process
 *     cache and returned { success: true }. The token in the client's storage
 *     stayed valid for the rest of its 30 days.
 *   - Changing a password did nothing to a session already in someone else's
 *     hands.
 *   - "Idle timeout" was unimplementable. There was no server-side record of
 *     when a token was last used, so the only honest options were a client
 *     timer (not security) or nothing.
 *
 * WHAT THIS DOES
 *
 * Every sign-in writes an auth_sessions row. The JWT carries that row's id as
 * `sid` and the user's session_epoch as `sev`. Every authenticated request
 * checks both. Revoking is now a database write, not a hope.
 *
 * THE POLICY, AND WHY THESE NUMBERS
 *
 *   OTP           10 minutes   a credential in flight
 *   idle          14 days      how long you can ignore Agently and walk back in
 *   absolute      30 days      hard ceiling; re-authenticate monthly
 *
 * The product complaint driving this was "close the app, reopen five minutes
 * later, made to log in again". So idle has to be long. The brief floated
 * "several hours", but for a tool a small business owner checks a few times a
 * week, a several-hour idle window means re-running password + OTP most
 * mornings — which trains people to hate the product and to pick weaker
 * passwords because they type them constantly.
 *
 * Fourteen days idle means normal use never sees a challenge and a fortnight
 * away asks once. The 30-day absolute ceiling is unchanged from the JWT expiry
 * that was already in production, so nothing about this migration makes
 * sessions live longer than they did yesterday — they can now be ENDED, which
 * they could not before.
 *
 * All three are env-tunable. Tighten them for a customer who asks; the code
 * does not assume the defaults.
 */

const { getSupabase } = require("./supabase");

const DAY_SECONDS = 24 * 60 * 60;

function clamp(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Session lifetime policy. Read these, do not hardcode durations elsewhere. */
const SESSION_POLICY = {
  // Hard ceiling from sign-in. Never extended, whatever the user does.
  absoluteSeconds: clamp(
    process.env.AUTH_SESSION_ABSOLUTE_SECONDS,
    30 * DAY_SECONDS,
    DAY_SECONDS,
    365 * DAY_SECONDS,
  ),
  // Maximum gap between two authenticated requests before the session dies.
  idleSeconds: clamp(
    process.env.AUTH_SESSION_IDLE_SECONDS,
    14 * DAY_SECONDS,
    60 * 60,
    90 * DAY_SECONDS,
  ),
  /*
   * How stale last_seen_at is allowed to get.
   *
   * Writing it on every request would add a database write to every single
   * authenticated call in the product — the dashboard alone fires several on
   * load. Touching at most once every 15 minutes costs nothing and still
   * measures idleness to a resolution far finer than a 14-day window needs.
   */
  touchIntervalSeconds: clamp(
    process.env.AUTH_SESSION_TOUCH_INTERVAL_SECONDS,
    15 * 60,
    60,
    60 * 60,
  ),
};

/**
 * Create a session row.
 *
 * Called at the END of authentication — after the password AND after the OTP.
 * Nothing earlier in the flow should call this; a half-authenticated caller
 * gets a pending token from lib/auth-pending.js instead, which is not a session
 * and cannot reach any tenant data.
 */
async function createSession({
  userId,
  organizationId,
  client = "web",
  requestIp = null,
  userAgent = null,
}) {
  const absoluteExpiresAt = new Date(
    Date.now() + SESSION_POLICY.absoluteSeconds * 1000,
  );

  const { data, error } = await getSupabase()
    .from("auth_sessions")
    .insert({
      user_id: userId,
      organization_id: organizationId || null,
      absolute_expires_at: absoluteExpiresAt.toISOString(),
      client: String(client || "web").slice(0, 40),
      request_ip: requestIp,
      user_agent: userAgent,
    })
    .select("id, absolute_expires_at, created_at")
    .single();

  if (error) throw error;
  return {
    sessionId: data.id,
    absoluteExpiresAt: data.absolute_expires_at,
    createdAt: data.created_at,
  };
}

/**
 * Is this session still good?
 *
 * Returns { valid: true, session } or { valid: false, reason }, where reason is
 * one of "not_found" | "revoked" | "expired" | "idle". The caller maps that to
 * a message; all four mean the same thing to the user ("sign in again") but
 * they are worth distinguishing in logs when someone reports being kicked out.
 */
async function loadSession(sessionId) {
  if (!sessionId) return { valid: false, reason: "not_found" };

  const { data: session, error } = await getSupabase()
    .from("auth_sessions")
    .select(
      "id, user_id, organization_id, created_at, last_seen_at, absolute_expires_at, revoked_at, revoked_reason",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw error;
  if (!session) return { valid: false, reason: "not_found" };
  if (session.revoked_at) return { valid: false, reason: "revoked", session };

  const now = Date.now();
  if (new Date(session.absolute_expires_at).getTime() <= now) {
    return { valid: false, reason: "expired", session };
  }

  const idleMs = now - new Date(session.last_seen_at).getTime();
  if (idleMs > SESSION_POLICY.idleSeconds * 1000) {
    return { valid: false, reason: "idle", session };
  }

  return { valid: true, session };
}

/**
 * Slide last_seen_at forward, at most once per touchIntervalSeconds.
 *
 * Deliberately not awaited by the request path — see middleware/auth.js. A slow
 * write here must not add latency to every authenticated call, and a failed one
 * only means the idle clock is measured from slightly earlier than it could be.
 */
async function touchSession(sessionId, lastSeenAt) {
  const sinceMs = Date.now() - new Date(lastSeenAt || 0).getTime();
  if (sinceMs < SESSION_POLICY.touchIntervalSeconds * 1000) return false;

  await getSupabase()
    .from("auth_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("revoked_at", null);
  return true;
}

/** End one session. This is what logout now does. */
async function revokeSession(sessionId, reason = "logout") {
  if (!sessionId) return;
  await getSupabase()
    .from("auth_sessions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("id", sessionId)
    .is("revoked_at", null);
}

/**
 * End every session for a user, everywhere.
 *
 * Two mechanisms on purpose, because they cover different gaps:
 *
 *   1. Mark the rows revoked — the authoritative record.
 *   2. Bump users.session_epoch — carried in the JWT as `sev`, so a token whose
 *      session row has been swept or is briefly unreadable is STILL rejected on
 *      the cheap comparison alone.
 *
 * Used by password reset and available for a "sign out everywhere" control.
 */
async function revokeAllSessionsForUser(userId, reason = "password_changed") {
  if (!userId) return;
  const db = getSupabase();

  await db
    .from("auth_sessions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("user_id", userId)
    .is("revoked_at", null);

  const { data: user } = await db
    .from("users")
    .select("session_epoch")
    .eq("id", userId)
    .maybeSingle();

  await db
    .from("users")
    .update({ session_epoch: Number(user?.session_epoch || 0) + 1 })
    .eq("id", userId);
}

/** Drop rows that can no longer authenticate anything. */
async function purgeDeadSessions(graceDays = 7) {
  const cutoff = new Date(
    Date.now() - Math.max(1, graceDays) * DAY_SECONDS * 1000,
  ).toISOString();
  await getSupabase()
    .from("auth_sessions")
    .delete()
    .lt("absolute_expires_at", cutoff);
}

module.exports = {
  SESSION_POLICY,
  createSession,
  loadSession,
  touchSession,
  revokeSession,
  revokeAllSessionsForUser,
  purgeDeadSessions,
};
