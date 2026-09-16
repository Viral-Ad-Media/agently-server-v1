"use strict";

/**
 * Agently V1 authentication.
 *
 * THE TWO FLOWS, AND THE LINE BETWEEN THEM
 *
 *   SIGNUP            register -> emailed 6-digit code (purpose email_verify)
 *                     -> verify-email -> SESSION. The account exists but is
 *                     unverified in between, and an unverified account cannot
 *                     obtain a session.
 *
 *   RETURNING LOGIN   login (email + password) -> emailed 6-digit code
 *                     (purpose login_otp) -> verify-login-otp -> SESSION.
 *
 * These are separate mechanisms that happen to look alike. A code minted to
 * prove ownership of a new address cannot complete a login, and a login code
 * cannot verify an address, because purpose is part of every lookup in
 * lib/auth-codes.js AND part of the pending token in lib/auth-pending.js.
 *
 * WHAT WAS REMOVED, AND WHY
 *
 * POST /api/auth/magic-link used to return the sign-in token in its own
 * response body — in production — and /magic-link/verify auto-created an
 * organization for any address it had never seen. Between them, anyone could
 * type any email into the sign-in form and be signed in as that person, or
 * manufacture tenants at will, without ever receiving an email. The sign-in
 * half is gone. The magic_link_tokens table survives for TEAM INVITATIONS,
 * which are a different thing: minted by an authenticated admin, bound to a
 * user id and organization id that already exist, and unable to create
 * anything.
 *
 * Google sign-in is not offered in V1. There was never any Google code here to
 * remove; see lib/auth-providers.js for the reasoning and for the seam that
 * makes adding it later a contained change.
 *
 * ERROR ENVELOPE
 * Every failure is { error: { code, message, ...extra } }. Codes are stable and
 * documented in docs/AUTH-API-CONTRACT.md; clients branch on `code`, never on
 * message text.
 */

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { getSupabase } = require("../../lib/supabase");
const { signToken, clearSessionCache } = require("../../lib/auth");
const { serializeUser } = require("../../lib/serializers");
const {
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendEmailVerificationCodeEmail,
  sendLoginOtpEmail,
} = require("../../lib/email");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { buildAppHashUrl } = require("../../lib/app-url");
const { grantSignupCredit } = require("../../lib/activation-gate");
const { publicAuthConfig } = require("../../lib/auth-providers");
const {
  PURPOSE_EMAIL_VERIFY,
  PURPOSE_LOGIN_OTP,
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  CODE_LENGTH,
  issueCode,
  verifyCode,
  invalidateCodes,
  secondsSinceLastIssue,
} = require("../../lib/auth-codes");
const {
  issuePendingToken,
  readPendingToken,
} = require("../../lib/auth-pending");
const {
  SESSION_POLICY,
  createSession,
  revokeSession,
  revokeAllSessionsForUser,
} = require("../../lib/auth-sessions");
const rateLimit = require("../../lib/auth-rate-limit");

const router = express.Router();

const USER_COLUMNS =
  "id, name, email, role, avatar, organization_id, email_verified, session_epoch";

const normalizeEmail = (value) => String(value || "").toLowerCase().trim();

function isOrganizationDeletionRequested(org) {
  const deletion =
    org &&
    org.outbound_call_limits &&
    typeof org.outbound_call_limits === "object"
      ? org.outbound_call_limits.organization_deletion
      : null;
  return deletion && deletion.requested === true;
}

function createResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function buildPasswordResetUrl(token) {
  return buildAppHashUrl(
    `/reset-password?resetToken=${encodeURIComponent(token)}`,
  );
}

async function getUserOrganization(db, organizationId) {
  if (!organizationId) return null;
  const { data: org } = await db
    .from("organizations")
    .select("id,name,outbound_call_limits")
    .eq("id", organizationId)
    .single();
  return org || null;
}

const deletionPendingResponse = (res) =>
  res.status(403).json({
    error: {
      code: "ORGANIZATION_PENDING_DELETION",
      message:
        "This organization is pending deletion. Access has been disabled while the deletion request is processed.",
    },
  });

/**
 * Issue the real session: a row in auth_sessions plus a JWT that points at it.
 *
 * The single place a session is born. Everything that authenticates a person
 * ends here, so session lifetime, revocability and the claim shape are decided
 * once rather than per-endpoint.
 */
async function establishSession(req, user) {
  const { sessionId, absoluteExpiresAt } = await createSession({
    userId: user.id,
    organizationId: user.organization_id,
    client: String(req.body?.client || req.headers["x-agently-client"] || "web"),
    requestIp: rateLimit.clientIp(req),
    userAgent: rateLimit.userAgent(req),
  });

  const token = signToken(
    {
      userId: user.id,
      orgId: user.organization_id,
      sid: sessionId,
      sev: Number(user.session_epoch || 0),
    },
    { expiresIn: `${SESSION_POLICY.absoluteSeconds}s` },
  );

  return {
    token,
    user: serializeUser(user),
    session: {
      id: sessionId,
      absoluteExpiresAt,
      idleTimeoutSeconds: SESSION_POLICY.idleSeconds,
      absoluteTimeoutSeconds: SESSION_POLICY.absoluteSeconds,
    },
  };
}

/**
 * Send a code, honouring the resend cooldown.
 *
 * Email delivery failures are surfaced, not swallowed. Everywhere else in this
 * codebase a failed email is logged and ignored, which is right for a welcome
 * message — but a verification code that never arrives leaves the user staring
 * at a code box with no way forward and no idea why.
 */
async function deliverCode(req, res, { user, email, purpose, isResend }) {
  const address = normalizeEmail(email);

  if (isResend) {
    const since = await secondsSinceLastIssue(address, purpose);
    if (since !== null && since < rateLimit.RESEND_COOLDOWN_SECONDS) {
      const wait = rateLimit.RESEND_COOLDOWN_SECONDS - since;
      res.setHeader("Retry-After", String(wait));
      res.status(429).json({
        error: {
          code: "RESEND_COOLDOWN",
          message: `Please wait ${wait} more second${wait === 1 ? "" : "s"} before requesting another code.`,
          retryable: true,
          retryAfterSeconds: wait,
        },
      });
      return null;
    }
  }

  const { code, expiresInSeconds } = await issueCode({
    email: address,
    userId: user?.id || null,
    purpose,
    requestIp: rateLimit.clientIp(req),
    userAgent: rateLimit.userAgent(req),
  });

  try {
    const usageContext = {
      organizationId: user?.organization_id || null,
      userId: user?.id || null,
      route:
        purpose === PURPOSE_EMAIL_VERIFY
          ? "auth.verify_email"
          : "auth.login_otp",
      billable: false,
    };
    if (purpose === PURPOSE_EMAIL_VERIFY) {
      await sendEmailVerificationCodeEmail(
        address,
        code,
        expiresInSeconds,
        usageContext,
      );
    } else {
      await sendLoginOtpEmail(address, code, expiresInSeconds, usageContext);
    }
  } catch (emailErr) {
    // Burn the code we just minted. A live code for a message that was never
    // delivered is a credential nobody legitimate can use.
    await invalidateCodes(address, purpose);
    console.error(
      "[auth] code delivery failed:",
      emailErr?.message || String(emailErr),
    );
    res.status(502).json({
      error: {
        code: "EMAIL_DELIVERY_FAILED",
        message:
          "We could not send your code right now. Please try again in a moment.",
        retryable: true,
      },
    });
    return null;
  }

  return { expiresInSeconds };
}

/**
 * One wording for "that code did not work", whatever the underlying reason.
 *
 * "No code was issued for this address" would confirm an address is registered.
 * Expiry is called out separately because it is actionable — press Resend
 * rather than re-read the same email.
 */
function codeFailureResponse(res, result) {
  if (result.reason === "expired") {
    return res.status(400).json({
      error: {
        code: "CODE_EXPIRED",
        message: "That code has expired. Request a new one.",
      },
    });
  }
  if (result.reason === "too_many_attempts") {
    return res.status(429).json({
      error: {
        code: "CODE_ATTEMPTS_EXCEEDED",
        message:
          "Too many incorrect attempts. Request a new code to try again.",
      },
    });
  }
  return res.status(400).json({
    error: {
      code: "CODE_INVALID",
      message: "That code is not correct. Check the email and try again.",
      ...(typeof result.attemptsRemaining === "number"
        ? { attemptsRemaining: result.attemptsRemaining }
        : {}),
    },
  });
}

// ─────────────────────────────────────────────────────────────
// GET /api/auth/config        (public)
// Lets a client discover the flow without shipping a new build when it changes.
// ─────────────────────────────────────────────────────────────
router.get("/config", (_req, res) => {
  res.json({
    ...publicAuthConfig(),
    emailVerifyCodeTtlSeconds: CODE_TTL_SECONDS[PURPOSE_EMAIL_VERIFY],
    loginOtpTtlSeconds: CODE_TTL_SECONDS[PURPOSE_LOGIN_OTP],
    codeLength: CODE_LENGTH,
    maxCodeAttempts: MAX_ATTEMPTS,
    resendCooldownSeconds: rateLimit.RESEND_COOLDOWN_SECONDS,
    sessionIdleTimeoutSeconds: SESSION_POLICY.idleSeconds,
    sessionAbsoluteTimeoutSeconds: SESSION_POLICY.absoluteSeconds,
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { name, companyName, email, password }
// -> 201 { verificationRequired: true, pendingToken, email, expiresInSeconds }
//
// Creates the user, organization and owner membership, then STOPS. No session
// is issued until the address is verified.
// ─────────────────────────────────────────────────────────────
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, companyName, email, password } = req.body || {};

    if (!name || !companyName || !email || !password) {
      return res.status(400).json({
        error: { code: "MISSING_FIELDS", message: "All fields are required." },
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        error: {
          code: "PASSWORD_TOO_SHORT",
          message: "Password must be at least 8 characters.",
        },
      });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      return res.status(400).json({
        error: { code: "EMAIL_INVALID", message: "Enter a valid email address." },
      });
    }

    const allowed = await rateLimit.enforce(req, res, [
      ["register_ip", rateLimit.clientIp(req)],
      ["code_send_email", normalizedEmail],
    ]);
    if (!allowed) return;

    const db = getSupabase();

    const { data: existing } = await db
      .from("users")
      .select("id, email_verified")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existing) {
      /*
       * An account exists. Two cases, different handling, SAME response shape —
       * because "this address is registered but never verified" is exactly what
       * an enumeration probe wants to learn.
       *
       * Never verified: quietly re-issue a code so someone who abandoned signup
       * halfway can finish. Live account: send nothing, but 409 so the client
       * can offer "sign in instead".
       */
      if (existing.email_verified === true) {
        return res.status(409).json({
          error: {
            code: "EMAIL_ALREADY_REGISTERED",
            message:
              "An account with this email already exists. Sign in instead, or reset your password.",
          },
        });
      }

      const { data: pendingUser } = await db
        .from("users")
        .select(USER_COLUMNS)
        .eq("id", existing.id)
        .single();

      const delivered = await deliverCode(req, res, {
        user: pendingUser,
        email: normalizedEmail,
        purpose: PURPOSE_EMAIL_VERIFY,
        isResend: false,
      });
      if (!delivered) return;

      const { pendingToken } = issuePendingToken({
        userId: pendingUser.id,
        email: normalizedEmail,
        organizationId: pendingUser.organization_id,
        purpose: PURPOSE_EMAIL_VERIFY,
        sessionEpoch: pendingUser.session_epoch,
      });

      return res.status(201).json({
        verificationRequired: true,
        pendingToken,
        email: normalizedEmail,
        expiresInSeconds: delivered.expiresInSeconds,
        message: "Check your email for a 6-digit verification code.",
      });
    }

    // ── organization -> user -> initial workspace state ───────────────────
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({
        name: String(companyName).trim(),
        onboarded: false,
        plan: "Starter",
        subscription_status: "active",
        subscription_period_end: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .select()
      .single();

    if (orgErr || !org) {
      console.error("[register] org creation failed:", orgErr);
      return res.status(500).json({
        error: {
          code: "REGISTRATION_FAILED",
          message: "Failed to create organization.",
        },
      });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const { data: user, error: userErr } = await db
      .from("users")
      .insert({
        organization_id: org.id,
        name: String(name).trim(),
        email: normalizedEmail,
        password_hash: passwordHash,
        // The first member of a workspace owns it. Everyone else arrives via
        // POST /api/team/invitations as Admin or Viewer.
        role: "Owner",
        email_verified: false,
        password_changed_at: new Date().toISOString(),
      })
      .select(USER_COLUMNS)
      .single();

    if (userErr || !user) {
      console.error("[register] user creation failed:", userErr);
      await db.from("organizations").delete().eq("id", org.id);
      return res.status(500).json({
        error: {
          code: "REGISTRATION_FAILED",
          message: "Failed to create user account.",
        },
      });
    }

    await db.from("invoices").insert([
      {
        id: `INV-${Date.now()}-001`,
        organization_id: org.id,
        amount: 0,
        status: "Paid",
        date: new Date().toISOString(),
      },
    ]);

    /*
     * Signup credit. Idempotent on a deterministic external_id, non-blocking: a
     * tenant who fails to receive it starts at $0 and tops up, which is
     * recoverable. A registration that 500s on a billing write is not.
     */
    const grant = await grantSignupCredit(db, org.id);
    if (grant.granted) {
      console.log(
        `[register] granted $${grant.amountUsd.toFixed(2)} signup credit to org ${org.id}`,
      );
    }

    const delivered = await deliverCode(req, res, {
      user,
      email: normalizedEmail,
      purpose: PURPOSE_EMAIL_VERIFY,
      isResend: false,
    });
    if (!delivered) return;

    const { pendingToken } = issuePendingToken({
      userId: user.id,
      email: normalizedEmail,
      organizationId: org.id,
      purpose: PURPOSE_EMAIL_VERIFY,
      sessionEpoch: user.session_epoch,
    });

    return res.status(201).json({
      verificationRequired: true,
      pendingToken,
      email: normalizedEmail,
      expiresInSeconds: delivered.expiresInSeconds,
      message: "Check your email for a 6-digit verification code.",
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/verify-email
// Body: { pendingToken, code }
// -> 200 { token, user, session, emailVerified: true }
//
// The user is NOT sent back to the sign-in form. They just proved both factors;
// retyping a password they set ninety seconds ago is friction with no value.
// ─────────────────────────────────────────────────────────────
router.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { pendingToken, code } = req.body || {};

    const pending = readPendingToken(pendingToken, PURPOSE_EMAIL_VERIFY);
    if (!pending.ok) {
      return res.status(400).json({
        error: {
          code: "PENDING_TOKEN_INVALID",
          message:
            "This verification session has expired. Please sign up or sign in again to get a new code.",
        },
      });
    }

    const allowed = await rateLimit.enforce(req, res, [
      ["code_verify_email", pending.claims.email],
      ["code_verify_ip", rateLimit.clientIp(req)],
    ]);
    if (!allowed) return;

    const result = await verifyCode({
      email: pending.claims.email,
      purpose: PURPOSE_EMAIL_VERIFY,
      code,
    });
    if (!result.ok) return codeFailureResponse(res, result);

    const db = getSupabase();
    const { data: user } = await db
      .from("users")
      .select(USER_COLUMNS)
      .eq("id", pending.claims.userId)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: "This account no longer exists.",
        },
      });
    }

    const org = await getUserOrganization(db, user.organization_id);
    if (isOrganizationDeletionRequested(org)) return deletionPendingResponse(res);

    const now = new Date().toISOString();
    await db
      .from("users")
      .update({ email_verified: true, email_verified_at: now, updated_at: now })
      .eq("id", user.id);

    /*
     * Session first. Respond. THEN send the welcome email.
     *
     * This used to await sendWelcomeEmail() here, between marking the address
     * verified and issuing the session. It was wrapped in try/catch, which
     * guards against the send THROWING but does nothing about it being SLOW —
     * and slow is the case that hurts. The one-time code has already been
     * consumed and email_verified already written by this point, so a client
     * that times out waiting on our mail provider is left in the worst possible
     * state: a spent code, a verified address, and no session. Re-entering the
     * same code then fails, because single-use means single-use.
     *
     * The welcome email is a courtesy. It must never sit on the critical path
     * of an authentication that has already succeeded.
     */
    const session = await establishSession(req, { ...user, email_verified: true });
    res.json({ ...session, emailVerified: true });

    /*
     * Deliberately not awaited, and deliberately after res.json(). Express has
     * already flushed the response; this runs on the next tick and cannot
     * affect what the client received. Any failure is logged, not surfaced —
     * there is nothing the user could do about it and nothing to retry into.
     */
    void sendWelcomeEmail(
      user.email,
      user.name,
      org?.name || "your workspace",
      {
        organizationId: user.organization_id,
        userId: user.id,
        route: "auth.verify_email",
      },
    ).catch((emailErr) =>
      console.warn(
        "[verify-email] welcome email failed (session already issued):",
        emailErr?.message || String(emailErr),
      ),
    );
    return;
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// -> 200 { otpRequired: true, pendingToken, email, expiresInSeconds }
//    or   { verificationRequired: true, ... } when the address was never verified
//
// NO SESSION IS ISSUED HERE. A correct password earns a challenge.
// ─────────────────────────────────────────────────────────────
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: {
          code: "MISSING_FIELDS",
          message: "Email and password are required.",
        },
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const allowed = await rateLimit.enforce(req, res, [
      ["login_email", normalizedEmail],
      ["login_ip", rateLimit.clientIp(req)],
    ]);
    if (!allowed) return;

    const db = getSupabase();
    const { data: user } = await db
      .from("users")
      .select(`${USER_COLUMNS}, password_hash`)
      .eq("email", normalizedEmail)
      .maybeSingle();

    /*
     * One response for "no such account" and "wrong password".
     *
     * Telling them apart lets anyone enumerate the customer list from the
     * sign-in form. The web client pairs this with a "create an account"
     * action, which solves the usability side without the leak.
     */
    const invalidCredentials = () =>
      res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message:
            "We couldn't sign you in with those details. Check your email and password, or create an account if you're new.",
        },
      });

    if (!user || !user.password_hash) return invalidCredentials();

    const valid = await bcrypt.compare(String(password), user.password_hash);
    if (!valid) return invalidCredentials();

    const org = await getUserOrganization(db, user.organization_id);
    if (isOrganizationDeletionRequested(org)) return deletionPendingResponse(res);

    const sendAllowed = await rateLimit.enforce(req, res, [
      ["code_send_email", normalizedEmail],
      ["code_send_ip", rateLimit.clientIp(req)],
    ]);
    if (!sendAllowed) return;

    /*
     * An account that never finished verifying gets the VERIFICATION flow, not
     * the login flow — different purpose, different code, different endpoint.
     * Routing it into login OTP would mean a login code could set
     * email_verified, which is precisely the conflation to avoid.
     */
    const purpose =
      user.email_verified === true ? PURPOSE_LOGIN_OTP : PURPOSE_EMAIL_VERIFY;

    const delivered = await deliverCode(req, res, {
      user,
      email: normalizedEmail,
      purpose,
      isResend: false,
    });
    if (!delivered) return;

    const { pendingToken } = issuePendingToken({
      userId: user.id,
      email: normalizedEmail,
      organizationId: user.organization_id,
      purpose,
      sessionEpoch: user.session_epoch,
    });

    return res.json({
      ...(purpose === PURPOSE_LOGIN_OTP
        ? { otpRequired: true }
        : { verificationRequired: true }),
      pendingToken,
      email: normalizedEmail,
      expiresInSeconds: delivered.expiresInSeconds,
      message:
        purpose === PURPOSE_LOGIN_OTP
          ? "We sent a 6-digit code to your email."
          : "Confirm your email address to finish setting up your account.",
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/verify-login-otp
// Body: { pendingToken, code }
// -> 200 { token, user, session }
// ─────────────────────────────────────────────────────────────
router.post(
  "/verify-login-otp",
  asyncHandler(async (req, res) => {
    const { pendingToken, code } = req.body || {};

    const pending = readPendingToken(pendingToken, PURPOSE_LOGIN_OTP);
    if (!pending.ok) {
      return res.status(400).json({
        error: {
          code: "PENDING_TOKEN_INVALID",
          message:
            "This sign-in attempt has expired. Please enter your email and password again.",
        },
      });
    }

    const allowed = await rateLimit.enforce(req, res, [
      ["code_verify_email", pending.claims.email],
      ["code_verify_ip", rateLimit.clientIp(req)],
    ]);
    if (!allowed) return;

    const result = await verifyCode({
      email: pending.claims.email,
      purpose: PURPOSE_LOGIN_OTP,
      code,
    });
    if (!result.ok) return codeFailureResponse(res, result);

    const db = getSupabase();
    const { data: user } = await db
      .from("users")
      .select(USER_COLUMNS)
      .eq("id", pending.claims.userId)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: "This account no longer exists.",
        },
      });
    }

    /*
     * The password may have been reset while this OTP was in flight — which is
     * exactly what someone does on realising an attacker has their password.
     * The pending token pinned the epoch at issue time; if it has moved, this
     * attempt dies with the sessions the reset revoked.
     */
    if (Number(pending.claims.sev || 0) !== Number(user.session_epoch || 0)) {
      return res.status(400).json({
        error: {
          code: "PENDING_TOKEN_STALE",
          message:
            "Your account credentials changed. Please sign in again with your new password.",
        },
      });
    }

    const org = await getUserOrganization(db, user.organization_id);
    if (isOrganizationDeletionRequested(org)) return deletionPendingResponse(res);

    const session = await establishSession(req, user);
    return res.json(session);
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/resend-code
// Body: { pendingToken }
// -> 200 { sent: true, pendingToken, email, expiresInSeconds }
//
// One endpoint for both purposes. It reads the purpose OUT OF the pending
// token rather than taking it from the caller, so a client cannot ask for a
// verification code by presenting a login token.
// ─────────────────────────────────────────────────────────────
router.post(
  "/resend-code",
  asyncHandler(async (req, res) => {
    const { pendingToken } = req.body || {};

    const forVerify = readPendingToken(pendingToken, PURPOSE_EMAIL_VERIFY);
    const pending = forVerify.ok
      ? forVerify
      : readPendingToken(pendingToken, PURPOSE_LOGIN_OTP);
    const purpose = forVerify.ok ? PURPOSE_EMAIL_VERIFY : PURPOSE_LOGIN_OTP;

    if (!pending.ok) {
      return res.status(400).json({
        error: {
          code: "PENDING_TOKEN_INVALID",
          message:
            "This session has expired. Please start again to get a new code.",
        },
      });
    }

    const allowed = await rateLimit.enforce(req, res, [
      ["code_send_email", pending.claims.email],
      ["code_send_ip", rateLimit.clientIp(req)],
    ]);
    if (!allowed) return;

    const db = getSupabase();
    const { data: user } = await db
      .from("users")
      .select(USER_COLUMNS)
      .eq("id", pending.claims.userId)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: "This account no longer exists.",
        },
      });
    }

    const delivered = await deliverCode(req, res, {
      user,
      email: pending.claims.email,
      purpose,
      isResend: true,
    });
    if (!delivered) return;

    /*
     * A fresh pending token accompanies the fresh code. Without it, someone who
     * waits out most of the first code's life and then resends gets a new code
     * wrapped in a token that expires first — the code would be live and
     * unusable.
     */
    const reissued = issuePendingToken({
      userId: user.id,
      email: pending.claims.email,
      organizationId: user.organization_id,
      purpose,
      sessionEpoch: user.session_epoch,
    });

    return res.json({
      sent: true,
      pendingToken: reissued.pendingToken,
      email: pending.claims.email,
      expiresInSeconds: delivered.expiresInSeconds,
      resendCooldownSeconds: rateLimit.RESEND_COOLDOWN_SECONDS,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/password-reset/request
// Body: { email }
// Always 200 with the same body, so it cannot be used to test whether an
// address is registered.
// ─────────────────────────────────────────────────────────────
router.post(
  "/password-reset/request",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};

    if (!email || typeof email !== "string") {
      return res.status(400).json({
        error: { code: "MISSING_FIELDS", message: "Email is required." },
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const allowed = await rateLimit.enforce(req, res, [
      ["password_reset_email", normalizedEmail],
      ["password_reset_ip", rateLimit.clientIp(req)],
    ]);
    if (!allowed) return;

    const db = getSupabase();
    const genericResponse = {
      message:
        "If an Agently account exists for that email, password reset instructions have been sent.",
      email: normalizedEmail,
      resetUrl: null,
    };

    const { data: user, error: userErr } = await db
      .from("users")
      .select("id, name, email, organization_id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (userErr) {
      console.warn(
        "[password-reset] lookup failed:",
        userErr.message || userErr,
      );
      return res.json(genericResponse);
    }
    if (!user) return res.json(genericResponse);

    const org = await getUserOrganization(db, user.organization_id);
    if (isOrganizationDeletionRequested(org)) return res.json(genericResponse);

    const token = createResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const resetUrl = buildPasswordResetUrl(token);

    await db
      .from("password_reset_tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("used", false);

    const { error: insertErr } = await db.from("password_reset_tokens").insert({
      user_id: user.id,
      email: normalizedEmail,
      // The legacy `token` column is NOT NULL and only `token_hash` is ever
      // matched against. Store the hash in both rather than keeping a usable
      // plaintext copy of a live credential in the table.
      token: tokenHash,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    if (insertErr) {
      console.error("[password-reset] token insert failed:", insertErr);
      return res.status(500).json({
        error: {
          code: "PASSWORD_RESET_UNAVAILABLE",
          message:
            "Password reset is temporarily unavailable. Please try again.",
        },
      });
    }

    /*
     * Same shape of fix as verify-email, for a second reason.
     *
     * Awaiting the send here made this endpoint a timing oracle: a registered
     * address waited on Resend (hundreds of ms), an unregistered one returned
     * immediately. The identical response body was carefully designed to stop
     * anyone testing whether an address has an account, and the latency handed
     * that back. Responding first makes the timing constant as well as the body.
     *
     * Nothing is lost by not waiting: the response is generic either way, so
     * there was never anything the outcome of the send could change about it.
     */
    res.json(genericResponse);

    void sendPasswordResetEmail(normalizedEmail, resetUrl, {
      organizationId: user.organization_id,
      userId: user.id,
      route: "auth.password_reset.request",
      billable: false,
    }).catch((emailErr) =>
      console.warn(
        "[password-reset] email failed:",
        emailErr?.message || String(emailErr),
      ),
    );
    return;
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/password-reset/confirm
// Body: { token, password }
// Sets the new password and REVOKES EVERY EXISTING SESSION for that user.
// ─────────────────────────────────────────────────────────────
router.post(
  "/password-reset/confirm",
  asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};

    if (!token || typeof token !== "string") {
      return res.status(400).json({
        error: { code: "MISSING_FIELDS", message: "Reset token is required." },
      });
    }

    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        error: {
          code: "PASSWORD_TOO_SHORT",
          message: "Password must be at least 8 characters.",
        },
      });
    }

    const db = getSupabase();
    const tokenHash = hashResetToken(token.trim());

    const { data: record } = await db
      .from("password_reset_tokens")
      .select("id, user_id, email, expires_at, used")
      .eq("token_hash", tokenHash)
      .eq("used", false)
      .maybeSingle();

    if (!record) {
      return res.status(400).json({
        error: {
          code: "RESET_TOKEN_INVALID",
          message: "This reset link is invalid or has already been used.",
        },
      });
    }

    if (new Date(record.expires_at) < new Date()) {
      await db
        .from("password_reset_tokens")
        .update({ used: true, used_at: new Date().toISOString() })
        .eq("id", record.id);
      return res.status(400).json({
        error: {
          code: "RESET_TOKEN_EXPIRED",
          message: "This reset link has expired. Please request a new one.",
        },
      });
    }

    const { data: user } = await db
      .from("users")
      .select("id, organization_id, email")
      .eq("id", record.user_id)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({
        error: {
          code: "RESET_TOKEN_INVALID",
          message: "This reset link is no longer valid.",
        },
      });
    }

    const org = await getUserOrganization(db, user.organization_id);
    if (isOrganizationDeletionRequested(org)) return deletionPendingResponse(res);

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();

    const { error: updateErr } = await db
      .from("users")
      .update({
        password_hash: passwordHash,
        password_changed_at: now,
        updated_at: now,
      })
      .eq("id", user.id);

    if (updateErr) {
      console.error("[password-reset] password update failed:", updateErr);
      return res.status(500).json({
        error: {
          code: "PASSWORD_RESET_FAILED",
          message: "Unable to update password. Please try again.",
        },
      });
    }

    await db
      .from("password_reset_tokens")
      .update({ used: true, used_at: now })
      .eq("user_id", user.id)
      .eq("used", false);

    /*
     * The whole point of a reset.
     *
     * Someone resets a password because they believe another person has it.
     * Leaving that person's sessions alive would defeat the exercise — they
     * would keep access for up to thirty days. Every session dies, and any OTP
     * challenge already in flight dies with it via the epoch bump.
     */
    await revokeAllSessionsForUser(user.id, "password_reset");
    await invalidateCodes(user.email, PURPOSE_LOGIN_OTP);

    return res.json({
      success: true,
      message: "Password updated. You can now sign in with your new password.",
      sessionsRevoked: true,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/change-password        (signed in)
// Body: { currentPassword, newPassword }
// Keeps the CURRENT session alive and revokes the others.
// ─────────────────────────────────────────────────────────────
router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (
      !newPassword ||
      typeof newPassword !== "string" ||
      newPassword.length < 8
    ) {
      return res.status(400).json({
        error: {
          code: "PASSWORD_TOO_SHORT",
          message: "New password must be at least 8 characters.",
        },
      });
    }

    const db = getSupabase();
    const { data: user } = await db
      .from("users")
      .select("id, organization_id, password_hash, session_epoch")
      .eq("id", req.user.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: "User account not found.",
        },
      });
    }

    // Step-up: prove you are the person at the keyboard, not someone who found
    // an unlocked laptop.
    if (user.password_hash) {
      if (!currentPassword || typeof currentPassword !== "string") {
        return res.status(400).json({
          error: {
            code: "CURRENT_PASSWORD_REQUIRED",
            message: "Current password is required.",
          },
        });
      }
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        return res.status(401).json({
          error: {
            code: "CURRENT_PASSWORD_INCORRECT",
            message: "Current password is incorrect.",
          },
        });
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const now = new Date().toISOString();
    const { error: updateErr } = await db
      .from("users")
      .update({
        password_hash: passwordHash,
        password_changed_at: now,
        updated_at: now,
      })
      .eq("id", user.id)
      .eq("organization_id", req.orgId);

    if (updateErr) {
      console.error("[change-password] update failed:", updateErr);
      return res.status(500).json({
        error: {
          code: "PASSWORD_CHANGE_FAILED",
          message: "Unable to update password. Please try again.",
        },
      });
    }

    /*
     * Revoke every session, then hand this caller a fresh one.
     *
     * Bumping the epoch invalidates this request's own token too, so without
     * re-issuing, changing your password in Settings would sign you out of the
     * tab you were standing in. The client swaps the token in and carries on.
     */
    await revokeAllSessionsForUser(user.id, "password_changed");
    clearSessionCache(req.authToken);

    const { data: refreshed } = await db
      .from("users")
      .select(USER_COLUMNS)
      .eq("id", user.id)
      .single();

    const session = await establishSession(req, refreshed);

    return res.json({
      success: true,
      message: "Password updated successfully.",
      otherSessionsRevoked: true,
      ...session,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/logout
// Revokes the session behind the presented token. This used to be a no-op that
// returned success while the token stayed valid for its full 30 days.
// ─────────────────────────────────────────────────────────────
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.sessionId) await revokeSession(req.sessionId, "logout");
    clearSessionCache(req.authToken);
    return res.json({ success: true, sessionRevoked: Boolean(req.sessionId) });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/logout-all
// Ends every session for the caller, on every device.
// ─────────────────────────────────────────────────────────────
router.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeAllSessionsForUser(req.user.id, "user_signed_out_everywhere");
    clearSessionCache(req.authToken);
    return res.json({ success: true, allSessionsRevoked: true });
  }),
);


// ─────────────────────────────────────────────────────────────
// POST /api/auth/accept-invitation
// Body: { token }
// -> 200 { token, user, session, mustSetPassword }
//
// The replacement for the one legitimate use of the old magic-link verifier.
//
// A team invitation is NOT a sign-in link and must not behave like one. It can
// only ever resolve to a user row that an authenticated admin already created
// (POST /api/team/invitations), inside the organization that admin belongs to.
// It creates nothing. That is the distinction the removed endpoint failed to
// draw: it accepted any token, and minted an organization for any address it
// did not recognise.
//
// Receiving the link proves mailbox control, so accepting also sets
// email_verified — the invitee is not then asked for a separate code.
// ─────────────────────────────────────────────────────────────
router.post(
  "/accept-invitation",
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({
        error: { code: "MISSING_FIELDS", message: "Invitation token is required." },
      });
    }

    const allowed = await rateLimit.enforce(req, res, [
      ["code_verify_ip", rateLimit.clientIp(req)],
    ]);
    if (!allowed) return;

    const db = getSupabase();
    const invalid = () =>
      res.status(400).json({
        error: {
          code: "INVITATION_INVALID",
          message:
            "This invitation is invalid, has expired, or has already been used. Ask your administrator to send a new one.",
        },
      });

    const { data: record } = await db
      .from("magic_link_tokens")
      .select("id, email, user_id, organization_id, purpose, expires_at, used")
      .eq("token", token)
      .eq("purpose", "team_invite")
      .eq("used", false)
      .maybeSingle();

    // Every failure below returns the same message. An invitation token is a
    // bearer credential and a probe should not learn whether it ever existed.
    if (!record) return invalid();
    if (new Date(record.expires_at) < new Date()) return invalid();
    if (!record.user_id || !record.organization_id) return invalid();

    const { data: user } = await db
      .from("users")
      .select(`${USER_COLUMNS}, password_hash`)
      .eq("id", record.user_id)
      .eq("organization_id", record.organization_id)
      .maybeSingle();

    if (!user) return invalid();

    const org = await getUserOrganization(db, user.organization_id);
    if (isOrganizationDeletionRequested(org)) return deletionPendingResponse(res);

    const now = new Date().toISOString();

    /*
     * Consume conditionally. Two clicks on the same link can race here; only
     * the UPDATE that still matches used = false comes back with a row, and the
     * loser is told the invitation is spent.
     */
    const { data: consumed } = await db
      .from("magic_link_tokens")
      .update({ used: true, used_reason: "accepted", used_at: now })
      .eq("id", record.id)
      .eq("used", false)
      .select("id")
      .maybeSingle();
    if (!consumed) return invalid();

    if (user.email_verified !== true) {
      await db
        .from("users")
        .update({ email_verified: true, email_verified_at: now, updated_at: now })
        .eq("id", user.id);
    }

    const session = await establishSession(req, {
      ...user,
      email_verified: true,
    });

    return res.json({
      ...session,
      emailVerified: true,
      /*
       * Invited members are created without a password (misc.js inserts the row
       * with no password_hash). They are signed in now, but until they set one
       * they cannot use the ordinary sign-in form ever again — /login requires
       * a password_hash. The client must send them to the set-password step;
       * POST /api/auth/change-password accepts an empty currentPassword
       * precisely for this case.
       */
      mustSetPassword: !user.password_hash,
    });
  }),
);

/*
 * REMOVED IN V1: POST /api/auth/magic-link and POST /api/auth/magic-link/verify.
 *
 * Gone, not deprecated — leaving them mounted would leave the bypass reachable.
 * Requests now fall through to the router's 404.
 *
 * What they did: /magic-link returned the sign-in token in its own response
 * body in production, and the web client rendered a button that fed it straight
 * back to /magic-link/verify. That is authentication with no second party; the
 * mailbox was never involved. /magic-link/verify also created an organization
 * and an owner user for any address it did not recognise, so it was
 * unauthenticated tenant creation as well.
 *
 * The magic_link_tokens TABLE stays. Team invitations use it with
 * purpose = "team_invite" — minted by an authenticated admin, bound to a user
 * and organization that already exist, incapable of creating anything. That
 * flow is unchanged and still verified in misc.js.
 */

module.exports = router;
