"use strict";

/**
 * Calendar integrations: per-tenant OAuth for Google Calendar and Calendly.
 *
 * ROUTES
 *
 *   GET    /api/integrations/status                         (auth)  connection list
 *   GET    /api/integrations/connections                    (auth)  one row per connected account
 *   PATCH  /api/integrations/connections/:id                (admin) rename a connection
 *   PUT    /api/integrations/connections/:id/booking-default(admin) choose the booking target
 *   POST   /api/integrations/connections/:id/disconnect     (admin) revoke + delete one account
 *   GET    /api/integrations/bookings                       (auth)  MERGED feed, all accounts
 *   POST   /api/integrations/:provider/start-token          (admin) mint a 2-min start token
 *   GET    /api/integrations/:provider/start?st=...         (token) begin OAuth (302 to provider)
 *   GET    /api/integrations/:provider/callback             (public*) provider redirect
 *   GET    /api/integrations/:provider/options              (auth)  calendars / event types
 *   PUT    /api/integrations/:provider/selection            (admin) choose calendar / event type
 *   POST   /api/integrations/:provider/disconnect           (admin) revoke + delete
 *
 * MULTI-ACCOUNT. One Agently login can run several businesses, each with its
 * own Google account, so calendar_integrations holds one row per connected
 * ACCOUNT — keyed on (organization_id, provider, provider_user_id) — not one
 * per provider. The /connections/* routes address a connection by id; the
 * older /:provider/* routes act on that provider's booking default and accept
 * an optional connectionId to name a specific account instead.
 *
 * Every handler scopes by req.orgId, which comes from the verified session.
 * No handler accepts an organization id from the client. The five calendar
 * tables are RLS-enabled with ZERO policies and this API uses the service
 * role, so those application-level filters are the whole of the tenant
 * boundary — see lib/calendar-tokens.js getConnectionById.
 *
 * The SPA cannot send its Authorization header on a full-page navigation, so
 * /start does not use requireAuth: the frontend first POSTs to /start-token
 * (authenticated) and navigates to the returned URL carrying the short-lived,
 * HMAC-signed, org-bound start token. The session token never appears in a URL.
 *
 * * The callback is intentionally unauthenticated: the OAuth provider
 * redirects the user's browser here without the API's Authorization header
 * (the SPA keeps its session token in memory, not a cookie). Authentication
 * comes from the signed `state` parameter instead: it is HMAC-signed with a
 * server-derived key, binds the organization id, expires in 10 minutes, and
 * its nonce must match the httpOnly SameSite=Lax cookie set at /start time
 * (the browser that started the flow). An attacker cannot forge state for a
 * victim's org without the server secret, and cannot replay a stolen
 * authorization code without the victim's cookie.
 *
 * SETUP (environment)
 *
 *   CALENDAR_TOKEN_KEY            64 hex chars — encrypts stored tokens (required)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   INTEGRATIONS_GOOGLE_REDIRECT_URI  e.g. https://api.example.com/api/integrations/google/callback
 *   CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET
 *   INTEGRATIONS_CALENDLY_REDIRECT_URI
 *
 * Register the redirect URIs in Google Cloud Console and in the Calendly
 * OAuth app respectively. Until Google's sensitive-scope verification
 * completes, the Google app stays in Testing mode (100 test users, 7-day
 * refresh tokens) — fine for development and beta.
 */

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { buildAppUrl, isProductionRuntime } = require("../../lib/app-url");
const {
  isEncryptionConfigured,
  keySetupHelp,
  encryptSecret,
  decryptSecret,
} = require("../../lib/crypto");
const {
  getConnection,
  getConnectionById,
  listConnections,
  saveConnection,
  setBookingDefault,
  renameConnection,
  promoteBookingDefault,
} = require("../../lib/calendar-tokens");
const {
  setupConnectionSync,
  teardownConnectionSync,
} = require("../../lib/calendar-sync");
const {
  invalidateAvailabilityCache,
  listMergedBookings,
} = require("../../lib/calendar-booking");

const router = express.Router();

const STATE_TTL_MS = 10 * 60 * 1000;
const NONCE_COOKIE_PREFIX = "agently_oauth_";

const GOOGLE_SCOPES = [
  // Identity: the callback reads the Google account's profile (userinfo) to
  // show which account is connected. These are non-sensitive basic scopes.
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
  // Read-only list of the account's calendars, so the tenant can pick which
  // one the agent books into. Without it, calendarList answers 403 and the
  // picker in Settings has nothing to show — booking still works, but only
  // ever against "primary". This grants the names of calendars, not their
  // contents; reading availability is calendar.freebusy above.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");

// Minimum for the agent: read event types + availability, book/cancel, webhooks.
const CALENDLY_SCOPES = [
  "users:read",
  "event_types:read",
  "availability:read",
  "scheduled_events:read",
  "scheduled_events:write",
  "webhooks:write",
].join(" ");

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function base64urlDecode(value) {
  return Buffer.from(String(value), "base64url").toString("utf8");
}

/**
 * Server key for signing OAuth state, derived from the token-encryption key
 * so no extra secret needs provisioning. Unavailable until CALENDAR_TOKEN_KEY
 * is set — the /start route refuses to run before that.
 */
function stateSigningKey() {
  const hex = String(process.env.CALENDAR_TOKEN_KEY || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return crypto.createHmac("sha256", Buffer.from(hex, "hex")).update("oauth-state-v1").digest();
}

function signState(payload) {
  const key = stateSigningKey();
  if (!key) throw new Error(keySetupHelp());
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", key).update(body).digest("hex");
  return `${body}.${sig}`;
}

function verifyState(state) {
  const key = stateSigningKey();
  if (!key) throw new Error(keySetupHelp());
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", key).update(body).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  // timingSafeEqual throws on length mismatch — a forged sig is just invalid.
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch (_) {
    return null;
  }
  if (!payload || !payload.orgId || !payload.provider || !payload.nonce) return null;
  if (Date.now() > Number(payload.exp || 0)) return null;
  return payload;
}

/**
 * PKCE (RFC 7636, S256) for the authorization-code flow. The verifier never
 * travels in the clear: it is AES-256-GCM encrypted with the calendar token
 * key (tenant-bound AAD) and only the ciphertext rides inside the signed
 * `state`. The challenge goes to the provider; the verifier is decrypted and
 * presented at the token endpoint.
 */
function generateCodeVerifier() {
  return base64urlEncode(crypto.randomBytes(32)); // 43 chars, within RFC 7636
}

function codeChallengeFor(verifier) {
  return base64urlEncode(crypto.createHash("sha256").update(verifier, "utf8").digest());
}

const PKCE_CONNECTION_ID = "oauth-pkce";

function sealCodeVerifier(verifier, orgId, provider) {
  const envelope = encryptSecret(verifier, {
    organizationId: String(orgId),
    provider,
    connectionId: PKCE_CONNECTION_ID,
  });
  return base64urlEncode(Buffer.from(envelope, "utf8"));
}

function openCodeVerifier(sealed, orgId, provider) {
  const envelope = base64urlDecode(sealed);
  return decryptSecret(envelope, {
    organizationId: String(orgId),
    provider,
    connectionId: PKCE_CONNECTION_ID,
  });
}

function getProviderConfig(provider) {
  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.INTEGRATIONS_GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      const error = new Error(
        "Google Calendar integration is not configured. Set GOOGLE_CLIENT_ID, " +
          "GOOGLE_CLIENT_SECRET and INTEGRATIONS_GOOGLE_REDIRECT_URI.",
      );
      error.status = 503;
      error.code = "provider_not_configured";
      throw error;
    }
    return { provider, clientId, clientSecret, redirectUri };
  }
  if (provider === "calendly") {
    const clientId = process.env.CALENDLY_CLIENT_ID;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
    const redirectUri = process.env.INTEGRATIONS_CALENDLY_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      const error = new Error(
        "Calendly integration is not configured. Set CALENDLY_CLIENT_ID, " +
          "CALENDLY_CLIENT_SECRET and INTEGRATIONS_CALENDLY_REDIRECT_URI.",
      );
      error.status = 503;
      error.code = "provider_not_configured";
      throw error;
    }
    return { provider, clientId, clientSecret, redirectUri };
  }
  const error = new Error(`Unknown calendar provider: ${provider}`);
  error.status = 400;
  error.code = "unknown_provider";
  throw error;
}

function getCookie(req, name) {
  // Tiny cookie parser for the single OAuth nonce cookie — avoids adding a
  // dependency for one value. The nonce is hex, so no decoding edge cases.
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function settingsRedirect(params) {
  const query = new URLSearchParams(params).toString();
  return `${buildAppUrl("/integrations")}?${query}`;
}

function setNonceCookie(res, provider, nonce) {
  res.cookie(`${NONCE_COOKIE_PREFIX}${provider}`, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProductionRuntime(),
    path: "/api/integrations",
    maxAge: STATE_TTL_MS,
  });
}

function clearNonceCookie(res, provider) {
  res.clearCookie(`${NONCE_COOKIE_PREFIX}${provider}`, { path: "/api/integrations" });
}

function buildAuthorizeUrl(provider, config, state, codeChallenge) {
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline", // ask for a refresh token
      /*
       * "select_account consent" rather than "consent".
       *
       * This is what makes "Add another account" work. With "consent" alone
       * Google silently reuses whichever account the browser is already
       * signed in to, so a tenant adding their second business's Gmail would
       * be sent straight back with the SAME provider_user_id — a reconnect of
       * the account they already had, not a new connection, and no amount of
       * correctness in saveConnection could tell the difference. The account
       * chooser is the only place that decision can be made. "consent" stays
       * alongside it so offline access is still granted on every run.
       */
      prompt: "select_account consent",
      include_granted_scopes: "false",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: CALENDLY_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `https://auth.calendly.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCode(provider, config, code, codeVerifier) {
  let response;
  if (provider === "google") {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      }).toString(),
    });
  } else {
    response = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: config.redirectUri,
      }),
    });
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = null;
  }
  if (!response.ok || !body || !body.access_token) {
    const error = new Error(
      `${provider} authorization failed (HTTP ${response.status}). ` +
        "The connection was not saved.",
    );
    error.status = 502;
    error.code = "oauth_exchange_failed";
    error.providerDetail = body && (body.error_description || body.error);
    throw error;
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    scopes: body.scope || null,
  };
}

async function fetchProviderIdentity(provider, accessToken) {
  if (provider === "google") {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const error = new Error("Could not read the Google account profile.");
      error.status = 502;
      throw error;
    }
    const profile = await response.json();
    return {
      providerUserId: profile.sub || null,
      providerUserEmail: profile.email || null,
      providerUserName: profile.name || null,
      timezone: null,
    };
  }
  const response = await fetch("https://api.calendly.com/users/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const error = new Error("Could not read the Calendly user profile.");
    error.status = 502;
    throw error;
  }
  const { resource } = await response.json();
  return {
    providerUserId: resource.uri || null,
    providerUserEmail: resource.email || null,
    providerUserName: resource.name || null,
    timezone: resource.timezone || null,
  };
}

async function revokeProviderToken(provider, config, token) {
  try {
    if (provider === "google") {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    } else {
      await fetch("https://auth.calendly.com/oauth/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify({ token }),
      });
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Short-lived token that authorizes one OAuth start redirect. The SPA cannot
 * send its Authorization header on a full-page navigation, so the frontend
 * fetches this token via authenticated POST and appends it to the /start
 * URL. It is HMAC-signed, bound to the org, expires in 2 minutes, and its
 * nonce is consumed in the database at /start time — replaying the URL a
 * second time is rejected. Far less sensitive than the session token, which
 * never appears in a URL. (Replay of an unused token would only restart the
 * same org's flow; the callback still requires the browser's nonce cookie.)
 */
function signStartToken({ orgId, userId, provider }) {
  return signState({
    kind: "start",
    orgId,
    userId,
    provider,
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + 2 * 60 * 1000,
  });
}

function verifyStartToken(token, provider) {
  const payload = verifyState(token);
  if (!payload || payload.kind !== "start" || payload.provider !== provider) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const connections = await listConnections(db, req.orgId);
    res.json({
      encryptionConfigured: isEncryptionConfigured(),
      encryptionHelp: isEncryptionConfigured() ? null : keySetupHelp(),
      googleConfigured: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.INTEGRATIONS_GOOGLE_REDIRECT_URI,
      ),
      calendlyConfigured: Boolean(
        process.env.CALENDLY_CLIENT_ID && process.env.INTEGRATIONS_CALENDLY_REDIRECT_URI,
      ),
      connections,
    });
  }),
);

// ---------------------------------------------------------------------------
// Connections (multi-account)
// ---------------------------------------------------------------------------
//
// One Agently login runs several businesses, each with its own Google
// account, so these routes address a CONNECTION by id rather than a provider
// by name. They are registered before the /:provider/* routes so a literal
// "connections" or "bookings" path segment can never be read as a provider.
//
// EVERY handler here re-scopes by req.orgId. The connection id arrives from
// the client, the five calendar tables are RLS-enabled with zero policies,
// and the API is the service role — so the organization filter in
// lib/calendar-tokens.js is the only thing between a guessed uuid and another
// tenant's calendar. No handler reads an organization id from the request
// body, query or params; req.orgId comes from the verified session and
// nothing else.

/**
 * GET /api/integrations/connections
 * The tenant-facing list: label, email, provider, booking default.
 */
router.get(
  "/connections",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    /*
     * The lighter camelCase summary shape (CalendarConnectionSummary in
     * services/api.ts) plus the few extras a connection card shows.
     * /status returns the raw snake_case rows AND the provider/encryption
     * flags in one round trip, which is what the Integrations page uses; this
     * route is for callers that want only the accounts.
     */
    const connections = await listConnections(db, req.orgId);
    res.json({
      connections: connections.map((row) => ({
        ...connectionSummary(row),
        name: row.provider_user_name || null,
        calendarId: row.calendar_id || null,
        eventTypeName: row.event_type_name || null,
        timezone: row.timezone || null,
        lastError: row.last_error || null,
        connectedAt: row.connected_at,
      })),
      bookingDefaultId: (connections.find((row) => row.is_booking_default) || {}).id || null,
    });
  }),
);

/**
 * PATCH /api/integrations/connections/:connectionId
 * Rename a connection ("Nutra Wellness"). Cosmetic only.
 */
router.patch(
  "/connections/:connectionId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const label = req.body && req.body.label;
    if (label === undefined) {
      return res.status(400).json({
        error: { code: "missing_label", message: "label is required." },
      });
    }
    const db = getSupabase();
    let updated;
    try {
      updated = await renameConnection(db, req.orgId, req.params.connectionId, label);
    } catch (error) {
      if (error.code === "invalid_label") {
        return res.status(400).json({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
    if (!updated) return res.status(404).json(connectionNotFound());
    res.json({ connection: connectionSummary(updated) });
  }),
);

/**
 * PUT /api/integrations/connections/:connectionId/booking-default
 * Choose which connection the voice agent books into (design point 5).
 *
 * PUT rather than POST: it sets a value rather than creating anything, and
 * sending it twice is the same as sending it once. The response describes only
 * the connection that WON — setting a default also clears the previous one, so
 * a client holding a list has to re-read it rather than flip a flag locally.
 */
router.put(
  "/connections/:connectionId/booking-default",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const target = await getConnectionById(db, req.orgId, req.params.connectionId);
    if (!target) return res.status(404).json(connectionNotFound());
    if (target.status === "disconnected") {
      return res.status(409).json({
        error: {
          code: "not_connected",
          message: "That connection is disconnected, so the agent cannot book into it.",
        },
      });
    }
    const updated = await setBookingDefault(db, req.orgId, target.id);
    // Availability is cached per organization and the booking target drives
    // the slot grid, so the cache is stale the moment this changes.
    invalidateAvailabilityCache(req.orgId);
    res.json({ connection: connectionSummary(updated || target) });
  }),
);

/**
 * POST /api/integrations/connections/:connectionId/disconnect
 * Remove ONE account: revoke at the provider, delete the row, and promote
 * another connection if this one was the booking default (design point 7).
 */
router.post(
  "/connections/:connectionId/disconnect",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const row = await getConnectionById(db, req.orgId, req.params.connectionId);
    if (!row) return res.status(404).json(connectionNotFound());

    const config = getProviderConfig(row.provider);
    const revoked = await revokeAndDelete(db, req.orgId, row, config);
    if (revoked.error) return res.status(revoked.status).json({ error: revoked.error });

    // Point 7: the organization must still have somewhere to book.
    const promoted = await promoteBookingDefault(db, req.orgId);
    invalidateAvailabilityCache(req.orgId);
    // promotedConnectionId names the replacement, or is null when nothing
    // needed promoting, so the caller never has to guess.
    res.json({
      disconnected: true,
      provider: row.provider,
      connectionId: row.id,
      promotedConnectionId: promoted && promoted.id !== row.id ? promoted.id : null,
    });
  }),
);

/**
 * GET /api/integrations/bookings
 * The merged feed: every appointment across all of this organization's
 * connections, each labelled with its connection (design point 6).
 *
 * Scoped to req.orgId. An organizationId in the query string is ignored
 * rather than honoured — see listMergedBookings.
 */
router.get(
  "/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const result = await listMergedBookings(
      req.orgId,
      {
        from: req.query.from || null,
        to: req.query.to || null,
        status: req.query.status || null,
        connectionId: req.query.connectionId || null,
        limit: req.query.limit ? Number(req.query.limit) : 200,
      },
      db,
    );
    res.json(result);
  }),
);

/**
 * Which connection a provider-shaped route is talking about.
 *
 * The picker, the selection and the booking-settings routes predate
 * multi-account and address a provider by name. A tenant with two Google
 * accounts has to be able to configure each, so they now accept an optional
 * connectionId — resolved through getConnectionById, which re-scopes by
 * organization, so a foreign id is a 404 and never another tenant's row.
 * Without one they fall back to the provider's booking default, which is what
 * the single-account case always meant.
 */
async function resolveProviderConnection(db, organizationId, provider, connectionId) {
  if (connectionId) {
    const row = await getConnectionById(db, organizationId, connectionId);
    if (!row || row.provider !== provider) return null;
    return row;
  }
  return getConnection(db, organizationId, provider);
}

function connectionNotFound() {
  return {
    error: {
      code: "connection_not_found",
      message: "That calendar connection does not belong to this business.",
    },
  };
}

/**
 * CalendarConnectionSummary: the small camelCase shape the per-connection
 * routes answer with. An explicit whitelist, never a spread — the row it is
 * built from carries the token ciphertext, and a spread would publish it the
 * first time someone passed a full row in by mistake.
 */
function connectionSummary(row) {
  return {
    id: row.id,
    provider: row.provider,
    // Never blank, so a connection card always has a name to show.
    label: row.label || row.provider_user_email || row.provider,
    email: row.provider_user_email || null,
    status: row.status,
    isBookingDefault: Boolean(row.is_booking_default),
  };
}

/**
 * Revoke a connection's grant at the provider, tear down its sync hooks, and
 * delete the row. Shared by the per-connection and per-provider disconnect
 * routes so both behave identically: the row survives a failed revocation,
 * so the tenant can retry rather than being left with a live grant that
 * Agently no longer tracks.
 */
async function revokeAndDelete(db, organizationId, row, config) {
  let tokenToRevoke = null;
  try {
    if (row.refresh_token_encrypted) {
      tokenToRevoke = decryptSecret(row.refresh_token_encrypted, {
        organizationId: row.organization_id,
        provider: row.provider,
        connectionId: row.id,
      });
    }
  } catch (_) {
    tokenToRevoke = null;
  }
  if (tokenToRevoke) {
    const revoked = await revokeProviderToken(row.provider, config, tokenToRevoke);
    if (!revoked) {
      return {
        status: 502,
        error: {
          code: "revoke_failed",
          message: `Could not revoke the ${row.provider} grant. The connection was kept so you can retry.`,
        },
      };
    }
  }

  // Best-effort: stop the webhook / push channel. Runs before the delete
  // because teardown may need to refresh the access token.
  await teardownConnectionSync(db, organizationId, row.provider, row);

  const { error } = await db
    .from("calendar_integrations")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", row.id);
  if (error) throw error;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// OAuth start / callback
// ---------------------------------------------------------------------------

router.post(
  "/:provider/start-token",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    getProviderConfig(provider); // throws 400/503 when misconfigured
    if (!isEncryptionConfigured()) {
      return res.status(503).json({
        error: { code: "encryption_not_configured", message: keySetupHelp() },
      });
    }
    const token = signStartToken({
      orgId: req.orgId,
      userId: req.user && req.user.id,
      provider,
    });
    res.json({ url: `/api/integrations/${provider}/start?st=${encodeURIComponent(token)}` });
  }),
);

router.get(
  "/:provider/start",
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const config = getProviderConfig(provider); // throws 400/503 when misconfigured
    if (!isEncryptionConfigured()) {
      return res.status(503).json({
        error: { code: "encryption_not_configured", message: keySetupHelp() },
      });
    }
    const payload = verifyStartToken(req.query.st, provider);
    if (!payload) {
      return res.status(401).json({
        error: {
          code: "invalid_start_token",
          message: "This connection link expired or is invalid. Please start again from Settings.",
        },
      });
    }
    // True single-use: consume the start-token nonce. A replayed URL is
    // rejected even within the 2-minute window, on every API instance.
    const db = getSupabase();
    const { error: nonceError } = await db.from("oauth_start_nonces").insert({
      nonce: payload.nonce,
      organization_id: payload.orgId,
      provider,
    });
    if (nonceError) {
      const alreadyUsed = nonceError.code === "23505";
      return res.status(alreadyUsed ? 401 : 503).json({
        error: {
          code: alreadyUsed ? "start_token_reused" : "start_token_failed",
          message: alreadyUsed
            ? "This connection link was already used. Please start again from Settings."
            : "Could not start the connection. Please try again.",
        },
      });
    }
    // Opportunistic prune; nonces expire after 2 minutes anyway.
    await db
      .from("oauth_start_nonces")
      .delete()
      .lt("consumed_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    const nonce = crypto.randomBytes(16).toString("hex");
    const codeVerifier = generateCodeVerifier();
    const state = signState({
      kind: "oauth",
      orgId: payload.orgId,
      userId: payload.userId,
      provider,
      nonce,
      pkce: sealCodeVerifier(codeVerifier, payload.orgId, provider),
      exp: Date.now() + STATE_TTL_MS,
    });
    setNonceCookie(res, provider, nonce);
    res.redirect(buildAuthorizeUrl(provider, config, state, codeChallengeFor(codeVerifier)));
  }),
);

router.get(
  "/:provider/callback",
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const fail = (code, message) => {
      clearNonceCookie(res, provider);
      return res.redirect(settingsRedirect({ error: code, message }));
    };

    let config;
    try {
      config = getProviderConfig(provider);
    } catch (error) {
      return fail("provider_not_configured", error.message);
    }

    const payload = verifyState(req.query.state);
    if (!payload || payload.kind !== "oauth" || payload.provider !== provider) {
      return fail("invalid_state", "The connection request expired or was tampered with. Please try again.");
    }
    const cookieNonce = getCookie(req, `${NONCE_COOKIE_PREFIX}${provider}`);
    if (!cookieNonce || cookieNonce !== payload.nonce) {
      return fail("invalid_state", "The connection request did not come from your browser session. Please try again.");
    }
    clearNonceCookie(res, provider);

    if (req.query.error) {
      return fail(
        "access_denied",
        `The ${provider} connection was not granted (${req.query.error}).`,
      );
    }
    if (!req.query.code) {
      return fail("missing_code", `No authorization code returned from ${provider}.`);
    }

    // Confirm the org still exists before writing anything for it.
    const db = getSupabase();
    const { data: org, error: orgError } = await db
      .from("organizations")
      .select("id, timezone")
      .eq("id", payload.orgId)
      .maybeSingle();
    if (orgError || !org) {
      return fail("unknown_organization", "The business for this connection no longer exists.");
    }

    let codeVerifier;
    try {
      if (!payload.pkce) throw new Error("missing pkce");
      codeVerifier = openCodeVerifier(payload.pkce, payload.orgId, provider);
    } catch (_) {
      return fail("invalid_state", "The connection request expired or was tampered with. Please try again.");
    }

    let tokens;
    try {
      tokens = await exchangeCode(provider, config, req.query.code, codeVerifier);
    } catch (error) {
      return fail("exchange_failed", error.message);
    }

    let identity;
    try {
      identity = await fetchProviderIdentity(provider, tokens.accessToken);
    } catch (error) {
      return fail("identity_failed", error.message);
    }

    let connectionRow;
    try {
      connectionRow = await saveConnection(db, payload.orgId, provider, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        providerUserId: identity.providerUserId,
        providerUserEmail: identity.providerUserEmail,
        providerUserName: identity.providerUserName,
        timezone: identity.timezone || org.timezone || null,
      });
    } catch (error) {
      return fail("save_failed", error.message);
    }

    // Best-effort: subscribe to change notifications (Calendly webhooks /
    // Google push channels) so bookings made outside the call reconcile.
    // Never fails the connect.
    await setupConnectionSync(db, payload.orgId, provider, config, connectionRow);

    return res.redirect(
      settingsRedirect({ connected: provider }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Calendar / event-type picker
// ---------------------------------------------------------------------------

router.get(
  "/:provider/options",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const {
      getValidAccessToken,
      getValidAccessTokenForConnection,
    } = require("../../lib/calendar-tokens");
    const db = getSupabase();
    // ?connectionId= picks ONE of several accounts of this provider; without
    // it the provider's booking default is used, as before.
    let accessToken;
    let connection;
    if (req.query.connectionId) {
      const row = await getConnectionById(db, req.orgId, req.query.connectionId);
      if (!row || row.provider !== provider) {
        return res.status(404).json(connectionNotFound());
      }
      ({ accessToken, connection } = await getValidAccessTokenForConnection(row, db));
    } else {
      ({ accessToken, connection } = await getValidAccessToken(req.orgId, provider, db));
    }

    if (provider === "google") {
      const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        /*
         * Listing calendars needs calendar.calendarlist.readonly. Booking needs
         * only freebusy + events, so a connection made before that scope was
         * requested works perfectly and simply cannot enumerate calendars —
         * Google answers 403 insufficientPermissions.
         *
         * That is not a fault worth a 502. Booking already falls back to the
         * primary calendar, so the honest answer is "you are on primary,
         * reconnect if you want to choose" — not "Could not list Google
         * calendars", which reads as breakage and tells the tenant nothing
         * about what to do.
         */
        if (response.status === 403) {
          return res.json({
            options: [],
            selected: connection.calendar_id || "primary",
            needsReconnect: true,
            notice:
              "Bookings go to this account's primary calendar. To choose a " +
              "different one, disconnect and connect again — permission to " +
              "list your calendars is only granted at connect time.",
          });
        }
        const error = new Error("Could not list Google calendars.");
        error.status = 502;
        throw error;
      }
      const { items } = await response.json();
      return res.json({
        options: (items || [])
          .filter((cal) => cal.accessRole === "owner" || cal.accessRole === "writer")
          .map((cal) => ({ id: cal.id, name: cal.summary, primary: Boolean(cal.primary) })),
        selected: connection.calendar_id || "primary",
      });
    }

    // calendly
    const params = new URLSearchParams({ user: connection.provider_user_id, count: "100" });
    const response = await fetch(`https://api.calendly.com/event_types?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const error = new Error("Could not list Calendly event types.");
      error.status = 502;
      throw error;
    }
    const { collection } = await response.json();
    return res.json({
      options: (collection || [])
        .filter((et) => et.active)
        .map((et) => ({ id: et.uri, name: et.name, slug: et.slug })),
      selected: connection.event_type_uri || null,
    });
  }),
);

router.put(
  "/:provider/selection",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const db = getSupabase();
    const row = await resolveProviderConnection(db, req.orgId, provider, req.body && req.body.connectionId);
    if (!row) {
      return res.status(404).json({
        error: { code: "not_connected", message: `No ${provider} calendar connected.` },
      });
    }
    const updates = { updated_at: new Date().toISOString() };
    if (provider === "google") {
      if (!req.body.calendarId) {
        return res.status(400).json({
          error: { code: "missing_selection", message: "calendarId is required." },
        });
      }
      updates.calendar_id = String(req.body.calendarId);
    } else {
      if (!req.body.eventTypeUri) {
        return res.status(400).json({
          error: { code: "missing_selection", message: "eventTypeUri is required." },
        });
      }
      updates.event_type_uri = String(req.body.eventTypeUri);
      updates.event_type_name = req.body.eventTypeName ? String(req.body.eventTypeName) : null;
    }
    const { data, error } = await db
      .from("calendar_integrations")
      .update(updates)
      .eq("organization_id", req.orgId)
      .eq("id", row.id)
      .select(
        "id, provider, label, status, provider_user_email, calendar_id, event_type_uri, event_type_name, updated_at",
      )
      .single();
    if (error) throw error;
    res.json({ connection: data });
  }),
);

// ---------------------------------------------------------------------------
// Booking settings
// ---------------------------------------------------------------------------

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validate + normalize tenant booking settings. Returns { settings } or
 * { error }. Slot length / working hours / sendUpdates only apply to Google
 * (Calendly takes its duration from the event type); windowDays applies to
 * both. Unknown keys are dropped.
 */
function normalizeBookingSettings(provider, input) {
  const body = (input && typeof input === "object" ? input : {});
  const settings = {};

  if (body.slotMinutes !== undefined) {
    const n = Number(body.slotMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 180) {
      return { error: "slotMinutes must be a whole number of minutes between 5 and 180." };
    }
    if (provider === "google") settings.slotMinutes = n;
  }

  if (body.windowDays !== undefined) {
    const n = Number(body.windowDays);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return { error: "windowDays must be a whole number of days between 1 and 60." };
    }
    settings.windowDays = n;
  }

  if (body.workingHours !== undefined) {
    const wh = body.workingHours;
    if (!wh || typeof wh !== "object" || Array.isArray(wh)) {
      return { error: "workingHours must be an object keyed by weekday." };
    }
    const normalized = {};
    for (const day of WEEKDAYS) {
      const windows = wh[day];
      if (windows === undefined) continue;
      if (!Array.isArray(windows)) return { error: `workingHours.${day} must be an array.` };
      const clean = [];
      for (const w of windows) {
        if (!Array.isArray(w) || w.length !== 2 || !TIME_RE.test(w[0]) || !TIME_RE.test(w[1])) {
          return { error: `workingHours.${day} windows must be ["HH:MM","HH:MM"] pairs.` };
        }
        if (w[0] >= w[1]) return { error: `workingHours.${day} window ${w[0]}–${w[1]} ends before it starts.` };
        clean.push([w[0], w[1]]);
      }
      normalized[day] = clean;
    }
    if (provider === "google") settings.workingHours = normalized;
  }

  if (body.sendUpdates !== undefined) {
    if (body.sendUpdates !== "all" && body.sendUpdates !== "none") {
      return { error: 'sendUpdates must be "all" or "none".' };
    }
    if (provider === "google") settings.sendUpdates = body.sendUpdates;
  }

  return { settings };
}

router.put(
  "/:provider/booking-settings",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    if (provider !== "google" && provider !== "calendly") {
      return res.status(400).json({
        error: { code: "unknown_provider", message: `Unknown calendar provider: ${provider}` },
      });
    }
    const db = getSupabase();
    const row = await resolveProviderConnection(db, req.orgId, provider, req.body && req.body.connectionId);
    if (!row) {
      return res.status(404).json({
        error: { code: "not_connected", message: `No ${provider} calendar connected.` },
      });
    }
    const { settings, error } = normalizeBookingSettings(provider, req.body);
    if (error) {
      return res.status(400).json({ error: { code: "invalid_settings", message: error } });
    }
    const merged = { ...(row.booking_settings || {}), ...settings };
    const { data, error: updateError } = await db
      .from("calendar_integrations")
      .update({ booking_settings: merged, updated_at: new Date().toISOString() })
      .eq("organization_id", req.orgId)
      .eq("id", row.id)
      .select("id, provider, label, booking_settings, updated_at")
      .single();
    if (updateError) throw updateError;
    invalidateAvailabilityCache(req.orgId);
    res.json({ connection: data });
  }),
);

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

router.post(
  "/:provider/disconnect",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const config = getProviderConfig(provider);
    const db = getSupabase();
    const row = await getConnection(db, req.orgId, provider);
    if (!row) {
      return res.json({ disconnected: false, message: "Nothing was connected." });
    }

    /*
     * Revoke at the provider, tear down the sync hooks, delete the row —
     * shared with the per-connection route so the two cannot drift. The row
     * survives a failed revocation so the tenant can retry instead of
     * orphaning a live grant.
     *
     * This route removes ONE row: the booking default for the provider, or
     * its oldest healthy connection. A tenant with several accounts of the
     * same provider should use
     * POST /connections/:connectionId/disconnect, which names the account.
     */
    const outcome = await revokeAndDelete(db, req.orgId, row, config);
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

    // Point 7: if that was the booking default, promote another connection so
    // the agent still has somewhere to book.
    const promoted = await promoteBookingDefault(db, req.orgId);
    invalidateAvailabilityCache(req.orgId);
    res.json({
      disconnected: true,
      provider,
      connectionId: row.id,
      promotedConnectionId: promoted && promoted.id !== row.id ? promoted.id : null,
    });
  }),
);

module.exports = router;

// Exported for unit tests: the route handlers stay thin, the security logic
// (state signing, provider config, authorize URLs) is verifiable on its own.
module.exports._internals = {
  signState,
  verifyState,
  signStartToken,
  verifyStartToken,
  getCookie,
  getProviderConfig,
  buildAuthorizeUrl,
  exchangeCode,
  generateCodeVerifier,
  codeChallengeFor,
  sealCodeVerifier,
  openCodeVerifier,
  normalizeBookingSettings,
  STATE_TTL_MS,
};
