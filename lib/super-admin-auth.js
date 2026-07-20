"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getSupabase } = require("./supabase");

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
  const value = Number(process.env.SUPER_ADMIN_SESSION_MINUTES || 30);
  return Number.isFinite(value) ? Math.min(Math.max(value, 5), 120) : 30;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || req.ip || "unknown";
}

function isAllowedIp(req) {
  const allowed = String(process.env.SUPER_ADMIN_ALLOWED_IPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
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
  if (!secret) return true;
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
  const otpMatches = passwordMatches ? verifyTotp(credentials?.otp) : false;

  if (!emailMatches || !passwordMatches || !otpMatches) {
    recordMemoryFailure(req, email);
    await logSecurityEvent(req, "login_failed", false, { adminEmail: email });
    return { ok: false, status: 401, message: "Invalid credentials." };
  }

  clearMemoryFailures(req, email);
  const sessionMinutes = getSessionMinutes();
  const token = jwt.sign(
    { scope: "super_admin", email: configuredEmail },
    secret,
    { expiresIn: `${sessionMinutes}m`, issuer: "agently-super-admin" },
  );
  await logSecurityEvent(req, "login_succeeded", true, { adminEmail: email });

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
};
