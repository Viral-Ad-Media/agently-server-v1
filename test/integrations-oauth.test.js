"use strict";
/*
 * api/routes/integrations.js — OAuth connect flow security properties.
 *
 * The critical invariants: state cannot be forged without the server key,
 * state expires, state binds the org, and the provider authorize URLs carry
 * the exact scopes and parameters the docs require.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { _internals } = require("../api/routes/integrations");
const { signState, verifyState, signStartToken, verifyStartToken, getCookie, getProviderConfig, buildAuthorizeUrl, generateCodeVerifier, codeChallengeFor, sealCodeVerifier, openCodeVerifier } = _internals;

const KEY = crypto.randomBytes(32).toString("hex");

function withKey(env, fn) {
  const prev = process.env.CALENDAR_TOKEN_KEY;
  process.env.CALENDAR_TOKEN_KEY = KEY;
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CALENDAR_TOKEN_KEY;
    else process.env.CALENDAR_TOKEN_KEY = prev;
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

const payload = (overrides = {}) => ({
  kind: "oauth",
  orgId: "org-123",
  userId: "user-1",
  provider: "google",
  nonce: "abc123",
  exp: Date.now() + 600000,
  ...overrides,
});

test("state round-trips and verifies", () => {
  withKey({}, () => {
    const state = signState(payload());
    const verified = verifyState(state);
    assert.equal(verified.orgId, "org-123");
    assert.equal(verified.provider, "google");
    assert.equal(verified.nonce, "abc123");
  });
});

test("state cannot be forged without the server key", () => {
  const forged = withKey({}, () => signState(payload()));
  const otherKey = crypto.randomBytes(32).toString("hex");
  withKey({ CALENDAR_TOKEN_KEY: otherKey }, () => {
    assert.equal(verifyState(forged), null);
  });
});

test("tampered state is rejected", () => {
  withKey({}, () => {
    const state = signState(payload());
    const [body, sig] = state.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify(payload({ orgId: "org-evil" })),
    ).toString("base64url");
    assert.equal(verifyState(`${tamperedBody}.${sig}`), null);
    assert.equal(verifyState(`${body}.deadbeef`), null);
    assert.equal(verifyState("not-a-state"), null);
    assert.equal(verifyState(""), null);
  });
});

test("expired state is rejected", () => {
  withKey({}, () => {
    const state = signState(payload({ exp: Date.now() - 1000 }));
    assert.equal(verifyState(state), null);
  });
});

test("signState refuses to run without an encryption key", () => {
  const prev = process.env.CALENDAR_TOKEN_KEY;
  delete process.env.CALENDAR_TOKEN_KEY;
  try {
    assert.throws(() => signState(payload()), /CALENDAR_TOKEN_KEY/);
  } finally {
    if (prev !== undefined) process.env.CALENDAR_TOKEN_KEY = prev;
  }
});

test("getCookie parses the nonce cookie and ignores others", () => {  const req = { headers: { cookie: "other=1; agently_oauth_google=abc123; x=2" } };
  assert.equal(getCookie(req, "agently_oauth_google"), "abc123");
  assert.equal(getCookie(req, "agently_oauth_calendly"), null);
  assert.equal(getCookie({ headers: {} }, "agently_oauth_google"), null);
});

test("unknown provider is rejected with 400", () => {
  assert.throws(() => getProviderConfig("outlook"), /Unknown calendar provider/);
});

test("missing provider credentials fail closed with 503", () => {
  const keep = { ...process.env };
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.INTEGRATIONS_GOOGLE_REDIRECT_URI;
  try {
    assert.throws(() => getProviderConfig("google"), /not configured/);
  } finally {
    process.env = keep;
  }
});

test("google authorize url requests offline access and minimal scopes", () => {
  const config = {
    provider: "google",
    clientId: "cid",
    redirectUri: "https://api.example.com/api/integrations/google/callback",
  };
  const url = new URL(buildAuthorizeUrl("google", config, "STATE", "CHALLENGE"));
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  /*
   * "select_account consent", not "consent".
   *
   * A tenant running several businesses adds a SECOND Google account from the
   * same browser. With "consent" alone Google reuses whichever account is
   * already signed in and returns the same provider_user_id, so the add is
   * indistinguishable from a reconnect and the second business can never be
   * connected. The account chooser is the only place that choice exists;
   * "consent" stays so offline access is still granted every time.
   */
  assert.equal(url.searchParams.get("prompt"), "select_account consent");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "STATE");
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const scopes = url.searchParams.get("scope").split(" ");
  assert.ok(scopes.includes("openid"), "userinfo needs the openid scope");
  assert.ok(scopes.includes("email"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.freebusy"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events"));
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/calendar"), "must not request full calendar scope");
});

test("calendly authorize url requests the booking scopes", () => {
  const config = {
    provider: "calendly",
    clientId: "cid",
    redirectUri: "https://api.example.com/api/integrations/calendly/callback",
  };
  const url = new URL(buildAuthorizeUrl("calendly", config, "STATE", "CHALLENGE"));
  assert.equal(url.hostname, "auth.calendly.com");
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const scopes = url.searchParams.get("scope").split(" ");
  for (const s of ["users:read", "event_types:read", "availability:read", "scheduled_events:write", "webhooks:write"]) {
    assert.ok(scopes.includes(s), `missing scope ${s}`);
  }
});

test("start token authorizes one provider's start redirect", () => {
  withKey({}, () => {
    const token = signStartToken({ orgId: "org-123", userId: "user-1", provider: "google" });
    const payload = verifyStartToken(token, "google");
    assert.equal(payload.orgId, "org-123");
    assert.equal(payload.kind, "start");
    // Wrong provider: rejected.
    assert.equal(verifyStartToken(token, "calendly"), null);
  });
});

test("start token cannot be confused with oauth state", () => {
  withKey({}, () => {
    const startToken = signStartToken({ orgId: "org-123", userId: "user-1", provider: "google" });
    // The callback requires kind === "oauth"; a start token is rejected there.
    assert.notEqual(verifyState(startToken).kind, "oauth");
    const oauthState = signState(payload());
    assert.equal(verifyState(oauthState).kind, "oauth");
    assert.equal(verifyStartToken(oauthState, "google"), null);
  });
});

test("pkce: challenge matches the verifier (RFC 7636 S256)", () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
  assert.equal(codeChallengeFor(verifier), expected);
});

test("pkce: sealed verifier round-trips and is tenant-bound", () => {
  withKey({}, () => {
    const verifier = generateCodeVerifier();
    const sealed = sealCodeVerifier(verifier, "org-123", "google");
    // The sealed value carries no plaintext verifier.
    assert.ok(!sealed.includes(verifier.slice(0, 10)));
    assert.equal(openCodeVerifier(sealed, "org-123", "google"), verifier);
    // Wrong org binding fails to decrypt.
    assert.throws(() => openCodeVerifier(sealed, "org-999", "google"));
    // Tampered ciphertext fails to decrypt.
    const tampered = sealed.slice(0, -2) + (sealed.slice(-2) === "AA" ? "BB" : "AA");
    assert.throws(() => openCodeVerifier(tampered, "org-123", "google"));
  });
});

test("pkce: sealed verifier refuses to run without an encryption key", () => {
  const keep = process.env.CALENDAR_TOKEN_KEY;
  delete process.env.CALENDAR_TOKEN_KEY;
  try {
    assert.throws(() => sealCodeVerifier(generateCodeVerifier(), "org-123", "google"));
  } finally {
    if (keep !== undefined) process.env.CALENDAR_TOKEN_KEY = keep;
  }
});

test("normalizeBookingSettings accepts a full valid google payload", () => {
  const { normalizeBookingSettings } = _internals;
  const { settings, error } = normalizeBookingSettings("google", {
    slotMinutes: 45,
    windowDays: 21,
    workingHours: { mon: [["09:00", "17:00"]], sat: [] },
    sendUpdates: "none",
    bogus: "dropped",
  });
  assert.equal(error, undefined);
  assert.deepEqual(settings, {
    slotMinutes: 45,
    windowDays: 21,
    workingHours: { mon: [["09:00", "17:00"]], sat: [] },
    sendUpdates: "none",
  });
});

test("normalizeBookingSettings ignores google-only keys for calendly", () => {
  const { normalizeBookingSettings } = _internals;
  const { settings, error } = normalizeBookingSettings("calendly", {
    slotMinutes: 45,
    windowDays: 10,
    workingHours: { mon: [["09:00", "17:00"]] },
    sendUpdates: "none",
  });
  assert.equal(error, undefined);
  assert.deepEqual(settings, { windowDays: 10 });
});

test("normalizeBookingSettings rejects bad values", () => {
  const { normalizeBookingSettings } = _internals;
  assert.ok(normalizeBookingSettings("google", { slotMinutes: 3 }).error);
  assert.ok(normalizeBookingSettings("google", { slotMinutes: 200 }).error);
  assert.ok(normalizeBookingSettings("google", { slotMinutes: 30.5 }).error);
  assert.ok(normalizeBookingSettings("google", { windowDays: 0 }).error);
  assert.ok(normalizeBookingSettings("google", { windowDays: 61 }).error);
  assert.ok(normalizeBookingSettings("google", { workingHours: { mon: [["9:00", "17:00"]] } }).error);
  assert.ok(normalizeBookingSettings("google", { workingHours: { mon: [["17:00", "09:00"]] } }).error);
  assert.ok(normalizeBookingSettings("google", { workingHours: { mon: "9-5" } }).error);
  assert.ok(normalizeBookingSettings("google", { sendUpdates: "sometimes" }).error);
  assert.ok(normalizeBookingSettings("google", { workingHours: null }).error);
});

test("normalizeBookingSettings allows partial updates and empty input", () => {
  const { normalizeBookingSettings } = _internals;
  assert.deepEqual(normalizeBookingSettings("google", { windowDays: 7 }).settings, { windowDays: 7 });
  assert.deepEqual(normalizeBookingSettings("google", {}).settings, {});
  assert.deepEqual(normalizeBookingSettings("google", null).settings, {});
});
