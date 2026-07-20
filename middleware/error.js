"use strict";

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
    console.error("[app] request error:", err && err.stack ? err.stack : err);
  }

  if (res.headersSent) return;

  res.status(status).json({
    error: {
      message: dependencyFailure
        ? "Agently could not reach a required data service. Your session is still valid; please retry."
        : err?.message || "Internal server error.",
      code: dependencyFailure
        ? "DEPENDENCY_UNAVAILABLE"
        : err?.code || "INTERNAL_ERROR",
      retryable: dependencyFailure,
      ...(process.env.NODE_ENV !== "production" &&
        !dependencyFailure && { stack: err?.stack }),
    },
  });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, asyncHandler, isTransientDependencyError };
