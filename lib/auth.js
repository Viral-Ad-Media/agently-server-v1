'use strict';

const jwt = require('jsonwebtoken');
const { getSupabase } = require('./supabase');

const JWT_SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET environment variable is required.');
  return s;
};

const JWT_EXPIRES_IN = '30d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET());
  } catch {
    return null;
  }
}

/**
 * Resolve a bearer token to { user, organization }.
 * Returns null if invalid/expired.
 */
async function resolveSession(token) {
  if (!token) return null;

  // Dev seed token shortcut (local dev only)
  if (process.env.NODE_ENV !== 'production' && token === process.env.DEV_SEED_TOKEN) {
    return getDevSeedSession();
  }

  const payload = verifyToken(token);
  if (!payload || !payload.userId) return null;

  const db = getSupabase();

  const { data: user, error: userErr } = await db
    .from('users')
    .select('id, name, email, role, avatar, organization_id')
    .eq('id', payload.userId)
    .single();

  if (userErr || !user) return null;

  const { data: org, error: orgErr } = await db
    .from('organizations')
    .select('*')
    .eq('id', user.organization_id)
    .single();

  if (orgErr || !org) return null;

  return { user, organization: org };
}

async function getDevSeedSession() {
  // Returns first user/org in DB for local dev
  const db = getSupabase();
  const { data: user } = await db
    .from('users')
    .select('id, name, email, role, avatar, organization_id')
    .limit(1)
    .single();

  if (!user) return null;

  const { data: org } = await db
    .from('organizations')
    .select('*')
    .eq('id', user.organization_id)
    .single();

  return org ? { user, organization: org } : null;
}

module.exports = { signToken, verifyToken, resolveSession };
