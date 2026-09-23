"use strict";

/**
 * The caller's address, taken from the end of the proxy chain the client
 * cannot write.
 *
 * X-Forwarded-For is a list, and the two ends mean opposite things. The load
 * balancer in front of this service APPENDS the peer address it observed
 * rather than replacing the header, so a request arriving with
 * `X-Forwarded-For: 203.0.113.99` is delivered as "203.0.113.99, <real peer>".
 * Reading element [0] reads whatever the caller typed.
 *
 * Measured against production on 22 Sep 2026: a POST carrying that header was
 * recorded by the super-admin audit log as ip=203.0.113.99 while the real peer
 * was 105.127.7.35. Four separate files had written the [0] form, and every
 * one of them used it for a security decision:
 *
 *   lib/super-admin-auth.js   allowlist, audit trail, login lockout key
 *   lib/auth-rate-limit.js    login_ip, code_send_ip, code_verify_ip,
 *                             register_ip, password_reset_ip
 *   api/routes/chatbot-public.js   public chat abuse and spend limits
 *   api/routes/webcall.js     webcall verification throttle
 *
 * A per-IP limit keyed on a forgeable value is not a limit: rotate the header
 * per request and every counter starts from zero. Hence one implementation,
 * imported everywhere, so a fifth copy cannot quietly reintroduce it.
 *
 * ASSUMPTION: exactly one proxy hop, which is this deployment. Putting a CDN
 * in front would append a second entry and this needs revisiting — the last
 * element would then be the CDN's egress rather than the visitor.
 */

const net = require("net");

function clientIp(req) {
  const chain = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const observed = chain.length ? chain[chain.length - 1] : "";
  if (observed && net.isIP(observed)) return observed;

  // Only reachable with no proxy in front — a direct connection, i.e. local
  // development. Behind the load balancer the chain above always wins, so
  // these cannot be used to spoof anything in production.
  const direct = req?.socket?.remoteAddress || req?.ip;
  if (direct) return String(direct);
  return "unknown";
}

module.exports = { clientIp };
