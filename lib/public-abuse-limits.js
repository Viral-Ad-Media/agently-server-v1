"use strict";

/**
 * c4: abuse and cost controls for the public, unauthenticated chat endpoint.
 *
 * The endpoint is unauthenticated BY DESIGN — it is what the embedded widget
 * on a customer's website talks to. So the controls have to work without an
 * identity, which leaves two levers: how often a source may call, and how much
 * a tenant may spend in a day.
 *
 * WHAT WAS WRONG WITH THE OLD CEILINGS. They lived in a process-global Map.
 * That has two consequences nobody would choose deliberately:
 *
 *   - they reset to zero on every container restart, and this container
 *     restarts on every deploy — five times today alone,
 *   - they are per-instance, so scaling to two replicas doubles every limit
 *     silently.
 *
 * An attacker does not need to know either of those to benefit from them.
 *
 * These use the same atomic Postgres counter the auth limiter uses
 * (auth_rate_limit_hit), so a ceiling is shared across instances and survives
 * a restart. It costs one round trip — about 313ms on this deployment, since
 * the API is in us-east-1 and the database is in eu-central-1 (N010).
 *
 * FAIL CLOSED, and this is a real choice rather than a default. The auth
 * limiter fails closed because letting brute force through is worse than a
 * brief outage (i10). The same logic applies harder here: this endpoint costs
 * MONEY per call. If the counter is unreachable we cannot tell a first visitor
 * from the ten-thousandth, and the safe answer to "I don't know" on a spend
 * path is no.
 *
 * THE SPEND CAP is the part the old code had nothing for. Rate limits bound
 * requests per minute; they do not bound a month's bill. A per-organization
 * daily ceiling, read from the usage ledger that already records every call,
 * is what turns "someone is hammering the widget" from an invoice into a 429.
 */

const { getSupabase } = require("./supabase");
const { log } = require("./logger");

const MINUTE = 60;

/* Per-source and per-tenant request ceilings. Two levels on purpose: the
   per-IP one stops a single abuser, the per-chatbot one stops a distributed
   one from bankrupting the tenant. */
const POLICIES = {
  public_chat_ip: { windowSecs: MINUTE, max: 20 },
  public_chat_bot: { windowSecs: MINUTE, max: 300 },
  public_voice_ip: { windowSecs: MINUTE, max: 10 },
  public_voice_bot: { windowSecs: MINUTE, max: 60 },

  /* c6: webcall TOKEN ISSUANCE. Every token starts a paid realtime session,
     so the cost is incurred at issuance, not at verification — which is the
     endpoint that already had a throttle. Keyed on the organization and the
     user id taken from the VERIFIED SESSION, never on anything the caller
     sends: that is the whole point of the row's title. An authenticated user
     can still burn their own allowance; they cannot burn somebody else's, and
     they cannot reset their own by changing a header. */
  webcall_token_user: { windowSecs: MINUTE, max: 6 },
  webcall_token_org: { windowSecs: MINUTE, max: 30 },
  webcall_token_org_hour: { windowSecs: 60 * MINUTE, max: 200 },
};

/* Daily spend ceiling per organization on public (unauthenticated) traffic.
   Deliberately generous — this is an abuse brake, not a billing tier. */
const DAILY_PUBLIC_SPEND_CAP_USD = Number(process.env.PUBLIC_DAILY_SPEND_CAP_USD || 25);

/**
 * One atomic increment against the shared counter.
 * Returns { allowed, degraded }. `degraded` means the counter could not be
 * reached, which is reported rather than hidden — an unverifiable control is
 * the failure mode this codebase keeps rediscovering.
 */
async function hitShared(policyName, identifier) {
  const policy = POLICIES[policyName];
  if (!policy) throw new Error(`Unknown public limit policy: ${policyName}`);

  try {
    const { data, error } = await getSupabase().rpc("auth_rate_limit_hit", {
      p_bucket: `${policyName}:${String(identifier || "unknown").toLowerCase().trim()}`,
      p_window_secs: policy.windowSecs,
      // p_limit, NOT p_max. Getting this wrong made every call error, and the
      // fail-closed branch then answered 503 to twenty consecutive requests —
      // correct behaviour hiding a broken control, which is exactly why the
      // degraded flag is reported rather than swallowed.
      p_limit: policy.max,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return { allowed: Boolean(row?.allowed), degraded: false };
  } catch (error) {
    log.warn("public_limit.degraded", { policy: policyName, reason: error.message });
    // See the header: on a path that spends money, "I don't know" means no.
    return { allowed: false, degraded: true };
  }
}

/**
 * Has this organization already spent its daily allowance on public traffic?
 *
 * Reads the usage ledger rather than a separate counter, so it cannot drift
 * from what is actually billed.
 */
async function isOverDailySpendCap(organizationId) {
  if (!organizationId) return { over: false, spentUsd: 0 };
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  try {
    const { data, error } = await getSupabase()
      .from("billing_usage_events")
      .select("estimated_cost_usd")
      .eq("organization_id", organizationId)
      .gte("occurred_at", since.toISOString())
      .limit(5000);
    if (error) throw new Error(error.message);

    const spentUsd = (data || []).reduce((sum, r) => sum + (Number(r.estimated_cost_usd) || 0), 0);
    return { over: spentUsd >= DAILY_PUBLIC_SPEND_CAP_USD, spentUsd, capUsd: DAILY_PUBLIC_SPEND_CAP_USD };
  } catch (error) {
    // A spend cap that cannot read spend must not silently allow unlimited
    // spend. Same reasoning as above.
    log.warn("public_spend_cap.degraded", { organizationId, reason: error.message });
    return { over: true, degraded: true, spentUsd: null, capUsd: DAILY_PUBLIC_SPEND_CAP_USD };
  }
}

/**
 * The whole gate for one public request.
 * Resolves { ok } or { ok: false, status, body } ready to send.
 */
async function checkPublicRequest({ scope, clientIp, chatbotId, organizationId }) {
  const ipPolicy = scope === "voice" ? "public_voice_ip" : "public_chat_ip";
  const botPolicy = scope === "voice" ? "public_voice_bot" : "public_chat_bot";

  const perIp = await hitShared(ipPolicy, `${clientIp}:${chatbotId}`);
  if (!perIp.allowed) {
    return {
      ok: false,
      status: perIp.degraded ? 503 : 429,
      body: {
        error: {
          code: perIp.degraded ? "RATE_LIMIT_UNAVAILABLE" : "RATE_LIMITED",
          message: perIp.degraded
            ? "This service is temporarily unavailable. Please retry shortly."
            : "Too many requests. Please slow down.",
          retryable: true,
        },
      },
      retryAfter: 30,
    };
  }

  const perBot = await hitShared(botPolicy, chatbotId);
  if (!perBot.allowed) {
    return {
      ok: false,
      status: perBot.degraded ? 503 : 429,
      body: {
        error: {
          code: perBot.degraded ? "RATE_LIMIT_UNAVAILABLE" : "RATE_LIMITED",
          message: "This assistant is receiving too many requests. Please try again shortly.",
          retryable: true,
        },
      },
      retryAfter: 30,
    };
  }

  const spend = await isOverDailySpendCap(organizationId);
  if (spend.over) {
    log.warn("public_spend_cap.blocked", {
      organizationId,
      chatbotId,
      spentUsd: spend.spentUsd,
      capUsd: spend.capUsd,
      degraded: spend.degraded,
    });
    return {
      ok: false,
      status: 429,
      body: {
        error: {
          code: "DAILY_LIMIT_REACHED",
          message: "This assistant has reached its daily limit. Please try again tomorrow.",
          retryable: false,
        },
      },
      retryAfter: 3600,
    };
  }

  return { ok: true };
}


/**
 * c6: may this authenticated user be issued another webcall token?
 *
 * Separate from checkPublicRequest because the identity is different in kind:
 * that one has only an IP to work with, this one has a verified session. Same
 * fail-closed posture for the same reason — a token costs money.
 */
async function checkWebcallTokenIssue({ organizationId, userId }) {
  const checks = [
    ["webcall_token_user", `${organizationId}:${userId}`],
    ["webcall_token_org", organizationId],
    ["webcall_token_org_hour", organizationId],
  ];

  for (const [policy, identifier] of checks) {
    const result = await hitShared(policy, identifier);
    if (!result.allowed) {
      log.warn("webcall_token.refused", { policy, organizationId, userId, degraded: result.degraded });
      return {
        ok: false,
        status: result.degraded ? 503 : 429,
        body: {
          error: {
            code: result.degraded ? "RATE_LIMIT_UNAVAILABLE" : "RATE_LIMITED",
            message: result.degraded
              ? "Test calls are temporarily unavailable. Please retry shortly."
              : "Too many test calls started. Please wait a moment.",
            retryable: true,
          },
        },
        retryAfter: policy.endsWith("_hour") ? 600 : 30,
      };
    }
  }
  return { ok: true };
}

module.exports = {
  checkPublicRequest,
  checkWebcallTokenIssue,
  hitShared,
  isOverDailySpendCap,
  POLICIES,
  DAILY_PUBLIC_SPEND_CAP_USD,
};
