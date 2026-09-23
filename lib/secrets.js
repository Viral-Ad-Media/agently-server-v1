"use strict";

/**
 * Load production secrets from AWS Secrets Manager at boot, falling back to
 * the environment.
 *
 * WHY
 *
 * p10 measured every credential stored as plaintext in the Lightsail
 * deployment definition, readable by anyone holding
 * lightsail:GetContainerServices. Lightsail container services have no native
 * secrets integration and no IAM task roles, so a bootstrap credential cannot
 * be eliminated here — the container must hold SOMETHING that unlocks the
 * rest. What this buys is therefore not elimination:
 *
 *   - eighteen readable credentials become two (an access key pair) scoped to
 *     GetSecretValue on one secret,
 *   - every read is logged by CloudTrail, so access is auditable for the first
 *     time,
 *   - rotation happens in Secrets Manager without a redeploy.
 *
 * Say that plainly rather than calling it "secrets are now encrypted".
 *
 * FAILURE POSTURE: this NEVER throws. Missing configuration, absent
 * credentials, a network failure, AccessDenied, malformed JSON — all of them
 * log and return, leaving process.env exactly as the platform supplied it.
 * A secrets loader that can fail a boot is worse than the problem it solves,
 * and the environment it falls back to is precisely today's behaviour.
 *
 * PRECEDENCE: values from Secrets Manager WIN over existing environment
 * variables. That is deliberate and it is the migration path — put the secrets
 * in, watch the log confirm which names were supplied, and only then prune the
 * plaintext copies. If the environment won instead, you could not tell whether
 * the loader worked until after deleting the fallback, which is the same
 * unverifiable-control trap that hid the SSRF regression for eleven days.
 *
 * NO SDK: SigV4 is implemented here against one read-only operation rather
 * than adding @aws-sdk to the image. The deciding argument is the failure
 * mode — if this signing is wrong, the loader falls back and the API still
 * boots. It is also testable against ListSecrets without creating anything.
 */

const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 5000;

const sha256Hex = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value, "utf8").digest();

/**
 * Sign and send one AWS JSON-protocol request. Exported for tests: signing is
 * the part most likely to be subtly wrong, so it is verifiable on its own.
 */
async function awsJsonRequest({
  service,
  region,
  target,
  body,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const host = `${service}.${region}.amazonaws.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260922T131500Z
  const dateStamp = amzDate.slice(0, 8);
  const payload = JSON.stringify(body);
  const payloadHash = sha256Hex(payload);

  const headers = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-target": target,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${String(headers[k]).trim()}\n`)
    .join("");

  const canonicalRequest = [
    "POST", "/", "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetchImpl(`https://${host}/`, {
    method: "POST",
    headers: { ...headers, authorization: authorization },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { /* left null deliberately */ }
  return { status: response.status, body: parsed, raw: text };
}

/**
 * Populate process.env from Secrets Manager. Resolves a small report rather
 * than throwing, so a caller can log the outcome without a try/catch.
 */
async function loadSecrets(options = {}) {
  const env = options.env || process.env;
  const log = options.log || console;
  const request = options.request || awsJsonRequest;

  const secretId = env.AGENTLY_SECRETS_ID;
  if (!secretId) {
    // Not an error: this is the state before migration and after a rollback.
    return { loaded: false, reason: "AGENTLY_SECRETS_ID is not set", names: [] };
  }

  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    log.error(
      "[secrets] AGENTLY_SECRETS_ID is set but AWS credentials are not — " +
        "continuing on environment variables alone.",
    );
    return { loaded: false, reason: "no AWS credentials", names: [] };
  }

  let response;
  try {
    response = await request({
      service: "secretsmanager",
      region: env.AWS_REGION || "us-east-1",
      target: "secretsmanager.GetSecretValue",
      body: { SecretId: secretId },
      accessKeyId,
      secretAccessKey,
      sessionToken: env.AWS_SESSION_TOKEN,
      timeoutMs: Number(env.AGENTLY_SECRETS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    log.error(
      `[secrets] Could not reach Secrets Manager (${error.message}) — ` +
        "continuing on environment variables alone.",
    );
    return { loaded: false, reason: "request failed", names: [] };
  }

  if (response.status !== 200) {
    // The error TYPE is safe and useful to log; the raw body is not, because a
    // failed GetSecretValue can echo the secret id and ARN.
    const type = response.body?.__type || `HTTP ${response.status}`;
    log.error(
      `[secrets] Secrets Manager refused the read (${type}) — ` +
        "continuing on environment variables alone.",
    );
    return { loaded: false, reason: type, names: [] };
  }

  let values;
  try {
    values = JSON.parse(response.body?.SecretString || "");
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("secret is not a JSON object of name/value pairs");
    }
  } catch (error) {
    log.error(
      `[secrets] Secret payload unusable (${error.message}) — ` +
        "continuing on environment variables alone.",
    );
    return { loaded: false, reason: "unparseable payload", names: [] };
  }

  const names = [];
  const overridden = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (key in env) overridden.push(key);
    env[key] = String(value);
    names.push(key);
  }

  // Names only, never values. Enough to confirm the loader is working, which
  // is the whole point of doing this before pruning the plaintext copies.
  log.warn(
    `[secrets] Loaded ${names.length} value(s) from Secrets Manager: ${names.sort().join(", ")}` +
      (overridden.length ? ` (${overridden.length} overrode an existing env var)` : ""),
  );
  return { loaded: true, names, overridden };
}

module.exports = { loadSecrets, awsJsonRequest };
