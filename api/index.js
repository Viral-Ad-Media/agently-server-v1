"use strict";

// Load .env (works locally, harmless on Vercel)
try {
  require("dotenv").config();
} catch (_) {}

const express = require("express");
const path = require("path");
const { errorHandler } = require("../middleware/error");
const { CANONICAL_APP_URL, isProductionRuntime } = require("../lib/app-url");
const app = express();

// ═══════════════════════════════════════════════════════════════
// BULLETPROOF CORS
// Applied BEFORE any require that could fail. If a downstream
// module throws during cold start, CORS headers are still set on
// the fallback error response — so the browser doesn't get a
// confusing CORS error on top of the real problem.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_ALLOWED_ORIGINS = [
  CANONICAL_APP_URL,
  "https://agentlycall.com",
  "https://www.agentlycall.com",
  "http://localhost:3000",
  "http://localhost:5173",
];

function splitEnvList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) return "";

  try {
    return new URL(raw).origin;
  } catch (_) {
    return raw;
  }
}

function collectAllowedOrigins() {
  return Array.from(
    new Set(
      [...DEFAULT_ALLOWED_ORIGINS, ...splitEnvList(process.env.ALLOWED_ORIGINS)]
        .map(normalizeOrigin)
        .filter(Boolean),
    ),
  );
}

const ALLOWED_ORIGINS = collectAllowedOrigins();

function isOriginAllowed(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return true; // server-to-server / curl
  if (!isProductionRuntime()) return true; // local development: allow all
  if (ALLOWED_ORIGINS.length === 0) return true; // preserve existing fallback behavior
  return ALLOWED_ORIGINS.includes(normalizedOrigin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", normalizeOrigin(origin));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Content-Type,Authorization,X-Requested-With",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// FIRST middleware — always set CORS and short-circuit OPTIONS
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Chatbot widget iframe must be embeddable from any domain
app.use((req, res, next) => {
  if (req.path.startsWith("/chatbot-widget/")) {
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:;",
    );
  }
  next();
});

app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || "4mb",
    verify: (req, _res, buffer) => {
      // Stripe signs the exact request bytes. Preserve them before Express
      // converts the JSON payload into an object. Never log this buffer.
      if (
        String(req.originalUrl || "").split("?")[0] ===
        "/api/billing/stripe/webhook"
      ) {
        req.rawBody = Buffer.from(buffer);
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Serve bundled chatbot preset avatars from the backend domain.
// The deployed widget iframe is also served from the backend, so relative
// /chatbot-avatars/... URLs must resolve here, not on the frontend.
app.use(
  "/chatbot-avatars",
  express.static(path.join(__dirname, "../public/chatbot-avatars"), {
    maxAge: "30d",
    immutable: true,
  }),
);

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK + DIAGNOSTIC
// Hit this endpoint first when debugging — tells you which env
// vars are set in production without exposing the values.
// ═══════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
    allowedOrigins: ALLOWED_ORIGINS,
    envCheck: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!(
        process.env.SUPABASE_SERVICE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY
      ),
      JWT_SECRET: !!process.env.JWT_SECRET,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
      ELEVENLABS_DEFAULT_MODEL: !!process.env.ELEVENLABS_DEFAULT_MODEL,
      VOICE_PROVIDER_DEFAULT: process.env.VOICE_PROVIDER_DEFAULT || "openai",
      VOICE_PROVIDER_FALLBACK: process.env.VOICE_PROVIDER_FALLBACK || "openai",
      RESEND_API_KEY: !!process.env.RESEND_API_KEY,
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
      TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
      TWILIO_API_KEY_SID: !!process.env.TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET: !!process.env.TWILIO_API_KEY_SECRET,
      TWILIO_TWIML_APP_SID: !!process.env.TWILIO_TWIML_APP_SID,
      TWILIO_WS_URL: !!process.env.TWILIO_WS_URL,
      API_URL: !!process.env.API_URL,
      APP_URL: !!process.env.APP_URL,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// DEFENSIVE ROUTE LOADING
// If any route file throws during require (syntax error, missing
// module, etc.) we mount a 503 placeholder for that prefix only —
// the rest of the app keeps working.
// ═══════════════════════════════════════════════════════════════

function safeMount(prefix, loader, label) {
  try {
    const router = loader();
    app.use(prefix, router);
    console.log(`[routes] mounted ${label} at ${prefix}`);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const stack = (e && e.stack) || "";
    console.error(`[routes] FAILED to mount ${label} at ${prefix}:`, msg);
    if (stack) console.error(stack);
    app.use(prefix, (req, res) => {
      setCorsHeaders(req, res);
      res.status(503).json({
        error: {
          message: `${label} route unavailable at startup.`,
          detail: msg,
        },
      });
    });
  }
}

safeMount("/api/auth", () => require("./routes/auth"), "auth");
safeMount("/api/blog", () => require("./routes/blog"), "blog");
// PLATFORM ASSISTANT — Agently's own in-app support agent.
// Mounted BEFORE /api/super-admin so the more specific prefix wins outright.
// If it were mounted after, every /api/super-admin/platform/* request would
// first traverse the super-admin router, run requireSuperAdmin, match nothing,
// and fall through — authenticating twice for no benefit.
// The tour router was saved as super-admin-platform.js while its own header
// declared it to be super-admin-tour.js. The result: /api/super-admin/tour
// failed to require and served the "route unavailable at startup" stub, while
// /api/super-admin/platform silently served TOUR endpoints to the platform
// assistant admin screen — which is why that screen could not finish loading.
// The file is now named for what it is.
//
safeMount(
  "/api/super-admin/platform",
  () => require("./routes/super-admin-platform"),
  "super-admin-platform",
);
safeMount(
  "/api/super-admin/tour",
  () => require("./routes/super-admin-tour"),
  "super-admin-tour",
);
safeMount(
  "/api/super-admin",
  () => require("./routes/super-admin"),
  "super-admin",
);
// Tenant-facing (requires a signed-in tenant session, never public).
safeMount(
  "/api/platform-assistant",
  () => require("./routes/platform-assistant"),
  "platform-assistant",
);
// PRODUCT TOUR — per-page onboarding state. Same ordering rule as above: the
// specific /api/super-admin/tour prefix is mounted before /api/super-admin.
safeMount("/api/tour", () => require("./routes/tour"), "tour");
safeMount(
  "/api/blog-automation",
  () => require("./routes/blog-automation"),
  "blog-automation",
);
safeMount("/api/bootstrap", () => require("./routes/bootstrap"), "bootstrap");
safeMount(
  "/api/onboarding",
  () => require("./routes/onboarding"),
  "onboarding",
);
safeMount("/api/agent", () => require("./routes/agent"), "agent");
safeMount(
  "/api/voice-agents",
  () => require("./routes/voice-agents"),
  "voice-agents",
);
safeMount("/api/chatbots", () => require("./routes/chatbots"), "chatbots");
safeMount(
  "/api/knowledge-bases",
  () => require("./routes/knowledge-bases"),
  "knowledge-bases",
);
safeMount(
  "/api/chatbots",
  () => require("./routes/chatbot-deploy"),
  "chatbot-deploy",
);
safeMount("/api/messenger", () => require("./routes/messenger"), "messenger");
// PATCH: discovery -> select -> scrape job flow. Replaces the setImmediate()
// background scrape, which never completed on Vercel serverless.
safeMount(
  "/api/knowledge-scrape",
  () => require("./routes/knowledge-scrape"),
  "knowledge-scrape",
);
safeMount(
  "/api/knowledge-uploads",
  () => require("./routes/knowledge-uploads"),
  "knowledge-uploads",
);
safeMount("/api/calls", () => require("./routes/calls"), "calls");
safeMount("/api/leads", () => require("./routes/leads"), "leads");
safeMount("/api/outreach", () => require("./routes/outreach"), "outreach");
safeMount(
  "/api/call-schedules",
  () => require("./routes/call-schedules"),
  "call-schedules",
);
safeMount(
  "/api/chatbot-public",
  () => require("./routes/chatbot-public"),
  "chatbot-public",
);
safeMount("/api/twilio", () => require("./routes/twilio"), "twilio");
safeMount(
  "/api/test-agent",
  () => require("./routes/test-agent"),
  "test-agent",
);
safeMount(
  "/api/notifications",
  () => require("./routes/notifications"),
  "notifications",
);
safeMount("/api/voices", () => require("./routes/voices"), "voices");
safeMount(
  "/api/elevenlabs",
  () => require("./routes/elevenlabs"),
  "elevenlabs",
);
safeMount(
  "/api/agents",
  () => require("./routes/agent-voice-config"),
  "agent-voice-config",
);
safeMount("/api/webcall", () => require("./routes/webcall"), "webcall");

// Billing usage, production-cost, vendor-rate-sync, wallet, and margin endpoints.
// Keep this mounted BEFORE the generic /api misc route so nested billing paths
// like /api/billing-usage/vendor-rate-sync/status are not swallowed by misc/404.
safeMount(
  "/api/billing-usage",
  () => require("./routes/billing-usage"),
  "billing-usage",
);

// Stripe Checkout creates verified prepaid-wallet top-ups. The webhook uses
// req.rawBody captured by the JSON parser above for signature verification.
safeMount(
  "/api/billing/stripe",
  () => require("./routes/stripe-billing"),
  "stripe-billing",
);

safeMount(
  "/api/internal/number-retention",
  () => require("./routes/number-retention"),
  "number-retention",
);

safeMount("/api", () => require("./routes/misc"), "misc");
safeMount(
  "/chatbot-avatar",
  () => require("./routes/chatbot-avatar"),
  "chatbot-avatar",
);
safeMount("/chatbot-widget", () => require("./routes/widget"), "widget");

// ── Start background billing tracker ────────────────────────────────
// Tracks per-number Twilio costs in the background every 30 seconds.
// Writes to voice_agents.twilio_billing_usd — NEVER exposed to users.
// Only starts if Twilio credentials are set (safe to skip in dev).
try {
  require("../lib/billing-tracker").start();
} catch (e) {
  console.warn("[app] billing-tracker failed to start:", e && e.message);
}

// 404 for anything else
app.use((req, res) => {
  setCorsHeaders(req, res);
  res.status(404).json({ error: { message: "Route not found." } });
});

// Top-level error handler — re-applies CORS so browsers get a proper
// response even when a route throws.
app.use((err, req, res, next) => {
  setCorsHeaders(req, res);
  return errorHandler(err, req, res, next);
});

// ═══════════════════════════════════════════════════════════════
// WebSocket for Twilio Media Streams -> OpenAI Realtime
// Deploy this server on a long-lived Node host for production WS.
// ═══════════════════════════════════════════════════════════════

function attachWebSocket(server) {
  try {
    const {
      attachRealtimeMediaStreamWebSocket,
    } = require("../lib/openai-realtime-bridge");
    attachRealtimeMediaStreamWebSocket(server);
  } catch (e) {
    console.warn("[WS] media stream handler failed to attach:", e.message);
  }
}

module.exports = app;
module.exports.attachWebSocket = attachWebSocket;
