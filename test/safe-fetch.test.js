"use strict";
/*
 * SSRF protection for the website importer.
 *
 * This file exists as much to be HARD TO DELETE QUIETLY as to pass. On
 * 22 Sep 2026 the previous protection and its test were both found missing —
 * the check went, the test went with it, and nothing failed. Every assertion
 * below names the bypass it blocks, so a future reader deleting one has to
 * decide, in words, that the bypass is acceptable.
 *
 * No network is touched: dns and the http/https transports are injected.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const SOURCE = fs.readFileSync(path.join(__dirname, "../lib/safe-fetch.js"), "utf8");

/* A transport whose responses are scripted per hop. Each entry is either
   {status, location} for a redirect or {status, body} for a terminal answer. */
function fakeTransport(script, log) {
  return {
    request(options, onResponse) {
      const req = new EventEmitter();
      req.end = () => {
        log.push({ host: options.hostname, pinned: options.lookup });
        const step = script.shift();
        if (!step) { req.emit("error", new Error("no scripted response")); return; }
        const res = new EventEmitter();
        res.statusCode = step.status;
        res.headers = step.location
          ? { location: step.location }
          : { "content-type": "text/html" };
        setImmediate(() => {
          onResponse(res);
          if (step.body) res.emit("data", Buffer.from(step.body));
          res.emit("end");
        });
      };
      req.destroy = () => {};
      return req;
    },
  };
}

function load({ resolves = {}, script = [], log = [] } = {}) {
  const module = { exports: {} };
  const transport = fakeTransport(script, log);
  vm.runInNewContext(SOURCE, {
    module,
    Buffer,
    URL,
    setImmediate,
    process: { env: {} },
    console: { warn() {}, error() {} },
    require(id) {
      if (id === "dns") {
        return {
          promises: {
            lookup: async (hostname) => {
              const answer = resolves[hostname];
              if (!answer) throw new Error("ENOTFOUND");
              return answer;
            },
          },
        };
      }
      if (id === "net") return require("node:net");
      if (id === "zlib") return require("node:zlib");
      if (id === "http" || id === "https") return transport;
      throw new Error(`unexpected require: ${id}`);
    },
  });
  return module.exports;
}

/* ---- 1. addresses written directly ------------------------------------ */

test("every private, loopback and reserved IPv4 range is refused", () => {
  const { isBlockedAddress } = load();
  for (const ip of [
    "127.0.0.1", "127.1.1.1",      // loopback
    "10.0.0.1", "10.255.255.254",  // RFC1918
    "172.16.0.1", "172.31.255.1",  // RFC1918
    "192.168.1.1",                 // RFC1918
    "169.254.169.254",             // cloud instance metadata — the classic target
    "100.64.0.1",                  // carrier-grade NAT
    "0.0.0.0",
    "224.0.0.1",                   // multicast
    "255.255.255.255",
    "198.18.0.1",                  // benchmarking
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be refused`);
  }
});

test("ordinary public addresses are still allowed", () => {
  const { isBlockedAddress } = load();
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
});

test("IPv6 private forms are refused, including v4 addresses wearing IPv6 clothes", () => {
  const { isBlockedAddress } = load();
  for (const ip of [
    "::1",                    // loopback
    "::",                     // unspecified
    "fc00::1", "fd12:3456::1", // unique local
    "fe80::1",                // link-local
    "ff02::1",                // multicast
    "::ffff:127.0.0.1",       // IPv4-mapped loopback
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "64:ff9b::127.0.0.1",     // NAT64-wrapped loopback
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be refused`);
  }
  assert.equal(isBlockedAddress("2606:4700::1111"), false, "public IPv6 allowed");
});

/* ---- 2. the URL itself ------------------------------------------------- */

test("only http and https are fetchable", () => {
  const { assertAllowedUrl } = load();
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/", "data:text/html,x"]) {
    assert.throws(() => assertAllowedUrl(url), (e) => e.code === "SSRF_BLOCKED", url);
  }
  assert.equal(assertAllowedUrl("https://example.com/a").hostname, "example.com");
});

test("credentials embedded in a URL are refused", () => {
  const { assertAllowedUrl } = load();
  assert.throws(
    () => assertAllowedUrl("http://user:pass@internal.example/"),
    (e) => e.code === "SSRF_BLOCKED",
  );
});

/* ---- 3. resolution, not appearance ------------------------------------- */

test("a public hostname that RESOLVES to a private address is refused", async () => {
  const mod = load({ resolves: { "sneaky.example": [{ address: "10.1.2.3", family: 4 }] } });
  await assert.rejects(
    () => mod.resolvePublicAddresses("sneaky.example"),
    (e) => e.code === "SSRF_BLOCKED" && /private or reserved/.test(e.message),
  );
});

test("one private answer disqualifies the name even when another is public", async () => {
  const mod = load({
    resolves: {
      "split.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    },
  });
  await assert.rejects(
    () => mod.resolvePublicAddresses("split.example"),
    (e) => e.code === "SSRF_BLOCKED",
    "resolver ordering must not decide whether this is safe",
  );
});

test("a fully public name resolves and is returned for pinning", async () => {
  const mod = load({ resolves: { "ok.example": [{ address: "93.184.216.34", family: 4 }] } });
  const addrs = await mod.resolvePublicAddresses("ok.example");
  assert.deepEqual(addrs, [{ address: "93.184.216.34", family: 4 }]);
});

/* ---- 4. redirects, the hop nobody checked ------------------------------ */

test("a public URL that redirects to a private one is refused at the second hop", async () => {
  const log = [];
  const mod = load({
    resolves: {
      "public.example": [{ address: "93.184.216.34", family: 4 }],
      "internal.example": [{ address: "169.254.169.254", family: 4 }],
    },
    script: [{ status: 302, location: "http://internal.example/latest/meta-data/" }],
    log,
  });
  await assert.rejects(
    () => mod.safeFetch("https://public.example/start"),
    (e) => e.code === "SSRF_BLOCKED" && /private or reserved/.test(e.message),
  );
  assert.equal(log.length, 1, "the internal hop must never be requested");
});

test("a redirect to a literal internal address is refused too", async () => {
  const mod = load({
    resolves: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
    script: [{ status: 302, location: "http://127.0.0.1:8080/admin" }],
  });
  await assert.rejects(
    () => mod.safeFetch("https://public.example/start"),
    (e) => e.code === "SSRF_BLOCKED",
  );
});

test("ordinary public redirects still work", async () => {
  const mod = load({
    resolves: {
      "a.example": [{ address: "93.184.216.34", family: 4 }],
      "b.example": [{ address: "1.1.1.1", family: 4 }],
    },
    script: [
      { status: 301, location: "https://b.example/final" },
      { status: 200, body: "<html>arrived</html>" },
    ],
  });
  const out = await mod.safeFetch("https://a.example/start");
  assert.match(out.text, /arrived/);
  assert.equal(out.finalUrl, "https://b.example/final");
  // Spread first: the array is constructed inside the vm realm, so a strict
  // deepEqual compares prototypes across realms and fails on identity alone.
  assert.deepEqual([...out.redirects], ["https://b.example/final"]);
});

test("a redirect chain is bounded rather than followed forever", async () => {
  const mod = load({
    resolves: { "loop.example": [{ address: "93.184.216.34", family: 4 }] },
    script: Array.from({ length: 12 }, () => ({ status: 302, location: "https://loop.example/again" })),
  });
  await assert.rejects(
    () => mod.safeFetch("https://loop.example/start"),
    (e) => e.code === "SSRF_BLOCKED" && /redirects/.test(e.message),
  );
});

/* ---- 5. the pin -------------------------------------------------------- */

test("the socket is pinned to the validated address, closing DNS rebinding", async () => {
  const log = [];
  const mod = load({
    resolves: { "ok.example": [{ address: "93.184.216.34", family: 4 }] },
    script: [{ status: 200, body: "<html>ok</html>" }],
    log,
  });
  await mod.safeFetch("https://ok.example/page");
  assert.equal(typeof log[0].pinned, "function", "a lookup override must be supplied");
  // A second resolution at connect time would re-query DNS; this returns the
  // address already checked, so a rebind has nothing to land on.
  const pinnedAddress = await new Promise((resolve) =>
    log[0].pinned("ok.example", {}, (_e, address) => resolve(address)),
  );
  assert.equal(pinnedAddress, "93.184.216.34");
});
