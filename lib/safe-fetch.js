"use strict";

/**
 * Outbound fetch for URLs a user supplied.
 *
 * The website-import feature takes a URL from a tenant and fetches it from
 * inside the production container — the same container that holds every
 * service credential. Without a guard that is a request-forgery primitive:
 * point it at 169.254.169.254, or at the Supabase host, or at anything else
 * reachable from inside, and the response comes back as page content.
 *
 * A check for "is this localhost" is not enough, and this codebase has already
 * learned that the expensive way. There are four separate ways to get an
 * internal address past a naive check:
 *
 *   1. A private address written directly, in any of its forms — decimal,
 *      IPv6-mapped (::ffff:127.0.0.1), or a shortened one.
 *   2. A public hostname whose DNS record RESOLVES to a private address. The
 *      URL looks fine; only the lookup reveals it.
 *   3. A public URL that REDIRECTS to an internal one. The first hop passes,
 *      the second is never checked, and fetch(redirect:"follow") takes it.
 *   4. DNS rebinding: the name resolves publicly when validated, then again
 *      privately when the socket is opened a moment later.
 *
 * So validation happens against RESOLVED ADDRESSES, on EVERY hop, and the
 * socket is pinned to the exact address that was validated — the lookup
 * function below hands back the checked IP rather than re-resolving, which is
 * what closes (4). Built-in fetch cannot do that, which is why this uses
 * http/https directly.
 *
 * REGRESSION HISTORY, because it matters: an earlier version of this
 * protection existed with a test, and on 22 Sep 2026 both were found gone —
 * no private-range rejection anywhere, no SSRF test in the suite, and
 * redirect:"follow" on the fetcher. The test is the part that makes the check
 * durable; deleting the two together is how it went unnoticed.
 */

const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const net = require("net");
const zlib = require("zlib");

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 8 * 1024 * 1024;

/* ---- address classification ------------------------------------------- */

const V4_BLOCKS = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — cloud instance metadata lives here
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

function v4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function v4Blocked(ip) {
  const addr = v4ToInt(ip);
  if (addr === null) return true; // unparseable is not provably public
  for (const [base, bits] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (v4ToInt(base) & mask)) return true;
  }
  return false;
}

/**
 * IPv6, including the forms that carry a v4 address inside them. An
 * IPv4-mapped ::ffff:127.0.0.1 is a loopback address wearing a different hat,
 * and NAT64 does the same thing, so both are unwrapped and re-checked as v4.
 */
function v6Blocked(ip) {
  const lower = ip.toLowerCase().split("%")[0]; // strip any zone index
  if (lower === "::1" || lower === "::") return true;

  const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]);
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const a = parseInt(hexMapped[1], 16), b = parseInt(hexMapped[2], 16);
    return v4Blocked(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }

  const head = lower.split(":")[0];
  const first = parseInt(head || "0", 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (lower.startsWith("2001:db8:")) return true; // documentation
  return false;
}

function isBlockedAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) return v4Blocked(ip);
  if (version === 6) return v6Blocked(ip);
  return true; // not an IP at all
}

/* ---- URL and host validation ------------------------------------------ */

function blocked(message, url) {
  const error = new Error(`Refusing to fetch ${url}: ${message}`);
  error.code = "SSRF_BLOCKED";
  return error;
}

function assertAllowedUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw blocked("not a valid URL", String(raw).slice(0, 120));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // file:, gopher:, ftp: and friends are the classic escapes.
    throw blocked(`unsupported scheme ${parsed.protocol}`, parsed.href);
  }
  if (parsed.username || parsed.password) {
    // Credentials in a URL are also how "user@internal-host" tricks parsers.
    throw blocked("credentials in URL", parsed.origin);
  }
  return parsed;
}

/**
 * Resolve, and refuse unless EVERY answer is public. Any single private
 * address is disqualifying — a name with one public and one private record
 * would otherwise be a coin flip decided by resolver ordering.
 */
async function resolvePublicAddresses(hostname) {
  const literal = net.isIP(hostname);
  if (literal) {
    if (isBlockedAddress(hostname)) {
      throw blocked("address is private, loopback or reserved", hostname);
    }
    return [{ address: hostname, family: literal }];
  }

  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    throw blocked("hostname does not resolve", hostname);
  }
  if (!answers.length) throw blocked("hostname resolved to nothing", hostname);

  for (const answer of answers) {
    if (isBlockedAddress(answer.address)) {
      throw blocked(
        `hostname resolves to a private or reserved address (${answer.address})`,
        hostname,
      );
    }
  }
  return answers;
}

/* ---- the request ------------------------------------------------------- */

function requestOnce(parsed, pinned, { headers, timeoutMs }) {
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { ...headers, Host: parsed.host },
        timeout: timeoutMs,
        // THE PIN. Node calls this instead of resolving again, so the socket
        // opens to the address that was validated a moment ago and a rebind
        // between check and connect has nothing to land on.
        lookup: (_hostname, options, callback) => {
          if (options && options.all) return callback(null, pinned);
          callback(null, pinned[0].address, pinned[0].family);
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            req.destroy();
            reject(blocked("response exceeded the size limit", parsed.href));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ res, buffer: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out after ${timeoutMs}ms fetching ${parsed.href}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function decode(buffer, encoding) {
  try {
    if (encoding === "gzip") return zlib.gunzipSync(buffer);
    if (encoding === "deflate") return zlib.inflateSync(buffer);
    if (encoding === "br") return zlib.brotliDecompressSync(buffer);
  } catch (_) {
    return buffer; // a mislabelled body is better read raw than thrown away
  }
  return buffer;
}

/**
 * Fetch a user-supplied URL, validating every hop.
 * Resolves { text, status, finalUrl, contentType }.
 */
async function safeFetch(rawUrl, options = {}) {
  const {
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = "AgentlyBot/1.0",
    acceptLanguage = "en-US,en;q=0.9",
  } = options;

  let current = assertAllowedUrl(rawUrl);
  const seen = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-validated per hop: a public URL redirecting inward is the whole trick.
    const pinned = await resolvePublicAddresses(current.hostname);
    seen.push(current.href);

    const { res, buffer } = await requestOnce(current, pinned, {
      headers: {
        "User-Agent": userAgent,
        Accept: accept,
        "Accept-Language": acceptLanguage,
        "Accept-Encoding": "gzip, deflate, br",
      },
      timeoutMs,
    });

    const status = res.statusCode || 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      if (hop === MAX_REDIRECTS) {
        throw blocked(`more than ${MAX_REDIRECTS} redirects`, seen[0]);
      }
      current = assertAllowedUrl(new URL(location, current).href);
      continue;
    }

    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status} from ${current.href}`);
    }

    const text = decode(buffer, String(res.headers["content-encoding"] || "").toLowerCase())
      .toString("utf8");
    return {
      text,
      status,
      finalUrl: current.href,
      contentType: String(res.headers["content-type"] || ""),
      redirects: seen.slice(1),
    };
  }
  throw blocked("redirect loop", seen[0]);
}

module.exports = {
  safeFetch,
  assertAllowedUrl,
  resolvePublicAddresses,
  isBlockedAddress,
  MAX_REDIRECTS,
};
