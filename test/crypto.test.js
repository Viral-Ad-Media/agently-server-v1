"use strict";
/*
 * lib/crypto.js — per-tenant token encryption.
 *
 * The properties that matter: round-trip works, the wrong tenant binding does
 * NOT decrypt, tampered ciphertext does NOT decrypt, and nothing silently
 * falls back to plaintext when the key is missing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  isEncryptionConfigured,
  encryptSecret,
  decryptSecret,
  aadFor,
} = require("../lib/crypto");

const KEY = crypto.randomBytes(32).toString("hex");
const OTHER_KEY = crypto.randomBytes(32).toString("hex");
const envWithKey = { CALENDAR_TOKEN_KEY: KEY };
const binding = { organizationId: "org-1", provider: "google", connectionId: "primary" };

test("round-trips a secret with the same binding", () => {
  const envelope = encryptSecret("refresh-token-abc", binding, envWithKey);
  assert.ok(!envelope.includes("refresh-token-abc"), "ciphertext must not contain the plaintext");
  assert.equal(decryptSecret(envelope, binding, envWithKey), "refresh-token-abc");
});

test("decryption fails when the tenant binding differs", () => {
  const envelope = encryptSecret("refresh-token-abc", binding, envWithKey);
  const otherTenant = { ...binding, organizationId: "org-2" };
  assert.throws(() => decryptSecret(envelope, otherTenant, envWithKey), /failed authentication/);
  const otherProvider = { ...binding, provider: "calendly" };
  assert.throws(() => decryptSecret(envelope, otherProvider, envWithKey), /failed authentication/);
});

test("decryption fails on tampered ciphertext", () => {
  const envelope = encryptSecret("refresh-token-abc", binding, envWithKey);
  const parsed = JSON.parse(envelope);
  const data = Buffer.from(parsed.data, "base64");
  data[0] ^= 0xff;
  parsed.data = data.toString("base64");
  assert.throws(
    () => decryptSecret(JSON.stringify(parsed), binding, envWithKey),
    /failed authentication/,
  );
});

test("decryption fails on a tampered tenant binding inside the envelope", () => {
  const envelope = encryptSecret("refresh-token-abc", binding, envWithKey);
  const parsed = JSON.parse(envelope);
  parsed.binding.organizationId = "org-2";
  // The recorded binding is audit-only; the GCM tag still binds the real one.
  assert.equal(decryptSecret(JSON.stringify(parsed), binding, envWithKey), "refresh-token-abc");
  assert.throws(
    () => decryptSecret(JSON.stringify(parsed), { ...binding, organizationId: "org-2" }, envWithKey),
    /failed authentication/,
  );
});

test("previous key decrypts envelopes made before rotation", () => {
  const envelope = encryptSecret("refresh-token-abc", binding, envWithKey);
  const rotatedEnv = { CALENDAR_TOKEN_KEY: OTHER_KEY, CALENDAR_TOKEN_KEY_PREV: KEY };
  assert.equal(decryptSecret(envelope, binding, rotatedEnv), "refresh-token-abc");
});

test("encrypt refuses to run without a configured key", () => {
  assert.equal(isEncryptionConfigured({}), false);
  assert.throws(() => encryptSecret("x", binding, {}), /CALENDAR_TOKEN_KEY/);
});

test("malformed keys are treated as unconfigured, not half-configured", () => {
  assert.equal(isEncryptionConfigured({ CALENDAR_TOKEN_KEY: "short" }), false);
  assert.equal(isEncryptionConfigured({ CALENDAR_TOKEN_KEY: "zz".repeat(32) }), false);
});

test("aadFor requires a tenant binding", () => {
  assert.throws(() => aadFor({ provider: "google" }), /organizationId/);
  assert.throws(() => aadFor({ organizationId: "org-1" }), /provider/);
});
