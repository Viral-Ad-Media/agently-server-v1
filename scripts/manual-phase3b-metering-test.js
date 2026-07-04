require("dotenv").config();

const {
  logOpenAIUsage,
  logElevenLabsUsage,
  logRailwayRuntimeUsage,
} = require("../lib/usage-ledger");

const organizationId = "747cf733-dd0d-42ba-87ab-bfea84590142";
const stamp = Date.now();

async function main() {
  console.log("Writing debug usage rows for org:", organizationId);

  await logOpenAIUsage({
    organizationId,
    service: "debug_metering_test",
    eventType: "openai_debug_meter_test",
    model: "debug-model",
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
    },
    externalId: "debug-openai-" + stamp,
    metadata: {
      debug: true,
      purpose: "manual_phase3b_metering_test",
    },
  });

  await logElevenLabsUsage({
    organizationId,
    service: "debug_metering_test",
    eventType: "elevenlabs_debug_meter_test",
    characters: 25,
    voiceId: "debug-voice",
    modelId: "debug-model",
    externalId: "debug-elevenlabs-" + stamp,
    metadata: {
      debug: true,
      purpose: "manual_phase3b_metering_test",
    },
  });

  await logRailwayRuntimeUsage({
    organizationId,
    service: "debug_metering_test",
    eventType: "railway_debug_meter_test",
    seconds: 15,
    externalId: "debug-railway-" + stamp,
    metadata: {
      debug: true,
      purpose: "manual_phase3b_metering_test",
    },
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});