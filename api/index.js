"use strict";

// Load .env in all environments (Vercel ignores it safely, local dev uses it)
try {
  require("dotenv").config();
} catch (_) {}

const express = require("express");

const authRoutes = require("./routes/auth");
const bootstrapRoutes = require("./routes/bootstrap");
const onboardingRoutes = require("./routes/onboarding");
const agentRoutes = require("./routes/agent");
const voiceAgentRoutes = require("./routes/voice-agents");
const chatbotRoutes = require("./routes/chatbots");
const chatbotDeployRoutes = require("./routes/chatbot-deploy");
const messengerRoutes = require("./routes/messenger");
const callsRoutes = require("./routes/calls");
const leadsRoutes = require("./routes/leads");
const miscRoutes = require("./routes/misc");
const widgetRoutes = require("./routes/widget");
const chatbotPublicRoutes = require("./routes/chatbot-public");
const twilioRoutes = require("./routes/twilio");
// const { errorHandler } = require("../../middleware/error");

const app = express();

// ═══════════════════════════════════════════════════════════════
// CORS — must be the VERY FIRST middleware
// Reads ALLOWED_ORIGINS from env var. No hardcoded URLs.
// ═══════════════════════════════════════════════════════════════
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // server-to-server / curl
  if (process.env.NODE_ENV !== "production") return true; // dev = allow all
  if (allowedOrigins.length === 0) return true; // no allowlist = allow all
  return allowedOrigins.includes(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
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
}

// FIRST middleware — handles CORS for ALL requests including OPTIONS preflight
app.use((req, res, next) => {
  setCorsHeaders(req, res);

  // Respond to preflight immediately. MUST send 204 with no body.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Block disallowed origins from real requests
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    return res
      .status(403)
      .json({ error: { message: `CORS: ${origin} not allowed` } });
  }

  next();
});

// Allow chatbot widget pages to be iframed from any domain
app.use((req, res, next) => {
  if (req.path.startsWith("/chatbot-widget/")) {
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https:;",
    );
  }
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Health ────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  }),
);

// ── Routes ────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/bootstrap", bootstrapRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/voice-agents", voiceAgentRoutes);
app.use("/api/chatbots", chatbotRoutes);
app.use("/api/chatbots", chatbotDeployRoutes);
app.use("/api/messenger", messengerRoutes);
app.use("/api/calls", callsRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/chatbot-public", chatbotPublicRoutes);
app.use("/api/twilio", twilioRoutes);
app.use("/api", miscRoutes);

app.use("/chatbot-widget", widgetRoutes);

app.use((_req, res) =>
  res.status(404).json({ error: { message: "Route not found." } }),
);

// ═══════════════════════════════════════════════════════════════
// Error handler — MUST re-apply CORS headers, because if the cors
// middleware threw an error, they may not be set yet.
// ═══════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  setCorsHeaders(req, res);
  console.error("Unhandled error:", err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: {
      message: err.message || "An unexpected error occurred.",
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    },
  });
});

// ── WebSocket support (local dev only) ────────────────────────
function attachWebSocket(server) {
  try {
    const { WebSocketServer } = require("ws");
    const { handleConversationRelayWS } = require("../lib/conversation-relay");
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if ((request.url || "").startsWith("/api/twilio/ws")) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          handleConversationRelayWS(ws, request);
        });
      } else {
        socket.destroy();
      }
    });
    console.log("[WS] ConversationRelay WebSocket handler attached.");
  } catch (e) {
    console.warn("[WS] ws package not available:", e.message);
  }
}

module.exports = app;
module.exports.attachWebSocket = attachWebSocket;
