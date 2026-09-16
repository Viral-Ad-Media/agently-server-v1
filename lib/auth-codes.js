"use strict";

/**
 * One-time email codes.
 *
 * TWO PURPOSES, AND WHY THEY MUST NOT BLUR
 *
 *   PURPOSE_EMAIL_VERIFY  proves a person controls the mailbox they signed up
 *                         with. Issued once at registration. Consuming it sets
 *                         users.email_verified.
 *
 *   PURPOSE_LOGIN_OTP     is a second factor on an existing, already-verified
 *                         account. Issued after a correct password. Consuming
 *                         it creates a session.
 *
 * They share this table and this code because expiry, hashing, attempt caps and
 * cleanup should be written once. They do not share meaning: every lookup
 * filters on purpose, so a verification code can never satisfy a login
 * challenge. Getting that wrong would mean a code emailed to an address during
 * signup could be replayed to authenticate as whoever later owned it, which is
 * precisely the confusion the brief calls out.
 *
 * STORAGE: only the SHA-256 hash is persisted. For the ten minutes it is alive
 * a code is a bearer credential, and a database dump or an over-broad SELECT
 * should not hand anyone a working one. The plaintext exists in exactly two
 * places: the email, and the request body that verifies it.
 *
 * LOGGING: the plaintext code is never logged, never returned in an API
 * response, and never placed in a URL. The one exception is a non-production
 * escape hatch documented on issueCode(), which refuses to run when
 * NODE_ENV === "production".
 */

const crypto = require("crypto");
const { getSupabase } = require("./supabase");

const PURPOSE_EMAIL_VERIFY = "email_verify";
const PURPOSE_LOGIN_OTP = "login_otp";

/**
 * Lifetimes.
 *
 * Verification is slightly longer than login OTP because signup is the moment
 * someone is most likely to get distracted — switching to a mail app, finding
 * the message in spam, coming back. Login OTP is a person who is already at the
 * keyboard trying to get in, so ten minutes is generous and keeps the window a
 * stolen code is useful in short.
 *
 * Both are deliberately minutes, not hours. The SESSION is what lasts; see
 * lib/auth-sessions.js.
 */
const CODE_TTL_SECONDS = {
  [PURPOSE_EMAIL_VERIFY]: clampSeconds(
    process.env.AUTH_EMAIL_VERIFY_TTL_SECONDS,
    15 * 60,
  ),
  [PURPOSE_LOGIN_OTP]: clampSeconds(
    process.env.AUTH_LOGIN_OTP_TTL_SECONDS,
    10 * 60,
  ),
};

/** Wrong guesses allowed against a single code before it is burned. */
const MAX_ATTEMPTS = Math.min(
  Math.max(Number(process.env.AUTH_CODE_MAX_ATTEMPTS) || 5, 3),
  10,
);

const CODE_LENGTH = 6;

function clampSeconds(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // Never shorter than a minute (unusable) or longer than an hour (defeats the
  // point of a short-lived code, whatever an env var says).
  return Math.min(Math.max(value, 60), 60 * 60);
}

/**
 * A six-digit code from a CSPRNG.
 *
 * randomInt is rejection-sampled by Node, so every value in the range is
 * equally likely. `Math.random()` would be predictable and
 * `randomBytes % 1000000` would be biased toward low numbers.
 */
function generateCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, "0");
}

function hashCode(code) {
  return crypto
    .createHash("sha256")
    .update(String(code || "").trim())
    .digest("hex");
}

/**
 * Compare in constant time.
 *
 * A plain === on the hashes leaks, through timing, how many leading characters
 * matched. Over enough requests that is enough to reconstruct the hash. The
 * lengths are equal here by construction, but the guard stays because a future
 * change to the hash could make that untrue.
 */
function hashesMatch(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const normalizeEmail = (email) => String(email || "").toLowerCase().trim();

/**
 * Mint a code, invalidating any earlier unconsumed code for the same
 * (email, purpose).
 *
 * Superseding matters: without it, asking for a new code leaves the old one
 * live, so every resend widens the window rather than refreshing it. After this
 * runs there is exactly one code that can work.
 *
 * Returns { code, expiresAt, expiresInSeconds }. The CALLER is responsible for
 * emailing `code` and must not log it or put it in a response body.
 */
async function issueCode({
  email,
  userId = null,
  purpose,
  requestIp = null,
  userAgent = null,
}) {
  if (purpose !== PURPOSE_EMAIL_VERIFY && purpose !== PURPOSE_LOGIN_OTP) {
    throw new Error(`Unknown auth code purpose: ${purpose}`);
  }

  const db = getSupabase();
  const normalizedEmail = normalizeEmail(email);
  const ttl = CODE_TTL_SECONDS[purpose];
  const code = generateCode();
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db
    .from("auth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("email", normalizedEmail)
    .eq("purpose", purpose)
    .is("consumed_at", null);

  const { error } = await db.from("auth_codes").insert({
    user_id: userId,
    email: normalizedEmail,
    purpose,
    code_hash: hashCode(code),
    expires_at: expiresAt.toISOString(),
    max_attempts: MAX_ATTEMPTS,
    request_ip: requestIp,
    user_agent: userAgent,
  });
  if (error) throw error;

  return {
    code,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: ttl,
  };
}

/**
 * How long ago was a code last sent for this (email, purpose)?
 * Used for the resend cooldown. Returns seconds, or null if never.
 */
async function secondsSinceLastIssue(email, purpose) {
  const { data } = await getSupabase()
    .from("auth_codes")
    .select("created_at")
    .eq("email", normalizeEmail(email))
    .eq("purpose", purpose)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.created_at) return null;
  return Math.floor((Date.now() - new Date(data.created_at).getTime()) / 1000);
}

/**
 * Verify a submitted code.
 *
 * Returns a discriminated result rather than throwing, because every outcome
 * here is an ordinary thing a user does and the caller needs to tell them apart:
 *
 *   { ok: true, record }
 *   { ok: false, reason: "not_found" | "expired" | "too_many_attempts" | "mismatch",
 *     attemptsRemaining }
 *
 * The caller decides what to SAY. The recommended wording collapses
 * not_found and mismatch into one message so a probe cannot learn whether a
 * code was ever issued for an address.
 */
async function verifyCode({ email, purpose, code }) {
  const db = getSupabase();
  const normalizedEmail = normalizeEmail(email);
  const submitted = String(code || "").trim();

  if (!/^\d{6}$/.test(submitted)) {
    return { ok: false, reason: "mismatch", attemptsRemaining: null };
  }

  const { data: record } = await db
    .from("auth_codes")
    .select(
      "id, user_id, email, purpose, code_hash, expires_at, consumed_at, attempts, max_attempts",
    )
    .eq("email", normalizedEmail)
    .eq("purpose", purpose)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) return { ok: false, reason: "not_found", attemptsRemaining: null };

  if (new Date(record.expires_at) < new Date()) {
    return { ok: false, reason: "expired", attemptsRemaining: null };
  }

  if (Number(record.attempts) >= Number(record.max_attempts)) {
    // Burn it. Leaving an exhausted code unconsumed would let a caller keep
    // probing it forever, and the attempts counter would stop mattering.
    await db
      .from("auth_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", record.id);
    return { ok: false, reason: "too_many_attempts", attemptsRemaining: 0 };
  }

  if (!hashesMatch(hashCode(submitted), record.code_hash)) {
    const attempts = Number(record.attempts) + 1;
    await db.from("auth_codes").update({ attempts }).eq("id", record.id);
    const remaining = Math.max(0, Number(record.max_attempts) - attempts);
    if (remaining === 0) {
      await db
        .from("auth_codes")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", record.id);
      return { ok: false, reason: "too_many_attempts", attemptsRemaining: 0 };
    }
    return { ok: false, reason: "mismatch", attemptsRemaining: remaining };
  }

  /*
   * Consume it, conditionally.
   *
   * The `.is("consumed_at", null)` is the whole safety of this step. Two
   * requests carrying the same correct code can both reach here; only the one
   * whose UPDATE matches a still-null row gets a result back, and the loser is
   * told the code is spent. Without that predicate both would succeed and a
   * single-use code would be usable twice.
   */
  const { data: consumed } = await db
    .from("auth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", record.id)
    .is("consumed_at", null)
    .select("id, user_id, email, purpose")
    .maybeSingle();

  if (!consumed) {
    return { ok: false, reason: "not_found", attemptsRemaining: null };
  }

  return { ok: true, record: consumed };
}

/** Invalidate every outstanding code for an address and purpose. */
async function invalidateCodes(email, purpose) {
  await getSupabase()
    .from("auth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("email", normalizeEmail(email))
    .eq("purpose", purpose)
    .is("consumed_at", null);
}

/**
 * Housekeeping. Consumed and expired rows have no value after the fact and
 * keeping them is an unnecessary liability, even hashed.
 */
async function purgeExpiredCodes(olderThanHours = 24) {
  const cutoff = new Date(
    Date.now() - Math.max(1, olderThanHours) * 60 * 60 * 1000,
  ).toISOString();
  await getSupabase().from("auth_codes").delete().lt("created_at", cutoff);
}

module.exports = {
  PURPOSE_EMAIL_VERIFY,
  PURPOSE_LOGIN_OTP,
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  CODE_LENGTH,
  generateCode,
  issueCode,
  verifyCode,
  invalidateCodes,
  secondsSinceLastIssue,
  purgeExpiredCodes,
};
