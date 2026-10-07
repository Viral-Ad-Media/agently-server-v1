"use strict";

/**
 * Per-tenant OAuth token vault for calendar providers (google, calendly).
 *
 * WHAT IT DOES
 *
 * - Reads/writes calendar_integrations rows (service-role Supabase client).
 *   ONE ROW PER CONNECTED ACCOUNT, not per provider: a single Agently login
 *   can run several businesses, each with its own Google account, so a row is
 *   keyed on (organization_id, provider, provider_user_id). Anything that
 *   needs exactly one row says which one it means — getBookingConnection for
 *   the row the agent books into, getConnectionById for a client-supplied id,
 *   listConnectionRows for all of them.
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
// Fallback order when an organization has no is_booking_default row yet:
// Calendly first when connected, Google as the fallback (Lawal, 2026-10-05).
const PROVIDERS_BY_BOOKING_PREFERENCE = ["calendly", "google"];
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

/**
 * Columns safe to hand to the client: everything except the ciphertext
 * columns and the sync tokens. Tokens never leave this module.
 */
const PUBLIC_CONNECTION_COLUMNS =
  "id, provider, status, label, is_booking_default, provider_user_id, provider_user_email, " +
  "provider_user_name, calendar_id, event_type_uri, event_type_name, scopes, timezone, " +
  "last_error, connected_at, updated_at, expires_at, booking_settings";

/*
 * AUTHORIZATION INVARIANT
 *
 * All five calendar tables are RLS-enabled with zero policies and this API
 * talks to Postgres as the service role, so the database will NOT stop a
 * query that forgets its tenant. Every read in this module therefore filters
 * on organization_id in application code, and this guard turns a missing
 * organization_id into a loud failure instead of a scan across tenants.
 * (This codebase has leaked across tenants before — 65 leads.)
 */
function requireOrganizationId(organizationId) {
  if (!organizationId || typeof organizationId !== "string") {
    const error = new Error(
      "calendar-tokens: organizationId is required — refusing to query calendar_integrations untenanted.",
    );
    error.code = "missing_organization";
    error.status = 500;
    throw error;
  }
  return organizationId;
}

/**
 * Deterministic order for an organization's connections, used everywhere a
 * set of rows has to be reduced to one: the booking default first, then
 * healthy before degraded, then oldest, then id as a stable tie-break. The
 * sort lives here rather than in SQL so the ordering is one testable rule
 * instead of a detail of each query.
 */
function compareConnections(a, b) {
  const rank = (row) => {
    if (row.is_booking_default) return 0;
    if (row.status === "connected") return 1;
    if (row.status === "disconnected") return 3;
    return 2;
  };
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const at = String(a.connected_at || "");
  const bt = String(b.connected_at || "");
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : 1;
}

/**
 * EVERY row for one organization, in compareConnections order.
 *
 * This is the primitive the multi-account world is built on. An organization
 * may now hold several rows per provider (one per connected Google account),
 * so a .maybeSingle() on (organization_id, provider) would either return an
 * arbitrary row or throw PGRST116. Callers that genuinely need one row say
 * WHICH one via getBookingConnection / getConnectionByAccount / getConnectionById.
 */
async function listConnectionRows(supabase, organizationId, options = {}) {
  requireOrganizationId(organizationId);
  const { provider = null, includeDisconnected = true } = options;
  if (provider) assertProvider(provider);
  let query = supabase
    .from("calendar_integrations")
    .select("*")
    .eq("organization_id", organizationId);
  if (provider) query = query.eq("provider", provider);
  const { data, error } = await query;
  if (error) throw error;
  let rows = Array.isArray(data) ? data.slice() : [];
  if (!includeDisconnected) rows = rows.filter((row) => row.status !== "disconnected");
  return rows.sort(compareConnections);
}

function normalizedEmail(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

/**
 * The row holding ONE provider account, keyed the way the database now is:
 * (organization_id, provider, provider_user_id).
 *
 * This is what makes "connect another Google account" safe. The old lookup
 * keyed on (organization_id, provider) alone, so a second account's save
 * would find the FIRST account's row and overwrite its tokens — silently
 * destroying a working connection. Returning null here is what makes the
 * caller insert a new row instead.
 */
async function getConnectionByAccount(supabase, organizationId, provider, providerUserId, options = {}) {
  assertProvider(provider);
  const { providerUserEmail = null } = options;
  const rows = await listConnectionRows(supabase, organizationId, { provider });

  if (providerUserId) {
    const exact = rows.find((row) => row.provider_user_id === String(providerUserId));
    if (exact) return exact;
    /*
     * Adoption of an id-less row. provider_user_id is nullable and rows
     * written before the account id was recorded carry NULL. The unique index
     * keys on coalesce(provider_user_id, ''), so a NULL row does not collide
     * with a real id — reconnecting that same account once we DO know its id
     * would therefore insert a second row for one real account. Matching on
     * the email closes the one gap SQL cannot.
     */
    if (providerUserEmail) {
      const adoptable = rows.find(
        (row) =>
          !row.provider_user_id &&
          normalizedEmail(row.provider_user_email) === normalizedEmail(providerUserEmail),
      );
      if (adoptable) return adoptable;
    }
    return null;
  }

  /*
   * Account id unknown: coalesce(provider_user_id, '') reserves exactly one
   * slot per (organization, provider) for that case, so reuse the row sitting
   * in it rather than inserting one the index would reject.
   *
   * But only when it is the SAME account. The branch above refuses to adopt an
   * id-less row unless the email matches; this one used to adopt any id-less
   * row outright, so connecting a SECOND business whose id we failed to read
   * would land on the first business's row and overwrite its tokens — the
   * exact data loss the id-keying was introduced to prevent, reached through
   * the one path that skipped the check.
   *
   * With no email either there is nothing to match on, so refuse and let the
   * caller insert: a duplicate row is recoverable, a destroyed grant is not.
   */
  if (!providerUserEmail) return null;
  return (
    rows.find(
      (row) =>
        !row.provider_user_id &&
        normalizedEmail(row.provider_user_email) === normalizedEmail(providerUserEmail),
    ) || null
  );
}

/**
 * One connection for (organization, provider).
 *
 * KEPT for the callers that are legitimately provider-shaped — sync setup and
 * teardown, the calendar/event-type picker, the realtime bridge's "is
 * anything connected?" probe. It no longer uses .maybeSingle(), which threw
 * the moment a second account existed; it returns the booking default when
 * there is one, which is also the row those callers want. New code that cares
 * which account should call getBookingConnection, getConnectionById or
 * listConnectionRows and say so.
 */
async function getConnection(supabase, organizationId, provider) {
  assertProvider(provider);
  const rows = await listConnectionRows(supabase, organizationId, { provider });
  return rows[0] || null;
}

/**
 * One connection by id, ALWAYS re-scoped to the organization.
 *
 * Connection ids now arrive from the client (rename, set-default, disconnect,
 * the merged feed), and an id on its own is a cross-tenant read waiting to
 * happen. The .eq("organization_id", ...) here is the only thing standing
 * between a guessed uuid and another tenant's calendar, because RLS is not.
 */
async function getConnectionById(supabase, organizationId, connectionId) {
  requireOrganizationId(organizationId);
  if (!connectionId) return null;
  const { data, error } = await supabase
    .from("calendar_integrations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", String(connectionId));
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows[0] || null;
}

/**
 * The connection the voice agent books INTO (design point 5).
 *
 * is_booking_default wins. When no row carries it — a pre-migration org, or
 * one whose default was just disconnected — fall back to the historical
 * preference order (Calendly first when connected, Google as fallback; Lawal,
 * 2026-10-05), so booking keeps working rather than stopping on a missing flag.
 */
async function getBookingConnection(supabase, organizationId) {
  const rows = await listConnectionRows(supabase, organizationId, { includeDisconnected: false });
  if (rows.length === 0) return null;
  const flagged = rows.find((row) => row.is_booking_default);
  if (flagged) return flagged;
  /*
   * No default recorded. Fall back to the historical provider preference, but
   * only over rows the agent could actually use: an "error" Calendly row must
   * not shadow a healthy Google one, which is what a naive provider-ordered
   * pick would do.
   */
  const usable = rows.filter((row) => row.status === "connected" || row.status === "needs_reconnect");
  for (const provider of PROVIDERS_BY_BOOKING_PREFERENCE) {
    const match = usable.find((row) => row.provider === provider);
    if (match) return match;
  }
  return usable[0] || rows[0];
}

/**
 * Make one connection the organization's booking target. The old default is
 * cleared FIRST: calendar_integrations_one_booking_default_per_org is a
 * partial unique index, so setting a second true before clearing the first is
 * rejected by the database — deliberately, since a loud failure beats an org
 * that quietly has two booking targets.
 */
async function setBookingDefault(supabase, organizationId, connectionId) {
  const target = await getConnectionById(supabase, organizationId, connectionId);
  if (!target) return null;
  const rows = await listConnectionRows(supabase, organizationId);
  for (const row of rows) {
    if (row.id === target.id || !row.is_booking_default) continue;
    const { error } = await supabase
      .from("calendar_integrations")
      .update({ is_booking_default: false })
      .eq("organization_id", organizationId)
      .eq("id", row.id);
    if (error) throw error;
  }
  if (target.is_booking_default) return target;
  const { data, error } = await supabase
    .from("calendar_integrations")
    .update({ is_booking_default: true, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", target.id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Rename a connection (design point 2). Cosmetic, so updated_at is left
 * alone — that column tracks token writes.
 */
async function renameConnection(supabase, organizationId, connectionId, label) {
  const target = await getConnectionById(supabase, organizationId, connectionId);
  if (!target) return null;
  const clean = String(label == null ? "" : label).trim().slice(0, 120);
  if (!clean) {
    const error = new Error("A connection label cannot be empty.");
    error.code = "invalid_label";
    error.status = 400;
    throw error;
  }
  const { data, error } = await supabase
    .from("calendar_integrations")
    .update({ label: clean })
    .eq("organization_id", organizationId)
    .eq("id", target.id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * After a connection is removed, make sure the organization still has a
 * booking target (design point 7). A no-op when one already exists or when
 * nothing usable is left.
 */
async function promoteBookingDefault(supabase, organizationId) {
  const rows = await listConnectionRows(supabase, organizationId, { includeDisconnected: false });
  if (rows.length === 0) return null;
  const existing = rows.find((row) => row.is_booking_default);
  if (existing) return existing;
  return setBookingDefault(supabase, organizationId, rows[0].id);
}

/**
 * Tenant-facing list for the connections screen. No ciphertext.
 */
async function listConnections(supabase, organizationId) {
  requireOrganizationId(organizationId);
  const { data, error } = await supabase
    .from("calendar_integrations")
    .select(PUBLIC_CONNECTION_COLUMNS)
    .eq("organization_id", organizationId);
  if (error) throw error;
  return (Array.isArray(data) ? data.slice() : []).sort(compareConnections);
}

/**
 * The label a new connection starts with (design point 2): the provider
 * account's own display name, then its email, then a provider literal. Never
 * blank, so the connections list always has something to show.
 */
function defaultConnectionLabel(provider, identity = {}) {
  for (const candidate of [identity.providerUserName, identity.providerUserEmail]) {
    const clean = String(candidate == null ? "" : candidate).trim();
    if (clean) return clean.slice(0, 120);
  }
  return provider === "google" ? "Google Calendar" : "Calendly";
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
 * A guaranteed-fresh access token for ONE known connection row.
 *
 * The per-row entry point. Availability has to talk to every one of an
 * organization's calendars, and each row's tokens decrypt only under its own
 * id (lib/crypto.js binds the ciphertext to { organizationId, provider,
 * connectionId }), so the caller must hand over the row it means rather than
 * a (organization, provider) pair that no longer identifies one.
 */
async function getValidAccessTokenForConnection(connection, supabase = getSupabase()) {
  if (!connection || !connection.id) {
    const error = new Error("getValidAccessTokenForConnection requires a connection row.");
    error.code = "not_connected";
    error.status = 404;
    throw error;
  }
  if (!isEncryptionConfigured()) {
    const error = new Error(keySetupHelp());
    error.code = "encryption_not_configured";
    error.status = 503;
    throw error;
  }
  let row = connection;
  const provider = row.provider;
  if (row.status === "disconnected") {
    const error = new Error(`No ${provider} calendar connected for this business.`);
    error.code = "not_connected";
    error.status = 404;
    throw error;
  }
  if (row.status === "needs_reconnect") {
    const error = new Error(
      `The ${provider} calendar connection needs to be reconnected. ` + (row.last_error || ""),
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
    const error = new Error(
      `The ${provider} calendar connection has no access token. Reconnect it in Settings.`,
    );
    error.code = "needs_reconnect";
    error.status = 409;
    throw error;
  }
  return { accessToken, connection: row };
}

/**
 * The hot path for booking code: returns { accessToken, connection } with a
 * guaranteed-fresh access token, refreshing if needed. Throws when the
 * connection is missing, broken, or encryption is unconfigured.
 *
 * Resolves (organization, provider) to the booking default — see
 * getConnection — and then defers to getValidAccessTokenForConnection.
 */
async function getValidAccessToken(organizationId, provider, supabase = getSupabase()) {
  assertProvider(provider);
  if (!isEncryptionConfigured()) {
    const error = new Error(keySetupHelp());
    error.code = "encryption_not_configured";
    error.status = 503;
    throw error;
  }
  const row = await getConnection(supabase, organizationId, provider);
  if (!row) {
    const error = new Error(`No ${provider} calendar connected for this business.`);
    error.code = "not_connected";
    error.status = 404;
    throw error;
  }
  return getValidAccessTokenForConnection(row, supabase);
}

/**
 * Persist a connection after a successful OAuth code exchange.
 *
 * KEYED ON THE ACCOUNT, not the provider: (organization_id, provider,
 * provider_user_id). One Agently login can run several businesses, each with
 * its own Google account, so connecting a DIFFERENT account must insert a new
 * row. The old lookup keyed on (organization_id, provider) and would have
 * found the first account's row and overwritten its tokens — the tenant's
 * working connection would have died silently, with the only symptom being
 * bookings landing on the wrong business's calendar.
 *
 * The encryption binding is unchanged: lib/crypto.js already binds ciphertext
 * to { organizationId, provider, connectionId }, and connectionId is this
 * row's id, so several rows per (organization, provider) were always safe —
 * each row's tokens decrypt only under its own id.
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
  label,
}) {
  assertProvider(provider);
  requireOrganizationId(organizationId);
  if (!isEncryptionConfigured()) {
    const error = new Error(keySetupHelp());
    error.code = "encryption_not_configured";
    error.status = 503;
    throw error;
  }
  const now = new Date().toISOString();

  // Reconnecting the SAME account reuses its row; a different account does not.
  const existing = await getConnectionByAccount(supabase, organizationId, provider, providerUserId, {
    providerUserEmail,
  });

  // Every row this organization already has, so the new one can work out
  // whether it is the org's first booking target without a second round trip.
  const siblings = await listConnectionRows(supabase, organizationId);
  const defaultElsewhere = siblings.some(
    (row) => row.is_booking_default && (!existing || row.id !== existing.id),
  );

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
    /*
     * Keep the stored refresh token when the provider does not send a new one.
     *
     * Google returns refresh_token only on the FIRST consent for a given
     * client; a reconnect of an already-granted account usually omits it. The
     * previous `: null` therefore wiped the live refresh token on exactly the
     * action a tenant takes to re-grant a scope — the connection kept working
     * until the access token expired an hour later, then died with no way to
     * refresh. Silent, delayed, and triggered by the remedy rather than the
     * fault.
     *
     * refreshConnection() in this same file already does this correctly; this
     * is the one write that did not. Null only ever wins on a genuinely new
     * row, where there is nothing to preserve.
     */
    refresh_token_encrypted: refreshToken
      ? encryptSecret(refreshToken, binding)
      : (existing && existing.refresh_token_encrypted) || null,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    scopes: scopes || null,
    timezone: timezone || null,
    last_error: null,
    connected_at: existing ? existing.connected_at : now,
    updated_at: now,
    /*
     * A tenant's rename survives a reconnect; a fresh row is named after the
     * provider account (design point 2).
     */
    label:
      existing && String(existing.label || "").trim()
        ? existing.label
        : String(label || "").trim() ||
          defaultConnectionLabel(provider, { providerUserName, providerUserEmail }),
    /*
     * Design point 3: an organization whose only usable connection is this one
     * becomes the booking target automatically, so the agent never ends up
     * with nowhere to book. An existing default is never demoted here —
     * choosing the target is the tenant's call, via setBookingDefault.
     */
    is_booking_default: existing ? Boolean(existing.is_booking_default) || !defaultElsewhere : !defaultElsewhere,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("calendar_integrations")
      .update(payload)
      .eq("organization_id", organizationId)
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
  PROVIDERS_BY_BOOKING_PREFERENCE,
  PUBLIC_CONNECTION_COLUMNS,
  getConnection,
  getConnectionById,
  getConnectionByAccount,
  getBookingConnection,
  listConnections,
  listConnectionRows,
  setBookingDefault,
  renameConnection,
  promoteBookingDefault,
  defaultConnectionLabel,
  compareConnections,
  getValidAccessToken,
  getValidAccessTokenForConnection,
  saveConnection,
  refreshConnection,
  markNeedsReconnect,
};
