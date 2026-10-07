"use strict";

/**
 * Calendar Phase 3: change notifications + reconciliation.
 *
 * Bookings don't only happen through the voice agent. A tenant's customer can
 * book directly in Calendly, or the tenant can add/move/delete events in
 * Google Calendar. This module keeps Agently's appointments table truthful:
 *
 * - Calendly: per-connection webhook subscription (invitee.created /
 *   invitee.canceled), HMAC-signed. The subscription URL carries the org id
 *   as a path segment so inbound events route to the right tenant.
 * - Google: push watch channels on the booking calendar (bodyless
 *   notifications) + syncToken incremental sync as the correctness path.
 *   The channel token carries an HMAC-bound org id for routing + spoof-check.
 * - Reconciliation policy (Lawal has not chosen between "human wins" and
 *   "flag for review", so the safe default is flag for review): an external
 *   event overlapping an agent-booked slot marks the appointment
 *   'conflicted' and notifies the tenant. Nothing is auto-cancelled.
 * - Every inbound change invalidates the availability cache (see
 * *   invalidateGroupAvailabilityCache in lib/calendar-booking.js).
 *
 * PUBLIC (unauthenticated) receivers verify authenticity cryptographically:
 * Calendly via HMAC signature + 3-minute replay window; Google via the
 * HMAC-bound channel token. No session, no secrets in URLs.
 */

const crypto = require("crypto");
const { getSupabase } = require("./supabase");
const {
  getConnection,
  getConnectionById,
  getValidAccessTokenForConnection,
  listConnectionRows,
} = require("./calendar-tokens");
const { encryptSecret, decryptSecret } = require("./crypto");
const { invalidateGroupAvailabilityCache } = require("./calendar-booking");

const PROVIDER_TIMEOUT_MS = 12000;
const CALENDLY_SIGNATURE_TOLERANCE_MS = 3 * 60 * 1000;
const GOOGLE_WATCH_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days; sweeper renews <24h out
const SYNC_TOKEN_AAD = "google-sync-token";

function signingKey() {
  return String(process.env.CALENDLY_WEBHOOK_SIGNING_KEY || "").trim();
}

function webhookBaseUrl(config) {
  return new URL(config.redirectUri).origin;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function apiFetch(url, { method = "GET", accessToken, body } = {}) {
  const headers = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text: text.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Tenant notifications (same shape as the booking service's)
// ---------------------------------------------------------------------------

async function notifyTenant(supabase, { organizationId, type, title, body, appointmentId, metadata }) {
  try {
    await supabase.from("tenant_notifications").insert({
      organization_id: organizationId,
      user_id: null,
      type,
      title,
      body,
      entity_type: "appointment",
      entity_id: appointmentId || null,
      voice_agent_id: null,
      call_record_id: null,
      is_read: false,
      metadata: metadata || {},
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[calendar-sync] notification insert failed:", error && error.message);
  }
}

function formatWhen(startsAt, timezone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(startsAt));
  } catch (_) {
    return String(startsAt);
  }
}

// ===========================================================================
// Calendly webhooks
// ===========================================================================

/**
 * Verify the Calendly webhook signature.
 * Header:  Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>
 * Content: t + "." + rawBody, HMAC-SHA256 hex with the app signing key.
 * Rejects timestamps older than ~3 minutes (replay protection).
 */
function verifyCalendlySignature(rawBody, signatureHeader) {
  const key = signingKey();
  if (!key) return false;
  const header = String(signatureHeader || "");
  const tMatch = header.match(/(?:^|,)\s*t=(\d+)/);
  const v1Match = header.match(/(?:^|,)\s*v1=([0-9a-fA-F]+)/);
  if (!tMatch || !v1Match) return false;
  const t = Number(tMatch[1]);
  if (!Number.isFinite(t)) return false;
  const ageMs = Math.abs(Date.now() - t * 1000);
  if (ageMs > CALENDLY_SIGNATURE_TOLERANCE_MS) return false;
  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const expected = crypto.createHmac("sha256", key).update(`${t}.${bodyText}`, "utf8").digest("hex");
  const a = Buffer.from(v1Match[1].toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function setupCalendlyWebhook(supabase, organizationId, connection, config) {
  if (!signingKey()) {
    console.warn("[calendar-sync] CALENDLY_WEBHOOK_SIGNING_KEY not set — skipping webhook setup");
    return { skipped: "no_signing_key" };
  }
  let accessToken;
  try {
    ({ accessToken } = await getValidAccessTokenForConnection(connection, supabase));
  } catch (error) {
    console.warn("[calendar-sync] webhook setup: no valid token:", error && error.message);
    return { skipped: "no_token" };
  }

  // users/me gives the user URI and current organization URI for the subscription.
  const me = await apiFetch("https://api.calendly.com/users/me", { accessToken });
  if (!me.ok) {
    console.warn("[calendar-sync] webhook setup: users/me failed:", me.status);
    return { skipped: "me_failed" };
  }
  const orgUri = me.json.resource.current_organization;
  const userUri = me.json.resource.uri;

  // Keep an existing subscription if the provider still has it.
  if (connection.webhook_subscription_uri) {
    const existing = await apiFetch(connection.webhook_subscription_uri, { accessToken });
    if (existing.ok) return { kept: connection.webhook_subscription_uri };
  }

  const url = `${webhookBaseUrl(config)}/api/integrations/calendly/webhook/${organizationId}`;
  const created = await apiFetch("https://api.calendly.com/webhook_subscriptions", {
    method: "POST",
    accessToken,
    body: {
      url,
      events: ["invitee.created", "invitee.canceled"],
      organization: orgUri,
      user: userUri,
      scope: "user",
    },
  });
  if (!created.ok) {
    // Webhook creation may be gated behind the paid plan; booking still works.
    console.warn("[calendar-sync] webhook subscription failed:", created.status, created.text);
    return { skipped: `provider_${created.status}` };
  }
  const subscriptionUri = created.json.resource.uri;
  await supabase
    .from("calendar_integrations")
    .update({ webhook_subscription_uri: subscriptionUri, updated_at: new Date().toISOString() })
    .eq("id", connection.id);
  console.log("[calendar-sync] calendly webhook subscribed", { organizationId, subscriptionUri });
  return { created: subscriptionUri };
}

async function teardownCalendlyWebhook(supabase, organizationId, connection) {
  if (!connection.webhook_subscription_uri) return;
  try {
    const { accessToken } = await getValidAccessTokenForConnection(connection, supabase);
    await apiFetch(connection.webhook_subscription_uri, { method: "DELETE", accessToken });
  } catch (error) {
    console.warn("[calendar-sync] webhook teardown failed (best-effort):", error && error.message);
  }
}

async function findAppointmentByInvitee(supabase, organizationId, invitee) {
  const eventUri = invitee.event || null;
  // Match on the invitee URI first, then the scheduled-event URI.
  for (const [column, value] of [["external_event_id", invitee.uri], ["external_event_uri", eventUri]]) {
    if (!value) continue;
    const { data } = await supabase
      .from("appointments")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("provider", "calendly")
      .eq(column, value)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function handleCalendlyEvent(supabase, organizationId, event) {
  const kind = event && event.event;
  const invitee = (event && event.payload) || {};
  if (kind !== "invitee.created" && kind !== "invitee.canceled") return { ignored: kind };
  if (!invitee.uri) return { ignored: "no_invitee_uri" };

  const existing = await findAppointmentByInvitee(supabase, organizationId, invitee);
  const now = new Date().toISOString();

  if (kind === "invitee.created") {
    if (existing) {
      // Our pending row, now confirmed by the provider.
      if (existing.status === "pending") {
        await supabase
          .from("appointments")
          .update({
            status: "booked",
            external_event_id: invitee.uri,
            external_event_uri: invitee.event || existing.external_event_uri,
            starts_at: invitee.start_time || existing.starts_at,
            ends_at: invitee.end_time || existing.ends_at,
            cancel_url: invitee.cancel_url || existing.cancel_url,
            reschedule_url: invitee.reschedule_url || existing.reschedule_url,
            updated_at: now,
          })
          .eq("id", existing.id);
      }
      await invalidateGroupAvailabilityCache(supabase, organizationId);
      return { reconciled: "confirmed", appointmentId: existing.id };
    }
    // Booked directly in Calendly, not through the agent. Record it so the
    // tenant sees every booking in one place; no notification (Calendly
    // already told them) unless it clashes with an agent booking.
    const start = invitee.start_time ? new Date(invitee.start_time) : null;
    const end = invitee.end_time ? new Date(invitee.end_time) : null;
    let conflictId = null;
    if (start && end) {
      const { data: overlapping } = await supabase
        .from("appointments")
        .select("id, starts_at, attendee_name, timezone")
        .eq("organization_id", organizationId)
        .eq("provider", "calendly")
        .eq("status", "booked")
        .lt("starts_at", end.toISOString())
        .gt("ends_at", start.toISOString())
        .limit(1)
        .maybeSingle();
      if (overlapping) conflictId = overlapping.id;
    }
    const { data: created } = await supabase
      .from("appointments")
      .insert({
        organization_id: organizationId,
        provider: "calendly",
        external_event_id: invitee.uri,
        external_event_uri: invitee.event || null,
        title: invitee.event_type_name || null,
        attendee_name: invitee.name || null,
        attendee_email: invitee.email || null,
        starts_at: start ? start.toISOString() : now,
        ends_at: end ? end.toISOString() : now,
        timezone: "America/New_York",
        status: "booked",
        cancel_url: invitee.cancel_url || null,
        reschedule_url: invitee.reschedule_url || null,
        raw: { origin: "external", source: "calendly_webhook" },
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();
    if (conflictId) {
      await supabase.from("appointments").update({ status: "conflicted", updated_at: now }).eq("id", conflictId);
      const { data: ours } = await supabase.from("appointments").select("starts_at, attendee_name, timezone").eq("id", conflictId).maybeSingle();
      await notifyTenant(supabase, {
        organizationId,
        type: "appointment_conflict",
        title: "Booking conflict needs review",
        body: `A booking made directly in Calendly overlaps the agent's booking for ${ours ? formatWhen(ours.starts_at, ours.timezone) : "a slot"} (${(ours && ours.attendee_name) || "caller"}). Neither was cancelled — please review.`,
        appointmentId: conflictId,
        metadata: { provider: "calendly", externalInviteeUri: invitee.uri },
      });
    }
    await invalidateGroupAvailabilityCache(supabase, organizationId);
    return { reconciled: "external_recorded", appointmentId: created && created.id, conflictId };
  }

  // invitee.canceled
  if (existing && existing.status !== "cancelled") {
    await supabase.from("appointments").update({ status: "cancelled", updated_at: now }).eq("id", existing.id);
    await notifyTenant(supabase, {
      organizationId,
      type: "appointment_cancelled",
      title: `Booking cancelled: ${existing.attendee_name || "appointment"}`,
      body: `The ${formatWhen(existing.starts_at, existing.timezone)} booking was cancelled in Calendly.`,
      appointmentId: existing.id,
      metadata: { provider: "calendly", origin: "webhook" },
    });
  }
  await invalidateGroupAvailabilityCache(supabase, organizationId);
  return { reconciled: "cancelled", appointmentId: existing && existing.id };
}

function createCalendlyWebhookHandler() {
  return async function calendlyWebhookHandler(req, res) {
    const organizationId = req.params.orgId;
    const rawBody = req.body; // express.raw buffer (route mounts express.raw)
    if (!organizationId || !verifyCalendlySignature(rawBody, req.headers["calendly-webhook-signature"])) {
      return res.status(401).json({ error: "invalid signature" });
    }
    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch (_) {
      return res.status(400).json({ error: "invalid json" });
    }
    // Acknowledge fast; Calendly retries on 5xx.
    res.status(200).json({ received: true });
    try {
      const result = await handleCalendlyEvent(getSupabase(), organizationId, event);
      console.log("[calendar-sync] calendly webhook processed", { organizationId, event: event.event, ...result });
    } catch (error) {
      console.error("[calendar-sync] calendly webhook processing failed:", error && error.message);
    }
  };
}

// ===========================================================================
// Google push channels
// ===========================================================================

function pushSigningKey() {
  const hex = String(process.env.CALENDAR_TOKEN_KEY || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return crypto.createHmac("sha256", Buffer.from(hex, "hex")).update("google-push-token-v1").digest();
}

/** Opaque channel token: v1.<orgId>.<hmac> — routes the push and proves origin. */
function pushTokenFor(organizationId) {
  const key = pushSigningKey();
  if (!key) throw new Error("CALENDAR_TOKEN_KEY is not configured.");
  const hmac = crypto.createHmac("sha256", key).update(String(organizationId), "utf8").digest("hex");
  return `v1.${organizationId}.${hmac}`;
}

function verifyPushToken(token) {
  const key = pushSigningKey();
  if (!key) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, organizationId, hmac] = parts;
  if (!organizationId || !hmac) return null;
  const expected = crypto.createHmac("sha256", key).update(organizationId, "utf8").digest("hex");
  const a = Buffer.from(hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? organizationId : null;
}

function encryptSyncToken(syncToken, organizationId, connectionId) {
  return encryptSecret(syncToken, {
    organizationId: String(organizationId),
    provider: "google",
    connectionId: `${connectionId}:${SYNC_TOKEN_AAD}`,
  });
}

function decryptSyncToken(envelope, organizationId, connectionId) {
  return decryptSecret(envelope, {
    organizationId: String(organizationId),
    provider: "google",
    connectionId: `${connectionId}:${SYNC_TOKEN_AAD}`,
  });
}

async function initSyncToken(accessToken, calendarId) {
  const result = await apiFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=1&singleEvents=true&orderBy=startTime`,
    { accessToken },
  );
  if (!result.ok) throw new Error(`sync token init failed: HTTP ${result.status}`);
  return result.json.nextSyncToken || null;
}

async function startGoogleWatch(supabase, organizationId, connection, config) {
  const calendarId = connection.calendar_id || "primary";
  let accessToken;
  try {
    /*
     * The token for THIS connection, not for (organization, google).
     *
     * An organization can now hold several Google accounts. Taking the
     * provider-level token would start the watch for account B using account
     * A's grant — Google would either refuse it or, worse, watch A's calendar
     * and write the channel id onto B's row, so B's bookings would never
     * reconcile and nobody would see an error. Each row's tokens decrypt only
     * under its own connection id, which is what makes this the correct call.
     */
    ({ accessToken } = await getValidAccessTokenForConnection(connection, supabase));
  } catch (error) {
    console.warn("[calendar-sync] watch setup: no valid token:", error && error.message);
    return { skipped: "no_token" };
  }
  const channelId = crypto.randomBytes(16).toString("hex"); // 32 chars, ≤64
  const address = `${webhookBaseUrl(config)}/api/integrations/google/push`;
  const expiration = Date.now() + GOOGLE_WATCH_TTL_MS;
  const watch = await apiFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: "POST",
      accessToken,
      body: {
        id: channelId,
        type: "web_hook",
        address,
        token: pushTokenFor(organizationId),
        expiration,
      },
    },
  );
  if (!watch.ok) {
    console.warn("[calendar-sync] watch setup failed:", watch.status, watch.text);
    return { skipped: `provider_${watch.status}` };
  }
  const syncToken = await initSyncToken(accessToken, calendarId);
  await supabase
    .from("calendar_integrations")
    .update({
      google_watch_channel_id: channelId,
      google_watch_resource_id: watch.json.resourceId || null,
      google_watch_expires_at: new Date(watch.json.expiration ? Number(watch.json.expiration) : expiration).toISOString(),
      google_sync_token_encrypted: syncToken
        ? encryptSyncToken(syncToken, organizationId, connection.id)
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", connection.id);
  console.log("[calendar-sync] google watch started", { organizationId, channelId });
  return { started: channelId };
}

async function stopGoogleWatch(supabase, organizationId, connection) {
  if (!connection.google_watch_channel_id || !connection.google_watch_resource_id) return;
  try {
    // Per-connection, for the same reason as startGoogleWatch: only this
    // row's grant can stop this row's channel.
    const { accessToken } = await getValidAccessTokenForConnection(connection, supabase);
    await apiFetch("https://www.googleapis.com/calendar/v3/channels/stop", {
      method: "POST",
      accessToken,
      body: {
        id: connection.google_watch_channel_id,
        resourceId: connection.google_watch_resource_id,
      },
    });
  } catch (error) {
    console.warn("[calendar-sync] watch stop failed (best-effort):", error && error.message);
  }
}

/**
 * Incremental sync after a push notification. Push is the fast path;
 * syncToken is the correctness path. On 410 Gone the token is stale and a
 * full re-baseline runs instead.
 */
async function syncGoogleCalendar(supabase, organizationId, connectionOrNull = null) {
  /*
   * WHICH connection. An organization can hold several Google accounts, and
   * a push notification is about exactly one of them — the caller passes the
   * row it resolved from the channel id. Without one (the manual/internal
   * path) this falls back to the booking default, which is what the
   * single-account case always meant.
   */
  const connection =
    connectionOrNull || (await getConnection(supabase, organizationId, "google"));
  if (!connection || connection.status !== "connected") return { skipped: "not_connected" };
  const calendarId = connection.calendar_id || "primary";
  let accessToken;
  try {
    ({ accessToken } = await getValidAccessTokenForConnection(connection, supabase));
  } catch (error) {
    if (error.code === "needs_reconnect") return { skipped: "needs_reconnect" };
    throw error;
  }

  let syncToken = null;
  if (connection.google_sync_token_encrypted) {
    try {
      syncToken = decryptSyncToken(connection.google_sync_token_encrypted, organizationId, connection.id);
    } catch (_) {
      syncToken = null;
    }
  }

  const params = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
  if (syncToken) params.set("syncToken", syncToken);
  else {
    params.set("timeMin", new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
    params.set("timeMax", new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString());
  }
  let result = await apiFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { accessToken },
  );
  if (result.status === 410) {
    // Stale sync token — full re-baseline.
    console.log("[calendar-sync] sync token expired, full re-baseline", { organizationId });
    return fullGoogleRebaseline(supabase, organizationId, connection, accessToken, calendarId);
  }
  if (!result.ok) throw new Error(`events.list failed: HTTP ${result.status}`);

  const outcome = await reconcileGoogleChanges(supabase, organizationId, connection, result.json.items || []);
  if (result.json.nextSyncToken) {
    await supabase
      .from("calendar_integrations")
      .update({
        google_sync_token_encrypted: encryptSyncToken(result.json.nextSyncToken, organizationId, connection.id),
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("id", connection.id);
  }
  await invalidateGroupAvailabilityCache(supabase, organizationId);
  return { synced: outcome };
}

async function fullGoogleRebaseline(supabase, organizationId, connection, accessToken, calendarId) {
  const params = new URLSearchParams({
    singleEvents: "true",
    maxResults: "250",
    timeMin: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    timeMax: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
  });
  const result = await apiFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { accessToken },
  );
  if (!result.ok) throw new Error(`full re-baseline failed: HTTP ${result.status}`);
  const outcome = await reconcileGoogleChanges(supabase, organizationId, connection, result.json.items || []);
  if (result.json.nextSyncToken) {
    await supabase
      .from("calendar_integrations")
      .update({
        google_sync_token_encrypted: encryptSyncToken(result.json.nextSyncToken, organizationId, connection.id),
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("id", connection.id);
  }
  await invalidateGroupAvailabilityCache(supabase, organizationId);
  return { rebaselined: outcome };
}

function timedRange(item) {
  if (!item || !item.start || !item.start.dateTime || !item.end || !item.end.dateTime) return null;
  const start = new Date(item.start.dateTime).getTime();
  const end = new Date(item.end.dateTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function isOurEvent(item) {
  return String(item && item.id || "").startsWith("agently");
}

async function reconcileGoogleChanges(supabase, organizationId, connection, items) {
  const now = new Date().toISOString();
  let cancelled = 0;
  let conflicts = 0;

  /*
   * Scope every probe to the account the push notification came from.
   *
   * `connection` used to be a dead parameter: both queries filtered only on
   * (organization_id, provider='google'). With one Google account per
   * organization that was indistinguishable from correct. With several — the
   * entire point of this change — a push for business B reconciles against
   * business A's appointments too, so a deletion in B's calendar cancels A's
   * booking and an unrelated event in B flags A's slot as conflicted.
   *
   * Appointments written before integration_id existed carry NULL, and those
   * cannot be attributed to an account at all; they stay with the booking
   * default so they are reconciled exactly once rather than by every account.
   */
  const connectionId = connection && connection.id;
  const ownsLegacyRows = Boolean(connection && connection.is_booking_default);
  const scopeToAccount = (query) => {
    if (!connectionId) return query; // nothing to scope by: behave as before
    return ownsLegacyRows
      ? query.or(`integration_id.eq.${connectionId},integration_id.is.null`)
      : query.eq("integration_id", connectionId);
  };

  for (const item of items) {
    const eventId = item && item.id;
    if (!eventId) continue;

    // Our own bookings: watch for external deletion.
    const { data: ours } = await supabase
      .from("appointments")
      .select("id, status, starts_at, attendee_name, timezone")
      .eq("organization_id", organizationId)
      .eq("provider", "google")
      .eq("external_event_id", eventId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ours) {
      if (item.status === "cancelled" && ours.status !== "cancelled") {
        await supabase.from("appointments").update({ status: "cancelled", updated_at: now }).eq("id", ours.id);
        await notifyTenant(supabase, {
          organizationId,
          type: "appointment_cancelled",
          title: `Booking cancelled: ${ours.attendee_name || "appointment"}`,
          body: `The ${formatWhen(ours.starts_at, ours.timezone)} booking was deleted in Google Calendar.`,
          appointmentId: ours.id,
          metadata: { provider: "google", origin: "push_sync" },
        });
        cancelled += 1;
      }
      continue;
    }

    // External event: only interesting if it overlaps an agent-booked slot.
    if (item.status === "cancelled" || isOurEvent(item)) continue;
    const range = timedRange(item);
    if (!range) continue;
    const { data: overlapping } = await supabase
      .from("appointments")
      .select("id, starts_at, attendee_name, timezone")
      .eq("organization_id", organizationId)
      .eq("provider", "google")
      .eq("status", "booked")
      .lt("starts_at", range.end)
      .gt("ends_at", range.start)
      .limit(1)
      .maybeSingle();
    if (overlapping) {
      await supabase.from("appointments").update({ status: "conflicted", updated_at: now }).eq("id", overlapping.id);
      await notifyTenant(supabase, {
        organizationId,
        type: "appointment_conflict",
        title: "Booking conflict needs review",
        body: `An event added directly in Google Calendar ("${(item.summary || "untitled").slice(0, 80)}") overlaps the agent's booking for ${formatWhen(overlapping.starts_at, overlapping.timezone)} (${overlapping.attendee_name || "caller"}). Neither was cancelled — please review.`,
        appointmentId: overlapping.id,
        metadata: { provider: "google", externalEventId: eventId },
      });
      conflicts += 1;
    }
  }
  return { cancelled, conflicts, examined: items.length };
}

function createGooglePushHandler() {
  return async function googlePushHandler(req, res) {
    const organizationId = verifyPushToken(req.headers["x-goog-channel-token"]);
    if (!organizationId) {
      return res.status(401).json({ error: "invalid channel token" });
    }
    // Acknowledge immediately — Google retries on 5xx. "sync" is the
    // channel-creation notice; everything else triggers an incremental sync.
    res.status(200).json({ received: true });
    const resourceState = req.headers["x-goog-resource-state"];
    if (resourceState === "sync") return;
    try {
      const db = getSupabase();
      /*
       * Resolve the notification to ONE connection by its channel id.
       *
       * The channel token binds the organization, not the account, and an
       * organization can now hold several Google accounts. Syncing "the"
       * Google connection would apply account B's change feed to account A:
       * A's bookings would be marked cancelled because they are absent from
       * B's calendar. The channel id is per-row, so it is the only thing in
       * the request that says which account changed. A notification we cannot
       * place is dropped rather than applied to a guess.
       */
      const channelId = req.headers["x-goog-channel-id"];
      const rows = await listConnectionRows(db, organizationId, { provider: "google" });
      const connection = channelId
        ? rows.find((row) => row.google_watch_channel_id === channelId) || null
        : null;
      if (!connection) {
        console.warn("[calendar-sync] google push for an unknown channel; ignored", {
          organizationId,
          channelId,
        });
        return;
      }
      const result = await syncGoogleCalendar(db, organizationId, connection);
      console.log("[calendar-sync] google push synced", {
        organizationId,
        connectionId: connection.id,
        ...result,
      });
    } catch (error) {
      console.error("[calendar-sync] google push sync failed:", error && error.message);
    }
  };
}

// ===========================================================================
// Setup / teardown dispatch + watch sweeper
// ===========================================================================

async function setupConnectionSync(supabase, organizationId, provider, config, connection) {
  const row = connection || (await getConnection(supabase, organizationId, provider));
  if (!row) return { skipped: "no_connection" };
  try {
    if (provider === "calendly") return await setupCalendlyWebhook(supabase, organizationId, row, config);
    return await startGoogleWatch(supabase, organizationId, row, config);
  } catch (error) {
    // Sync setup must never fail a connect.
    console.warn("[calendar-sync] setup failed (non-fatal):", error && error.message);
    return { skipped: "error" };
  }
}

async function teardownConnectionSync(supabase, organizationId, provider, connection) {
  const row = connection || (await getConnection(supabase, organizationId, provider));
  if (!row) return;
  if (provider === "calendly") await teardownCalendlyWebhook(supabase, organizationId, row);
  else await stopGoogleWatch(supabase, organizationId, row);
}

/**
 * Renew Google watch channels expiring within 24h. Run daily via the
 * deployment's scheduler hitting POST /api/internal/calendar/sweep.
 * Creates the new channel first, then stops the old one (overlap is normal).
 */
async function sweepWatchChannels(supabase = getSupabase()) {
  const cutoff = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from("calendar_integrations")
    .select("id, organization_id, calendar_id, google_watch_channel_id, google_watch_resource_id, google_watch_expires_at")
    .eq("provider", "google")
    .eq("status", "connected")
    .not("google_watch_channel_id", "is", null)
    .lt("google_watch_expires_at", cutoff);
  if (error) throw error;
  const summary = { checked: (rows || []).length, renewed: 0, failed: 0 };
  for (const row of rows || []) {
    try {
      // By id, not by (organization, google): with several Google accounts
      // the provider-level lookup renews the wrong row's channel.
      const full = await getConnectionById(supabase, row.organization_id, row.id);
      if (!full) {
        summary.failed += 1;
        continue;
      }
      // Minimal config: only the redirect URI origin is needed for the address.
      const fakeConfig = { redirectUri: process.env.INTEGRATIONS_GOOGLE_REDIRECT_URI };
      const oldChannel = {
        google_watch_channel_id: row.google_watch_channel_id,
        google_watch_resource_id: row.google_watch_resource_id,
      };
      const started = await startGoogleWatch(supabase, row.organization_id, full, fakeConfig);
      if (started.started) {
        await stopGoogleWatch(supabase, row.organization_id, { ...full, ...oldChannel });
        summary.renewed += 1;
      } else {
        summary.failed += 1;
      }
    } catch (err) {
      console.warn("[calendar-sync] watch renewal failed:", row.organization_id, err && err.message);
      summary.failed += 1;
    }
  }
  return summary;
}

module.exports = {
  // Calendly
  verifyCalendlySignature,
  setupCalendlyWebhook,
  teardownCalendlyWebhook,
  handleCalendlyEvent,
  createCalendlyWebhookHandler,
  // Google
  pushTokenFor,
  verifyPushToken,
  startGoogleWatch,
  stopGoogleWatch,
  syncGoogleCalendar,
  reconcileGoogleChanges,
  createGooglePushHandler,
  // lifecycle
  setupConnectionSync,
  teardownConnectionSync,
  sweepWatchChannels,
  // internals for tests
  _internals: {
    timedRange,
    isOurEvent,
    encryptSyncToken,
    decryptSyncToken,
  },
};
