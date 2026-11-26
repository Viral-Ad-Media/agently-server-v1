"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getSupabase } = require("./supabase");
const { clientIp } = require("./client-ip");

const memoryFailures = new Map();

function firstNonEmpty(...values) {
  for (const value of values) {
    const clean = String(value || "").trim();
    if (clean) return clean;
  }
  return "";
}

function isEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.SUPER_ADMIN_ENABLED || "").toLowerCase(),
  );
}

function getAdminEmail() {
  return String(process.env.SUPER_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
}

function getPasswordHash() {
  return String(process.env.SUPER_ADMIN_PASSWORD_HASH || "").trim();
}

function getJwtSecret() {
  return String(process.env.SUPER_ADMIN_JWT_SECRET || "").trim();
}

function getSessionMinutes() {
  const value = Number(process.env.SUPER_ADMIN_SESSION_MINUTES || 15);
  return Number.isFinite(value) ? Math.min(Math.max(value, 5), 15) : 15;
}

/*
 * X-Forwarded-For is a chain, and only one end of it is trustworthy.
 *
 * This used to return chain[0]. That is the end the CLIENT writes: the AWS
 * load balancer in front of this service APPENDS the peer address it actually
 * saw rather than replacing the header, so a request carrying
 * `X-Forwarded-For: 203.0.113.99` arrives as "203.0.113.99, <real client>"
 * and the old code believed the forged half. Measured against production on
 * 22 Sep 2026: a request sent with that header was recorded in
 * super_admin_security_events as ip=203.0.113.99.
 *
 * Three things read this, and all three were wrong in the same way:
 *   - isAllowedIp()      — an allowlist anyone could satisfy by sending a header
 *   - logSecurityEvent() — an audit trail an attacker could write
 *   - memoryFailureKey() — the brute-force lockout key, so rotating the header
 *                          per request gave unlimited login attempts
 *
 * The LAST entry is the address our own load balancer observed and is the only
 * one a client cannot influence. That assumes exactly one proxy hop, which is
 * this deployment; putting a CDN in front would add a hop and need this
 * revisited.
 */
const getClientIp = clientIp;

let warnedNoAllowlist = false;

/*
 * An empty allowlist means "any address", which is a legitimate choice but an
 * invisible one: unset and satisfied return the same value, so nobody can tell
 * a deliberate decision from a forgotten variable. verifyTotp() had the same
 * shape and was silently off in production for weeks. Say it once at the first
 * super-admin request so the state is at least legible in the logs.
 */
function isAllowedIp(req) {
  const allowed = String(process.env.SUPER_ADMIN_ALLOWED_IPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.length) {
    if (!warnedNoAllowlist) {
      warnedNoAllowlist = true;
      console.warn(
        "[super-admin] SUPER_ADMIN_ALLOWED_IPS is unset — super-admin is reachable " +
          "from any address. This is intentional while administration happens from a " +
          "dynamic IP; password and TOTP are the controls. Set it to a comma-separated " +
          "list of exact addresses to restrict (no CIDR support).",
      );
    }
    return true;
  }
  return allowed.includes(getClientIp(req));
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(value || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, step) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, "0");
}

function verifyTotp(code) {
  const secret = String(process.env.SUPER_ADMIN_TOTP_SECRET || "").trim();
  // This used to `return true` when the secret was missing, which meant the
  // super-admin gate silently degraded to email plus password and read, from
  // the outside, exactly like working 2FA (N005). Absence is now a refusal.
  //
  // LOCKOUT IS THE INTENDED FAILURE MODE: if the seed ever goes missing, no
  // one signs in as super-admin until it is restored. That is the correct
  // trade for an account that can act as any tenant, and the log line says
  // precisely what to fix.
  if (!secret) {
    console.error(
      "[super-admin] SUPER_ADMIN_TOTP_SECRET is not set — refusing every " +
        "super-admin sign-in. Restore the seed to re-enable access.",
    );
    return false;
  }
  const cleanCode = String(code || "").replace(/\D/g, "");
  if (cleanCode.length !== 6) return false;
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  for (const offset of [-1, 0, 1]) {
    const expected = totpCode(secret, currentStep + offset);
    const left = Buffer.from(expected);
    const right = Buffer.from(cleanCode);
    if (left.length === right.length && crypto.timingSafeEqual(left, right)) {
      return true;
    }
  }
  return false;
}

async function logSecurityEvent(req, eventType, success, metadata = {}) {
  try {
    const db = getSupabase();
    await db.from("super_admin_security_events").insert({
      event_type: eventType,
      admin_email: String(metadata.adminEmail || getAdminEmail() || "") || null,
      ip_address: getClientIp(req),
      user_agent: String(req.headers["user-agent"] || "").slice(0, 500) || null,
      success: Boolean(success),
      metadata,
    });
  } catch (error) {
    console.warn("[super-admin] audit log unavailable:", error.message);
  }
}

function memoryFailureKey(req, email) {
  return `${getClientIp(req)}:${String(email || "").toLowerCase()}`;
}

function recordMemoryFailure(req, email) {
  const key = memoryFailureKey(req, email);
  const now = Date.now();
  const entry = memoryFailures.get(key) || { timestamps: [], lockedUntil: 0 };
  entry.timestamps = entry.timestamps.filter(
    (time) => now - time < 15 * 60 * 1000,
  );
  entry.timestamps.push(now);
  if (entry.timestamps.length >= 5) entry.lockedUntil = now + 30 * 60 * 1000;
  memoryFailures.set(key, entry);
}

function clearMemoryFailures(req, email) {
  memoryFailures.delete(memoryFailureKey(req, email));
}

async function getLockState(req, email) {
  const now = Date.now();
  const memory = memoryFailures.get(memoryFailureKey(req, email));
  if (memory?.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((memory.lockedUntil - now) / 1000),
    };
  }

  try {
    const db = getSupabase();
    const since = new Date(now - 15 * 60 * 1000).toISOString();
    const { count, error } = await db
      .from("super_admin_security_events")
      .select("id", { count: "exact", head: true })
      .eq("success", false)
      .eq("event_type", "login_failed")
      .eq("admin_email", String(email || "").toLowerCase())
      .gte("created_at", since);
    if (!error && Number(count || 0) >= 5) {
      return { locked: true, retryAfterSeconds: 30 * 60 };
    }
  } catch (_) {
    // The in-memory fallback above still limits repeated attempts.
  }

  return { locked: false, retryAfterSeconds: 0 };
}

/*
 * Recovery codes: the way back in when the authenticator app is unavailable.
 * SUPER_ADMIN_RECOVERY_CODES holds comma-separated SHA-256 fingerprints of
 * ten one-time codes (format XXXX-XXXX-XXXX); the codes themselves are never
 * stored on the server. A code is spent by writing a recovery_code_used
 * security event; if that write fails the code is refused, so a code can
 * never be used twice. Issued by scripts/reset-super-admin.js.
 */
function recoveryCodeHashes() {
  return String(process.env.SUPER_ADMIN_RECOVERY_CODES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value));
}

function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function looksLikeRecoveryCode(code) {
  const clean = normalizeRecoveryCode(code);
  return clean.length === 12 && /[A-Z]/.test(clean);
}

const spentRecoveryCodes = new Set();

async function redeemRecoveryCode(req, code, email) {
  const hash = crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
  if (!recoveryCodeHashes().includes(hash) || spentRecoveryCodes.has(hash)) return false;
  try {
    const db = getSupabase();
    const { count, error } = await db
      .from("super_admin_security_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "recovery_code_used")
      .eq("metadata->>codeHash", hash);
    if (error || Number(count || 0) > 0) return false;
    const { error: insertError } = await db.from("super_admin_security_events").insert({
      event_type: "recovery_code_used",
      admin_email: email || null,
      ip_address: getClientIp(req),
      user_agent: String(req.headers["user-agent"] || "").slice(0, 500) || null,
      success: true,
      metadata: { codeHash: hash },
    });
    if (insertError) return false;
    spentRecoveryCodes.add(hash);
    return true;
  } catch (_) {
    return false;
  }
}

async function authenticateSuperAdmin(req, credentials) {
  if (!isEnabled()) {
    return { ok: false, status: 404, message: "Not found." };
  }
  if (!isAllowedIp(req)) {
    await logSecurityEvent(req, "login_blocked_ip", false, {});
    return { ok: false, status: 404, message: "Not found." };
  }

  const email = String(credentials?.email || "")
    .trim()
    .toLowerCase();
  const password = String(credentials?.password || "");
  const configuredEmail = getAdminEmail();
  const passwordHash = getPasswordHash();
  const secret = getJwtSecret();

  if (!configuredEmail || !passwordHash || !secret) {
    return {
      ok: false,
      status: 503,
      message: "Super-admin access has not been configured on the backend.",
    };
  }

  const lock = await getLockState(req, email);
  if (lock.locked) {
    await logSecurityEvent(req, "login_locked", false, { adminEmail: email });
    return {
      ok: false,
      status: 429,
      message: "Too many failed attempts. Try again later.",
      retryAfterSeconds: lock.retryAfterSeconds,
    };
  }

  const emailMatches = email === configuredEmail;
  const passwordMatches = emailMatches
    ? await bcrypt.compare(password, passwordHash)
    : false;
  let otpMatches = passwordMatches ? verifyTotp(credentials?.otp) : false;
  let usedRecoveryCode = false;
  if (passwordMatches && !otpMatches && looksLikeRecoveryCode(credentials?.otp)) {
    otpMatches = await redeemRecoveryCode(req, credentials.otp, email);
    usedRecoveryCode = otpMatches;
  }

  if (!emailMatches || !passwordMatches) {
    recordMemoryFailure(req, email);
    await logSecurityEvent(req, "login_failed", false, { adminEmail: email });
    return { ok: false, status: 401, message: "Invalid credentials." };
  }
  if (!otpMatches) {
    // Email and password were right; only the second factor failed. Saying so
    // is the normal two-step behaviour and stops the owner guessing which of
    // the three fields is wrong. It still counts toward the lockout.
    recordMemoryFailure(req, email);
    await logSecurityEvent(req, "login_failed", false, { adminEmail: email, factor: "otp" });
    return {
      ok: false,
      status: 401,
      message:
        "Email and password are correct, but that code didn't match. Enter the current 6-digit code for “Agently Admin” in your authenticator app (it changes every 30 seconds), or one of your recovery codes.",
    };
  }

  clearMemoryFailures(req, email);
  const sessionMinutes = getSessionMinutes();
  const token = jwt.sign(
    { scope: "super_admin", email: configuredEmail },
    secret,
    { expiresIn: `${sessionMinutes}m`, issuer: "agently-super-admin" },
  );
  await logSecurityEvent(req, "login_succeeded", true, {
    adminEmail: email,
    method: usedRecoveryCode ? "recovery_code" : "totp",
  });

  return {
    ok: true,
    token,
    email: configuredEmail,
    expiresInSeconds: sessionMinutes * 60,
    otpRequired: Boolean(
      String(process.env.SUPER_ADMIN_TOTP_SECRET || "").trim(),
    ),
  };
}

function requireSuperAdmin(req, res, next) {
  if (!isEnabled() || !isAllowedIp(req)) {
    return res.status(404).json({ error: { message: "Not found." } });
  }
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return res
      .status(401)
      .json({ error: { message: "Super-admin authentication required." } });
  }
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      issuer: "agently-super-admin",
      algorithms: ["HS256"],
      maxAge: `${getSessionMinutes()}m`,
    });
    if (payload.scope !== "super_admin" || payload.email !== getAdminEmail()) {
      throw new Error("Invalid super-admin scope");
    }
    req.superAdmin = { email: payload.email };
    return next();
  } catch (_) {
    return res
      .status(401)
      .json({ error: { message: "Super-admin session expired or invalid." } });
  }
}

module.exports = {
  authenticateSuperAdmin,
  requireSuperAdmin,
  logSecurityEvent,
  isEnabled,
  getClientIp,
  // Exported for tests: the allowlist is a security boundary, and the only way
  // to assert a forged header cannot satisfy it is to call it directly.
  isAllowedIp,
};
