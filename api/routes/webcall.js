"use strict";

/**
 * ============================================================
 * api/routes/webcall.js
 * ============================================================
 * "Talk to Your Agent" — live browser test call.
 *
 * This route only ISSUES a short-lived, purpose-scoped token
 * after verifying the requesting user's organization owns the
 * agent. The actual audio session lives entirely in
 * agently-ws-server (Vercel cannot hold long-lived WebSockets).
 *
 * Additive only — new route, new table, one new organizations
 * column. Nothing existing is modified.
 * ============================================================
 */

const crypto = require("crypto");
const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { signScopedToken, verifyToken } = require("../../lib/auth");

const router = express.Router();

const WEBCALL_TOKEN_TTL_SECONDS = Math.max(
  60,
  Number(process.env.WEBCALL_TOKEN_TTL_SECONDS || 600),
);
const WEBCALL_MAX_SESSION_SECONDS = Math.max(
  30,
  Number(process.env.WEBCALL_MAX_SESSION_SECONDS || 300),
);

function normalizeWebSocketBase(value) {
  const base = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  return base.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

function webcallWsBase() {
  const explicit = (process.env.TWILIO_WS_URL || "").trim().replace(/\/+$/, "");
  const apiUrl = (process.env.API_URL || "").trim().replace(/\/+$/, "");
  return normalizeWebSocketBase(explicit || apiUrl);
}

// ── Internal service guard for /verify-token ─────────────────
// This endpoint is called server-to-server by agently-ws-server, never by a
// browser. It is locked behind a shared secret so it cannot be used as a
// public oracle for probing webcall tokens and reading their org/agent/user
// claims. Fail closed, matching requireInternalBillingAccess in
// billing-usage.js: no secret configured means the route is unavailable.
function webcallVerifySecret() {
  return String(process.env.WEBCALL_VERIFY_SECRET || "").trim();
}

function isSafeInternalKey(key) {
  return Boolean(key) && key.length >= 32;
}

function keysMatch(provided, expected) {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireWebcallVerifyAccess(req, res, next) {
  const expected = webcallVerifySecret();
  if (!isSafeInternalKey(expected)) {
    console.warn(
      "[webcall] /verify-token is locked: set WEBCALL_VERIFY_SECRET (32+ chars) on the backend and agently-ws-server.",
    );
    return res.status(503).json({
      valid: false,
      error: {
        code: "VERIFIER_NOT_CONFIGURED",
        message: "Token verification service is not configured.",
      },
    });
  }

  const provided = String(req.headers["x-webcall-verify-key"] || "").trim();
  if (!provided || !keysMatch(provided, expected)) {
    return res.status(403).json({
      valid: false,
      error: {
        code: "INTERNAL_ACCESS_REQUIRED",
        message: "Internal access required.",
      },
    });
  }
  next();
}

// Per-instance sliding-window limiter. Serverless means this is per warm
// instance rather than global, so it is a brake on abuse, not a hard quota —
// the shared secret above is the real control.
const VERIFY_RATE_WINDOW_MS = 60_000;
const VERIFY_RATE_MAX = Math.max(
  10,
  Number(process.env.WEBCALL_VERIFY_RATE_LIMIT || 120),
);
const verifyHits = new Map();

function rateLimitVerify(req, res, next) {
  const now = Date.now();
  const key = String(
    req.headers["x-forwarded-for"] || req.ip || "unknown",
  ).split(",")[0].trim();

  const hits = (verifyHits.get(key) || []).filter(
    (t) => now - t < VERIFY_RATE_WINDOW_MS,
  );
  hits.push(now);
  verifyHits.set(key, hits);

  // Bound memory on a long-lived instance.
  if (verifyHits.size > 500) {
    for (const [k, v] of verifyHits) {
      if (!v.length || now - v[v.length - 1] > VERIFY_RATE_WINDOW_MS) {
        verifyHits.delete(k);
      }
    }
  }

  if (hits.length > VERIFY_RATE_MAX) {
    return res.status(429).json({
      valid: false,
      error: { code: "RATE_LIMITED", message: "Too many verification requests." },
    });
  }
  next();
}

async function loadOrgWebcallFlag(db, orgId) {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("live_webcall_enabled")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw error;
    // Default to enabled when the column is null (e.g. rows created before
    // the migration ran) rather than silently locking owners out.
    return data?.live_webcall_enabled !== false;
  } catch (err) {
    // If the migration hasn't been applied yet, fail open rather than
    // breaking the feature outright — this is a test-call convenience
    // gate, not a security boundary.
    console.warn(
      "[webcall] live_webcall_enabled lookup failed, defaulting to enabled:",
      err.message || String(err),
    );
    return true;
  }
}

// ── GET /api/webcall/status ─────────────────────────────────
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const enabled = await loadOrgWebcallFlag(db, req.orgId);
    res.json({
      enabled,
      maxSessionSeconds: WEBCALL_MAX_SESSION_SECONDS,
      wsConfigured: Boolean(webcallWsBase()),
    });
  }),
);

// ── POST /api/webcall/verify-token ────────────────────────────
// Server-to-server verifier used by agently-ws-server as a safe fallback
// when Railway and Vercel do not share the same local JWT_SECRET. It does
// not use requireAuth (there is no end-user session on this hop); instead it
// is gated on the shared WEBCALL_VERIFY_SECRET, and it accepts ONLY
// purpose-scoped webcall JWTs signed by this backend, returning just the
// claims the WS service needs.
router.post(
  "/verify-token",
  rateLimitVerify,
  requireWebcallVerifyAccess,
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({
        valid: false,
        error: { code: "TOKEN_REQUIRED", message: "token is required." },
      });
    }

    const claims = verifyToken(token);
    if (
      !claims ||
      claims.purpose !== "webcall" ||
      !claims.orgId ||
      !claims.agentId
    ) {
      return res.status(401).json({
        valid: false,
        error: { code: "TOKEN_INVALID", message: "Invalid or expired webcall token." },
      });
    }

    return res.json({
      valid: true,
      claims: {
        purpose: "webcall",
        orgId: claims.orgId,
        agentId: claims.agentId,
        userId: claims.userId || null,
        iat: claims.iat || null,
        exp: claims.exp || null,
      },
    });
  }),
);

// ── POST /api/webcall/token ──────────────────────────────────
router.post(
  "/token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agentId = String(req.body?.agentId || "").trim();
    if (!agentId) {
      return res.status(400).json({
        error: { code: "AGENT_ID_REQUIRED", message: "agentId is required." },
      });
    }

    const db = getSupabase();

    const enabled = await loadOrgWebcallFlag(db, req.orgId);
    if (!enabled) {
      return res.status(403).json({
        error: {
          code: "WEBCALL_DISABLED",
          message: "Live test calls are turned off for this account.",
        },
      });
    }

    const { data: agent, error } = await db
      .from("voice_agents")
      .select("id, organization_id, is_active")
      .eq("id", agentId)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!agent) {
      return res.status(404).json({
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found." },
      });
    }

    const wsBase = webcallWsBase();
    if (!wsBase) {
      return res.status(503).json({
        error: {
          code: "WEBCALL_NOT_CONFIGURED",
          message: "Live test calls are not configured yet. Try again shortly.",
        },
      });
    }

    const token = signScopedToken(
      {
        purpose: "webcall",
        orgId: req.orgId,
        agentId: agent.id,
        userId: req.user?.id || null,
      },
      `${WEBCALL_TOKEN_TTL_SECONDS}s`,
    );

    res.json({
      token,
      wsUrl: `${wsBase}/api/webcall/stream?token=${encodeURIComponent(token)}`,
      expiresInSeconds: WEBCALL_TOKEN_TTL_SECONDS,
      maxSessionSeconds: WEBCALL_MAX_SESSION_SECONDS,
    });
  }),
);

module.exports = router;
