"use strict";

const jwt = require("jsonwebtoken");
const { getSupabase } = require("./supabase");

const JWT_EXPIRES_IN = "30d";

function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET is not set. Check your .env file.");
  return secret;
}

/**
 * Signs a JWT with the user's id and org id.
 */
function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verifies a JWT and returns the decoded payload, or null if invalid.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

/**
 * Resolves a token into a full { user, organization } session.
 * Returns null for any invalid/expired token.
 */
async function resolveSession(token) {
  if (!token) return null;

  // Dev shortcut — lets you bypass auth in local dev
  if (
    process.env.NODE_ENV !== "production" &&
    token === (process.env.DEV_SEED_TOKEN || "").trim()
  ) {
    return getDevSeedSession();
  }

  const payload = verifyToken(token);
  if (!payload || !payload.userId) return null;

  const db = getSupabase();

  const { data: user, error: userErr } = await db
    .from("users")
    .select("id, name, email, role, avatar, organization_id")
    .eq("id", payload.userId)
    .single();

  if (userErr || !user) return null;

  const { data: org, error: orgErr } = await db
    .from("organizations")
    .select("*")
    .eq("id", user.organization_id)
    .single();

  if (orgErr || !org) return null;

  return { user, organization: org };
}

/**
 * Used in local dev when DEV_SEED_TOKEN is passed.
 * Returns the first user/org in the database.
 */
async function getDevSeedSession() {
  const db = getSupabase();

  const { data: user } = await db
    .from("users")
    .select("id, name, email, role, avatar, organization_id")
    .limit(1)
    .single();

  if (!user) return null;

  const { data: org } = await db
    .from("organizations")
    .select("*")
    .eq("id", user.organization_id)
    .single();

  if (!org) return null;

  return { user, organization: org };
}

module.exports = { signToken, verifyToken, resolveSession };
