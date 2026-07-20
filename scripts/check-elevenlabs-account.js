"use strict";

require("dotenv").config();

async function main() {
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is missing from agently-server/.env");
  }

  const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
    headers: {
      "xi-api-key": apiKey,
      Accept: "application/json",
    },
  });

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { message: raw };
  }

  if (!response.ok) {
    const message =
      payload?.detail?.message ||
      payload?.message ||
      `ElevenLabs returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const used = Number(payload.character_count || 0);
  const limit = Number(payload.character_limit || 0);
  const remaining = Math.max(0, limit - used);

  console.log(
    JSON.stringify(
      {
        tier: payload.tier || null,
        status: payload.status || null,
        characterCount: used,
        characterLimit: limit,
        charactersRemaining: remaining,
        canExtendCharacterLimit: Boolean(payload.can_extend_character_limit),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`[elevenlabs-check] ${error.message}`);
  process.exit(1);
});
