"use strict";

/**
 * Per-tenant OAuth token vault for calendar providers (google, calendly).
 *
 * WHAT IT DOES
 *
 * - Reads/writes calendar_integrations rows (service-role Supabase client).
 * - Encrypts tokens with lib/crypto.js (AES-256-GCM, bound to the tenant).
 * - Hands out a valid access token, refreshing proactively when the token is
 *   expiring within REFRESH_SKEW_MS. Calendly's refresh tokens are
 *   SINGLE-USE and rotating: every successful refresh revokes the old pair,
 *   so refresh is serialized per connection (in-process mutex) and the row is
 *   overwritten atomically in one UPDATE. A second concurrent refresh with the
 *   old token would kill the grant (invalid_grant) — that is the failure this
 *   module exists to prevent.
 * - On invalid_grant / 401 at refresh, marks the connection needs_reconnect so
 *   the dashboard can show a "Reconnect" banner instead of failing silently.
 *
 * SCOPE NOTE: the mutex here is in-process. That is correct for today's
 * single-container Lightsail deployment. If the API ever runs multiple
 * containers, replace the mutex with a Postgres advisory lock
 * (pg_advisory_xact_lock on the connection id) — the refresh function is
 * already isolated for that swap.
 *
 * Tokens never leave this module decrypted except to the immediate caller
 * (the booking code path). They are never logged, never put in prompts.
 */

const { getSupabase } = require("./supabase");
const crypto = require("crypto");
const {
  encryptSecret,
  decryptSecret,
  isEncryptionConfigured,
  keySetupHelp,
} = require("./crypto");

const PROVIDERS = ["google", "calendly"];
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh when <5min of life remains

// connectionId -> in-flight refresh promise. Prevents double refresh.
const refreshLocks = new Map();

function bindingFor(row) {
  return {
    organizationId: row.organization_id,
    provider: row.provider,
    connectionId: row.id,
  };
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    const error = new Error(`Unknown calendar provider: ${provider}`);
    error.code = "unknown_provider";
    error.status = 400;
    throw error;
  }
}

async function getConnection(supabase, organizationId, provider) {
  assertProvider(provider);
  const { data, error } = await supabase
    .from("calendar_integrations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listConnections(supabase, organizationId) {
  const { data, error } = await supabase
    .from("calendar_integrations")
    .select(
      "id, provider, status, provider_user_id, provider_user_email, provider_user_name, " +
        "calendar_id, event_type_uri, event_type_name, scopes, timezone, last_error, " +
        "connected_at, updated_at, expires_at, booking_settings",
    )
    .eq("organization_id", organizationId)
    .order("provider");
  if (error) throw error;
  return data || [];
}

function decryptTokens(row) {
  const binding = bindingFor(row);
  return {
    accessToken: row.access_token_encrypted
      ? decryptSecret(row.access_token_encrypted, binding)
      : null,
    refreshToken: row.refresh_token_encrypted
      ? decryptSecret(row.refresh_token_encrypted, binding)
      : null,
  };
}

function isExpiringSoon(row, now = Date.now()) {
  if (!row.expires_at) return true; // unknown expiry: refresh to be safe
  return new Date(row.expires_at).getTime() - now < REFRESH_SKEW_MS;
}

async function markNeedsReconnect(supabase, row, message) {
  await supabase
    .from("calendar_integrations")
    .update({
      status: "needs_reconnect",
      last_error: message,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
}

/**
 * Refresh one connection's token pair. Serialized per connection id.
 * Returns the updated row, or null when the grant died (row marked
 * needs_reconnect — the caller should surface "Reconnect" UI).
 */
async function refreshConnection(supabase, row) {
  const inFlight = refreshLocks.get(row.id);
  if (inFlight) return inFlight;

  const work = (async () => {
    const { refreshToken } = decryptTokens(row);
    if (!refreshToken) {
      await markNeedsReconnect(supabase, row, "No refresh token stored.");
      return null;
    }
    let refreshed;
    try {
      refreshed =
        row.provider === "google"
          ? await refreshGoogleToken(refreshToken)
          : await refreshCalendlyToken(refreshToken);
    } catch (error) {
      if (error.code === "invalid_grant") {
        await markNeedsReconnect(
          supabase,
          row,
          "The calendar connection was revoked or expired. Reconnect to restore booking.",
        );
        return null;
      }
      throw error;
    }

    const binding = bindingFor(row);
    const now = new Date().toISOString();
    // Atomic overwrite of BOTH tokens: Calendly revokes the old refresh token
    // on every use, so the pair must land together or not at all.
    const { data, error } = await supabase
      .from("calendar_integrations")
      .update({
        access_token_encrypted: encryptSecret(refreshed.accessToken, binding),
        // Some providers omit a new refresh token when the old one is
        // long-lived; Calendly always rotates, Google usually does not.
        refresh_token_encrypted: refreshed.refreshToken
          ? encryptSecret(refreshed.refreshToken, binding)
          : row.refresh_token_encrypted,
        expires_at: refreshed.expiresAt ? new Date(refreshed.expiresAt).toISOString() : null,
        status: "connected",
        last_error: null,
        updated_at: now,
      })
      .eq("id", row.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  })();

  refreshLocks.set(row.id, work);
  try {
    return await work;
  } finally {
    refreshLocks.delete(row.id);
  }
}

async function readTokenResponse(response, provider) {
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = null;
  }
  if (!response.ok) {
    const code =
      body && (body.error === "invalid_grant" || body.error_description === "invalid_grant")
        ? "invalid_grant"
        : `${provider}_token_error`;
    const error = new Error(
      `${provider} token request failed (HTTP ${response.status}): ` +
        (body && (body.error_description || body.error)) || text.slice(0, 200),
    );
    error.code = code;
    error.status = response.status;
    throw error;
  }
  if (!body || !body.access_token) {
    const error = new Error(`${provider} token response had no access_token.`);
    error.code = `${provider}_token_error`;
    throw error;
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    scope: body.scope || null,
  };
}

async function refreshGoogleToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  return readTokenResponse(response, "google");
}

async function refreshCalendlyToken(refreshToken) {
  const clientId = process.env.CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET are not configured.");
  }
  const response = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  return readTokenResponse(response, "calendly");
}

/**
 * The hot path for booking code: returns { accessToken, connection } with a
 * guaranteed-fresh access token, refreshing if needed. Throws when the
 * connection is missing, broken, or encryption is unconfigured.
 */
async function getValidAccessToken(organizationId, provider, supabase = getSupabase()) {
  assertProvider(provider);
  if (!isEncryptionConfigured()) {
    const error = new Error(keySetupHelp());
    error.code = "encryption_not_configured";
    error.status = 503;
    throw error;
  }
  let row = await getConnection(supabase, organizationId, provider);
  if (!row || row.status === "disconnected") {
    const error = new Error(`No ${provider} calendar connected for this business.`);
    error.code = "not_connected";
    error.status = 404;
    throw error;
  }
  if (row.status === "needs_reconnect") {
    const error = new Error(
      `The ${provider} calendar connection needs to be reconnected. ` +
        (row.last_error || ""),
    );
    error.code = "needs_reconnect";
    error.status = 409;
    throw error;
  }
  if (isExpiringSoon(row)) {
    row = await refreshConnection(supabase, row);
    if (!row) {
      const error = new Error(
        `The ${provider} calendar connection expired and could not be refreshed. Reconnect it in Settings.`,
      );
      error.code = "needs_reconnect";
      error.status = 409;
      throw error;
    }
  }
  const { accessToken } = decryptTokens(row);
  if (!accessToken) {
    const error = new Error(`The ${provider} calendar connection has no access token. Reconnect it in Settings.`);
    error.code = "needs_reconnect";
    error.status = 409;
    throw error;
  }
  return { accessToken, connection: row };
}

/**
 * Upsert a connection row after a successful OAuth code exchange.
 */
async function saveConnection(supabase, organizationId, provider, {
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
  providerUserId,
  providerUserEmail,
  providerUserName,
  timezone,
}) {
  assertProvider(provider);
  if (!isEncryptionConfigured()) {
    const error = new Error(keySetupHelp());
    error.code = "encryption_not_configured";
    error.status = 503;
    throw error;
  }
  const now = new Date().toISOString();

  /*
   * Reconnecting the same provider must reuse the existing row.
   *
   * This lookup was missing, so `existing` was a free variable and every save
   * threw "existing is not defined" — the OAuth callback caught it and
   * redirected to ?error=save_failed, which made the integration impossible to
   * connect at all. The table also carries unique (organization_id, provider),
   * so even past the ReferenceError a blind insert would fail the second time
   * a tenant connected.
   */
  const existing = await getConnection(supabase, organizationId, provider);

  // The row id is generated client-side so the AAD binding (which includes
  // the connection id) is stable from the first write — no re-encryption pass.
  const id = existing ? existing.id : crypto.randomUUID();
  const binding = { organizationId, provider, connectionId: id };

  const payload = {
    id,
    organization_id: organizationId,
    provider,
    status: "connected",
    provider_user_id: providerUserId || null,
    provider_user_email: providerUserEmail || null,
    provider_user_name: providerUserName || null,
    access_token_encrypted: accessToken ? encryptSecret(accessToken, binding) : null,
    refresh_token_encrypted: refreshToken ? encryptSecret(refreshToken, binding) : null,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    scopes: scopes || null,
    timezone: timezone || null,
    last_error: null,
    connected_at: existing ? existing.connected_at : now,
    updated_at: now,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("calendar_integrations")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("calendar_integrations")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  PROVIDERS,
  getConnection,
  listConnections,
  getValidAccessToken,
  saveConnection,
  refreshConnection,
  markNeedsReconnect,
};
