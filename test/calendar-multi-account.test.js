"use strict";
/*
 * Multi-account calendar support.
 *
 * One Agently login runs several businesses, each with its own Google
 * account. calendar_integrations therefore holds one row per connected
 * ACCOUNT, and three behaviours follow from that:
 *
 *   - availability merges ACROSS accounts: a slot is only offered when the
 *     owner is free on every calendar they have connected (design point 4);
 *   - booking writes only to the is_booking_default connection, and removing
 *     that connection promotes another (points 5 and 7);
 *   - the bookings feed merges every account into one labelled list (point 6),
 *     scoped to the caller's own organization and nothing else.
 *
 * The last of those is the one with teeth. All five calendar tables are
 * RLS-enabled with ZERO policies and the API uses the service role, so
 * Postgres will not stop a query that forgets its tenant — the
 * .eq("organization_id", ...) in application code is the entire boundary.
 * This codebase has had a live cross-tenant exposure before (65 leads), so
 * the scoping test below is written to FAIL if that filter is removed: it
 * seeds a second organization whose rows would be returned by an unscoped
 * read, and asserts on identity, not just on count.
 *
 * saveConnection's own keying is covered in calendar-save-connection.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

/*
 * test/run.js requires every test file into ONE process, and several of the
 * neighbours delete CALENDAR_TOKEN_KEY to assert that the code fails closed
 * without it (integrations-oauth and calendar-sync both do). Setting the key
 * once at require time is therefore not enough — by the time these tests run
 * a neighbour may have removed it, and the fixtures below encrypt real
 * ciphertext. ensureKey() is called by every fixture so this file works the
 * same under `node --test` on its own and under the shared runner.
 */
const TEST_KEY = "b".repeat(64);

function ensureKey() {
  if (process.env.CALENDAR_TOKEN_KEY !== TEST_KEY) process.env.CALENDAR_TOKEN_KEY = TEST_KEY;
}

ensureKey();

const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { encryptSecret } = require("../lib/crypto");
const {
  getConnection,
  getConnectionById,
  getBookingConnection,
  listConnectionRows,
  setBookingDefault,
  renameConnection,
  promoteBookingDefault,
} = require("../lib/calendar-tokens");
const {
  checkAvailability,
  cancelAppointment,
  listMergedBookings,
  getActiveProvider,
  getCrossAccountBusy,
  invalidateAvailabilityCache,
} = require("../lib/calendar-booking");

const ORG = "org-nutra";
const OTHER_ORG = "org-someone-else";

// --- fixtures ---------------------------------------------------------------

/**
 * A connection row with real ciphertext, so the per-connection token path is
 * genuinely exercised rather than stubbed around.
 */
function connectionRow({
  id,
  organizationId = ORG,
  provider = "google",
  label,
  calendarId = "primary",
  isBookingDefault = false,
  status = "connected",
  connectedAt = "2026-01-01T00:00:00.000Z",
  providerUserId = null,
  email = null,
  bookingSettings = null,
}) {
  ensureKey();
  const binding = { organizationId, provider, connectionId: id };
  return {
    id,
    organization_id: organizationId,
    provider,
    status,
    label: label || id,
    is_booking_default: isBookingDefault,
    provider_user_id: providerUserId || `uid-${id}`,
    provider_user_email: email || `${id}@example.test`,
    provider_user_name: label || id,
    calendar_id: calendarId,
    event_type_uri: provider === "calendly" ? "https://api.calendly.com/event_types/et-1" : null,
    event_type_name: provider === "calendly" ? "Consult" : null,
    access_token_encrypted: encryptSecret(`access-${id}`, binding),
    refresh_token_encrypted: encryptSecret(`refresh-${id}`, binding),
    // Far future, so no refresh is attempted and no HTTP call is needed.
    expires_at: "2099-01-01T00:00:00.000Z",
    scopes: "openid email",
    timezone: "America/New_York",
    booking_settings: bookingSettings,
    last_error: null,
    connected_at: connectedAt,
    updated_at: connectedAt,
  };
}

function appointmentRow({
  id,
  organizationId = ORG,
  integrationId,
  startsAt,
  endsAt,
  status = "booked",
  attendeeName = "Caller",
  provider = "google",
}) {
  return {
    id,
    organization_id: organizationId,
    integration_id: integrationId,
    provider,
    title: null,
    attendee_name: attendeeName,
    attendee_email: null,
    attendee_phone: null,
    starts_at: startsAt,
    ends_at: endsAt,
    timezone: "America/New_York",
    status,
    cancel_url: null,
    reschedule_url: null,
    created_at: startsAt,
  };
}

/**
 * Stub global fetch with a freeBusy responder keyed by bearer token, so each
 * connection can return different busy time. Returns a restore function and
 * the recorded calls.
 */
function stubFreeBusy(busyByToken) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const token = String((options.headers || {}).authorization || "").replace("Bearer ", "");
    calls.push({ url: String(url), token });
    if (String(url).includes("/freeBusy")) {
      const body = JSON.parse(options.body || "{}");
      const calendarId = ((body.items || [])[0] || {}).id || "primary";
      const busy = busyByToken[token] || [];
      return new Response(JSON.stringify({ calendars: { [calendarId]: { busy } } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return { restore: () => { global.fetch = original; }, calls };
}

/**
 * checkAvailability memoises per (organization, provider, window) in module
 * scope, and these tests deliberately reuse one organization id and one
 * window so the merge is the only thing that differs. Without clearing the
 * cache the second test would assert against the first test's answer — which
 * it did, and the failure looked like a scoping bug in the product rather
 * than bleed between cases.
 */
async function freshAvailability(db, organizationId, from, to) {
  ensureKey();
  invalidateAvailabilityCache(organizationId);
  return checkAvailability(organizationId, { from: new Date(from), to: new Date(to) }, db);
}

// Working hours wide enough that the slot grid is driven by busy time, not by
// the calendar's office hours.
const ALL_DAY = {
  slotMinutes: 60,
  windowDays: 1,
  workingHours: {
    mon: [["00:00", "23:00"]],
    tue: [["00:00", "23:00"]],
    wed: [["00:00", "23:00"]],
    thu: [["00:00", "23:00"]],
    fri: [["00:00", "23:00"]],
    sat: [["00:00", "23:00"]],
    sun: [["00:00", "23:00"]],
  },
};

// ===========================================================================
// Connection selection
// ===========================================================================

test("listConnectionRows returns every account, default first, and only this org's", async () => {
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "second", connectedAt: "2026-02-01T00:00:00.000Z" }),
      connectionRow({ id: "first", isBookingDefault: true, connectedAt: "2026-01-01T00:00:00.000Z" }),
      connectionRow({ id: "foreign", organizationId: OTHER_ORG, isBookingDefault: true }),
    ],
  });
  const rows = await listConnectionRows(db, ORG);
  assert.deepEqual(rows.map((r) => r.id), ["first", "second"]);
  assert.ok(!rows.some((r) => r.organization_id === OTHER_ORG), "another org's row must never appear");
});

test("getConnection no longer throws when an org has several accounts of one provider", async () => {
  /*
   * This is what the old .maybeSingle() did here: PostgREST answers PGRST116
   * for "multiple rows returned", so the first tenant to connect a second
   * Google account broke availability, booking and the settings page at once.
   * The fake reproduces that error code, so this test would fail if the
   * one-row lookup came back.
   */
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "a", isBookingDefault: true }),
      connectionRow({ id: "b" }),
      connectionRow({ id: "c" }),
    ],
  });
  const row = await getConnection(db, ORG, "google");
  assert.equal(row.id, "a", "the booking default is the row a provider-shaped caller wants");
});

test("getConnectionById refuses another organization's connection", async () => {
  const db = makeFakeSupabase({
    calendar_integrations: [connectionRow({ id: "foreign", organizationId: OTHER_ORG })],
  });
  // The id is correct and exists; only the tenant is wrong. RLS would not
  // stop this, so the application filter has to.
  assert.equal(await getConnectionById(db, ORG, "foreign"), null);
  assert.ok(await getConnectionById(db, OTHER_ORG, "foreign"));
});

test("getBookingConnection honours is_booking_default over provider preference", async () => {
  // Calendly used to win unconditionally. An explicit default must beat it.
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "calendly-row", provider: "calendly" }),
      connectionRow({ id: "google-row", provider: "google", isBookingDefault: true }),
    ],
  });
  const row = await getBookingConnection(db, ORG);
  assert.equal(row.id, "google-row");

  const active = await getActiveProvider(db, ORG);
  assert.equal(active.provider, "google");
  assert.equal(active.connection.id, "google-row");
});

test("with no default recorded, a healthy google row beats a broken calendly one", async () => {
  /*
   * The pre-migration fallback. A plain provider-ordered pick would return
   * the unusable Calendly row and report "not connected" for an org that has
   * a perfectly good Google calendar.
   */
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "calendly-broken", provider: "calendly", status: "error" }),
      connectionRow({ id: "google-ok", provider: "google" }),
    ],
  });
  const row = await getBookingConnection(db, ORG);
  assert.equal(row.id, "google-ok");
});

test("setBookingDefault moves the flag and never leaves two defaults", async () => {
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "a", isBookingDefault: true }),
      connectionRow({ id: "b" }),
    ],
  });
  const updated = await setBookingDefault(db, ORG, "b");
  assert.equal(updated.id, "b");
  assert.equal(updated.is_booking_default, true);

  const defaults = db._rows("calendar_integrations").filter((r) => r.is_booking_default);
  assert.equal(defaults.length, 1, "the partial unique index allows exactly one");
  assert.equal(defaults[0].id, "b");
});

test("setBookingDefault cannot be aimed at another organization's connection", async () => {
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "mine", isBookingDefault: true }),
      connectionRow({ id: "foreign", organizationId: OTHER_ORG, isBookingDefault: true }),
    ],
  });
  assert.equal(await setBookingDefault(db, ORG, "foreign"), null);
  const foreign = db._rows("calendar_integrations").find((r) => r.id === "foreign");
  assert.equal(foreign.is_booking_default, true, "the other tenant's flag must be untouched");
  const mine = db._rows("calendar_integrations").find((r) => r.id === "mine");
  assert.equal(mine.is_booking_default, true, "and ours must not be cleared on a failed call");
});

test("renaming a connection is scoped to the organization", async () => {
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "mine", label: "Google Calendar" }),
      connectionRow({ id: "foreign", organizationId: OTHER_ORG, label: "Their Business" }),
    ],
  });
  const renamed = await renameConnection(db, ORG, "mine", "  Nutra Wellness  ");
  assert.equal(renamed.label, "Nutra Wellness", "trimmed");

  assert.equal(await renameConnection(db, ORG, "foreign", "Hijacked"), null);
  assert.equal(
    db._rows("calendar_integrations").find((r) => r.id === "foreign").label,
    "Their Business",
  );

  await assert.rejects(
    () => renameConnection(db, ORG, "mine", "   "),
    (err) => err.code === "invalid_label",
  );
});

test("removing the booking default promotes another connection", async () => {
  // Design point 7: the agent must never be left with nowhere to book.
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "survivor", connectedAt: "2026-03-01T00:00:00.000Z" }),
      connectionRow({ id: "older-survivor", connectedAt: "2026-02-01T00:00:00.000Z" }),
    ],
  });
  assert.equal(await getBookingConnection(db, ORG).then((r) => r.is_booking_default), false);

  const promoted = await promoteBookingDefault(db, ORG);
  assert.equal(promoted.id, "older-survivor", "the oldest healthy connection is promoted");
  assert.equal(db._rows("calendar_integrations").filter((r) => r.is_booking_default).length, 1);
});

test("promotion is a no-op when a default already exists, and when nothing is left", async () => {
  const withDefault = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "a", isBookingDefault: true }),
      connectionRow({ id: "b" }),
    ],
  });
  assert.equal((await promoteBookingDefault(withDefault, ORG)).id, "a");

  const empty = makeFakeSupabase({ calendar_integrations: [] });
  assert.equal(await promoteBookingDefault(empty, ORG), null);

  const onlyDisconnected = makeFakeSupabase({
    calendar_integrations: [connectionRow({ id: "gone", status: "disconnected" })],
  });
  assert.equal(
    await promoteBookingDefault(onlyDisconnected, ORG),
    null,
    "a disconnected row is not a booking target",
  );
});

// ===========================================================================
// Availability merge (design point 4)
// ===========================================================================

test("a slot busy on ANOTHER connected calendar is not offered", async () => {
  /*
   * The whole point of the feature. The booking calendar is free at 15:00
   * UTC; the tenant's other business has an event there. One person, one
   * diary — so 15:00 must disappear from the list.
   */
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", label: "Nutra Wellness", isBookingDefault: true, bookingSettings: ALL_DAY }),
      connectionRow({ id: "other-biz", label: "Other Business", calendarId: "other@example.test" }),
    ],
  });

  const busy = stubFreeBusy({
    // The booking calendar is wide open.
    "access-nutra": [],
    // The other business is booked 15:00–16:00 UTC.
    "access-other-biz": [
      { start: "2026-10-08T15:00:00.000Z", end: "2026-10-08T16:00:00.000Z" },
    ],
  });
  try {
    const result = await freshAvailability(
      db,
      ORG,
      "2026-10-08T12:00:00.000Z",
      "2026-10-08T20:00:00.000Z",
    );
    assert.equal(result.success, true);
    const starts = result.slots.map((s) => s.start);
    assert.ok(starts.length > 0, "there should still be slots outside the busy hour");
    assert.ok(
      starts.includes("2026-10-08T14:00:00.000Z"),
      "a slot free on both calendars is still offered",
    );
    assert.ok(
      !starts.includes("2026-10-08T15:00:00.000Z"),
      "a slot busy on the OTHER account must not be offered",
    );
    assert.equal(result.mergedAcrossAccounts, 1, "and the result says a merge happened");

    // Each account's freeBusy must be asked with ITS OWN token — the tokens
    // decrypt only under their own connection id, so a shared token would
    // mean the wrong calendar was consulted.
    const tokens = busy.calls.filter((c) => c.url.includes("/freeBusy")).map((c) => c.token);
    assert.ok(tokens.includes("access-nutra"));
    assert.ok(tokens.includes("access-other-biz"));
  } finally {
    busy.restore();
  }
});

test("a Calendly booking on another account also blocks the slot", async () => {
  /*
   * Calendly exposes available times, not busy ones, so its connections
   * contribute busy time through Agently's own appointments rows. Without
   * that, the tenant's Calendly business would be invisible to the merge.
   */
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", isBookingDefault: true, bookingSettings: ALL_DAY }),
      connectionRow({ id: "cal-biz", provider: "calendly" }),
    ],
    appointments: [
      appointmentRow({
        id: "appt-cal",
        integrationId: "cal-biz",
        provider: "calendly",
        startsAt: "2026-10-08T15:00:00.000Z",
        endsAt: "2026-10-08T16:00:00.000Z",
      }),
    ],
  });
  const busy = stubFreeBusy({ "access-nutra": [] });
  try {
    const result = await freshAvailability(
      db,
      ORG,
      "2026-10-08T12:00:00.000Z",
      "2026-10-08T20:00:00.000Z",
    );
    const starts = result.slots.map((s) => s.start);
    assert.ok(!starts.includes("2026-10-08T15:00:00.000Z"), "the Calendly hour must be blocked");
    assert.ok(starts.includes("2026-10-08T17:00:00.000Z"), "other hours remain open");
  } finally {
    busy.restore();
  }
});

test("the merge reads only this organization's connections and appointments", async () => {
  // Another tenant busy at 15:00 must not shrink our availability.
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", isBookingDefault: true, bookingSettings: ALL_DAY }),
      connectionRow({ id: "foreign", organizationId: OTHER_ORG, calendarId: "them@example.test" }),
    ],
    appointments: [
      appointmentRow({
        id: "their-appt",
        organizationId: OTHER_ORG,
        integrationId: "foreign",
        startsAt: "2026-10-08T15:00:00.000Z",
        endsAt: "2026-10-08T16:00:00.000Z",
      }),
    ],
  });
  const busy = stubFreeBusy({
    "access-nutra": [],
    "access-foreign": [{ start: "2026-10-08T15:00:00.000Z", end: "2026-10-08T16:00:00.000Z" }],
  });
  try {
    const result = await freshAvailability(
      db,
      ORG,
      "2026-10-08T12:00:00.000Z",
      "2026-10-08T20:00:00.000Z",
    );
    assert.ok(
      result.slots.map((s) => s.start).includes("2026-10-08T15:00:00.000Z"),
      "another tenant's busy time must not affect ours",
    );
    const tokens = busy.calls.map((c) => c.token);
    assert.ok(!tokens.includes("access-foreign"), "we must never touch another tenant's calendar");
  } finally {
    busy.restore();
  }
});

test("one unusable account degrades the merge instead of emptying the day", async () => {
  /*
   * If a second account's freeBusy fails we could either offer slots that may
   * clash or offer nothing at all. Offering nothing turns one expired token
   * into "the business has no availability", so the failure is absorbed and
   * reported rather than propagated.
   */
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", isBookingDefault: true, bookingSettings: ALL_DAY }),
      connectionRow({ id: "broken" }),
    ],
  });
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const token = String((options.headers || {}).authorization || "").replace("Bearer ", "");
    if (token === "access-broken") throw new Error("network down");
    const body = JSON.parse(options.body || "{}");
    const calendarId = ((body.items || [])[0] || {}).id || "primary";
    return new Response(JSON.stringify({ calendars: { [calendarId]: { busy: [] } } }), { status: 200 });
  };
  try {
    const result = await freshAvailability(
      db,
      ORG,
      "2026-10-08T12:00:00.000Z",
      "2026-10-08T20:00:00.000Z",
    );
    assert.equal(result.success, true);
    assert.ok(result.slots.length > 0, "a broken sibling account must not erase availability");
  } finally {
    global.fetch = original;
  }
});

test("getCrossAccountBusy labels each block with the connection it came from", async () => {
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", isBookingDefault: true }),
      connectionRow({ id: "other-biz", label: "Other Business" }),
    ],
    appointments: [
      appointmentRow({
        id: "appt-1",
        integrationId: "other-biz",
        startsAt: "2026-10-08T15:00:00.000Z",
        endsAt: "2026-10-08T16:00:00.000Z",
      }),
    ],
  });
  const busy = stubFreeBusy({ "access-other-biz": [] });
  try {
    const { blocks, connectionsChecked } = await getCrossAccountBusy(db, ORG, {
      from: new Date("2026-10-08T00:00:00.000Z"),
      to: new Date("2026-10-09T00:00:00.000Z"),
      exceptConnectionId: "nutra",
    });
    assert.equal(connectionsChecked, 1, "the booking connection itself is excluded");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].connection_id, "other-biz");
    assert.equal(blocks[0].label, "Other Business");
  } finally {
    busy.restore();
  }
});

// ===========================================================================
// Merged bookings feed (design point 6)
// ===========================================================================

function feedFixture() {
  return makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", label: "Nutra Wellness", isBookingDefault: true }),
      connectionRow({ id: "other-biz", label: "Other Business" }),
      connectionRow({ id: "foreign", organizationId: OTHER_ORG, label: "Rival Co" }),
    ],
    appointments: [
      appointmentRow({
        id: "appt-nutra",
        integrationId: "nutra",
        attendeeName: "Our Caller",
        startsAt: "2026-10-08T15:00:00.000Z",
        endsAt: "2026-10-08T16:00:00.000Z",
      }),
      appointmentRow({
        id: "appt-other",
        integrationId: "other-biz",
        attendeeName: "Our Other Caller",
        startsAt: "2026-10-08T09:00:00.000Z",
        endsAt: "2026-10-08T10:00:00.000Z",
      }),
      appointmentRow({
        id: "appt-foreign",
        organizationId: OTHER_ORG,
        integrationId: "foreign",
        attendeeName: "Someone Else's Patient",
        startsAt: "2026-10-08T11:00:00.000Z",
        endsAt: "2026-10-08T12:00:00.000Z",
      }),
    ],
  });
}

test("the merged feed returns every account's bookings in one labelled list", async () => {
  const db = feedFixture();
  const { bookings, connections } = await listMergedBookings(ORG, {}, db);

  assert.deepEqual(
    bookings.map((b) => b.id),
    ["appt-other", "appt-nutra"],
    "chronological, regardless of which account they belong to",
  );
  assert.equal(bookings[0].connectionLabel, "Other Business");
  assert.equal(bookings[1].connectionLabel, "Nutra Wellness");
  assert.equal(bookings[1].isBookingDefault, true);
  assert.deepEqual(
    connections.map((c) => c.label).sort(),
    ["Nutra Wellness", "Other Business"],
    "the filter chips cover this org's accounts only",
  );
  // Ciphertext must never reach the client through this route, and the field
  // names must match services/api.ts MergedBooking / MergedBookingsResponse —
  // the frontend is already written against them.
  for (const booking of bookings) {
    assert.ok(!("access_token_encrypted" in booking));
    assert.ok(!("refresh_token_encrypted" in booking));
    for (const field of [
      "id",
      "integration_id",
      "provider",
      "starts_at",
      "ends_at",
      "status",
      "connectionId",
      "connectionLabel",
      "connectionEmail",
      "isBookingDefault",
    ]) {
      assert.ok(field in booking, `MergedBooking is missing ${field}`);
    }
  }
  for (const summary of connections) {
    for (const field of ["id", "provider", "label", "email", "status", "isBookingDefault"]) {
      assert.ok(field in summary, `CalendarConnectionSummary is missing ${field}`);
    }
    assert.ok(summary.label, "label is never blank: it falls back to the email, then the provider");
    assert.ok(!("access_token_encrypted" in summary));
  }
});

test("the merged feed NEVER returns another organization's appointments", async () => {
  /*
   * THE REGRESSION TEST THAT MATTERS.
   *
   * It is written to fail if the .eq("organization_id", organizationId) in
   * listMergedBookings is removed: the fixture seeds a second tenant whose
   * appointment sorts into the middle of ours, so an unscoped read returns
   * three rows with "appt-foreign" among them. The assertions name that row
   * rather than only counting, so no plausible edit makes it pass by
   * accident. (Verified by removing the filter: this test failed with
   * "another organization's appointment leaked into the feed" while the rest
   * of the suite stayed green — which is exactly why it exists.)
   *
   * RLS cannot save us here. All five calendar tables are RLS-enabled with
   * zero policies and the API is the service role, so an unscoped query
   * returns every tenant's rows.
   */
  const db = feedFixture();
  const { bookings, total } = await listMergedBookings(ORG, {}, db);

  const ids = bookings.map((b) => b.id);
  assert.ok(
    !ids.includes("appt-foreign"),
    "another organization's appointment leaked into the feed",
  );
  assert.deepEqual(ids, ["appt-other", "appt-nutra"]);
  assert.equal(total, 2, "the total must count only this organization's rows");
  for (const booking of bookings) {
    assert.ok(
      ["nutra", "other-biz"].includes(booking.connectionId),
      `booking ${booking.id} is attached to a connection this org does not own`,
    );
  }
  assert.ok(
    !bookings.some((b) => b.attendee_name === "Someone Else's Patient"),
    "no attendee from another tenant may appear",
  );

  // And the other tenant's own feed is equally narrow, so the scoping is a
  // filter rather than a hard-coded exclusion of this one fixture.
  const theirs = await listMergedBookings(OTHER_ORG, {}, db);
  assert.deepEqual(theirs.bookings.map((b) => b.id), ["appt-foreign"]);
});

test("a connectionId from the client cannot aim the feed at another org", async () => {
  const db = feedFixture();
  const result = await listMergedBookings(ORG, { connectionId: "foreign" }, db);
  assert.deepEqual(result.bookings, [], "a foreign connection id yields nothing");
  assert.equal(result.total, 0);

  const mine = await listMergedBookings(ORG, { connectionId: "other-biz" }, db);
  assert.deepEqual(mine.bookings.map((b) => b.id), ["appt-other"]);
});

test("the merged feed refuses to run without an organization id", async () => {
  // An unscoped read of appointments is the 65-lead exposure again, so a
  // missing tenant has to be a loud failure and not a full-table scan.
  const db = feedFixture();
  for (const bad of [null, undefined, "", 0]) {
    await assert.rejects(
      () => listMergedBookings(bad, {}, db),
      (err) => err.code === "missing_organization",
      `organizationId ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("the merged feed filters by window and status without losing its scoping", async () => {
  const db = feedFixture();
  const windowed = await listMergedBookings(
    ORG,
    { from: "2026-10-08T12:00:00.000Z", to: "2026-10-09T00:00:00.000Z" },
    db,
  );
  assert.deepEqual(windowed.bookings.map((b) => b.id), ["appt-nutra"]);
  assert.ok(!windowed.bookings.some((b) => b.id === "appt-foreign"));

  const cancelled = await listMergedBookings(ORG, { status: "cancelled" }, db);
  assert.deepEqual(cancelled.bookings, []);

  /*
   * status is matched exactly and there is no "all" sentinel — a client that
   * wants every status omits the parameter. Accepting one would mean a
   * misspelled status quietly returned everything.
   */
  const sentinel = await listMergedBookings(ORG, { status: "all" }, db);
  assert.deepEqual(sentinel.bookings, [], '"all" is a status, not a wildcard');
});

// ===========================================================================
// Cancellation targets the booking's own connection
// ===========================================================================

test("cancelling deletes the event from the account that holds it, not the default", async () => {
  /*
   * The silent half-cancellation. Resolving the "active" connection sends
   * account B's event id to account A's calendar with A's token; Google
   * answers 404, 404 is tolerated here because the event may genuinely be
   * gone, so the row was marked cancelled while the real event stayed on the
   * caller's calendar. Nobody saw an error and the caller still turned up.
   *
   * appointments.integration_id records which account took the booking, so
   * assert the DELETE went to THAT calendar with THAT token.
   */
  ensureKey();
  const db = makeFakeSupabase({
    calendar_integrations: [
      connectionRow({ id: "nutra", isBookingDefault: true, calendarId: "nutra@example.test" }),
      connectionRow({ id: "other-biz", calendarId: "other@example.test" }),
    ],
    appointments: [
      {
        ...appointmentRow({
          id: "appt-on-other",
          integrationId: "other-biz",
          startsAt: "2026-10-08T15:00:00.000Z",
          endsAt: "2026-10-08T16:00:00.000Z",
        }),
        external_event_id: "agnt0000000000000000001",
      },
    ],
  });

  const deletes = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const token = String((options.headers || {}).authorization || "").replace("Bearer ", "");
    if ((options.method || "GET") === "DELETE") deletes.push({ url: String(url), token });
    // 204 is a null-body status: passing a body to the Response constructor
    // throws, and the throw would surface as a provider error from inside
    // providerFetch rather than as a stub mistake.
    return new Response(null, { status: 204 });
  };
  try {
    const result = await cancelAppointment(ORG, "appt-on-other", db);
    assert.equal(result.success, true);
    assert.equal(deletes.length, 1, "exactly one provider delete");
    assert.ok(
      deletes[0].url.includes(encodeURIComponent("other@example.test")),
      `the delete went to the wrong calendar: ${deletes[0].url}`,
    );
    assert.equal(
      deletes[0].token,
      "access-other-biz",
      "and it must use that connection's own token, which is the only one that can decrypt for it",
    );
  } finally {
    global.fetch = original;
  }
});

test("cancelling refuses an appointment belonging to another organization", async () => {
  ensureKey();
  const db = makeFakeSupabase({
    calendar_integrations: [connectionRow({ id: "foreign", organizationId: OTHER_ORG, isBookingDefault: true })],
    appointments: [
      appointmentRow({
        id: "their-appt",
        organizationId: OTHER_ORG,
        integrationId: "foreign",
        startsAt: "2026-10-08T15:00:00.000Z",
        endsAt: "2026-10-08T16:00:00.000Z",
      }),
    ],
  });
  const original = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    // 204 is a null-body status: passing a body to the Response constructor
    // throws, and the throw would surface as a provider error from inside
    // providerFetch rather than as a stub mistake.
    return new Response(null, { status: 204 });
  };
  try {
    const result = await cancelAppointment(ORG, "their-appt", db);
    assert.equal(result.success, false);
    assert.equal(result.code, "validation_error");
    assert.equal(called, false, "no provider call may be made for another tenant's booking");
    assert.equal(
      db._rows("appointments").find((a) => a.id === "their-appt").status,
      "booked",
      "and their row must be untouched",
    );
  } finally {
    global.fetch = original;
  }
});
