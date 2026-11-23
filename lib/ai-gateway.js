"use strict";
/*
 * Protection around paid AI calls (Front Desk port).
 *
 * A customer photo is the most expensive thing the chat widget can ask the
 * model to do, and the public widget is where traffic is least predictable.
 * Every vision call therefore goes through one gateway that:
 *
 *   - answers a repeat of the same request from a cache, and lets concurrent
 *     identical requests share ONE upstream call (single flight);
 *   - caps how many calls run at once and how fast they start (token bucket),
 *     queueing the rest instead of failing them;
 *   - times a call out, retries transient failures with jittered backoff;
 *   - stops calling a provider that keeps failing (circuit breaker), so a
 *     provider outage costs one fast refusal instead of a 25s hang per visitor;
 *   - counts what happened, for the owner-facing health numbers.
 *
 * In-memory and per process, like the other limiters in this API. It is a
 * cost and latency control, not a security boundary: the durable abuse limits
 * live in public-abuse-limits.js.
 */

const crypto = require("node:crypto");

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Stable key for any JSON-able value: object key order does not matter. */
function stableKey(value) {
  const norm = (v) => {
    if (Buffer.isBuffer(v)) return `buf:${sha256(v)}`;
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object")
      return Object.keys(v)
        .sort()
        .reduce((o, k) => ((o[k] = norm(v[k])), o), {});
    return v;
  };
  return sha256(JSON.stringify(norm(value)));
}

class TtlCache {
  constructor(max = 500, ttlMs = 3600000, now = Date.now) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  get size() {
    return this.map.size;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, exp: this.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  /** Cached value, or one shared load for everyone asking at the same time. Failures are never cached. */
  getOrLoad(key, load) {
    const hit = this.get(key);
    if (hit !== undefined) {
      this.hits += 1;
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.hits += 1;
      return pending;
    }
    this.misses += 1;
    const p = Promise.resolve()
      .then(load)
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

class Throttle {
  constructor({ rps = 5, burst = 10, concurrency = 4, maxQueue = 50, now = Date.now } = {}) {
    this.rps = rps;
    this.burst = burst;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.now = now;
    this.tokens = burst;
    this.last = now();
    this.inFlight = 0;
    this.queue = [];
    this.timer = null;
  }
  get queued() {
    return this.queue.length;
  }
  refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rps);
    this.last = t;
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) {
        const err = new Error("AI gateway is busy.");
        err.code = "AI_BUSY";
        return reject(err);
      }
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  }
  pump() {
    this.refill();
    while (this.queue.length && this.inFlight < this.concurrency && this.tokens >= 1) {
      const job = this.queue.shift();
      this.tokens -= 1;
      this.inFlight += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.inFlight -= 1;
          this.pump();
        });
    }
    if (this.queue.length && this.inFlight < this.concurrency && !this.timer) {
      const wait = Math.max(20, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      this.timer.unref?.();
    }
  }
}

class CircuitBreaker {
  constructor(threshold = 5, coolMs = 15000, now = Date.now) {
    this.threshold = threshold;
    this.coolMs = coolMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = null;
  }
  get state() {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.coolMs ? "half_open" : "open";
  }
  async run(fn) {
    if (this.state === "open") {
      const err = new Error("AI provider is temporarily unavailable.");
      err.code = "AI_CIRCUIT_OPEN";
      throw err;
    }
    try {
      const out = await fn();
      this.failures = 0;
      this.openedAt = null;
      return out;
    } catch (err) {
      // A request the provider rejected as wrong is our bug, not an outage.
      if (!isCallerError(err)) {
        this.failures += 1;
        if (this.failures >= this.threshold || this.openedAt !== null) this.openedAt = this.now();
      }
      throw err;
    }
  }
}

function statusOf(err) {
  return Number(err?.status || err?.response?.status || 0);
}
function isCallerError(err) {
  const s = statusOf(err);
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}
function isRetryable(err) {
  if (err?.code === "AI_TIMEOUT") return true;
  const s = statusOf(err);
  if (!s) return true; // network error
  return s === 408 || s === 429 || s >= 500;
}

function withTimeout(promise, ms, label = "call") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = "AI_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function retry(fn, { attempts = 3, baseMs = 300, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) break;
      await wait(Math.round(baseMs * 2 ** i * (0.5 + Math.random())));
    }
  }
  throw lastErr;
}

class AiGateway {
  constructor(opts = {}) {
    this.cache = new TtlCache(
      opts.cacheMax ?? envNum("AI_GATEWAY_CACHE_MAX", 500),
      opts.cacheTtlMs ?? envNum("AI_GATEWAY_CACHE_TTL_MS", 6 * 3600000),
    );
    this.throttle = new Throttle({
      rps: opts.rps ?? envNum("AI_GATEWAY_RPS", 5),
      burst: opts.burst ?? envNum("AI_GATEWAY_BURST", 10),
      concurrency: opts.concurrency ?? envNum("AI_GATEWAY_CONCURRENCY", 4),
      maxQueue: opts.maxQueue ?? envNum("AI_GATEWAY_MAX_QUEUE", 50),
    });
    this.breaker = new CircuitBreaker(
      opts.breakerThreshold ?? envNum("AI_GATEWAY_BREAKER_THRESHOLD", 5),
      opts.breakerCoolMs ?? envNum("AI_GATEWAY_BREAKER_COOL_MS", 15000),
    );
    this.timeoutMs = opts.timeoutMs ?? envNum("AI_GATEWAY_TIMEOUT_MS", 30000);
    this.attempts = opts.attempts ?? envNum("AI_GATEWAY_ATTEMPTS", 2);
    this.sleep = opts.sleep;
    this.metrics = {};
  }

  record(op, ms, ok) {
    const m = (this.metrics[op] = this.metrics[op] || { calls: 0, errors: 0, totalMs: 0, maxMs: 0 });
    m.calls += 1;
    if (!ok) m.errors += 1;
    m.totalMs += ms;
    m.maxMs = Math.max(m.maxMs, ms);
  }

  /**
   * Run one upstream call. `key` (any JSON-able value, Buffers allowed) makes
   * the result cacheable; pass null for calls that must not be cached.
   */
  call(op, key, fn) {
    const exec = async () => {
      const started = Date.now();
      try {
        const out = await this.throttle.run(() =>
          this.breaker.run(() =>
            retry(() => withTimeout(Promise.resolve().then(fn), this.timeoutMs, op), {
              attempts: this.attempts,
              sleep: this.sleep,
            }),
          ),
        );
        this.record(op, Date.now() - started, true);
        return out;
      } catch (err) {
        this.record(op, Date.now() - started, false);
        throw err;
      }
    };
    return key == null ? exec() : this.cache.getOrLoad(`${op}:${stableKey(key)}`, exec);
  }

  stats() {
    const ops = {};
    for (const [op, m] of Object.entries(this.metrics))
      ops[op] = { calls: m.calls, errors: m.errors, avgMs: m.calls ? Math.round(m.totalMs / m.calls) : 0, maxMs: m.maxMs };
    return {
      cache: { size: this.cache.size, hits: this.cache.hits, misses: this.cache.misses },
      throttle: { inFlight: this.throttle.inFlight, queued: this.throttle.queued },
      breaker: this.breaker.state,
      ops,
    };
  }
}

let shared = null;
function getAiGateway() {
  if (!shared) shared = new AiGateway();
  return shared;
}

module.exports = {
  AiGateway,
  TtlCache,
  Throttle,
  CircuitBreaker,
  retry,
  withTimeout,
  stableKey,
  isRetryable,
  getAiGateway,
};
