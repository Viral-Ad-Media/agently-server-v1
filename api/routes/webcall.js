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

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { signScopedToken } = require("../../lib/auth");

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
