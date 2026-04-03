'use strict';

const { resolveSession } = require('../lib/auth');

/**
 * Require authentication. Attaches req.user and req.organization.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required.' } });
  }

  try {
    const session = await resolveSession(token);
    if (!session) {
      return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    }

    req.user = session.user;
    req.organization = session.organization;
    req.orgId = session.organization.id;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    return res.status(500).json({ error: { message: 'Authentication service error.' } });
  }
}

/**
 * Require Owner or Admin role.
 */
function requireAdmin(req, res, next) {
  if (!req.user || !['Owner', 'Admin'].includes(req.user.role)) {
    return res.status(403).json({ error: { message: 'Admin access required.' } });
  }
  next();
}

/**
 * Require Owner role only.
 */
function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'Owner') {
    return res.status(403).json({ error: { message: 'Owner access required.' } });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireOwner };
