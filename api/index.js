"use strict";

try {
  require("dotenv").config();
} catch (_) {}

const express = require("express");
const cors = require("cors");

const scrapeRoutes = require("./routes/scrape");
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
const widgetRoutes = require("./routes/widget"); // ← only one, using the new file
const chatbotPublicRoutes = require("./routes/chatbot-public");
const vapiWebhookRoutes = require("./routes/vapi-webhook");

const { errorHandler } = require("../middleware/error");

const app = express();

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // server-to-server
      if (process.env.NODE_ENV !== "production") return cb(null, true);
      if (!allowedOrigins.length) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: ${origin} not allowed`));
    },
    credentials: true,
  }),
);

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
app.use("/api/chatbots", chatbotDeployRoutes); // /deploy + /deploy-status
app.use("/api/messenger", messengerRoutes);
app.use("/api/calls", callsRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/chatbot-public", chatbotPublicRoutes);
app.use("/api/scrape", scrapeRoutes);
app.use("/api/vapi", vapiWebhookRoutes);
app.use("/api", miscRoutes); // team, billing, settings, contact
app.use("/chatbot-widget", widgetRoutes);

app.use((_req, res) =>
  res.status(404).json({ error: { message: "Route not found." } }),
);
app.use(errorHandler);

module.exports = app;
