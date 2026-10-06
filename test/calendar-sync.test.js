"use strict";
/*
 * lib/calendar-sync.js — webhook signature verification, push tokens,
 * reconciliation, and the availability cache contract.
 *
 * Provider HTTP is not exercised here (no credentials); the DB is an
 * in-memory fake implementing the query-builder chains the module uses.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  verifyCalendlySignature,
  handleCalendlyEvent,
  pushTokenFor,
  verifyPushToken,
  reconcileGoogleChanges,
  _internals: { timedRange, isOurEvent, encryptSyncToken, decryptSyncToken },
} = require("../lib/calendar-sync");
const {
  invalidateAvailabilityCache,
  _internals: {
    readAvailabilityCache,
    writeAvailabilityCache,
  },
} = require("../lib/calendar-booking");

const HEX_KEY = crypto.randomBytes(32).toString("hex");

function withEnv(env, fn) {
  const keep = {};
  for (const k of Object.keys(env)) {
    keep[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  }
}

// --- In-memory Supabase fake ------------------------------------------------

function makeFakeSupabase(seed = {}) {
  const tables = {
    appointments: [],
    tenant_notifications: [],
    calendar_integrations: [],
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
  };
  let seq = 1;

  function matches(row, filters) {
    return filters.every(([op, col, val]) => {
      if (op === "eq") return row[col] === val;
      if (op === "lt") return row[col] < val;
      if (op === "gt") return row[col] > val;
      return true;
    });
  }

  function from(tableName) {
    const rows = tables[tableName];
    const state = { filters: [], order: null, limitN: null, updateObj: null, isUpdate: false };
    const api = {
      select() {
        return api;
      },
      eq(col, val) {
        if (state.isUpdate) {
          const hit = rows.filter((r) => matches(r, [...state.filters, ["eq", col, val]]));
          for (const r of hit) Object.assign(r, state.updateObj);
          return Promise.resolve({ data: hit, error: null });
        }
        state.filters.push(["eq", col, val]);
        return api;
      },
      lt(col, val) {
        state.filters.push(["lt", col, val]);
        return api;
      },
      gt(col, val) {
        state.filters.push(["gt", col, val]);
        return api;
      },
      order(col, opts = {}) {
        state.order = { col, ascending: opts.ascending !== false };
        return api;
      },
      limit(n) {
        state.limitN = n;
        return api;
      },
      _run() {
        let out = rows.filter((r) => matches(r, state.filters));
        if (state.order) {
          const { col, ascending } = state.order;
          out = [...out].sort((a, b) =>
            ascending ? (a[col] > b[col] ? 1 : -1) : a[col] < b[col] ? 1 : -1,
          );
        }
        if (state.limitN != null) out = out.slice(0, state.limitN);
        return out;
      },
      async maybeSingle() {
        const out = api._run();
        return { data: out[0] || null, error: null };
      },
      async single() {
        const out = api._run();
        if (!out[0]) return { data: null, error: new Error("no rows") };
        return { data: out[0], error: null };
      },
      update(obj) {
        state.isUpdate = true;
        state.updateObj = obj;
        return api;
      },
      insert(obj) {
        const row = { id: `fake-${seq++}`, ...obj };
        rows.push(row);
        return {
          select() {
            return { single: async () => ({ data: row, error: null }) };
          },
        };
      },
    };
    return api;
  }

  return { from, _tables: tables };
}

// --- Calendly signature ------------------------------------------------------

function signCalendly(t, body, key) {
  const v1 = crypto.createHmac("sha256", key).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

test("calendly: valid signature verifies", () => {
  withEnv({ CALENDLY_WEBHOOK_SIGNING_KEY: "whsec-test-key" }, () => {
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event: "invitee.created" });
    assert.equal(verifyCalendlySignature(body, signCalendly(t, body, "whsec-test-key")), true);
    // Buffer bodies work too (express.raw).
    assert.equal(
      verifyCalendlySignature(Buffer.from(body), signCalendly(t, body, "whsec-test-key")),
      true,
    );
  });
});

test("calendly: wrong key, tampered body, stale and malformed signatures fail", () => {
  withEnv({ CALENDLY_WEBHOOK_SIGNING_KEY: "whsec-test-key" }, () => {
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event: "invitee.created" });
    const good = signCalendly(t, body, "whsec-test-key");
    assert.equal(verifyCalendlySignature(body, signCalendly(t, body, "other-key")), false);
    assert.equal(verifyCalendlySignature(body + "!", good), false);
    const stale = signCalendly(t - 600, body, "whsec-test-key");
    assert.equal(verifyCalendlySignature(body, stale), false);
    assert.equal(verifyCalendlySignature(body, "garbage"), false);
    assert.equal(verifyCalendlySignature(body, null), false);
  });
});

test("calendly: missing signing key fails closed", () => {
  withEnv({ CALENDLY_WEBHOOK_SIGNING_KEY: "" }, () => {
    const t = Math.floor(Date.now() / 1000);
    assert.equal(verifyCalendlySignature("{}", signCalendly(t, "{}", "x")), false);
  });
});

// --- Google push tokens -------------------------------------------------------

test("google push token round-trips and is tamper-evident", () => {
  withEnv({ CALENDAR_TOKEN_KEY: HEX_KEY }, () => {
    const token = pushTokenFor("org-123");
    assert.equal(verifyPushToken(token), "org-123");
    assert.equal(verifyPushToken(token.replace("org-123", "org-999")), null);
    assert.equal(verifyPushToken("v1.org-123.deadbeef"), null);
    assert.equal(verifyPushToken("garbage"), null);
    assert.equal(verifyPushToken(null), null);
  });
});

test("google push token without encryption key fails closed", () => {
  const keep = process.env.CALENDAR_TOKEN_KEY;
  delete process.env.CALENDAR_TOKEN_KEY;
  try {
    assert.equal(verifyPushToken("v1.org-123.abc"), null);
    assert.throws(() => pushTokenFor("org-123"));
  } finally {
    if (keep !== undefined) process.env.CALENDAR_TOKEN_KEY = keep;
  }
});

// --- Pure helpers --------------------------------------------------------------

test("timedRange and isOurEvent", () => {
  assert.deepEqual(
    timedRange({ start: { dateTime: "2026-10-07T14:00:00Z" }, end: { dateTime: "2026-10-07T14:30:00Z" } }),
    { start: "2026-10-07T14:00:00.000Z", end: "2026-10-07T14:30:00.000Z" },
  );
  assert.equal(timedRange({ start: { date: "2026-10-07" }, end: { date: "2026-10-08" } }), null); // all-day
  assert.equal(timedRange(null), null);
  assert.ok(isOurEvent({ id: "agentlyabc123" }));
  assert.ok(!isOurEvent({ id: "xyz" }));
});

test("sync token encrypt/decrypt round-trips with tenant binding", () => {
  withEnv({ CALENDAR_TOKEN_KEY: HEX_KEY }, () => {
    const enc = encryptSyncToken("sync-abc", "org-1", "conn-1");
    assert.equal(decryptSyncToken(enc, "org-1", "conn-1"), "sync-abc");
    assert.throws(() => decryptSyncToken(enc, "org-2", "conn-1"));
  });
});

// --- Availability cache ---------------------------------------------------------

test("availability cache: write/read/invalidate, failures never cached", () => {
  const org = `org-cache-${Date.now()}`;
  const good = { success: true, provider: "google", slots: [{ start: "x" }] };
  writeAvailabilityCache(org, "google", "2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z", good);
  const hit = readAvailabilityCache(org, "google", "2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z");
  assert.equal(hit, good);
  // Different window misses.
  assert.equal(readAvailabilityCache(org, "google", "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"), null);
  // Failures are not cached.
  writeAvailabilityCache(org, "google", "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z", { success: false });
  assert.equal(readAvailabilityCache(org, "google", "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"), null);
  // Invalidation clears only this org.
  const other = `org-cache-other-${Date.now()}`;
  writeAvailabilityCache(other, "google", "2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z", good);
  invalidateAvailabilityCache(org);
  assert.equal(readAvailabilityCache(org, "google", "2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z"), null);
  assert.equal(readAvailabilityCache(other, "google", "2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z"), good);
  invalidateAvailabilityCache(other);
});

// --- Calendly reconciliation -----------------------------------------------------

function inviteeEvent(kind, overrides = {}) {
  return {
    event: kind,
    payload: {
      uri: "https://api.calendly.com/invitees/INV1",
      event: "https://api.calendly.com/scheduled_events/EV1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      start_time: "2026-10-07T14:00:00.000Z",
      end_time: "2026-10-07T14:30:00.000Z",
      cancel_url: "https://calendly.com/cancel/1",
      ...overrides,
    },
  };
}

test("calendly invitee.created confirms our pending appointment", async () => {
  const db = makeFakeSupabase({
    appointments: [
      {
        id: "appt-1",
        organization_id: "org-1",
        provider: "calendly",
        status: "pending",
        external_event_id: null,
        external_event_uri: "https://api.calendly.com/scheduled_events/EV1",
        starts_at: "2026-10-07T14:00:00.000Z",
        ends_at: "2026-10-07T14:30:00.000Z",
      },
    ],
  });
  const result = await handleCalendlyEvent(db, "org-1", inviteeEvent("invitee.created"));
  assert.equal(result.reconciled, "confirmed");
  assert.equal(db._tables.appointments[0].status, "booked");
  assert.equal(db._tables.appointments[0].external_event_id, "https://api.calendly.com/invitees/INV1");
  assert.equal(db._tables.tenant_notifications.length, 0); // confirmations stay quiet
});

test("calendly invitee.canceled marks our booking cancelled and notifies", async () => {
  const db = makeFakeSupabase({
    appointments: [
      {
        id: "appt-1",
        organization_id: "org-1",
        provider: "calendly",
        status: "booked",
        attendee_name: "Ada Lovelace",
        external_event_id: "https://api.calendly.com/invitees/INV1",
        starts_at: "2026-10-07T14:00:00.000Z",
        timezone: "America/New_York",
      },
    ],
  });
  const result = await handleCalendlyEvent(db, "org-1", inviteeEvent("invitee.canceled"));
  assert.equal(result.reconciled, "cancelled");
  assert.equal(db._tables.appointments[0].status, "cancelled");
  assert.equal(db._tables.tenant_notifications.length, 1);
  assert.equal(db._tables.tenant_notifications[0].type, "appointment_cancelled");
});

test("calendly external booking is recorded quietly; overlap flags conflict", async () => {
  const db = makeFakeSupabase({
    appointments: [
      {
        id: "appt-agent",
        organization_id: "org-1",
        provider: "calendly",
        status: "booked",
        attendee_name: "Agent Caller",
        starts_at: "2026-10-07T14:00:00.000Z",
        ends_at: "2026-10-07T14:30:00.000Z",
        timezone: "America/New_York",
      },
    ],
  });
  const result = await handleCalendlyEvent(db, "org-1", inviteeEvent("invitee.created"));
  assert.equal(result.reconciled, "external_recorded");
  assert.ok(result.conflictId, "overlap should flag the agent booking");
  const agentRow = db._tables.appointments.find((r) => r.id === "appt-agent");
  assert.equal(agentRow.status, "conflicted"); // flagged for review, not auto-cancelled
  const notes = db._tables.tenant_notifications;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "appointment_conflict");
});

test("calendly external booking without overlap is recorded silently", async () => {
  const db = makeFakeSupabase({ appointments: [] });
  const result = await handleCalendlyEvent(
    db,
    "org-1",
    inviteeEvent("invitee.created", {
      uri: "https://api.calendly.com/invitees/INV9",
      start_time: "2026-10-08T14:00:00.000Z",
      end_time: "2026-10-08T14:30:00.000Z",
    }),
  );
  assert.equal(result.reconciled, "external_recorded");
  assert.equal(result.conflictId, null);
  assert.equal(db._tables.appointments.length, 1);
  assert.equal(db._tables.appointments[0].raw.origin, "external");
  assert.equal(db._tables.tenant_notifications.length, 0);
});

// --- Google reconciliation -------------------------------------------------------

function googleItem(overrides = {}) {
  return {
    id: "ext-event-1",
    status: "confirmed",
    summary: "Dentist",
    start: { dateTime: "2026-10-07T14:00:00Z" },
    end: { dateTime: "2026-10-07T15:00:00Z" },
    ...overrides,
  };
}

test("google: externally deleted booking is marked cancelled and notified", async () => {
  const db = makeFakeSupabase({
    appointments: [
      {
        id: "appt-1",
        organization_id: "org-1",
        provider: "google",
        status: "booked",
        attendee_name: "Ada",
        external_event_id: "our-event-1",
        starts_at: "2026-10-07T14:00:00.000Z",
        timezone: "America/New_York",
      },
    ],
  });
  const outcome = await reconcileGoogleChanges(db, "org-1", {}, [
    { id: "our-event-1", status: "cancelled", start: { dateTime: "2026-10-07T14:00:00Z" }, end: { dateTime: "2026-10-07T14:30:00Z" } },
  ]);
  assert.equal(outcome.cancelled, 1);
  assert.equal(db._tables.appointments[0].status, "cancelled");
  assert.equal(db._tables.tenant_notifications[0].type, "appointment_cancelled");
});

test("google: external event overlapping our booking flags conflict", async () => {
  const db = makeFakeSupabase({
    appointments: [
      {
        id: "appt-1",
        organization_id: "org-1",
        provider: "google",
        status: "booked",
        attendee_name: "Ada",
        external_event_id: "agentlyabc123",
        starts_at: "2026-10-07T14:00:00.000Z",
        ends_at: "2026-10-07T14:30:00.000Z",
        timezone: "America/New_York",
      },
    ],
  });
  const outcome = await reconcileGoogleChanges(db, "org-1", {}, [googleItem()]);
  assert.equal(outcome.conflicts, 1);
  assert.equal(db._tables.appointments[0].status, "conflicted");
  assert.equal(db._tables.tenant_notifications[0].type, "appointment_conflict");
});

test("google: non-overlapping external events are ignored", async () => {
  const db = makeFakeSupabase({
    appointments: [
      {
        id: "appt-1",
        organization_id: "org-1",
        provider: "google",
        status: "booked",
        external_event_id: "agentlyabc123",
        starts_at: "2026-10-07T18:00:00.000Z",
        ends_at: "2026-10-07T18:30:00.000Z",
      },
    ],
  });
  const outcome = await reconcileGoogleChanges(db, "org-1", {}, [googleItem()]);
  assert.equal(outcome.conflicts, 0);
  assert.equal(outcome.cancelled, 0);
  assert.equal(db._tables.appointments[0].status, "booked");
  assert.equal(db._tables.tenant_notifications.length, 0);
});
