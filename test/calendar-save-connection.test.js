"use strict";
/*
 * saveConnection is the function the whole calendar integration rests on: it
 * is what persists the tokens after a successful OAuth exchange.
 *
 * It shipped with a bare ReferenceError — `existing` was used four times and
 * never declared — so every connection attempt failed and the callback
 * redirected to ?error=save_failed&message=existing+is+not+defined. Twenty
 * OAuth tests passed throughout: they covered state signing, authorize URLs,
 * nonce cookies and missing-credential handling, everything AROUND the save
 * and never the save itself.
 *
 * It then grew a second, quieter failure mode. Multi-account support means an
 * organization holds one row per connected ACCOUNT, and the lookup still
 * keyed on (organization_id, provider) alone — so a tenant adding their
 * second business's Google account would have had the FIRST account's tokens
 * overwritten. Nothing would have reported an error; bookings would simply
 * have started landing on the wrong business's calendar. These tests assert
 * on the resulting ROWS rather than on which method was called, because
 * "a second row exists, and the first is unharmed" is the property that
 * matters.
 *
 * The fake enforces the migration's unique indexes, so a duplicate account or
 * a second booking default fails here the way it would in Postgres.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CALENDAR_TOKEN_KEY = process.env.CALENDAR_TOKEN_KEY || "a".repeat(64);

const { makeFakeSupabase } = require("./helpers/fake-supabase");
const { saveConnection, listConnectionRows } = require("../lib/calendar-tokens");
const { decryptSecret } = require("../lib/crypto");

const ORG = "org-1";

function tokensFor(account) {
  return {
    accessToken: `access-${account}`,
    refreshToken: `refresh-${account}`,
    expiresAt: "2026-10-07T00:00:00.000Z",
    scopes: "openid email",
    providerUserId: `google-uid-${account}`,
    providerUserEmail: `${account}@example.test`,
    providerUserName: `${account} Owner`,
    timezone: "Europe/London",
  };
}

const TOKENS = tokensFor("first");

test("a first connection inserts a row and encrypts both tokens", async () => {
  const db = makeFakeSupabase();
  const saved = await saveConnection(db, ORG, "google", TOKENS);

  const rows = db._rows("calendar_integrations");
  assert.equal(rows.length, 1, "should INSERT when nothing exists");
  const row = rows[0];
  assert.equal(row.organization_id, ORG);
  assert.equal(row.provider, "google");
  assert.equal(row.status, "connected");
  assert.ok(row.id, "a row id must be generated before encryption, for the AAD binding");
  assert.equal(saved.id, row.id);

  // The point of the vault: neither token may be stored in the clear.
  assert.notEqual(row.access_token_encrypted, TOKENS.accessToken);
  assert.notEqual(row.refresh_token_encrypted, TOKENS.refreshToken);
  assert.ok(String(row.access_token_encrypted).includes("{"), "should be a JSON envelope");
});

test("reconnecting the SAME account updates its row instead of inserting a second", async () => {
  // Same provider_user_id => the same real Google account => one row.
  const db = makeFakeSupabase();
  const first = await saveConnection(db, ORG, "google", TOKENS);
  const again = await saveConnection(db, ORG, "google", {
    ...TOKENS,
    accessToken: "access-rotated",
  });

  const rows = db._rows("calendar_integrations");
  assert.equal(rows.length, 1, "must not insert a duplicate for one account");
  assert.equal(again.id, first.id, "must reuse the id, or the AAD binding changes");
  assert.equal(
    again.connected_at,
    first.connected_at,
    "the original connection time is preserved across a reconnect",
  );
});

test("connecting a DIFFERENT google account creates a SECOND row, keeping the first intact", async () => {
  /*
   * The headline requirement. One Agently login, several businesses, each
   * with its own Gmail. Keyed on (organization_id, provider) this overwrote
   * row one; keyed on the account it must not.
   */
  const db = makeFakeSupabase();
  const first = await saveConnection(db, ORG, "google", tokensFor("nutra"));
  const second = await saveConnection(db, ORG, "google", tokensFor("other"));

  const rows = db._rows("calendar_integrations");
  assert.equal(rows.length, 2, "a second account must get its own row");
  assert.notEqual(second.id, first.id, "a different account must not reuse the first row's id");

  const firstRow = rows.find((r) => r.id === first.id);
  const secondRow = rows.find((r) => r.id === second.id);
  assert.equal(firstRow.provider_user_id, "google-uid-nutra");
  assert.equal(secondRow.provider_user_id, "google-uid-other");

  // The first account's stored credentials must be untouched by the second
  // connect. This is the destructive failure the old key would have caused.
  assert.equal(
    decryptSecret(firstRow.access_token_encrypted, {
      organizationId: ORG,
      provider: "google",
      connectionId: firstRow.id,
    }),
    "access-nutra",
    "the first account's tokens must survive a second account connecting",
  );
});

test("each row's tokens decrypt only under its OWN connection id", async () => {
  /*
   * lib/crypto.js binds ciphertext to { organizationId, provider,
   * connectionId }. That binding is what made several rows per
   * (organization, provider) safe in the first place, and it only holds if
   * each row was encrypted under its own id — so prove both directions.
   */
  const db = makeFakeSupabase();
  const a = await saveConnection(db, ORG, "google", tokensFor("aaa"));
  const b = await saveConnection(db, ORG, "google", tokensFor("bbb"));
  const rows = db._rows("calendar_integrations");
  const rowA = rows.find((r) => r.id === a.id);
  const rowB = rows.find((r) => r.id === b.id);

  const binding = (id) => ({ organizationId: ORG, provider: "google", connectionId: id });

  assert.equal(decryptSecret(rowA.refresh_token_encrypted, binding(rowA.id)), "refresh-aaa");
  assert.equal(decryptSecret(rowB.refresh_token_encrypted, binding(rowB.id)), "refresh-bbb");

  // Cross-binding must fail the GCM tag check, not quietly return something.
  assert.throws(
    () => decryptSecret(rowA.refresh_token_encrypted, binding(rowB.id)),
    /failed authentication/,
    "one row's tokens must not decrypt under another row's connection id",
  );
  assert.throws(
    () => decryptSecret(rowA.refresh_token_encrypted, { ...binding(rowA.id), organizationId: "org-2" }),
    /failed authentication/,
    "a row copied to another tenant must not decrypt",
  );
});

test("the first usable connection becomes the booking default; the second does not steal it", async () => {
  const db = makeFakeSupabase();
  const first = await saveConnection(db, ORG, "google", tokensFor("nutra"));
  assert.equal(first.is_booking_default, true, "an org's only connection is the booking target");

  const second = await saveConnection(db, ORG, "google", tokensFor("other"));
  assert.equal(second.is_booking_default, false, "adding an account must not move the booking target");

  const defaults = db._rows("calendar_integrations").filter((r) => r.is_booking_default);
  assert.equal(defaults.length, 1, "exactly one booking default per organization");
  assert.equal(defaults[0].id, first.id);
});

test("a reconnect does not demote the account that is the booking default", async () => {
  const db = makeFakeSupabase();
  const first = await saveConnection(db, ORG, "google", tokensFor("nutra"));
  await saveConnection(db, ORG, "google", tokensFor("other"));
  const again = await saveConnection(db, ORG, "google", tokensFor("nutra"));
  assert.equal(again.is_booking_default, true);
  assert.equal(db._rows("calendar_integrations").filter((r) => r.is_booking_default).length, 1);
});

test("a new connection is labelled from the provider account, and a rename survives reconnect", async () => {
  const db = makeFakeSupabase();
  const saved = await saveConnection(db, ORG, "google", tokensFor("nutra"));
  assert.equal(saved.label, "nutra Owner", "defaults to the provider account's display name");

  // Tenant renames it to the business name.
  await db
    .from("calendar_integrations")
    .update({ label: "Nutra Wellness" })
    .eq("organization_id", ORG)
    .eq("id", saved.id);

  const again = await saveConnection(db, ORG, "google", tokensFor("nutra"));
  assert.equal(again.label, "Nutra Wellness", "a tenant's rename must survive a reconnect");
});

test("an id-less row is adopted by email rather than duplicated", async () => {
  /*
   * provider_user_id is nullable and older rows may carry NULL. The unique
   * index keys on coalesce(provider_user_id, ''), so a real id does not
   * collide with the NULL slot — without the email fallback, the tenant
   * reconnecting that same account once we DO know its id would end up with
   * two rows for one real Google account.
   */
  const db = makeFakeSupabase({
    calendar_integrations: [
      {
        id: "legacy-row",
        organization_id: ORG,
        provider: "google",
        status: "connected",
        provider_user_id: null,
        provider_user_email: "Nutra@Example.test",
        label: "Nutra Wellness",
        is_booking_default: true,
        connected_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  const saved = await saveConnection(db, ORG, "google", {
    ...tokensFor("nutra"),
    providerUserEmail: "nutra@example.test", // same mailbox, different case
  });

  assert.equal(saved.id, "legacy-row", "the id-less row must be adopted, not duplicated");
  assert.equal(db._rows("calendar_integrations").length, 1);
  assert.equal(saved.provider_user_id, "google-uid-nutra", "and it learns the account id");
});

test("connections for different organizations never collide", async () => {
  const db = makeFakeSupabase();
  await saveConnection(db, "org-a", "google", tokensFor("shared"));
  await saveConnection(db, "org-b", "google", tokensFor("shared"));

  const rows = db._rows("calendar_integrations");
  assert.equal(rows.length, 2, "the same Google account may serve two tenants");
  const a = await listConnectionRows(db, "org-a");
  const b = await listConnectionRows(db, "org-b");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].id, b[0].id);
  assert.equal(a[0].is_booking_default, true, "each org's own first connection is its default");
  assert.equal(b[0].is_booking_default, true);
});

test("a missing refresh token is stored as null, not as an encrypted empty string", async () => {
  const db = makeFakeSupabase();
  await saveConnection(db, ORG, "calendly", { ...TOKENS, refreshToken: null });
  assert.equal(db._rows("calendar_integrations")[0].refresh_token_encrypted, null);
});

test("an unknown provider is refused before anything is written", async () => {
  const db = makeFakeSupabase();
  await assert.rejects(() => saveConnection(db, ORG, "outlook", TOKENS));
  assert.equal(db._rows("calendar_integrations").length, 0);
});

test("a missing organization id is refused rather than written untenanted", async () => {
  // RLS is enabled with zero policies and the API is the service role, so an
  // untenanted write is not stopped by Postgres. It has to be stopped here.
  const db = makeFakeSupabase();
  await assert.rejects(
    () => saveConnection(db, null, "google", TOKENS),
    (err) => err.code === "missing_organization",
  );
  assert.equal(db._rows("calendar_integrations").length, 0);
});

test("without an encryption key it fails closed, rather than storing plaintext", async () => {
  const previous = process.env.CALENDAR_TOKEN_KEY;
  delete process.env.CALENDAR_TOKEN_KEY;
  try {
    const db = makeFakeSupabase();
    await assert.rejects(
      () => saveConnection(db, ORG, "google", TOKENS),
      (err) => err.code === "encryption_not_configured" && err.status === 503,
    );
    assert.equal(db._rows("calendar_integrations").length, 0, "nothing may be written without the key");
  } finally {
    process.env.CALENDAR_TOKEN_KEY = previous;
  }
});
