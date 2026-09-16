"use strict";

/**
 * The half-authenticated state.
 *
 * Between "your password was right" and "you entered the code", a caller is
 * partly authenticated. Something has to carry that across two HTTP requests,
 * and the wrong answers are instructive:
 *
 *   - Re-post the email and password to the verify endpoint. Now the password
 *     crosses the wire twice per sign-in and sits in the client's memory while
 *     the user reads their email.
 *   - Trust an emailed address in the verify request. Then anyone can verify a
 *     code for anyone, and the password step is decorative.
 *   - Issue a real session before the OTP. Then the OTP is optional, because
 *     the caller already holds what they came for.
 *
 * So: a short-lived, purpose-scoped, signed token that proves one specific
 * earlier step happened, names exactly one user, and is useless anywhere else.
 * It is signed with the same JWT_SECRET but carries `typ: "pending"`, and
 * middleware/auth.js refuses any token with that marker. A pending token cannot
 * reach /api/bootstrap or any tenant data — the only things that accept it are
 * the verify and resend endpoints.
 *
 * Its life is tied to the code it accompanies, plus a small margin so a user
 * who submits a code at 9:59 is not rejected by a token that died at 9:58.
 */

const { signScopedToken, verifyToken } = require("./auth");
const {
  PURPOSE_EMAIL_VERIFY,
  PURPOSE_LOGIN_OTP,
  CODE_TTL_SECONDS,
} = require("./auth-codes");

/** Extra seconds the wrapper outlives the code inside it. */
const PENDING_GRACE_SECONDS = 120;

function pendingTtlSeconds(purpose) {
  const codeTtl = CODE_TTL_SECONDS[purpose];
  if (!codeTtl) throw new Error(`Unknown pending purpose: ${purpose}`);
  return codeTtl + PENDING_GRACE_SECONDS;
}

/**
 * Mint a pending token.
 *
 * `sev` pins the user's session_epoch at issue time. If a password reset bumps
 * the epoch while someone is staring at an OTP screen, their pending token dies
 * with the sessions — which is the point of the reset.
 */
function issuePendingToken({ userId, email, organizationId, purpose, sessionEpoch = 0 }) {
  const ttl = pendingTtlSeconds(purpose);
  const token = signScopedToken(
    {
      typ: "pending",
      purpose,
      userId,
      orgId: organizationId || null,
      email: String(email || "").toLowerCase().trim(),
      sev: Number(sessionEpoch) || 0,
    },
    `${ttl}s`,
  );
  return { pendingToken: token, expiresInSeconds: ttl };
}

/**
 * Read a pending token back, insisting it is the right kind.
 *
 * `expectedPurpose` is the guard that keeps the two flows apart at the token
 * layer as well as the code layer. A pending token minted for email
 * verification will not open the login-OTP endpoint even if the code inside
 * somehow matched — belt and braces around the separation this whole design
 * turns on.
 *
 * Returns { ok: true, claims } or { ok: false, reason }.
 */
function readPendingToken(token, expectedPurpose) {
  if (!token) return { ok: false, reason: "missing" };

  const claims = verifyToken(token);
  // verifyToken returns null for a bad signature AND for an expired token;
  // both mean "start again", which is all the caller can act on.
  if (!claims) return { ok: false, reason: "invalid_or_expired" };
  if (claims.typ !== "pending") return { ok: false, reason: "wrong_type" };
  if (claims.purpose !== expectedPurpose) return { ok: false, reason: "wrong_purpose" };
  if (!claims.userId || !claims.email) return { ok: false, reason: "malformed" };

  return { ok: true, claims };
}

module.exports = {
  PENDING_GRACE_SECONDS,
  PURPOSE_EMAIL_VERIFY,
  PURPOSE_LOGIN_OTP,
  pendingTtlSeconds,
  issuePendingToken,
  readPendingToken,
};
