"use strict";
/*
 * saveConnection is the function the whole calendar integration rests on: it
 * is what persists the tokens after a successful OAuth exchange. It shipped
 * with a bare ReferenceError — `existing` was used four times and never
 * declared — so every connection attempt failed and the callback redirected to
 * ?error=save_failed&message=existing+is+not+defined.
 *
 * Twenty OAuth tests passed throughout. They covered state signing, authorize
 * URLs, nonce cookies and missing-credential handling — everything AROUND the
 * save, and never the save. The feature was untestable-by-omission rather than
 * untested-by-accident, which is the more expensive kind.
 *
 * These exercise the real function against a fake Supabase.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CALENDAR_TOKEN_KEY =
  process.env.CALENDAR_TOKEN_KEY || "a".repeat(64);

const { saveConnection } = require("../lib/calendar-tokens");

/*
 * Minimal chainable stub. It records what it was asked to do, so a test can
 * assert the UPDATE path was taken rather than the INSERT path — the
 * distinction that matters, because calendar_integrations carries
 * unique (organization_id, provider) and a second insert would violate it.
 */
function fakeSupabase({ existingRow = null } = {}) {
  const calls = { selects: 0, inserts: [], updates: [], eq: {} };

  function builder() {
    const api = {
      select() { return api; },
      eq(column, value) { calls.eq[column] = value; return api; },
      async maybeSingle() { calls.selects += 1; return { data: existingRow, error: null }; },
      async single() { return { data: api._payload, error: null }; },
      insert(payload) { calls.inserts.push(payload); api._payload = payload; return api; },
      update(payload) { calls.updates.push(payload); api._payload = payload; return api; },
    };
    return api;
  }

  return { from: () => builder(), calls };
}

const TOKENS = {
  accessToken: "access-123",
  refreshToken: "refresh-456",
  expiresAt: "2026-10-07T00:00:00.000Z",
  scopes: "openid email",
  providerUserId: "u1",
  providerUserEmail: "owner@example.test",
  providerUserName: "Owner",
  timezone: "Europe/London",
};

test("a first connection inserts a row and encrypts both tokens", async () => {
  const db = fakeSupabase({ existingRow: null });
  const saved = await saveConnection(db, "org-1", "google", TOKENS);

  assert.equal(db.calls.inserts.length, 1, "should INSERT when nothing exists");
  assert.equal(db.calls.updates.length, 0);

  const row = db.calls.inserts[0];
  assert.equal(row.organization_id, "org-1");
  assert.equal(row.provider, "google");
  assert.equal(row.status, "connected");
  assert.ok(row.id, "a row id must be generated before encryption, for the AAD binding");

  // The point of the vault: neither token may be stored in the clear.
  assert.notEqual(row.access_token_encrypted, TOKENS.accessToken);
  assert.notEqual(row.refresh_token_encrypted, TOKENS.refreshToken);
  assert.ok(String(row.access_token_encrypted).includes("{"), "should be a JSON envelope");
  assert.equal(saved, row);
});

test("reconnecting updates the existing row instead of inserting a second", async () => {
  // Without the lookup this threw ReferenceError; with a naive fix that always
  // inserts, it would violate unique (organization_id, provider) instead.
  const existingRow = {
    id: "existing-row-id",
    organization_id: "org-1",
    provider: "google",
    connected_at: "2026-01-01T00:00:00.000Z",
  };
  const db = fakeSupabase({ existingRow });
  await saveConnection(db, "org-1", "google", TOKENS);

  assert.equal(db.calls.updates.length, 1, "should UPDATE when a row exists");
  assert.equal(db.calls.inserts.length, 0, "must not insert a duplicate");

  const row = db.calls.updates[0];
  assert.equal(row.id, "existing-row-id", "must reuse the id, or the AAD binding changes");
  assert.equal(
    row.connected_at,
    existingRow.connected_at,
    "the original connection time is preserved across a reconnect",
  );
  assert.equal(db.calls.eq.id, "existing-row-id", "the update must target that row");
});

test("a missing refresh token is stored as null, not as an encrypted empty string", async () => {
  const db = fakeSupabase({ existingRow: null });
  await saveConnection(db, "org-1", "calendly", { ...TOKENS, refreshToken: null });
  assert.equal(db.calls.inserts[0].refresh_token_encrypted, null);
});

test("an unknown provider is refused before anything is written", async () => {
  const db = fakeSupabase({ existingRow: null });
  await assert.rejects(() => saveConnection(db, "org-1", "outlook", TOKENS));
  assert.equal(db.calls.inserts.length, 0);
  assert.equal(db.calls.updates.length, 0);
});

test("without an encryption key it fails closed, rather than storing plaintext", async () => {
  const previous = process.env.CALENDAR_TOKEN_KEY;
  delete process.env.CALENDAR_TOKEN_KEY;
  try {
    const db = fakeSupabase({ existingRow: null });
    await assert.rejects(
      () => saveConnection(db, "org-1", "google", TOKENS),
      (err) => err.code === "encryption_not_configured" && err.status === 503,
    );
    assert.equal(db.calls.inserts.length, 0, "nothing may be written without the key");
  } finally {
    process.env.CALENDAR_TOKEN_KEY = previous;
  }
});
