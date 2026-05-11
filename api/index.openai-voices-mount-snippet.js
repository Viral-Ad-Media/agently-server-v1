// Optional: add this line to agently-server/api/index.js near the other safeMount calls.
// The /api/voices?provider=openai route works without this because /api/voices is already mounted.
// This optional mount only enables /api/openai/voices and /api/openai/test-voice.
safeMount("/api/openai", () => require("./routes/openai-voices"), "openai-voices");
