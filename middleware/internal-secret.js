"use strict";

/**
 * Shared-secret guard for /api/internal/* routes called by the ws-server.
 * INTERNAL_API_SECRET must be set on both containers; missing -> 503 (fail
 * closed). Constant-time compare, since the header is attacker-controlled.
 */
const INTERNAL_HEADER = "x-agently-internal-secret";

function requireInternalSecret(req, res, next) {
  const expected = String(process.env.INTERNAL_API_SECRET || "");
  if (!expected) {
    return res.status(503).json({
      error: {
        code: "internal_not_configured",
        message: "Calendar booking is not configured on the API server.",
      },
    });
  }
  const provided = String(req.headers[INTERNAL_HEADER] || "");
  if (!provided || provided.length !== expected.length) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } });
  }
  // Constant-time compare: the header value is attacker-controlled.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } });
  }
  next();
}

module.exports = { requireInternalSecret, INTERNAL_HEADER };
