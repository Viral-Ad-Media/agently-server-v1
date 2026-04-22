"use strict";

const { resolveSession } = require("../lib/auth");

/**
 * Middleware: requires a valid Bearer token.
 * Attaches req.user, req.organization, req.orgId on success.
 */
async function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token) {
    return res
      .status(401)
      .json({ error: { message: "Authentication required." } });
  }

  try {
    const session = await resolveSession(token);
    if (!session) {
      return res.status(401).json({
        error: {
          message: "Invalid or expired session. Please log in again.",
        },
      });
    }
    req.user = session.user;
    req.organization = session.organization;
    req.orgId = session.organization.id;
    next();
  } catch (err) {
    console.error("[requireAuth] error:", err.message);
    return res
      .status(500)
      .json({ error: { message: "Authentication service error." } });
  }
}

/**
 * Middleware: requires Owner or Admin role.
 * Must be used after requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user || !["Owner", "Admin"].includes(req.user.role)) {
    return res
      .status(403)
      .json({ error: { message: "Admin access required." } });
  }
  next();
}

/**
 * Middleware: requires Owner role only.
 * Must be used after requireAuth.
 */
function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== "Owner") {
    return res
      .status(403)
      .json({ error: { message: "Owner access required." } });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireOwner };
