"use strict";

/**
 * Authenticated encryption for per-tenant OAuth tokens (Google, Calendly).
 *
 * WHY THIS EXISTS
 *
 * The OAuth tokens this platform will hold are bearer credentials: whoever
 * holds a tenant's Google refresh token can read and write that business's
 * calendar indefinitely. The old Twilio column
 * (organizations.twilio_auth_token_encrypted) stored its "encrypted" token in
 * plaintext; this module is the replacement discipline — AES-256-GCM with the
 * ciphertext bound to (organization, provider, connection) via additional
 * authenticated data, so a row copied to another tenant will not decrypt.
 *
 * KEY MANAGEMENT
 *
 * The key-encryption key is a 32-byte secret supplied as 64 hex characters in
 * CALENDAR_TOKEN_KEY. In production it comes from AWS Secrets Manager through
 * lib/secrets.js (which populates process.env at boot); locally it lives in
 * the environment. Generate one with:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * CALENDAR_TOKEN_KEY_PREV holds the previous key during rotation: decryption
 * tries the current key first, then the previous one, so rotating the key
 * does not orphan stored tokens. There is no per-row data key here — with no
 * KMS/IAM task role on Lightsail, a single strong KEK from Secrets Manager is
 * the honest step up from plaintext. If a KMS-backed envelope scheme arrives
 * later, this module's encrypt/decrypt surface is where it plugs in.
 *
 * FAILURE POSTURE: misconfiguration throws loudly at the point of use (never
 * silently stores plaintext). Tampered or cross-tenant ciphertext throws on
 * decrypt. Callers translate these into 503/500 responses; see
 * isEncryptionConfigured() for the pre-flight check the settings UI uses.
 */

const crypto = require("crypto");

const KEY_ENV = "CALENDAR_TOKEN_KEY";
const PREV_KEY_ENV = "CALENDAR_TOKEN_KEY_PREV";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

function readKey(envName, env = process.env) {
  const raw = env[envName];
  if (!raw) return null;
  const hex = String(raw).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function currentKey(env = process.env) {
  return readKey(KEY_ENV, env);
}

function previousKey(env = process.env) {
  return readKey(PREV_KEY_ENV, env);
}

/**
 * True when a usable encryption key is configured.
 */
function isEncryptionConfigured(env = process.env) {
  return currentKey(env) !== null;
}

function keySetupHelp() {
  return (
    "Token encryption is not configured. Set CALENDAR_TOKEN_KEY to 64 hex " +
    "characters (32 random bytes) — generate one with: " +
    "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\". " +
    "In production, add it to the AWS Secrets Manager secret named by " +
    "AGENTLY_SECRETS_ID; lib/secrets.js loads it at boot."
  );
}

/**
 * Canonical additional-authenticated-data binding a ciphertext to one tenant's
 * one provider connection. Decryption with a different binding fails the GCM
 * tag check, so a token row cannot be replayed across tenants or providers.
 */
function aadFor({ organizationId, provider, connectionId } = {}) {
  if (!organizationId || !provider) {
    throw new Error(
      "aadFor requires organizationId and provider — refusing to encrypt without a tenant binding.",
    );
  }
  return JSON.stringify({
    organizationId: String(organizationId),
    provider: String(provider),
    connectionId: connectionId === undefined || connectionId === null ? "" : String(connectionId),
  });
}

/**
 * Encrypt a secret string. Returns a JSON envelope (never the plaintext).
 */
function encryptSecret(plaintext, binding, env = process.env) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret requires a non-empty string.");
  }
  const key = currentKey(env);
  if (!key) throw new Error(keySetupHelp());

  const aad = aadFor(binding);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    data: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    // The binding is recorded for audit; GCM authenticates it regardless.
    binding: JSON.parse(aad),
  });
}

/**
 * Decrypt an envelope produced by encryptSecret. The binding MUST match the
 * one used at encryption time. Tries the previous key after the current one
 * so key rotation does not orphan stored tokens.
 */
function decryptSecret(envelope, binding, env = process.env) {
  if (typeof envelope !== "string" || envelope.length === 0) {
    throw new Error("decryptSecret requires the envelope string.");
  }
  let parsed;
  try {
    parsed = JSON.parse(envelope);
  } catch (_) {
    throw new Error("decryptSecret: envelope is not valid JSON — refusing to guess.");
  }
  if (!parsed || parsed.v !== ENVELOPE_VERSION || parsed.alg !== ALGORITHM) {
    throw new Error("decryptSecret: unsupported envelope version or algorithm.");
  }

  const aad = aadFor(binding);
  const keys = [currentKey(env), previousKey(env)].filter(Boolean);
  if (keys.length === 0) throw new Error(keySetupHelp());

  let lastError = null;
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(parsed.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return plaintext;
    } catch (error) {
      lastError = error;
    }
  }
  // Deliberately generic: distinguishing "wrong key" from "tampered" helps an
  // attacker and never helps the caller.
  throw new Error(
    `decryptSecret failed authentication (${lastError ? lastError.message : "no key"}). ` +
      "The ciphertext was tampered with, the tenant binding is wrong, or no configured key matches.",
  );
}

module.exports = {
  KEY_ENV,
  PREV_KEY_ENV,
  isEncryptionConfigured,
  keySetupHelp,
  aadFor,
  encryptSecret,
  decryptSecret,
};
