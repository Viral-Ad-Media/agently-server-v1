"use strict";

const { resolveSession } = require("../lib/auth");

let lastAuthDependencyLogAt = 0;
let suppressedAuthDependencyLogs = 0;

function logAuthFailure(error) {
  const now = Date.now();
  const isDependencyFailure = Number(error?.status) === 503;

  if (isDependencyFailure && now - lastAuthDependencyLogAt < 15000) {
    suppressedAuthDependencyLogs += 1;
    return;
  }

  if (suppressedAuthDependencyLogs > 0) {
    console.warn(
      `[requireAuth] suppressed ${suppressedAuthDependencyLogs} repeated dependency errors.`,
    );
    suppressedAuthDependencyLogs = 0;
  }

  if (isDependencyFailure) {
    lastAuthDependencyLogAt = now;
    console.warn(
      "[requireAuth] authentication data service temporarily unavailable:",
      error?.cause?.message || error?.message || String(error),
    );
    return;
  }

  console.error("[requireAuth] error:", error?.message || String(error));
}

/*
 * Viewers are read-only on the server, not just in the UI.
 *
 * The dashboard greys out controls for a Viewer, but a greyed-out button is a
 * courtesy; anyone can replay a request with their token. Every authenticated
 * route passes through requireAuth, so the rule lives here once: a Viewer may
 * read anything their workspace can read, and may only write to their own
 * account (password, their own devices, sign-out), mark notifications read,
 * talk to the help assistant and record product-tour progress.
 */
const VIEWER_WRITE_ALLOWED_PREFIXES = [
  "/api/auth/",
  "/api/notifications",
  "/api/platform-assistant",
  "/api/tour",
];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isViewerWriteBlocked(req) {
  if (req.user?.role !== "Viewer") return false;
  if (SAFE_METHODS.has(String(req.method || "GET").toUpperCase())) return false;
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return !VIEWER_WRITE_ALLOWED_PREFIXES.some((prefix) =>
    path.startsWith(prefix),
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      error: { message: "Authentication required.", code: "AUTH_REQUIRED" },
    });
  }

  try {
    const session = await resolveSession(token);
    if (!session) {
      return res.status(401).json({
        error: {
          message: "Invalid or expired session. Please log in again.",
          code: "AUTH_SESSION_INVALID",
        },
      });
    }
    req.authToken = token;
    req.user = session.user;
    req.organization = session.organization;
    req.orgId = session.organization.id;
    /*
     * The auth_sessions row behind this request, so POST /api/auth/logout can
     * revoke exactly this session and leave the user's other devices alone.
     * Undefined for tokens minted before the V1 auth migration; those carry no
     * session row and simply cannot be revoked, which is what they did before.
     */
    req.sessionId = session.sessionId || null;
    res.setHeader("Cache-Control", "no-store");
    if (isViewerWriteBlocked(req)) {
      return res.status(403).json({
        error: {
          code: "VIEWER_READ_ONLY",
          message:
            "Your Viewer role is read-only. Ask the account owner to make this change.",
        },
      });
    }
    next();
  } catch (error) {
    logAuthFailure(error);
    const status = Number(error?.status) === 503 ? 503 : 500;
    if (status === 503) res.setHeader("Retry-After", "5");
    return res.status(status).json({
      error: {
        message:
          status === 503
            ? "Agently could not reach the account data service. Your session is still valid; please retry."
            : "Authentication service error.",
        code:
          status === 503 ? "AUTH_DEPENDENCY_UNAVAILABLE" : "AUTH_SERVICE_ERROR",
        retryable: status === 503,
      },
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !["Owner", "Admin"].includes(req.user.role)) {
    return res
      .status(403)
      .json({ error: { message: "Admin access required." } });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== "Owner") {
    return res
      .status(403)
      .json({ error: { message: "Owner access required." } });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireOwner,
  isViewerWriteBlocked,
};
