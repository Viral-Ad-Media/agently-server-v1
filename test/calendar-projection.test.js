"use strict";
/*
 * The column projection that keeps calendar token ciphertext off the wire.
 *
 * WHY THIS FILE EXISTS
 *
 * GET /api/integrations/status hands lib/calendar-tokens.js listConnections()
 * rows STRAIGHT to the browser (api/routes/integrations.js — res.json({...,
 * connections })), with no serializer in between to drop fields. The only
 * thing standing between the client and three encrypted-secret columns is the
 * PostgREST column list in listConnections:
 *
 *   .select(PUBLIC_CONNECTION_COLUMNS)
 *
 * calendar_integrations carries THREE ciphertext columns, not two:
 *   access_token_encrypted       (20261005_calendar_integrations.sql)
 *   refresh_token_encrypted      (20261005_calendar_integrations.sql)
 *   google_sync_token_encrypted  (20261005_calendar_phase3.sql)
 * None of them is in PUBLIC_CONNECTION_COLUMNS, and none may ever be.
 *
 * Until now nothing tested that, because test/helpers/fake-supabase.js had a
 * select() that ignored its column list and returned every column — so the
 * projection and "*" were indistinguishable to every test in this suite. The
 * fake now projects, and this file is the test that projection makes possible.
 *
 * The first group below is the security assertion. The second pins the fake's
 * own projection contract, because other changes build on this helper and a
 * regression to the old no-op would silently disarm the first group rather
 * than fail it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

/*
 * test/run.js requires every test file into ONE process and several
 * neighbours delete CALENDAR_TOKEN_KEY to prove the code fails closed without
 * it. Setting it once at require time is therefore not enough; every fixture
 * calls ensureKey(), the same way calendar-multi-account.test.js does.
 */
const TEST_KEY = "c".repeat(64);

function ensureKey() {
  if (process.env.CALENDAR_TOKEN_KEY !== TEST_KEY) process.env.CALENDAR_TOKEN_KEY = TEST_KEY;
}

ensureKey();

const { makeFakeSupabase, parseProjection } = require("./helpers/fake-supabase");
const { encryptSecret } = require("../lib/crypto");
const { listConnections, PUBLIC_CONNECTION_COLUMNS } = require("../lib/calendar-tokens");

const ORG = "org-viral-ad-media";
const OTHER_ORG = "org-nutra-wellness";

/* The columns that must never reach a browser. */
const SECRET_COLUMNS = [
  "access_token_encrypted",
  "refresh_token_encrypted",
  "google_sync_token_encrypted",
];

/**
 * A row carrying REAL ciphertext in all three secret columns, so this tests
 * the projection against the values that actually exist in the live table
 * rather than against placeholder strings.
 */
function connectionRow({
  id,
  organizationId = ORG,
  provider = "google",
  status = "connected",
  isBookingDefault = false,
  connectedAt = "2026-01-01T00:00:00.000Z",
}) {
  ensureKey();
  const binding = { organizationId, provider, connectionId: id };
  return {
    id,
    organization_id: organizationId,
    provider,
    status,
    label: `label-${id}`,
    is_booking_default: isBookingDefault,
    provider_user_id: `uid-${id}`,
    provider_user_email: `${id}@example.test`,
    provider_user_name: `name-${id}`,
    calendar_id: "primary",
    event_type_uri: null,
    event_type_name: null,
    access_token_encrypted: encryptSecret(`access-${id}`, binding),
    refresh_token_encrypted: encryptSecret(`refresh-${id}`, binding),
    google_sync_token_encrypted: encryptSecret(`sync-${id}`, binding),
    expires_at: "2099-01-01T00:00:00.000Z",
    scopes: "openid email https://www.googleapis.com/auth/calendar",
    timezone: "America/New_York",
    last_error: null,
    booking_settings: null,
    webhook_subscription_uri: null,
    google_watch_channel_id: `chan-${id}`,
    google_watch_resource_id: `res-${id}`,
    google_watch_expires_at: "2099-01-01T00:00:00.000Z",
    connected_at: connectedAt,
    updated_at: connectedAt,
  };
}

function seeded() {
  const rows = [
    connectionRow({ id: "conn-vam", isBookingDefault: true }),
    connectionRow({
      id: "conn-second",
      provider: "calendly",
      connectedAt: "2026-02-01T00:00:00.000Z",
    }),
    connectionRow({
      id: "conn-stale",
      status: "needs_reconnect",
      connectedAt: "2026-03-01T00:00:00.000Z",
    }),
    // A second tenant, so a projection change that quietly drops the org
    // filter still fails here.
    connectionRow({ id: "conn-other", organizationId: OTHER_ORG, isBookingDefault: true }),
  ];
  return { db: makeFakeSupabase({ calendar_integrations: rows }), rows };
}

// ---------------------------------------------------------------------------
// The thing that matters: no ciphertext in the tenant-facing list.
// ---------------------------------------------------------------------------

test("listConnections never returns access or refresh token ciphertext", async () => {
  const { db } = seeded();
  const connections = await listConnections(db, ORG);

  assert.equal(connections.length, 3, "should return this org's three connections");
  for (const row of connections) {
    for (const column of SECRET_COLUMNS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(row, column),
        false,
        `listConnections leaked ${column} for ${row.id}`,
      );
    }
  }
});

/**
 * Every string anywhere in the returned structure.
 *
 * Deliberately NOT JSON.stringify + includes(): encryptSecret returns a JSON
 * *string* ('{"v":1,"alg":"aes-256-gcm","iv":...}'), so once it is nested in
 * a stringified response its quotes come back escaped (\") and the raw
 * ciphertext is never a substring of the serialized form. A containment check
 * against the wire text can therefore never fail — which is the same kind of
 * silently-vacuous assertion this whole file exists to remove.
 */
function stringValues(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringValues(item, out);
  }
  return out;
}

test("no ciphertext VALUE survives the projection under any key", async () => {
  /*
   * Asserting on key names alone would pass if someone aliased a secret into
   * an innocent-looking column ("calendar_id:access_token_encrypted" is a
   * legal PostgREST select), so compare against the actual ciphertext — and
   * against its inner `data` segment, which catches ciphertext embedded in
   * some larger string rather than returned whole.
   */
  const { db, rows } = seeded();
  const values = stringValues(await listConnections(db, ORG));
  assert.ok(values.length > 0, "the list should contain some string fields to check");

  for (const row of rows) {
    for (const column of SECRET_COLUMNS) {
      const ciphertext = row[column];
      const payload = JSON.parse(ciphertext).data;
      assert.ok(payload, `fixture ${column} should carry a data segment`);
      for (const value of values) {
        assert.equal(
          value.includes(ciphertext),
          false,
          `the ${column} ciphertext of ${row.id} reached the response`,
        );
        assert.equal(
          value.includes(payload),
          false,
          `the ${column} ciphertext body of ${row.id} reached the response`,
        );
      }
    }
  }
});

test("every key listConnections returns is one the public column list names", async () => {
  const { db } = seeded();
  const allowed = new Set(parseProjection(PUBLIC_CONNECTION_COLUMNS).map(({ out }) => out));
  for (const row of await listConnections(db, ORG)) {
    for (const key of Object.keys(row)) {
      assert.equal(allowed.has(key), true, `unexpected column ${key} in the tenant-facing list`);
    }
  }
});

test("the projection still carries the fields the connections screen needs", async () => {
  /*
   * The other direction. A projection narrowed until the UI breaks is also a
   * bug, and this stops someone "fixing" a leak by selecting almost nothing.
   */
  const { db } = seeded();
  const [first] = await listConnections(db, ORG);
  for (const key of [
    "id",
    "provider",
    "status",
    "label",
    "is_booking_default",
    "provider_user_email",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(first, key),
      true,
      `projection dropped ${key}`,
    );
  }
  assert.equal(first.id, "conn-vam", "the booking default should still sort first");
});

test("PUBLIC_CONNECTION_COLUMNS names no secret column and is not a wildcard", () => {
  /*
   * A unit guard on the constant itself, independent of the fake: it catches
   * the one-character change ("*") that this file's other tests catch only
   * because the fake projects.
   */
  const names = parseProjection(PUBLIC_CONNECTION_COLUMNS);
  assert.notEqual(names, null, 'PUBLIC_CONNECTION_COLUMNS must not be "*" or empty');
  const sources = names.map(({ src }) => src);
  for (const column of SECRET_COLUMNS) {
    assert.equal(sources.includes(column), false, `PUBLIC_CONNECTION_COLUMNS names ${column}`);
  }
});

test("listConnections reads only the caller's organization", async () => {
  const { db } = seeded();
  const ids = (await listConnections(db, ORG)).map((row) => row.id);
  assert.equal(ids.includes("conn-other"), false, "another tenant's connection was returned");
});

// ---------------------------------------------------------------------------
// The fake's projection contract, which the group above depends on.
// ---------------------------------------------------------------------------

test("the fake's select() is not a no-op", async () => {
  /*
   * The canary. If select() ever goes back to ignoring its column list, this
   * fails immediately and names the reason, instead of every projection test
   * above passing vacuously.
   */
  const { db } = seeded();
  const { data } = await db.from("calendar_integrations").select("id").eq("organization_id", ORG);
  assert.deepEqual(
    Object.keys(data[0]),
    ["id"],
    "select() ignored its column list — the projection tests in this file would pass vacuously",
  );
});

test("the fake projects a comma-separated list and keeps the order asked for", async () => {
  const { db } = seeded();
  const { data } = await db
    .from("calendar_integrations")
    .select("id, provider, status")
    .eq("id", "conn-vam");
  assert.deepEqual(Object.keys(data[0]), ["id", "provider", "status"]);
});

test("a bare select(), a wildcard and a list containing one all mean every column", async () => {
  const { db } = seeded();
  for (const columns of ["*", undefined, "", "*, provider", " * "]) {
    const query = db.from("calendar_integrations").eq("id", "conn-vam");
    const { data } = await (columns === undefined ? query.select() : query.select(columns));
    assert.equal(
      Object.prototype.hasOwnProperty.call(data[0], "access_token_encrypted"),
      true,
      `select(${JSON.stringify(columns)}) should behave like a wildcard`,
    );
  }
});

test("the fake honours an alias and a cast the way PostgREST does", async () => {
  const { db } = seeded();
  const { data } = await db
    .from("calendar_integrations")
    .select("connectionId:id, provider::text")
    .eq("id", "conn-vam");
  assert.deepEqual(data[0], { connectionId: "conn-vam", provider: "google" });
});

test("a column the row does not carry is absent, not undefined", async () => {
  const { db } = seeded();
  const { data } = await db.from("calendar_integrations").select("id, nope").eq("id", "conn-vam");
  assert.deepEqual(Object.keys(data[0]), ["id"]);
});

test("filters and limit still see the whole row while the response is narrowed", async () => {
  /*
   * PostgREST evaluates the WHERE clause server-side on the full row and
   * projects only the response, so filtering on a column that is not selected
   * has to keep working — lib/calendar-tokens.js and lib/calendar-sync.js
   * both rely on that.
   */
  const { db, rows } = seeded();
  const secret = rows.find((row) => row.id === "conn-vam").access_token_encrypted;
  const { data } = await db
    .from("calendar_integrations")
    .select("id")
    .eq("access_token_encrypted", secret);
  assert.deepEqual(data, [{ id: "conn-vam" }]);

  const limited = await db
    .from("calendar_integrations")
    .select("id")
    .eq("organization_id", ORG)
    .limit(2);
  assert.equal(limited.data.length, 2);
  assert.deepEqual(Object.keys(limited.data[0]), ["id"]);
});

test("single() and maybeSingle() project too", async () => {
  const { db } = seeded();
  const one = await db
    .from("calendar_integrations")
    .select("id, label")
    .eq("id", "conn-vam")
    .single();
  assert.deepEqual(one.data, { id: "conn-vam", label: "label-conn-vam" });

  const maybe = await db
    .from("calendar_integrations")
    .select("id")
    .eq("id", "conn-second")
    .maybeSingle();
  assert.deepEqual(maybe.data, { id: "conn-second" });
});

test("a projected insert and update return only the requested columns", async () => {
  const { db } = seeded();
  const inserted = await db
    .from("calendar_integrations")
    .insert(connectionRow({ id: "conn-new", organizationId: ORG }))
    .select("id")
    .single();
  assert.equal(inserted.error, null);
  assert.deepEqual(inserted.data, { id: "conn-new" });

  const updated = await db
    .from("calendar_integrations")
    .update({ label: "renamed" })
    .eq("id", "conn-new")
    .select("id, label")
    .single();
  assert.deepEqual(updated.data, { id: "conn-new", label: "renamed" });
});

test("the unique-index checks still see the whole row under a narrow projection", async () => {
  /*
   * The projection must not weaken the constraint emulation: Postgres checks
   * its indexes on the stored row, not on what the caller asked to read back.
   */
  const { db } = seeded();
  const clash = await db
    .from("calendar_integrations")
    .update({ is_booking_default: true })
    .eq("id", "conn-second")
    .select("id");
  assert.equal(
    clash.error && clash.error.code,
    "23505",
    "a second booking default should still be rejected",
  );
  assert.equal(clash.data, null);
});
