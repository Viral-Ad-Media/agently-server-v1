"use strict";

// Load .env (works locally, harmless on Vercel)
try {
  require("dotenv").config();
} catch (_) {}

const express = require("express");
const app = express();

// ═══════════════════════════════════════════════════════════════
// BULLETPROOF CORS
// Applied BEFORE any require that could fail. If a downstream
// module throws during cold start, CORS headers are still set on
// the fallback error response — so the browser doesn't get a
// confusing CORS error on top of the real problem.
// ═══════════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // server-to-server / curl
  if (process.env.NODE_ENV !== "production") return true; // dev: allow all
  if (ALLOWED_ORIGINS.length === 0) return true; // no list configured: allow all
  return ALLOWED_ORIGINS.includes(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
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

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

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
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      JWT_SECRET: !!process.env.JWT_SECRET,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
      ELEVENLABS_DEFAULT_MODEL: !!process.env.ELEVENLABS_DEFAULT_MODEL,
      VOICE_PROVIDER_DEFAULT: process.env.VOICE_PROVIDER_DEFAULT || "openai",
      VOICE_PROVIDER_FALLBACK: process.env.VOICE_PROVIDER_FALLBACK || "openai",
      RESEND_API_KEY: !!process.env.RESEND_API_KEY,
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
  "/api/chatbots",
  () => require("./routes/chatbot-deploy"),
  "chatbot-deploy",
);
safeMount("/api/messenger", () => require("./routes/messenger"), "messenger");
safeMount("/api/calls", () => require("./routes/calls"), "calls");
safeMount("/api/leads", () => require("./routes/leads"), "leads");
safeMount(
  "/api/chatbot-public",
  () => require("./routes/chatbot-public"),
  "chatbot-public",
);
safeMount("/api/twilio", () => require("./routes/twilio"), "twilio");
safeMount("/api/voices", () => require("./routes/voices"), "voices");
safeMount("/api", () => require("./routes/misc"), "misc");
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
app.use((err, req, res, _next) => {
  setCorsHeaders(req, res);
  console.error("[app] unhandled error:", err && err.stack ? err.stack : err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: {
      message: err.message || "Internal server error.",
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    },
  });
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
