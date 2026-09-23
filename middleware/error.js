"use strict";

const { mentionsVendor, newReference } = require("../lib/provider-errors");
const { logError } = require("../lib/logger");

const recentDependencyLogs = new Map();

function errorText(error) {
  return `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""} ${error?.cause?.message || ""}`.trim();
}

function isTransientDependencyError(error) {
  if (!error) return false;
  const text = errorText(error).toLowerCase();
  const code = String(error.code || error.cause?.code || "").toUpperCase();
  return (
    text.includes("fetch failed") ||
    text.includes("network request failed") ||
    text.includes("connect timeout") ||
    text.includes("connection timeout") ||
    text.includes("eai_again") ||
    text.includes("enotfound") ||
    text.includes("socket hang up") ||
    text.includes("aborted") ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function logDependencyError(error, req) {
  const route = `${req?.method || "REQUEST"} ${req?.originalUrl || req?.url || "unknown"}`;
  const key = `${route}:${String(error?.code || error?.cause?.code || error?.message || "dependency")}`;
  const now = Date.now();
  const previous = recentDependencyLogs.get(key);

  if (previous && now - previous.lastAt < 15000) {
    previous.suppressed += 1;
    previous.lastAt = now;
    return;
  }

  if (previous?.suppressed) {
    console.warn(
      `[dependency] ${route}: suppressed ${previous.suppressed} repeated failures.`,
    );
  }

  recentDependencyLogs.set(key, { lastAt: now, suppressed: 0 });
  if (recentDependencyLogs.size > 500) {
    for (const [candidate, entry] of recentDependencyLogs.entries()) {
      if (now - entry.lastAt > 60000) recentDependencyLogs.delete(candidate);
    }
  }

  console.warn(
    `[dependency] ${route}:`,
    errorText(error) || "service unavailable",
  );
}

function errorHandler(err, req, res, _next) {
  const dependencyFailure = isTransientDependencyError(err);
  const status = dependencyFailure
    ? 503
    : Number(err?.status || err?.statusCode || 500);

  if (dependencyFailure) {
    logDependencyError(err, req);
    res.setHeader("Retry-After", "5");
  } else {
    // Structured, with the request id and route attached, so a user reporting
    // "it failed around 2pm" can be matched to an exact request instead of
    // grepped for. Message and stack are redacted by lib/logger.
    logError(err, req, { handled: "errorHandler", status });
  }

  if (res.headersSent) return;

  let message = dependencyFailure
    ? "Agently could not reach a required data service. Your session is still valid; please retry."
    : err?.message || "Internal server error.";
  let code = dependencyFailure
    ? "DEPENDENCY_UNAVAILABLE"
    : err?.code || "INTERNAL_ERROR";
  let reference;

  // Last line of defence. Individual routes translate their own upstream
  // failures (see lib/provider-errors.js), but anything that throws past
  // them lands here and this handler used to relay err.message verbatim —
  // which is how a vendor's billing notice reached a tenant. If a message
  // names a provider, it is replaced and the original is logged instead.
  if (!dependencyFailure && mentionsVendor(message)) {
    reference = newReference();
    console.error(
      `[provider-leak-blocked] ${reference} route=${req?.method} ${
        String(req?.originalUrl || req?.url || "").split("?")[0]
      } original=${JSON.stringify(String(message).slice(0, 500))}`,
    );
    message = `That request could not be completed right now. Please try again shortly — if it keeps happening, contact support and quote ${reference}.`;
    code = "UPSTREAM_UNAVAILABLE";
  }

  res.status(status).json({
    error: {
      message,
      code,
      ...(reference && { reference }),
      retryable: dependencyFailure || Boolean(reference),
      ...(process.env.NODE_ENV !== "production" &&
        !dependencyFailure &&
        !reference && { stack: err?.stack }),
    },
  });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, asyncHandler, isTransientDependencyError };
