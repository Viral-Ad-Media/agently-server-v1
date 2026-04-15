"use strict";

require("dotenv").config();

const http = require("http");
const app = require("./api/index");

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);
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
  console.log(`🔌 WS relay:    ws://localhost:${PORT}/api/twilio/ws\n`);
});
