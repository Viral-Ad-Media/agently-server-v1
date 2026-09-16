"use strict";

/**
 * Rate limiting for credential endpoints.
 *
 * There is already an in-memory Map limiter in routes/chatbot-public.js. It is
 * fine there and wrong here: it resets on every container restart and is
 * per-instance, so "5 attempts per hour" becomes "5 per instance until the next
 * deploy". For endpoints that guard passwords and one-time codes, that is not a
 * limit, it is a suggestion. These counters live in Postgres via the
 * auth_rate_limit_hit() function, which increments atomically so two requests
 * arriving together cannot both read a stale count.
 *
 * FAILURE POSTURE: if the database cannot be reached, this FAILS OPEN and logs
 * loudly. A Supabase blip should not lock every customer out of their account.
 * The attempt limits on the codes themselves (auth_codes.max_attempts) are
 * enforced in the same transaction as the verification, so brute force is still
 * bounded even with these counters unavailable.
 */

const { getSupabase } = require("./supabase");

const MINUTE = 60;
const HOUR = 60 * 60;

/**
 * The policy, in one place.
 *
 * Numbers chosen so a real person never meets them. Someone mistyping a
 * password three times, or asking for one more code because the first went to
 * spam, sails through. Someone scripting does not.
 */
const LIMITS = {
  // Password attempts. Per-email catches credential stuffing against one
  // account; per-IP catches spraying across many.
  login_email: { windowSecs: 15 * MINUTE, max: 10 },
  login_ip: { windowSecs: 15 * MINUTE, max: 30 },

  // Sending codes costs us an email and costs the recipient attention.
  code_send_email: { windowSecs: HOUR, max: 5 },
  code_send_ip: { windowSecs: HOUR, max: 20 },

  // Verifying codes. Six digits is a million combinations; this plus the
  // per-code attempt cap makes guessing hopeless well inside the 10-minute life.
  code_verify_email: { windowSecs: 15 * MINUTE, max: 10 },
  code_verify_ip: { windowSecs: 15 * MINUTE, max: 40 },

  register_ip: { windowSecs: HOUR, max: 10 },
  password_reset_email: { windowSecs: HOUR, max: 5 },
  password_reset_ip: { windowSecs: HOUR, max: 20 },
};

/** Seconds a client must wait between requesting codes. Separate from the
 *  hourly cap: this is the "stop double-tapping Resend" guard. */
const RESEND_COOLDOWN_SECONDS = Math.max(
  15,
  Number(process.env.AUTH_RESEND_COOLDOWN_SECONDS) || 60,
);

/**
 * The caller's IP, honouring the proxy chain Lightsail puts in front of us.
 * Never trusted for authorization — only for bucketing.
 */
function clientIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return (
    forwarded ||
    req?.headers?.["x-real-ip"] ||
    req?.socket?.remoteAddress ||
    req?.ip ||
    "unknown"
  );
}

function userAgent(req) {
  return String(req?.headers?.["user-agent"] || "").slice(0, 400) || null;
}

/**
 * Record one hit. Returns { allowed, retryAfterSecs }.
 *
 * `identifier` is lowercased and truncated so "A@B.com" and "a@b.com " share a
 * bucket — otherwise changing the capitalisation resets the counter.
 */
async function hit(policyName, identifier) {
  const policy = LIMITS[policyName];
  if (!policy) {
    throw new Error(`Unknown rate limit policy: ${policyName}`);
  }

  const bucket = `${policyName}:${String(identifier || "unknown")
    .toLowerCase()
    .trim()
    .slice(0, 180)}`;

  try {
    const { data, error } = await getSupabase().rpc("auth_rate_limit_hit", {
      p_bucket: bucket,
      p_window_secs: policy.windowSecs,
      p_limit: policy.max,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { allowed: true, retryAfterSecs: 0 };

    return {
      allowed: row.allowed !== false,
      retryAfterSecs: Number(row.retry_after_secs) || policy.windowSecs,
    };
  } catch (err) {
    // Fail open, but make it impossible to miss that the limiter is down.
    console.error(
      "[auth-rate-limit] FAILING OPEN — counter unavailable, credential endpoints are unthrottled:",
      err?.message || String(err),
    );
    return { allowed: true, retryAfterSecs: 0, degraded: true };
  }
}

/**
 * Apply one or more policies and respond with 429 if any is exceeded.
 * Returns true when the request may proceed.
 *
 * The message never says which bucket tripped. "Too many attempts for this
 * email" would confirm the address exists.
 */
async function enforce(req, res, checks) {
  for (const [policyName, identifier] of checks) {
    const result = await hit(policyName, identifier);
    if (result.allowed) continue;

    res.setHeader("Retry-After", String(result.retryAfterSecs));
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message:
          "Too many attempts. Please wait a few minutes and try again.",
        retryable: true,
        retryAfterSeconds: result.retryAfterSecs,
      },
    });
    return false;
  }
  return true;
}

module.exports = {
  LIMITS,
  RESEND_COOLDOWN_SECONDS,
  clientIp,
  userAgent,
  hit,
  enforce,
};
