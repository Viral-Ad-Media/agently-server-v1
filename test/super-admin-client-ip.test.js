"use strict";
/*
 * The client IP behind the load balancer, and the three controls that trust it.
 *
 * X-Forwarded-For is a chain the client writes the left end of. Our load
 * balancer appends the peer address it actually saw, so the RIGHT end is the
 * only trustworthy entry. Reading the left end let a caller choose the IP used
 * for the super-admin allowlist, the audit log and the brute-force lockout key.
 *
 * Measured against production on 22 Sep 2026 before the fix: a request sent
 * with `X-Forwarded-For: 203.0.113.99` was recorded as ip=203.0.113.99 while
 * the real peer was 105.127.7.35.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../lib/super-admin-auth.js"), "utf8"),
    {
      module,
      process: { env },
      console: { warn() {}, error() {} },
      Buffer,
      Date,
      Math,
      Number,
      String,
      JSON,
      Map,
      require(id) {
        if (id === "crypto") return require("crypto");
        if (id === "net") return require("net");
        if (id === "bcryptjs") return require("bcryptjs");
        if (id === "jsonwebtoken") return require("jsonwebtoken");
        if (id === "./supabase") return { getSupabase: () => ({}) };
        // The real shared helper, not a stub: the whole point of these tests is
        // that every caller gets the same, correct derivation.
        if (id === "./client-ip") return require("../lib/client-ip");
        throw new Error(`unexpected require: ${id}`);
      },
    },
  );
  return module.exports;
}

const reqWith = (xff, peer = "10.0.0.7") => ({
  headers: xff === null ? {} : { "x-forwarded-for": xff },
  socket: { remoteAddress: peer },
});

test("a forged left-hand entry is ignored in favour of the address the proxy observed", () => {
  const { getClientIp } = load();
  assert.equal(getClientIp(reqWith("203.0.113.99, 105.127.7.35")), "105.127.7.35");
});

test("a single-entry chain is the proxy's own observation and is used", () => {
  const { getClientIp } = load();
  assert.equal(getClientIp(reqWith("105.127.7.35")), "105.127.7.35");
});

test("no header falls back to the socket peer, not to a forgeable value", () => {
  const { getClientIp } = load();
  assert.equal(getClientIp(reqWith(null)), "10.0.0.7");
});

test("a junk chain falls back to the socket peer rather than trusting garbage", () => {
  const { getClientIp } = load();
  assert.equal(getClientIp(reqWith("not-an-ip")), "10.0.0.7");
  assert.equal(getClientIp(reqWith("1.2.3.4, still-not-an-ip")), "10.0.0.7");
});

test("whitespace and empty members in the chain do not shift the result", () => {
  const { getClientIp } = load();
  assert.equal(getClientIp(reqWith("  203.0.113.99 ,  , 105.127.7.35  ")), "105.127.7.35");
});

test("IPv6 is accepted", () => {
  const { getClientIp } = load();
  assert.equal(getClientIp(reqWith("203.0.113.99, 2001:db8::1")), "2001:db8::1");
});

/* ---- the controls that depend on it ---------------------------------- */

test("the allowlist cannot be satisfied by a forged header", () => {
  const { isAllowedIp } = load({ SUPER_ADMIN_ALLOWED_IPS: "198.51.100.5" });
  // Attacker sends the allowed address; the proxy appends their real one.
  assert.equal(isAllowedIp(reqWith("198.51.100.5, 105.127.7.35")), false);
  // The genuine holder of that address still gets in.
  assert.equal(isAllowedIp(reqWith("198.51.100.5")), true);
});

test("an empty allowlist still allows everyone — documented, not accidental", () => {
  const { isAllowedIp } = load({ SUPER_ADMIN_ALLOWED_IPS: "" });
  assert.equal(isAllowedIp(reqWith("203.0.113.99, 105.127.7.35")), true);
});

test("a multi-entry allowlist matches any of its members", () => {
  const { isAllowedIp } = load({ SUPER_ADMIN_ALLOWED_IPS: " 198.51.100.5 , 105.127.7.35 " });
  assert.equal(isAllowedIp(reqWith("105.127.7.35")), true);
  assert.equal(isAllowedIp(reqWith("192.0.2.1")), false);
});

test("the brute-force lockout key cannot be rotated by changing the header", () => {
  const mod = load();
  const key = (xff) => `${mod.getClientIp(reqWith(xff))}:admin@example.com`;
  // Same real client, three different forged prefixes: one bucket, not three.
  const keys = new Set([
    key("203.0.113.1, 105.127.7.35"),
    key("203.0.113.2, 105.127.7.35"),
    key("203.0.113.3, 105.127.7.35"),
  ]);
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], "105.127.7.35:admin@example.com");
});

/* ---- the same helper, everywhere it is used -------------------------- */

test("every caller derives the address through the one shared helper", () => {
  const shared = require("../lib/client-ip").clientIp;
  const superAdmin = load().getClientIp;
  const rateLimit = require("../lib/auth-rate-limit").clientIp;
  const forged = reqWith("198.51.100.5, 105.127.7.35");
  assert.equal(shared(forged), "105.127.7.35");
  assert.equal(superAdmin(forged), "105.127.7.35");
  assert.equal(rateLimit(forged), "105.127.7.35");
});

test("per-IP auth limits cannot be reset by rotating the header", () => {
  const { clientIp } = require("../lib/client-ip");
  // The bucket lib/auth-rate-limit.js builds is `${policy}:${identifier}`.
  const bucket = (xff) => `code_send_ip:${clientIp(reqWith(xff))}`;
  const buckets = new Set([
    bucket("203.0.113.1, 105.127.7.35"),
    bucket("203.0.113.2, 105.127.7.35"),
    bucket("10.0.0.9, 105.127.7.35"),
  ]);
  assert.equal(buckets.size, 1, "one real client must map to one counter");
  assert.equal([...buckets][0], "code_send_ip:105.127.7.35");
});

test("two genuinely different clients still get separate counters", () => {
  const { clientIp } = require("../lib/client-ip");
  assert.notEqual(
    clientIp(reqWith("203.0.113.1, 105.127.7.35")),
    clientIp(reqWith("203.0.113.1, 41.58.2.9")),
  );
});
