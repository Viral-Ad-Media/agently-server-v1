"use strict";

/**
 * N014: something that WATCHES, not just records.
 *
 * p6 made errors structured and p7 made webhook failures countable. Both are
 * passive: a 500 at 3am still sits in the container log until somebody thinks
 * to look. This closes that, without a vendor account, a DSN, or a new
 * dependency — it reuses the email path that already exists and is already
 * verified working.
 *
 * WHAT IT CANNOT DO, said plainly rather than discovered later: this runs
 * INSIDE the API. If the container is dead, nothing here fires. It detects a
 * sick process, not an absent one. Liveness needs an external checker polling
 * GET /api/webhooks/health, which p7 built precisely so that a third party
 * could judge this system without credentials to it. This is the half that can
 * be built from the inside; the other half is a service you point at the
 * endpoint.
 *
 * ALERT FATIGUE IS A FAILURE MODE, not an inconvenience. An alerter that mails
 * every minute during an incident gets filtered, and then it has made things
 * worse than silence. So: it notifies on the TRANSITION into unhealthy, once,
 * then stays quiet until either the state clears or the re-notify interval
 * passes. Recovery is also notified, once — an incident with no "it stopped"
 * leaves someone refreshing a dashboard.
 */

const { health } = require("./webhook-monitor");
const { log } = require("./logger");

const CHECK_INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS || 5 * 60 * 1000);
const RENOTIFY_MS = Number(process.env.HEALTH_RENOTIFY_MS || 60 * 60 * 1000);

/* Remembered in process. Losing it on restart is acceptable and even useful:
   a restart re-alerts if the condition is still there. */
const state = { unhealthy: false, lastNotifiedAt: 0, checks: 0, alerts: 0 };

function recipients() {
  return String(process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function notify(subject, body) {
  const to = recipients();
  if (!to.length) {
    // Do not fail silently: an alerter with nobody to alert is the same shape
    // as a disabled one, and it should say so every time it would have fired.
    log.error("health_alert.no_recipients", { subject });
    return false;
  }

  try {
    const { sendTrackedEmail } = require("./email");
    for (const address of to) {
      await sendTrackedEmail({
        to: address,
        subject,
        html: `<pre style="font:13px ui-monospace,monospace;white-space:pre-wrap">${body}</pre>`,
        text: body,
        emailType: "platform_health_alert",
        route: "health-alerts.notify",
      });
    }
    state.alerts++;
    return true;
  } catch (error) {
    log.error("health_alert.send_failed", { subject, reason: error.message });
    return false;
  }
}

/** One pass. Exported so it can be tested and invoked on demand. */
async function checkOnce({ now = Date.now(), healthFn = health, notifyFn = notify } = {}) {
  state.checks++;
  const report = await healthFn({ windowMinutes: 15 });

  // `unknown` (the query itself failed) counts as unhealthy. Not being able to
  // tell is not the same as fine — the trap N011, N005 and N013 all fell into.
  const bad = report.ok === false;

  if (bad && !state.unhealthy) {
    state.unhealthy = true;
    state.lastNotifiedAt = now;
    const lines = [
      report.unknown
        ? `Webhook health could not be determined: ${report.reason}`
        : `Webhook providers failing: ${report.unhealthy.join(", ")}`,
      "",
      `window          : ${report.window_minutes} minutes`,
      `deliveries seen : ${report.deliveries ?? "unknown"}`,
      "",
      JSON.stringify(report.providers || {}, null, 2),
      "",
      "A failing webhook path means Stripe fulfilment or Resend bounce handling",
      "is silently not working. Nobody on the other end will report this.",
    ].join("\n");
    await notifyFn("Agently: webhook path unhealthy", lines);
    return { changed: true, unhealthy: true };
  }

  if (bad && state.unhealthy && now - state.lastNotifiedAt >= RENOTIFY_MS) {
    state.lastNotifiedAt = now;
    await notifyFn(
      "Agently: webhook path STILL unhealthy",
      `Unresolved since ${new Date(state.lastNotifiedAt).toISOString()}.\n\n` +
        JSON.stringify(report.providers || {}, null, 2),
    );
    return { changed: false, unhealthy: true, renotified: true };
  }

  if (!bad && state.unhealthy) {
    state.unhealthy = false;
    state.lastNotifiedAt = 0;
    // An incident with no "it stopped" leaves someone refreshing a dashboard.
    await notifyFn("Agently: webhook path recovered", "Webhook deliveries are being accepted again.");
    return { changed: true, unhealthy: false, recovered: true };
  }

  return { changed: false, unhealthy: state.unhealthy };
}

let timer = null;

function start() {
  if (timer) return { started: false, reason: "already running" };
  if (process.env.HEALTH_ALERTS_ENABLED !== "true") {
    log.info("health_alerts.disabled", { hint: "set HEALTH_ALERTS_ENABLED=true" });
    return { started: false, reason: "disabled" };
  }
  if (!recipients().length) {
    log.error("health_alerts.no_recipients", { hint: "set PLATFORM_ADMIN_EMAILS" });
    return { started: false, reason: "no recipients" };
  }

  timer = setInterval(() => {
    checkOnce().catch((error) => log.error("health_alert.check_failed", { reason: error.message }));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();

  log.info("health_alerts.started", {
    intervalMs: CHECK_INTERVAL_MS,
    renotifyMs: RENOTIFY_MS,
    recipients: recipients().length,
  });
  return { started: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, checkOnce, state, CHECK_INTERVAL_MS, RENOTIFY_MS };
