"use strict";

const WebSocket = require("ws");
const { URL } = require("url");
const { buildAssistantPrompt, loadVoiceAgentContext } = require("./assistant-intelligence");
const { updateCallRecordById, appendTranscript, finalizeCallRecord } = require("./call-records");

const MODEL = () => process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const VOICE_FALLBACK = "alloy";

function mapVoice(agentVoice) {
  const v = String(agentVoice || "").toLowerCase();
  if (["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"].includes(v)) return v;
  return VOICE_FALLBACK;
}

async function loadAgentContext(agentId, direction = "inbound") {
  const context = await loadVoiceAgentContext(agentId);
  return { agent: context.entity, context, direction };
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function getParams(request) {
  const url = new URL(request.url || "", "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

async function handleOpenAIRealtimeMediaStream(twilioWs, request) {
  const params = getParams(request);
  const agentId = params.agentId;
  const callRecordId = params.callRecordId;
  const callSid = params.callSid || "";
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestampTwilio = null;
  let lastAssistantItem = null;
  let markQueue = [];
  let closed = false;

  const { agent, context } = await loadAgentContext(agentId, params.direction || "inbound");
  const instructions = buildAssistantPrompt({ context, message: params.direction === "outbound" ? "outbound phone call" : "inbound phone call", mode: "voice", direction: params.direction || "inbound", languageName: agent.language || "English" });

  await updateCallRecordById(callRecordId, {
    status: "in-progress",
    twilio_call_sid: callSid,
    direction: params.direction || "inbound",
    metadata: {
      ...(params || {}),
      realtimeModel: MODEL(),
    },
  });

  const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL())}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  function sendMark() {
    if (!streamSid) return;
    safeSend(twilioWs, { event: "mark", streamSid, mark: { name: "responsePart" } });
    markQueue.push("responsePart");
  }

  function handleSpeechStarted() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = Math.max(0, latestMediaTimestamp - responseStartTimestampTwilio);
      if (lastAssistantItem) {
        safeSend(openAiWs, {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        });
      }
      if (streamSid) safeSend(twilioWs, { event: "clear", streamSid });
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  function initializeRealtimeSession() {
    safeSend(openAiWs, {
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL(),
        output_modalities: ["audio"],
        instructions,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: { format: { type: "audio/pcmu" }, voice: mapVoice(agent.voice) },
        },
      },
    });

    // Let OpenAI speak first with the configured greeting.
    const greeting = agent.greeting || "Hello, thank you for calling. How can I help you today?";
    safeSend(openAiWs, {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Start the call by saying exactly this greeting, then wait for the caller: ${greeting}` }],
      },
    });
    safeSend(openAiWs, { type: "response.create" });
  }

  openAiWs.on("open", initializeRealtimeSession);

  openAiWs.on("message", async (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    if (event.type === "response.output_audio.delta" && event.delta && streamSid) {
      safeSend(twilioWs, { event: "media", streamSid, media: { payload: event.delta } });
      if (responseStartTimestampTwilio == null) responseStartTimestampTwilio = latestMediaTimestamp;
      if (event.item_id) lastAssistantItem = event.item_id;
      sendMark();
    }

    if (event.type === "input_audio_buffer.speech_started") handleSpeechStarted();

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      await appendTranscript(callRecordId, { speaker: "Caller", text: event.transcript });
    }

    if ((event.type === "response.audio_transcript.done" || event.type === "response.output_text.done") && event.transcript) {
      await appendTranscript(callRecordId, { speaker: "Agent", text: event.transcript });
    }

    if (event.type === "error") console.error("[openai realtime]", event.error || event);
  });

  twilioWs.on("message", (message) => {
    let data;
    try { data = JSON.parse(message.toString()); } catch { return; }
    if (data.event === "start") {
      streamSid = data.start?.streamSid || streamSid;
      updateCallRecordById(callRecordId, { twilio_stream_sid: streamSid, status: "in-progress" }).catch(() => {});
      return;
    }
    if (data.event === "media") {
      latestMediaTimestamp = Number(data.media?.timestamp || latestMediaTimestamp || 0);
      safeSend(openAiWs, { type: "input_audio_buffer.append", audio: data.media?.payload || "" });
      return;
    }
    if (data.event === "mark") {
      if (markQueue.length > 0) markQueue.shift();
      return;
    }
    if (data.event === "stop") {
      finalizeAndClose("completed");
    }
  });

  async function finalizeAndClose(reason) {
    if (closed) return;
    closed = true;
    try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch (_) {}
    await finalizeCallRecord({ callRecordId, callSid, status: reason === "completed" ? "completed" : "failed", endReason: reason });
  }

  twilioWs.on("close", () => finalizeAndClose("completed"));
  twilioWs.on("error", (err) => { console.error("[twilio media ws]", err.message); finalizeAndClose("websocket-error"); });
  openAiWs.on("error", (err) => { console.error("[openai realtime ws]", err.message); });
  openAiWs.on("close", () => { if (!closed && twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); });
}

function attachRealtimeMediaStreamWebSocket(server) {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = request.url || "";
    if (!url.startsWith("/api/twilio/media-stream")) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleOpenAIRealtimeMediaStream(ws, request).catch((err) => {
        console.error("[media-stream attach]", err.message);
        try { ws.close(); } catch (_) {}
      });
    });
  });
  console.log("[WS] Twilio Media Streams -> OpenAI Realtime attached at /api/twilio/media-stream");
}

module.exports = { attachRealtimeMediaStreamWebSocket, handleOpenAIRealtimeMediaStream };
