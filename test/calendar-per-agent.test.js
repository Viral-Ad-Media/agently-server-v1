"use strict";
/*
 * Which business calendar an agent books into, and which Calendly account a
 * webhook belongs to.
 *
 * One login runs several businesses, each with its own connected calendar.
 * Several agents work for one business, so the rule is many agents -> one
 * connection (voice_agents.calendar_integration_id), with NULL meaning the
 * organization's booking default. Calendly webhooks follow the same shape as
 * Google: attributed to the connection, not just the tenant.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const TEST_KEY = "b".repeat(64);
function ensureKey() {
  if (process.env.CALENDAR_TOKEN_KEY !== TEST_KEY) process.env.CALENDAR_TOKEN_KEY = TEST_KEY;
}
ensureKey();

const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { encryptSecret } = require("../lib/crypto");
const { getBookingConnection } = require("../lib/calendar-tokens");
const {
  checkAvailability,
  bookAppointment,
  cancelAppointment,
  listMergedBookings,
  invalidateAvailabilityCache,
} = require("../lib/calendar-booking");
const { handleCalendlyEvent, setupCalendlyWebhook } = require("../lib/calendar-sync");

const ORG = "org-owner";
const OTHER_ORG = "org-stranger";

const ALL_DAY = {
  slotMinutes: 60,
  windowDays: 1,
  workingHours: Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "23:00"]]]),
  ),
};

function connectionRow({ id, organizationId = ORG, provider = "google", isBookingDefault = false, status = "connected", providerUserId }) {
  ensureKey();
  const binding = { organizationId, provider, connectionId: id };
  return {
    id,
    organization_id: organizationId,
    provider,
    status,
    label: id,
    is_booking_default: isBookingDefault,
    provider_user_id: providerUserId || `uid-${id}`,
    provider_user_email: `${id}@example.test`,
    calendar_id: "primary",
    event_type_uri: provider === "calendly" ? "https://api.calendly.com/event_types/et-1" : null,
    access_token_encrypted: encryptSecret(`access-${id}`, binding),
    refresh_token_encrypted: encryptSecret(`refresh-${id}`, binding),
    expires_at: "2099-01-01T00:00:00.000Z",
    timezone: "America/New_York",
    booking_settings: ALL_DAY,
    last_error: null,
    webhook_subscription_uri: null,
    connected_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function agentRow(id, calendarIntegrationId, organizationId = ORG) {
  return { id, organization_id: organizationId, calendar_integration_id: calendarIntegrationId };
}

/** freeBusy stub: busy blocks keyed by bearer token; records which tokens were used. */
function stubFetch(busyByToken = {}, { failTokens = [] } = {}) {
  const original = global.fetch;
  const tokens = [];
  global.fetch = async (url, options = {}) => {
    const token = String((options.headers || {}).authorization || "").replace("Bearer ", "");
    tokens.push(token);
    if (failTokens.includes(token)) throw new Error("network down");
    const body = JSON.parse(options.body || "{}");
    const calendarId = ((body.items || [])[0] || {}).id || "primary";
    return new Response(JSON.stringify({ calendars: { [calendarId]: { busy: busyByToken[token] || [] } } }), { status: 200 });
  };
  return { tokens, restore: () => { global.fetch = original; } };
}

const FROM = new Date("2026-10-08T12:00:00.000Z");
const TO = new Date("2026-10-08T16:00:00.000Z");

// ===========================================================================
// Per-agent booking connection
// ===========================================================================

function threeBusinesses(agents) {
  return makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "viral", isBookingDefault: true }),
      connectionRow({ id: "nutra" }),
      connectionRow({ id: "foreign", organizationId: OTHER_ORG }),
    ],
    voice_agents: agents,
  });
}

test("several agents assigned to one business all book into that business's calendar", async () => {
  const db = threeBusinesses([agentRow("agent-1", "nutra"), agentRow("agent-2", "nutra")]);
  assert.equal((await getBookingConnection(db, ORG, { voiceAgentId: "agent-1" })).id, "nutra");
  assert.equal((await getBookingConnection(db, ORG, { voiceAgentId: "agent-2" })).id, "nutra");
});

test("an agent needs an assignment while an org-level action may use the default", async () => {
  const db = threeBusinesses([agentRow("agent-3", null)]);
  assert.equal(await getBookingConnection(db, ORG, { voiceAgentId: "agent-3" }), null);
  assert.equal((await getBookingConnection(db, ORG)).id, "viral");
});

test("an assignment pointing at another tenant's connection is ignored", async () => {
  // A forged or stale id must never route a booking into a stranger's calendar.
  const db = threeBusinesses([agentRow("agent-4", "foreign")]);
  assert.equal(await getBookingConnection(db, ORG, { voiceAgentId: "agent-4" }), null);
});

test("another tenant's agent id cannot pick this tenant's calendar", async () => {
  const db = threeBusinesses([agentRow("agent-x", "nutra", OTHER_ORG)]);
  assert.equal(await getBookingConnection(db, ORG, { voiceAgentId: "agent-x" }), null);
});

test("availability is checked against the agent's own calendar and cached per connection", async () => {
  const db = threeBusinesses([agentRow("agent-nutra", "nutra")]);
  const fetchStub = stubFetch({
    // Nutra is busy 12-14; Viral is free all window.
    "access-nutra": [{ start: "2026-10-08T12:00:00.000Z", end: "2026-10-08T14:00:00.000Z" }],
  });
  try {
    invalidateAvailabilityCache(ORG);
    const viral = await checkAvailability(ORG, { from: FROM, to: TO }, db);
    const nutra = await checkAvailability(ORG, { from: FROM, to: TO, voiceAgentId: "agent-nutra" }, db);
    assert.equal(viral.success, true);
    assert.equal(nutra.success, true);
    // Cross-account merge applies both ways, so both see Nutra's busy block;
    // what must differ is WHOSE calendar computed the slots — the cache must
    // not have handed the default's answer to the Nutra agent.
    const firstNutraCall = fetchStub.tokens.lastIndexOf("access-nutra");
    assert.ok(firstNutraCall >= 0, "the Nutra agent's check must read Nutra's calendar");
    assert.ok(!nutra.slots.some((s) => s.start < "2026-10-08T14:00:00.000Z"), "Nutra's busy time is excluded");
  } finally {
    fetchStub.restore();
    invalidateAvailabilityCache(ORG);
  }
});

test("booking fails closed when another connected account cannot be read", async () => {
  const db = threeBusinesses([agentRow("agent-nutra", "nutra")]);
  const fetchStub = stubFetch({}, { failTokens: ["access-viral"] });
  try {
    const result = await bookAppointment(
      ORG,
      { startISO: "2099-10-08T13:00:00.000Z", attendeeName: "Ada", voiceAgentId: "agent-nutra" },
      db,
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "availability_unverified");
    const appt = db._tables.appointments[0];
    assert.equal(appt.integration_id, "nutra", "the pending row was opened on the agent's calendar");
    assert.equal(appt.status, "cancelled", "and released, not left pending");
  } finally {
    fetchStub.restore();
  }
});

// ===========================================================================
// Merged feed edge cases
// ===========================================================================

test("booking and cancelling refresh availability before provider webhooks arrive", async () => {
  const connection = connectionRow({ id: "cache-lifecycle", isBookingDefault: true });
  connection.timezone = "UTC";
  const db = makeFakeSupabase({ calendar_integrations: [connection], email_integrations: [] });
  const from = new Date("2098-10-08T12:00:00Z");
  const to = new Date("2098-10-08T16:00:00Z");
  let event = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/freeBusy")) {
      return new Response(JSON.stringify({ calendars: { primary: { busy: event ? [{ start: event.start.dateTime, end: event.end.dateTime }] : [] } } }));
    }
    if (options.method === "POST" && String(url).includes("/events")) {
      event = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: event.id }));
    }
    if (options.method === "DELETE" && String(url).includes("/events/")) {
      event = null;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected provider request ${options.method} ${url}`);
  };
  invalidateAvailabilityCache(ORG);
  try {
    const before = await checkAvailability(ORG, { from, to }, db);
    assert.equal(before.success, true);
    const slot = before.slots[0];
    const booked = await bookAppointment(ORG, { startISO: slot.start, attendeeName: "Cache test", attendeeEmail: "cache@example.test" }, db);
    assert.equal(booked.success, true, JSON.stringify(booked));
    const during = await checkAvailability(ORG, { from, to }, db);
    assert.equal(during.success, true);
    assert.ok(!during.slots.some(s => s.start === slot.start), "the just-booked slot must disappear immediately");
    const cancelled = await cancelAppointment(ORG, booked.appointmentId, db);
    assert.equal(cancelled.success, true);
    const after = await checkAvailability(ORG, { from, to }, db);
    assert.equal(after.success, true);
    assert.ok(after.slots.some(s => s.start === slot.start), "the cancelled slot must return immediately");
  } finally {
    global.fetch = originalFetch;
    invalidateAvailabilityCache(ORG);
  }
});

test("listMergedBookings rejects a malformed date with 400, not a RangeError", async () => {
  const db = makeFakeSupabase({ calendar_integrations: [], appointments: [] });
  await assert.rejects(
    () => listMergedBookings(ORG, { from: "not-a-date" }, db),
    (error) => error.status === 400 && error.code === "invalid_date",
  );
});

test("listMergedBookings total matches the list returned and flags truncation", async () => {
  const appointments = [1, 2, 3].map((n) => ({
    id: `a${n}`,
    organization_id: ORG,
    integration_id: null,
    provider: "google",
    starts_at: `2026-10-0${n}T10:00:00.000Z`,
    ends_at: `2026-10-0${n}T11:00:00.000Z`,
    status: "booked",
  }));
  const db = makeFakeSupabase({ calendar_integrations: [], appointments });
  const result = await listMergedBookings(ORG, { limit: 2 }, db);
  assert.equal(result.bookings.length, 2);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
});

// ===========================================================================
// Calendly: per-connection attribution
// ===========================================================================

function invitee(overrides = {}) {
  return {
    event: "invitee.created",
    payload: {
      uri: `https://api.calendly.com/invitees/${overrides.id || "INV1"}`,
      event: "https://api.calendly.com/scheduled_events/EV1",
      name: "Grace Hopper",
      start_time: "2026-10-09T14:00:00.000Z",
      end_time: "2026-10-09T14:30:00.000Z",
      ...overrides.payload,
    },
  };
}

function twoCalendlyAccounts(appointments = []) {
  return makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "cal-a", provider: "calendly", providerUserId: "https://api.calendly.com/users/A" }),
      connectionRow({ id: "cal-b", provider: "calendly", providerUserId: "https://api.calendly.com/users/B" }),
      connectionRow({ id: "cal-foreign", provider: "calendly", organizationId: OTHER_ORG }),
    ],
    appointments,
  });
}

test("a booking on the per-connection URL is labelled with that Calendly account", async () => {
  const db = twoCalendlyAccounts();
  const result = await handleCalendlyEvent(db, ORG, invitee(), { connectionId: "cal-b" });
  assert.equal(result.reconciled, "external_recorded");
  assert.equal(db._tables.appointments[0].integration_id, "cal-b");
});

test("one Calendly account's booking does not conflict another account's appointment", async () => {
  // Same time, different business: not a Calendly-level conflict.
  const db = twoCalendlyAccounts([
    {
      id: "appt-a",
      organization_id: ORG,
      integration_id: "cal-a",
      provider: "calendly",
      status: "booked",
      starts_at: "2026-10-09T14:00:00.000Z",
      ends_at: "2026-10-09T14:30:00.000Z",
    },
  ]);
  const result = await handleCalendlyEvent(db, ORG, invitee(), { connectionId: "cal-b" });
  assert.equal(result.conflictId, null);
  assert.equal(db._tables.appointments.find((r) => r.id === "appt-a").status, "booked");
});

test("an overlap on the SAME Calendly account is still flagged", async () => {
  const db = twoCalendlyAccounts([
    {
      id: "appt-b",
      organization_id: ORG,
      integration_id: "cal-b",
      provider: "calendly",
      status: "booked",
      starts_at: "2026-10-09T14:00:00.000Z",
      ends_at: "2026-10-09T14:30:00.000Z",
    },
  ]);
  const result = await handleCalendlyEvent(db, ORG, invitee(), { connectionId: "cal-b" });
  assert.equal(result.conflictId, "appt-b");
});

test("a connection id from another tenant in the URL is dropped, not recorded", async () => {
  const db = twoCalendlyAccounts();
  const result = await handleCalendlyEvent(db, ORG, invitee(), { connectionId: "cal-foreign" });
  assert.equal(result.ignored, "unknown_connection");
  assert.equal(db._tables.appointments.length, 0);
});

test("the legacy org-only URL attributes by the event's Calendly host", async () => {
  const db = twoCalendlyAccounts();
  const event = invitee({
    payload: { scheduled_event: { event_memberships: [{ user: "https://api.calendly.com/users/A" }] } },
  });
  await handleCalendlyEvent(db, ORG, event);
  assert.equal(db._tables.appointments[0].integration_id, "cal-a");
});

test("new Calendly subscriptions register a per-connection URL and replace a legacy one", async () => {
  const db = twoCalendlyAccounts();
  const conn = db._tables.calendar_integrations.find((r) => r.id === "cal-b");
  conn.webhook_subscription_uri = "https://api.calendly.com/webhook_subscriptions/OLD";
  const previousKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = "test-signing-key";
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/users/me")) {
      return new Response(JSON.stringify({ resource: { uri: "https://api.calendly.com/users/B", current_organization: "o" } }), { status: 200 });
    }
    if (String(url).endsWith("/OLD") && method === "GET") {
      return new Response(JSON.stringify({ resource: { callback_url: `https://api.example.test/api/integrations/calendly/webhook/${ORG}` } }), { status: 200 });
    }
    if (String(url).endsWith("/OLD") && method === "DELETE") return new Response(null, { status: 204 });
    if (String(url).endsWith("/webhook_subscriptions") && method === "POST") {
      return new Response(JSON.stringify({ resource: { uri: "https://api.calendly.com/webhook_subscriptions/NEW" } }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    ensureKey();
    const result = await setupCalendlyWebhook(db, ORG, conn, { redirectUri: "https://api.example.test/api/integrations/calendly/callback" });
    assert.equal(result.created, "https://api.calendly.com/webhook_subscriptions/NEW");
    assert.ok(calls.some((c) => c.url.endsWith("/OLD") && c.method === "DELETE"), "legacy subscription removed");
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post.body.url, `https://api.example.test/api/integrations/calendly/webhook/${ORG}/cal-b`);
    assert.equal(conn.webhook_subscription_uri, "https://api.calendly.com/webhook_subscriptions/NEW");
  } finally {
    global.fetch = original;
    if (previousKey === undefined) delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    else process.env.CALENDLY_WEBHOOK_SIGNING_KEY = previousKey;
  }
});

// ===========================================================================
// Owner-mode agenda endpoint (POST /api/internal/calendar/schedule)
// ===========================================================================

test("internal /schedule returns only the selected business agenda, secret-gated", async () => {
  const express = require("express");
  const supabaseModule = require("../lib/supabase");
  const db = makeFakeSupabase({
    voice_agents:[agentRow("agent-nutra","nutra")],
    calendar_integrations: [connectionRow({ id: "viral", isBookingDefault: true }), connectionRow({ id: "nutra" })],
    appointments: [
      { id: "a1", organization_id: ORG, integration_id: "viral", provider: "google", attendee_name: "Ann", status: "booked", starts_at: "2026-10-09T10:00:00.000Z", ends_at: "2026-10-09T11:00:00.000Z", timezone: "UTC" },
      { id: "a2", organization_id: ORG, integration_id: "nutra", provider: "google", attendee_name: "Bo", status: "booked", starts_at: "2026-10-09T08:00:00.000Z", ends_at: "2026-10-09T08:30:00.000Z", timezone: "Africa/Lagos" },
      { id: "a3", organization_id: ORG, integration_id: "nutra", provider: "google", attendee_name: "Cy", status: "cancelled", starts_at: "2026-10-09T14:00:00.000Z", ends_at: "2026-10-09T15:00:00.000Z", timezone: "UTC" },
      { id: "x1", organization_id: OTHER_ORG, integration_id: null, provider: "google", attendee_name: "Stranger", status: "booked", starts_at: "2026-10-09T10:00:00.000Z", ends_at: "2026-10-09T11:00:00.000Z", timezone: "UTC" },
    ],
  });
  const originalGet = supabaseModule.getSupabase;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  supabaseModule.getSupabase = () => db;
  process.env.INTERNAL_API_SECRET = "s3cret-for-tests";
  delete require.cache[require.resolve("../api/routes/internal-calendar")];
  const app = express();
  app.use(express.json());
  app.use("/api/internal/calendar", require("../api/routes/internal-calendar"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/internal/calendar/schedule`;
  const body = JSON.stringify({ organizationId: ORG, voiceAgentId:"agent-nutra", fromISO: "2026-10-09T00:00:00.000Z", toISO: "2026-10-10T00:00:00.000Z" });
  try {
    const denied = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(denied.status, 401, "no secret, no agenda");

    const ok = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agently-internal-secret": "s3cret-for-tests" },
      body,
    });
    const json = await ok.json();
    assert.equal(json.success, true);
    assert.deepEqual(json.appointments.map((a) => a.id), ["a2"], "only assigned business, no cancelled, no stranger");
    assert.deepEqual(json.appointments.map((a) => a.business), ["nutra"]);
    assert.match(json.appointments[0].localStart, /9:00 AM/);
    assert.match(json.appointments[0].localEnd, /9:30 AM/);
    assert.equal(json.appointments[0].timezone, "Africa/Lagos");
    assert.ok(!("attendee_email" in json.appointments[0]), "compact payload only");
  } finally {
    server.close();
    supabaseModule.getSupabase = originalGet;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
    delete require.cache[require.resolve("../api/routes/internal-calendar")];
  }
});

test("OAuth returnTo only accepts an in-app path (no open redirect)", () => {
  const { safeReturnTo } = require("../api/routes/integrations")._internals;
  assert.equal(safeReturnTo("/agents/abc-1"), "/agents/abc-1");
  assert.equal(safeReturnTo("/integrations"), "/integrations");
  for (const bad of ["//evil.com", "https://evil.com", "/x?y=1", "", null, "/a\b", "javascript:alert(1)", "/a/../..//evil"]) {
    assert.equal(safeReturnTo(bad), "/integrations", String(bad));
  }
});
