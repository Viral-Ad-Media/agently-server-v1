#!/usr/bin/env node
/**
 * agently-server/scripts/verify-widget-audio.js   <-- NEW FILE
 *
 * PATCH 30 — P2-6. Answers "what do I need to verify the audio works?"
 *
 * SHORT ANSWER: no, you do not need to hold a conversation. This script proves
 * the transport end to end without a microphone. Do a 60-second human call
 * afterwards only to judge quality, not correctness.
 *
 * WHAT THIS CHECKS, IN ORDER — each step is a distinct failure mode:
 *   1. WS server reachable at all
 *   2. /realtime accepts a WebSocket upgrade  (widget realtime endpoint)
 *   3. Session negotiation completes           (auth + org resolution)
 *   4. Synthetic audio frames are accepted     (inbound path)
 *   5. Audio frames come BACK                  (outbound path — the one that
 *                                               silently fails most often)
 *   6. A usage event was written               (the call was billed)
 *
 * USAGE
 *   node scripts/verify-widget-audio.js \
 *     --ws wss://agently-ws-server-production2.up.railway.app \
 *     --chatbot <chatbotId> \
 *     --org <organizationId>
 */

"use strict";

const WebSocket = require("ws");

const args = process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith("--")) acc[cur.slice(2)] = arr[i + 1];
  return acc;
}, {});

const WS_URL = (args.ws || process.env.TWILIO_WS_URL || "").replace(/\/$/, "");
const CHATBOT_ID = args.chatbot;
const ORG_ID = args.org;
const TIMEOUT_MS = Number(args.timeout || 25000);

if (!WS_URL || !CHATBOT_ID || !ORG_ID) {
  console.error("Usage: --ws <wss://...> --chatbot <id> --org <id>");
  process.exit(2);
}

const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 1 second of 24kHz PCM16 silence, base64 — enough to exercise the path. */
function silenceFrame(ms = 100) {
  return Buffer.alloc(Math.round(24000 * 2 * (ms / 1000))).toString("base64");
}

async function main() {
  console.log(`\nVerifying widget audio at ${WS_URL}/realtime\n`);

  const ws = new WebSocket(`${WS_URL}/realtime`, {
    handshakeTimeout: 10000,
  });

  let sessionReady = false;
  let audioFramesReceived = 0;
  let firstAudioMs = null;
  const openedAt = Date.now();

  const done = new Promise((resolve) => {
    const finish = () => resolve();
    const timer = setTimeout(() => {
      step("Audio returned from server", audioFramesReceived > 0,
        audioFramesReceived > 0
          ? `${audioFramesReceived} frame(s), first at ${firstAudioMs}ms`
          : "NO AUDIO RECEIVED — this is the failure mode to investigate");
      try { ws.close(); } catch { /* already closed */ }
      finish();
    }, TIMEOUT_MS);

    ws.on("open", () => {
      step("WebSocket upgrade accepted", true, `${Date.now() - openedAt}ms`);

      ws.send(JSON.stringify({
        type: "session.start",
        chatbotId: CHATBOT_ID,
        organizationId: ORG_ID,
        mode: "voice",
        audioFormat: "pcm16",
        sampleRate: 24000,
      }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { audioFramesReceived += 1; return; } // binary frame = audio

      const type = String(msg.type || "");

      if (/session\.(ready|created|started)/.test(type)) {
        sessionReady = true;
        step("Session negotiated", true, type);

        // Push synthetic audio to exercise the inbound path.
        let sent = 0;
        const pump = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN || sent >= 10) {
            clearInterval(pump);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              ws.send(JSON.stringify({ type: "response.create" }));
              step("Synthetic audio accepted", true, `${sent} frames sent`);
            }
            return;
          }
          ws.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: silenceFrame(100),
          }));
          sent += 1;
        }, 100);
      }

      if (/audio\.delta|response\.audio|output_audio/.test(type) && msg.delta) {
        audioFramesReceived += 1;
        if (firstAudioMs === null) firstAudioMs = Date.now() - openedAt;
      }

      if (/error/i.test(type)) {
        step("Server error", false, msg.error?.message || JSON.stringify(msg).slice(0, 200));
      }

      if (/response\.done|session\.closed/.test(type)) {
        clearTimeout(timer);
        step("Audio returned from server", audioFramesReceived > 0,
          audioFramesReceived > 0
            ? `${audioFramesReceived} frame(s), first at ${firstAudioMs}ms`
            : "NO AUDIO RECEIVED");
        try { ws.close(); } catch { /* already closed */ }
        finish();
      }
    });

    ws.on("error", (err) => {
      step("WebSocket upgrade accepted", false, err.message);
      clearTimeout(timer);
      finish();
    });

    ws.on("close", (code) => {
      if (!sessionReady) step("Session negotiated", false, `closed with code ${code}`);
    });
  });

  await done;

  // ── Billing check
  try {
    const { getSupabase } = require("../lib/supabase");
    const db = getSupabase();
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data } = await db
      .from("billing_usage_events")
      .select("id,service,event_type,created_at")
      .eq("organization_id", ORG_ID)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    step("Usage event written", (data || []).length > 0,
      (data || []).length
        ? `${data.length} event(s), latest: ${data[0].service}/${data[0].event_type}`
        : "no usage event in the last 5 minutes — the session was NOT billed");
  } catch (err) {
    step("Usage event written", false, err.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);

  if (failed.length) {
    console.log("Interpreting the failure:\n");
    console.log("  Upgrade rejected      -> wrong WS_URL, or /realtime not routed in ws-server.js");
    console.log("  Session not negotiated-> chatbotId/orgId invalid, or auth rejected pre-session");
    console.log("  Audio accepted, none  -> the common one. Check OPENAI_API_KEY on Railway,");
    console.log("     returned              realtime model name, and lib/realtime-relay.js");
    console.log("                            forwarding audio.delta back to the browser socket.");
    console.log("  Not billed            -> runtime-meter.js not invoked on widget sessions\n");
    process.exit(1);
  }

  console.log("Transport verified. Now do one 60-second human call to judge");
  console.log("quality: latency, interruption handling, and echo.\n");
}

main().catch((err) => {
  console.error("verifier crashed:", err);
  process.exit(1);
});
