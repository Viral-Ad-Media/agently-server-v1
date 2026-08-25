"use strict";

const crypto = require("crypto");

/**
 * Upstream provider failures, translated for the person actually reading them.
 *
 * A tenant (and, on the public widget, a tenant's own customer) has no
 * relationship with the AI vendors behind this platform. Handing them
 * "You have no credits remaining. Add credits to continue using the API at
 * https://platform.openai.com/settings/organization/billing/" tells them
 * which vendor we resell, that our account is delinquent, and where our
 * billing page is. None of that is theirs to see, and none of it is
 * actionable for them.
 *
 * So: the operator-facing detail goes to the server log with a reference
 * code, and the caller gets a neutral sentence plus that same code. Support
 * can then join the two without the tenant ever learning who the provider is.
 *
 * The split below matters. Blanket-masking every upstream error would also
 * swallow the genuinely useful ones — "that recording was too short" is the
 * caller's problem to fix and naming no vendor. Those get relayed in our own
 * words. Everything else (auth, quota, billing, rate limits, provider
 * outages) is OUR problem and becomes "temporarily unavailable".
 */

// Upstream statuses that mean the provider or our account with it is at
// fault, never the caller's input.
const OPERATIONAL_STATUSES = new Set([401, 402, 403, 429, 500, 502, 503, 504]);

// Upstream complaints that ARE the caller's to fix. Matched against the
// provider's message, then answered in our own words so no vendor phrasing
// or URL is ever passed through verbatim.
const RELAYABLE_INPUT_ERRORS = [
  {
    test: /too short|minimum audio|audio_too_short/i,
    message:
      "That recording was too short to make out. Hold the mic a moment longer and try again.",
  },
  {
    test: /invalid file format|unsupported file|could not be decoded|unrecognized format/i,
    message:
      "That audio could not be read. Try recording again, or type your message instead.",
  },
  {
    test: /too large|maximum size|file size|too long/i,
    message:
      "That recording is too long to process. Try again with a shorter message.",
  },
  {
    test: /no audio|empty file|corrupt/i,
    message:
      "No audio came through. Check your microphone is allowed for this site and try again.",
  },
];

// Unambiguous vendor identifiers. Deliberately NOT generic words like
// "credit", "quota", "wallet" or "plan" — those appear in Agently's own
// billing messages, which are legitimately tenant-facing and must survive
// untouched.
const VENDOR_IDENTIFIERS =
  /(openai|open ai|eleven ?labs|anthropic|claude|whisper|gpt-[0-9a-z.]+|deepgram|assemblyai|twilio|platform\.openai|api\.openai)/i;

function newReference() {
  return `REF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/** True when a message would tell the reader which vendor sits behind us. */
function mentionsVendor(message) {
  return VENDOR_IDENTIFIERS.test(String(message || ""));
}

/**
 * Decide what the caller should be told, and what the log should record.
 *
 * @param {object}  input
 * @param {string}  input.provider   Vendor name — for the LOG only.
 * @param {string}  input.operation  What we were doing, e.g. "transcribe".
 * @param {number}  [input.status]   Upstream HTTP status, when known.
 * @param {*}       [input.error]    Error object or upstream message.
 * @param {string}  [input.fallback] Neutral sentence for the unclassified case.
 * @returns {{reference:string, clientMessage:string, isOperational:boolean, detail:string}}
 */
function describeProviderFailure({
  provider,
  operation,
  status,
  error,
  fallback,
}) {
  const detail =
    (typeof error === "string" ? error : null) ||
    error?.error?.message ||
    error?.message ||
    String(error || "unknown error");

  const reference = newReference();
  const numericStatus = Number(status || error?.status || error?.statusCode || 0);

  // Provider/account fault: never explain it, just own it.
  const isOperational =
    OPERATIONAL_STATUSES.has(numericStatus) || mentionsVendor(detail);

  if (!isOperational) {
    const relayable = RELAYABLE_INPUT_ERRORS.find((entry) =>
      entry.test.test(detail),
    );
    if (relayable) {
      return {
        reference,
        clientMessage: relayable.message,
        isOperational: false,
        detail,
      };
    }
  }

  return {
    reference,
    clientMessage: `${
      fallback || "That request could not be completed right now."
    } Please try again shortly — if it keeps happening, contact support and quote ${reference}.`,
    isOperational: true,
    detail,
  };
}

/**
 * Log the real cause where developers can find it. The vendor name, the
 * upstream status and the verbatim provider message all belong HERE.
 */
function logProviderFailure({
  provider,
  operation,
  status,
  detail,
  reference,
  req,
}) {
  const route = req
    ? `${req.method} ${String(req.originalUrl || req.url || "").split("?")[0]}`
    : "";
  console.error(
    `[provider-failure] ${reference} provider=${provider} op=${operation}` +
      `${status ? ` status=${status}` : ""}${route ? ` route=${route}` : ""}` +
      `${req?.orgId ? ` org=${req.orgId}` : ""} detail=${JSON.stringify(
        String(detail).slice(0, 500),
      )}`,
  );
}

/**
 * Classify, log the truth, and respond with the neutral version.
 * Returns the reference so callers can attach it to their own telemetry.
 */
function sendProviderFailure(res, options) {
  const described = describeProviderFailure(options);
  logProviderFailure({
    provider: options.provider,
    operation: options.operation,
    status: options.status,
    detail: described.detail,
    reference: described.reference,
    req: options.req,
  });

  // 502 for an upstream fault, so logs and uptime checks can tell a provider
  // outage apart from a genuine bug in this service. A caller-input problem
  // stays a 400 — it is not a server error.
  const responseStatus = described.isOperational ? 502 : 400;

  if (!res.headersSent) {
    res.status(responseStatus).json({
      error: {
        message: described.clientMessage,
        code: described.isOperational
          ? "UPSTREAM_UNAVAILABLE"
          : "INVALID_INPUT",
        reference: described.reference,
        retryable: described.isOperational,
      },
    });
  }
  return described.reference;
}

module.exports = {
  describeProviderFailure,
  logProviderFailure,
  sendProviderFailure,
  mentionsVendor,
  newReference,
};
