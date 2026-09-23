"use strict";

/**
 * p7: watch the webhook path specifically.
 *
 * Webhooks are the one surface where failure is silent and expensive. A user
 * who cannot log in complains within minutes. A Stripe fulfilment webhook that
 * started returning 500 takes the money and never provisions, and a Resend
 * bounce webhook that stops being accepted means the suppression list quietly
 * stops growing — em2's whole failure mode. Nobody is on the other end to
 * notice either one.
 *
 * Two halves, and the second is the one that matters:
 *
 *   record()  — one row per delivery: provider, outcome, status, latency.
 *   health()  — a verdict an EXTERNAL checker can poll, returning 503 when the
 *               recent failure rate crosses a threshold, so an uptime monitor
 *               alerts without anyone reading a log.
 *
 * Recording NEVER affects the webhook's own response. A monitoring write that
 * can fail a Stripe delivery would cause the outage it exists to detect, so
 * every failure here is swallowed after logging.
 *
 * NOTHING FROM THE PAYLOAD IS STORED beyond the provider's own event id and
 * type. Webhook bodies carry cards, emails and call transcripts.
 */

const { getSupabase } = require("./supabase");
const { log } = require("./logger");

const WINDOW_MINUTES = 15;

/* A provider that has sent nothing in the window is not unhealthy — Stripe is
   quiet at 3am. Only a provider with traffic can be judged. */
const MIN_SAMPLE = 3;
const FAILURE_RATE_UNHEALTHY = 0.5;

/**
 * Record one delivery. Fire-and-forget by design: callers must not await this
 * on the response path, and it resolves rather than rejects.
 */
async function record({
  provider,
  eventType = null,
  externalId = null,
  signatureOk = null,
  statusCode = null,
  durationMs = null,
  outcome,
  detail = null,
}) {
  // Structured log first: if the table write fails, the line still exists.
  const level = outcome === "accepted" ? "info" : "warn";
  log[level]("webhook", {
    provider,
    eventType,
    externalId,
    signatureOk,
    status: statusCode,
    ms: durationMs,
    outcome,
    detail: detail ? String(detail).slice(0, 200) : undefined,
  });

  try {
    const { error } = await getSupabase().from("webhook_deliveries").insert({
      provider: String(provider || "unknown"),
      event_type: eventType ? String(eventType).slice(0, 120) : null,
      external_id: externalId ? String(externalId).slice(0, 200) : null,
      signature_ok: typeof signatureOk === "boolean" ? signatureOk : null,
      status_code: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
      duration_ms: Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : null,
      outcome,
      detail: detail ? String(detail).slice(0, 500) : null,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    // Deliberately swallowed. See the header: a monitoring write must never
    // be able to fail the delivery it is monitoring.
    log.warn("webhook.record_failed", { provider, reason: error.message });
  }
}

/** Wrap a handler so every outcome is recorded without touching its logic. */
function monitored(provider, handler) {
  return async function monitoredWebhook(req, res, ...rest) {
    const startedAt = process.hrtime.bigint();
    let finished = false;
    res.on("finish", () => {
      if (finished) return;
      finished = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const statusCode = res.statusCode;
      void record({
        provider,
        eventType: res.locals?.webhookEventType || null,
        externalId: res.locals?.webhookExternalId || null,
        signatureOk: res.locals?.webhookSignatureOk ?? (statusCode === 400 || statusCode === 401 ? false : null),
        statusCode,
        durationMs,
        outcome: statusCode < 300 ? "accepted" : statusCode < 500 ? "rejected" : "error",
      });
    });
    return handler(req, res, ...rest);
  };
}

/**
 * A verdict, not a dump. `ok` false and HTTP 503 is what an uptime checker
 * alerts on.
 */
async function health({ windowMinutes = WINDOW_MINUTES } = {}) {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const { data, error } = await getSupabase()
    .from("webhook_deliveries")
    .select("provider, outcome, status_code, duration_ms, received_at")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(2000);

  if (error) {
    // Cannot tell healthy from unhealthy — say so rather than reporting ok.
    return { ok: false, unknown: true, reason: error.message, window_minutes: windowMinutes, providers: {} };
  }

  const providers = {};
  for (const row of data || []) {
    const p = (providers[row.provider] ||= { total: 0, accepted: 0, rejected: 0, error: 0, p95_ms: 0, _ms: [] });
    p.total++;
    p[row.outcome] = (p[row.outcome] || 0) + 1;
    if (Number.isFinite(row.duration_ms)) p._ms.push(row.duration_ms);
  }

  let ok = true;
  const unhealthy = [];
  for (const [name, p] of Object.entries(providers)) {
    p._ms.sort((a, b) => a - b);
    p.p95_ms = p._ms.length ? p._ms[Math.min(p._ms.length - 1, Math.floor(p._ms.length * 0.95))] : null;
    delete p._ms;
    p.failure_rate = p.total ? Number(((p.total - p.accepted) / p.total).toFixed(3)) : 0;
    p.judged = p.total >= MIN_SAMPLE;
    if (p.judged && p.failure_rate >= FAILURE_RATE_UNHEALTHY) {
      ok = false;
      unhealthy.push(name);
    }
  }

  return {
    ok,
    window_minutes: windowMinutes,
    checked_at: new Date().toISOString(),
    deliveries: (data || []).length,
    unhealthy,
    providers,
    note:
      "A provider with fewer than " +
      MIN_SAMPLE +
      " deliveries in the window is not judged — silence is not failure. Absence of traffic is NOT detected here; that needs a separate expected-frequency check.",
  };
}

module.exports = { record, monitored, health, WINDOW_MINUTES, FAILURE_RATE_UNHEALTHY, MIN_SAMPLE };
