"use strict";

/**
 * ============================================================
 * lib/webcall-auth.js
 * ============================================================
 * Verifies the short-lived webcall session token issued by
 * agently-server (which signs it with jsonwebtoken using HS256).
 *
 * IMPORTANT: this uses ONLY Node's built-in `crypto` — no
 * `jsonwebtoken` dependency. An earlier version required
 * jsonwebtoken, which is not installed in this service's
 * node_modules; if the deploy didn't run `npm install`, that
 * missing module crashed the whole ws-server on boot (taking
 * down phone calls too). Depending only on built-ins removes
 * that entire failure mode.
 *
 * HS256 JWT = base64url(header).base64url(payload).base64url(HMAC_SHA256).
 * We recompute the HMAC with JWT_SECRET and compare in constant time,
 * then check exp and the webcall purpose/claims.
 * ============================================================
 */

const crypto = require("crypto");

function getJwtSecret() {
  return (process.env.JWT_SECRET || "").trim();
}

function base64UrlDecode(str) {
  const pad = 4 - (str.length % 4 || 4);
  const b64 =
    str.replace(/-/g, "+").replace(/_/g, "/") + (pad < 4 ? "=".repeat(pad) : "");
  return Buffer.from(b64, "base64");
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verifies a webcall session token (HS256 JWT).
 * Returns the decoded payload on success, or null on any failure
 * (missing secret, bad signature, expired, malformed, wrong purpose).
 */
function verifyWebcallToken(token) {
  const secret = getJwtSecret();
  if (!secret || !token) return null;

  try {
    const parts = String(token).trim().split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature.
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    if (!timingSafeEqualStr(signatureB64, expectedSig)) return null;

    // Confirm HS256 header (reject "alg":"none" and other algorithms).
    const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    if (!header || header.alg !== "HS256") return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
    if (!payload) return null;

    // Expiry (exp is in seconds).
    if (payload.exp && Date.now() / 1000 > Number(payload.exp)) return null;

    if (payload.purpose !== "webcall") return null;
    if (!payload.orgId || !payload.agentId) return null;

    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = { verifyWebcallToken };
