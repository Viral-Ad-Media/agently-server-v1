"use strict";

require("dotenv").config();

const http = require("http");
const { loadSecrets } = require("./lib/secrets");

const PORT = process.env.PORT || 4000;

// Secrets must land in process.env BEFORE api/index is required. Half this
// codebase reads process.env at module scope — lib/supabase.js builds its
// client on first require, auth-rate-limit.js freezes its windows — so a
// require that happens first would capture the old values and the loader would
// silently do nothing. Hence the deferred require below rather than a
// top-level one.
async function start() {
  await loadSecrets();

  const app = require("./api/index");
  const server = http.createServer(app);

  // Attach WebSocket for Twilio Media Streams -> OpenAI Realtime
  if (typeof app.attachWebSocket === "function") {
    app.attachWebSocket(server);
  }

  server.listen(PORT, () => {
    console.log(`\n✅ Agently backend running on http://localhost:${PORT}`);
    console.log(`📡 Health:      http://localhost:${PORT}/health`);
    console.log(`🔑 Auth:        http://localhost:${PORT}/api/auth/login`);
    console.log(`🤖 Bootstrap:   http://localhost:${PORT}/api/bootstrap`);
    console.log(
      `📞 Voice webhook: http://localhost:${PORT}/api/twilio/voice-inbound`,
    );
    console.log(
      `🔌 Media WS:    ws://localhost:${PORT}/api/twilio/media-stream\n`,
    );
  });
}

start().catch((error) => {
  // loadSecrets never throws, so reaching here means the app itself failed to
  // start. That is fatal and should be, but it must be legible in the log.
  console.error("Fatal: the API failed to start.", error);
  process.exit(1);
});
