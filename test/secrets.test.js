"use strict";
/*
 * The Secrets Manager loader.
 *
 * The property that matters most here is NEGATIVE: this must never prevent the
 * API from starting. Most of the assertions below are therefore failure cases,
 * and each one names the real-world event it stands for — a revoked key, a
 * network partition, an IAM policy tightened at the wrong moment.
 *
 * On signing: these tests prove the Authorization header is well formed and
 * that it responds to every input that must change it. They do NOT prove the
 * signature is one AWS accepts — nothing derived from the same implementation
 * could. That is proved separately by calling the live Secrets Manager API and
 * getting a 200 back; infra/put-secrets.js exercises this same code path
 * against the real service.
 *
 * No network is touched: fetch is injected.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSecrets, awsJsonRequest } = require("../lib/secrets");

const CREDS = {
  service: "secretsmanager",
  region: "us-east-1",
  target: "secretsmanager.GetSecretValue",
  body: { SecretId: "agently/api" },
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCY",
  now: new Date("2026-09-22T13:15:00Z"),
};

/* Captures one request instead of sending it. */
function capture(responseBody, status = 200) {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.init = init;
    return {
      status,
      text: async () =>
        typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    };
  };
  return { seen, fetchImpl };
}

const quietLog = () => {
  const lines = [];
  return {
    lines,
    error: (m) => lines.push(["error", m]),
    warn: (m) => lines.push(["warn", m]),
  };
};

test("a signed request carries the headers AWS requires, in canonical order", async () => {
  const { seen, fetchImpl } = capture({ SecretString: "{}" });
  await awsJsonRequest({ ...CREDS, fetchImpl });

  assert.equal(seen.url, "https://secretsmanager.us-east-1.amazonaws.com/");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["x-amz-target"], "secretsmanager.GetSecretValue");
  assert.equal(seen.init.headers["x-amz-date"], "20260922T131500Z");

  const auth = seen.init.headers.authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 /);
  assert.ok(
    auth.includes("Credential=AKIAEXAMPLE/20260922/us-east-1/secretsmanager/aws4_request"),
    "credential scope must name the date, region and service",
  );
  // Signed headers must be sorted; AWS rejects any other order.
  const signed = /SignedHeaders=([^,]+)/.exec(auth)[1].split(";");
  assert.deepEqual(signed, [...signed].sort(), "signed headers must be lexically sorted");
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
});

test("a session token is signed in when present and absent when not", async () => {
  const a = capture({ SecretString: "{}" });
  await awsJsonRequest({ ...CREDS, fetchImpl: a.fetchImpl });
  assert.ok(!("x-amz-security-token" in a.seen.init.headers));
  assert.ok(!a.seen.init.headers.authorization.includes("x-amz-security-token"));

  const b = capture({ SecretString: "{}" });
  await awsJsonRequest({ ...CREDS, sessionToken: "FwoGZXIvYXdz", fetchImpl: b.fetchImpl });
  assert.equal(b.seen.init.headers["x-amz-security-token"], "FwoGZXIvYXdz");
  assert.ok(
    b.seen.init.headers.authorization.includes("x-amz-security-token"),
    "a token sent but not signed produces a signature mismatch at AWS",
  );
});

test("the signature depends on the key, the body, the date and the region", async () => {
  const sign = async (overrides) => {
    const { seen, fetchImpl } = capture({ SecretString: "{}" });
    await awsJsonRequest({ ...CREDS, ...overrides, fetchImpl });
    return /Signature=([0-9a-f]{64})/.exec(seen.init.headers.authorization)[1];
  };

  const base = await sign({});
  assert.notEqual(base, await sign({ secretAccessKey: "a-different-secret-key" }));
  assert.notEqual(base, await sign({ body: { SecretId: "agently/worker" } }));
  assert.notEqual(base, await sign({ now: new Date("2026-09-23T13:15:00Z") }));
  assert.notEqual(base, await sign({ region: "eu-central-1" }));
  assert.equal(base, await sign({}), "signing must be deterministic for identical input");
});

test("values from Secrets Manager land in the environment and beat what was there", async () => {
  const env = {
    AGENTLY_SECRETS_ID: "agently/api",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
    STRIPE_SECRET_KEY: "the-plaintext-copy",
  };
  const log = quietLog();
  const request = async () => ({
    status: 200,
    body: {
      SecretString: JSON.stringify({
        STRIPE_SECRET_KEY: "the-managed-copy",
        OPENAI_API_KEY: "sk-new",
      }),
    },
  });

  const result = await loadSecrets({ env, log, request });

  assert.equal(result.loaded, true);
  assert.equal(env.OPENAI_API_KEY, "sk-new");
  // Precedence is the migration path: populate, confirm in the log, THEN prune
  // the plaintext env var. If the environment won, the loader could not be
  // verified until after the fallback had already been deleted.
  assert.equal(env.STRIPE_SECRET_KEY, "the-managed-copy");
  assert.deepEqual(result.overridden, ["STRIPE_SECRET_KEY"]);
});

test("the log names the keys and never prints a value", async () => {
  const env = { AGENTLY_SECRETS_ID: "x", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
  const log = quietLog();
  const request = async () => ({
    status: 200,
    body: {
      SecretString: JSON.stringify({
        OPENAI_API_KEY: "sk-live-do-not-log-me",
        TWILIO_AUTH_TOKEN: "tw-secret",
      }),
    },
  });

  await loadSecrets({ env, log, request });

  const text = log.lines.map(([, m]) => m).join("\n");
  assert.ok(text.includes("OPENAI_API_KEY"), "an operator must be able to confirm WHICH keys arrived");
  assert.ok(text.includes("TWILIO_AUTH_TOKEN"));
  assert.ok(
    !text.includes("sk-live-do-not-log-me"),
    "a secret in the container log is the bug this feature exists to fix",
  );
  assert.ok(!text.includes("tw-secret"));
});

/* ---- Everything below is a failure that MUST still boot the API. ---- */

test("no AGENTLY_SECRETS_ID is a silent no-op, not an error", async () => {
  const env = { STRIPE_SECRET_KEY: "from-env" };
  const log = quietLog();
  const result = await loadSecrets({
    env,
    log,
    request: async () => { throw new Error("must not be called"); },
  });

  assert.equal(result.loaded, false);
  assert.equal(env.STRIPE_SECRET_KEY, "from-env");
  assert.equal(
    log.lines.length, 0,
    "the pre-migration state is normal and must not log an error every boot",
  );
});

test("AccessDenied falls back to the environment without echoing the secret id", async () => {
  const env = {
    AGENTLY_SECRETS_ID: "agently/api",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
    STRIPE_SECRET_KEY: "from-env",
  };
  const log = quietLog();
  const request = async () => ({
    status: 400,
    body: {
      __type: "AccessDeniedException",
      Message:
        "User is not authorized to perform secretsmanager:GetSecretValue on resource: agently/api",
    },
  });

  const result = await loadSecrets({ env, log, request });

  assert.equal(result.loaded, false);
  assert.equal(env.STRIPE_SECRET_KEY, "from-env", "a revoked key must not take the API down with it");
  const text = log.lines.map(([, m]) => m).join("\n");
  assert.ok(text.includes("AccessDeniedException"));
  assert.ok(
    !text.includes("not authorized to perform"),
    "the raw AWS message can quote the secret ARN",
  );
});

test("a network failure or timeout falls back instead of throwing", async () => {
  const env = {
    AGENTLY_SECRETS_ID: "x",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
    OPENAI_API_KEY: "from-env",
  };
  const log = quietLog();
  const request = async () => { throw new Error("The operation was aborted due to timeout"); };

  const result = await loadSecrets({ env, log, request });

  assert.equal(result.loaded, false);
  assert.equal(env.OPENAI_API_KEY, "from-env");
  assert.equal(log.lines[0][0], "error");
});

test("configured without a key pair, it falls back loudly", async () => {
  const env = { AGENTLY_SECRETS_ID: "x", OPENAI_API_KEY: "from-env" };
  const log = quietLog();
  const result = await loadSecrets({
    env,
    log,
    request: async () => { throw new Error("must not be called"); },
  });

  assert.equal(result.loaded, false);
  assert.equal(env.OPENAI_API_KEY, "from-env");
  assert.equal(log.lines[0][0], "error", "this one IS a misconfiguration and must be visible");
});

test("a secret that is not a flat JSON object falls back rather than corrupting the environment", async () => {
  for (const payload of ["not json at all", '["a","b"]', "null", '"a bare string"']) {
    const env = {
      AGENTLY_SECRETS_ID: "x",
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      OPENAI_API_KEY: "from-env",
    };
    const log = quietLog();
    const result = await loadSecrets({
      env,
      log,
      request: async () => ({ status: 200, body: { SecretString: payload } }),
    });

    assert.equal(result.loaded, false, `payload ${payload} should not be accepted`);
    assert.equal(env.OPENAI_API_KEY, "from-env");
    assert.equal(log.lines[0][0], "error");
  }
});

test("a binary-only secret (no SecretString) falls back", async () => {
  const env = {
    AGENTLY_SECRETS_ID: "x",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
    OPENAI_API_KEY: "from-env",
  };
  const log = quietLog();
  const result = await loadSecrets({
    env,
    log,
    request: async () => ({ status: 200, body: { SecretBinary: "AAAA" } }),
  });

  assert.equal(result.loaded, false);
  assert.equal(env.OPENAI_API_KEY, "from-env");
});
