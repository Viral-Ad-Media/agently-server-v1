"use strict";

/**
 * Structured logging and error capture.
 *
 * p6 measured the state honestly: no Sentry, no Datadog, no pino, no
 * OpenTelemetry — console.* into a Lightsail container log with no search and
 * no alerting. This does not pretend to be an APM. It does the part that has
 * to exist first and that no vendor can do for you: make every line MACHINE
 * READABLE and give every line enough context to be worth reading.
 *
 * One JSON object per line on stdout. Whatever you point at the log later —
 * CloudWatch, a Datadog agent, Sentry's log drain — ingests structured JSON;
 * none of them can do anything useful with `console.log("failed:", e)`.
 *
 * Why not just add Sentry now: it needs an account, a DSN in the secret store,
 * and a dependency in an image that currently has fourteen. The blocker on p6
 * was never the vendor, it was that a request could not be traced through the
 * log at all. That is what this fixes. Adding a drain afterwards is a config
 * change, not a rewrite.
 *
 * NOTHING SECRET GOES IN A LOG LINE. Values are redacted by key name, and the
 * redaction list is deliberately broad — this codebase has already shipped one
 * credential-retention bug (N002) by logging a subject that contained an OTP.
 */

const crypto = require("crypto");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;

/* Key names whose VALUES must never be printed. Matched case-insensitively as
   a substring, so `stripe_secret_key` and `authorization` are both caught. */
const SECRET_KEY = /(secret|token|password|passwd|api[-_]?key|authorization|cookie|credential|signature|otp|code_hash|token_hash|private)/i;

/* Values that look like a credential even under an innocent key name. */
const SECRET_VALUE = /^(sk-|rk_|pk_live|whsec_|re_|SG\.|Bearer\s|eyJ[A-Za-z0-9_-]{10,})/;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[deep]";
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[redacted]";
    // A bare 6-digit run is almost always an OTP in this codebase.
    return value.replace(/\b\d{6}\b/g, "[redacted-code]");
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level, message, fields = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: String(message),
    ...redact(fields),
  };
  let text;
  try {
    text = JSON.stringify(line);
  } catch (_) {
    // A circular or unserialisable field must not silence the log line.
    text = JSON.stringify({ ts: line.ts, level, msg: line.msg, fields: "[unserialisable]" });
  }
  (level === "error" ? process.stderr : process.stdout).write(text + "\n");
}

const log = {
  debug: (m, f) => emit("debug", m, f),
  info: (m, f) => emit("info", m, f),
  warn: (m, f) => emit("warn", m, f),
  error: (m, f) => emit("error", m, f),
};

/** Everything known about the request, for attaching to any line. */
function requestContext(req) {
  if (!req) return {};
  return {
    requestId: req.id,
    method: req.method,
    route: req.originalUrl || req.url,
    orgId: req.orgId || req.organizationId || undefined,
    userId: req.user?.id || undefined,
  };
}

/**
 * Tag each request and log one line when it completes. The completion line is
 * what makes a log searchable: without status and duration you cannot answer
 * "what was slow" or "what started failing at 14:00".
 */
function requestLogger(options = {}) {
  const skip = options.skip || ((req) => req.path === "/health");
  return function requestLoggerMiddleware(req, res, next) {
    req.id = req.headers["x-request-id"] || crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    if (skip(req)) return next();

    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      emit(level, "request", {
        ...requestContext(req),
        status: res.statusCode,
        ms: Math.round(ms),
      });
    });
    next();
  };
}

/** One error, with its stack and the request that caused it. */
function logError(error, req, extra = {}) {
  emit("error", error?.message || "unhandled error", {
    ...requestContext(req),
    errorName: error?.name,
    errorCode: error?.code || error?.cause?.code,
    stack: String(error?.stack || "").split("\n").slice(0, 12).join("\n"),
    ...extra,
  });
}

/**
 * Catch what escapes every handler. Without this an unhandled rejection is a
 * silent container restart with nothing in the log explaining why.
 *
 * An uncaught exception leaves the process in an undefined state, so it is
 * logged and then rethrown by exiting — Lightsail restarts the container, and
 * a crash that is visible is worth more than one that is swallowed.
 */
function installProcessHandlers({ exitOnUncaught = true } = {}) {
  process.on("unhandledRejection", (reason) => {
    emit("error", "unhandledRejection", {
      errorName: reason?.name,
      reason: reason?.message || String(reason),
      stack: String(reason?.stack || "").split("\n").slice(0, 12).join("\n"),
    });
  });
  process.on("uncaughtException", (error) => {
    emit("error", "uncaughtException", {
      errorName: error?.name,
      reason: error?.message,
      stack: String(error?.stack || "").split("\n").slice(0, 12).join("\n"),
    });
    if (exitOnUncaught) process.exit(1);
  });
}

module.exports = { log, redact, requestLogger, requestContext, logError, installProcessHandlers };
