"use strict";

const WebSocket = require("ws");
const { URL } = require("url");
const {
  buildAssistantPrompt,
  loadVoiceAgentContext,
} = require("./assistant-intelligence");
const voiceBehavior = require("./voice-behavior");
const {
  updateCallRecordById,
  appendTranscript,
  finalizeCallRecord,
} = require("./call-records");
const { insertUsageEvent, logOpenAIUsage } = require("./usage-ledger");

const MODEL = () => process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const VOICE_FALLBACK = "alloy";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function usageFromRealtimeResponse(event) {
  const response = event && event.response ? event.response : {};
  return response.usage || event.usage || null;
}

function realtimeEventId(event) {
  const response = event && event.response ? event.response : {};
  return response.id || event.response_id || event.event_id || event.id || null;
}

function mapVoice(agentVoice) {
  const v = String(agentVoice || "").toLowerCase();
  if (
    [
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
    ].includes(v)
  )
    return v;
  return VOICE_FALLBACK;
}

async function loadAgentContext(
  agentId,
  direction = "inbound",
  retrievalQuery = "",
) {
  const context = await loadVoiceAgentContext(agentId, retrievalQuery);
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
  const sessionStartedAt = Date.now();
  let streamStartedAt = null;
  let mediaPacketCount = 0;
  let inboundAudioBytesApprox = 0;
  let outboundAudioDeltaCount = 0;
  let realtimeTokenEventsLogged = 0;

  const direction = params.direction || "inbound";
  const callPurpose = params.callPurpose || params.purpose || "";
  const retrievalQuery =
    direction === "outbound"
      ? [
          "outbound phone call",
          callPurpose,
          params.recipientName ||
            params.targetName ||
            params.customerName ||
            "",
        ]
          .filter(Boolean)
          .join(" ")
      : "inbound phone call";
  const { agent, context } = await loadAgentContext(
    agentId,
    direction,
    retrievalQuery,
  );
  const organizationId =
    agent?.organization_id || context?.organization_id || null;
  const primaryKnowledgeBaseId = Array.isArray(context?.knowledgeBaseIds)
    ? context.knowledgeBaseIds[0] || null
    : null;
  const recipientName = voiceBehavior.cleanRecipientNameForSpeech(
    params.recipientName || params.targetName || params.customerName || "",
  );
  const baseInstructions = buildAssistantPrompt({
    context,
    message:
      direction === "outbound"
        ? ["outbound phone call", callPurpose].filter(Boolean).join(" ")
        : "inbound phone call",
    mode: "voice",
    direction,
    languageName: agent.language || "English",
  });
  const instructions =
    direction === "outbound"
      ? [
          baseInstructions,
          voiceBehavior.outboundBehaviorRules({ callPurpose, recipientName }),
          callPurpose
            ? `Raw operator call purpose note. Understand it but do not read it verbatim: ${callPurpose}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n---\n\n")
      : [baseInstructions, voiceBehavior.inboundBehaviorRules()].join(
          "\n\n---\n\n",
        );

  await updateCallRecordById(callRecordId, {
    status: "in-progress",
    twilio_call_sid: callSid,
    direction,
    metadata: {
      ...(params || {}),
      realtimeModel: MODEL(),
    },
  });

  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL())}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    },
  );

  function sendMark() {
    if (!streamSid) return;
    safeSend(twilioWs, {
      event: "mark",
      streamSid,
      mark: { name: "responsePart" },
    });
    markQueue.push("responsePart");
  }

  function handleSpeechStarted() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = Math.max(
        0,
        latestMediaTimestamp - responseStartTimestampTwilio,
      );
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
          output: {
            format: { type: "audio/pcmu" },
            voice: mapVoice(agent.voice),
          },
        },
      },
    });

    // Let OpenAI speak first with a direction-safe greeting.
    const greeting =
      direction === "outbound"
        ? voiceBehavior.buildOutboundGreeting({
            recipientName,
            agentName: agent.name || "your assistant",
            organizationName: context.organization?.name || "the business",
            callPurpose,
          })
        : agent.greeting ||
          "Hello, thank you for calling. How can I help you today?";
    safeSend(openAiWs, {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Speak exactly this greeting and nothing else, then wait for the caller: ${greeting}`,
          },
        ],
      },
    });
    safeSend(openAiWs, { type: "response.create" });
  }

  openAiWs.on("open", initializeRealtimeSession);

  openAiWs.on("message", async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (
      event.type === "response.output_audio.delta" &&
      event.delta &&
      streamSid
    ) {
      outboundAudioDeltaCount += 1;
      safeSend(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: event.delta },
      });
      if (responseStartTimestampTwilio == null)
        responseStartTimestampTwilio = latestMediaTimestamp;
      if (event.item_id) lastAssistantItem = event.item_id;
      sendMark();
    }

    if (event.type === "input_audio_buffer.speech_started")
      handleSpeechStarted();

    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      event.transcript
    ) {
      await appendTranscript(callRecordId, {
        speaker: "Caller",
        text: event.transcript,
      });
    }

    if (
      (event.type === "response.audio_transcript.done" ||
        event.type === "response.output_text.done") &&
      event.transcript
    ) {
      await appendTranscript(callRecordId, {
        speaker: "Agent",
        text: event.transcript,
      });
    }

    if (event.type === "response.done") {
      const usage = usageFromRealtimeResponse(event);
      if (usage) {
        realtimeTokenEventsLogged += 1;
        logOpenAIUsage({
          organizationId,
          service: "realtime_call",
          eventType: "openai_realtime_tokens",
          model: MODEL(),
          usage,
          externalId:
            realtimeEventId(event) ||
            `${callSid || callRecordId}:response:${realtimeTokenEventsLogged}`,
          callId: callRecordId || null,
          voiceAgentId: agentId || null,
          knowledgeBaseId: primaryKnowledgeBaseId,
          metadata: {
            call_sid: callSid || null,
            stream_sid: streamSid || null,
            direction,
            response_status: event.response?.status || null,
            response_status_details: event.response?.status_details || null,
            source: "openai_realtime_bridge.response.done",
          },
        }).catch((err) => {
          console.warn(
            "[usage-ledger] OpenAI realtime token log skipped",
            err.message || String(err),
          );
        });
      } else {
        insertUsageEvent({
          organizationId,
          provider: "openai",
          service: "realtime_call",
          eventType: "openai_realtime_response_without_usage",
          source: "openai_realtime_bridge",
          externalId:
            realtimeEventId(event) ||
            `${callSid || callRecordId}:response:no-usage`,
          callId: callRecordId || null,
          voiceAgentId: agentId || null,
          knowledgeBaseId: primaryKnowledgeBaseId,
          unit: "response",
          quantity: 1,
          billable: Boolean(organizationId),
          metadata: {
            model: MODEL(),
            call_sid: callSid || null,
            stream_sid: streamSid || null,
            direction,
            note: "OpenAI realtime response did not include usage. Reconcile exact usage from OpenAI dashboard/export if needed.",
          },
        }).catch(() => {});
      }
    }

    if (event.type === "error")
      console.error("[openai realtime]", event.error || event);
  });

  twilioWs.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }
    if (data.event === "start") {
      streamSid = data.start?.streamSid || streamSid;
      streamStartedAt = streamStartedAt || Date.now();
      insertUsageEvent({
        organizationId,
        provider: "twilio",
        service: "media_stream",
        eventType: "twilio_media_stream_started",
        source: "openai_realtime_bridge",
        externalId: streamSid || `${callSid || callRecordId}:stream:start`,
        callId: callRecordId || null,
        voiceAgentId: agentId || null,
        knowledgeBaseId: primaryKnowledgeBaseId,
        unit: "session",
        quantity: 1,
        billable: Boolean(organizationId),
        metadata: {
          call_sid: callSid || null,
          stream_sid: streamSid || null,
          direction,
          model: MODEL(),
          source: "twilio.start",
        },
      }).catch(() => {});
      updateCallRecordById(callRecordId, {
        twilio_stream_sid: streamSid,
        status: "in-progress",
      }).catch(() => {});
      return;
    }
    if (data.event === "media") {
      mediaPacketCount += 1;
      inboundAudioBytesApprox += Buffer.byteLength(
        String(data.media?.payload || ""),
        "base64",
      );
      latestMediaTimestamp = Number(
        data.media?.timestamp || latestMediaTimestamp || 0,
      );
      safeSend(openAiWs, {
        type: "input_audio_buffer.append",
        audio: data.media?.payload || "",
      });
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
    try {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    } catch (_) {}
    const endedAt = Date.now();
    const sessionSeconds = Math.max(
      0,
      Math.ceil((endedAt - sessionStartedAt) / 1000),
    );
    const mediaSeconds = streamStartedAt
      ? Math.max(0, Math.ceil((endedAt - streamStartedAt) / 1000))
      : 0;
    await Promise.allSettled([
      insertUsageEvent({
        organizationId,
        provider: "railway",
        service: "websocket_runtime",
        eventType: "realtime_call_runtime_seconds",
        source: "openai_realtime_bridge",
        externalId: `${callSid || callRecordId}:runtime`,
        callId: callRecordId || null,
        voiceAgentId: agentId || null,
        knowledgeBaseId: primaryKnowledgeBaseId,
        unit: "seconds",
        quantity: sessionSeconds,
        billable: Boolean(organizationId),
        metadata: {
          call_sid: callSid || null,
          stream_sid: streamSid || null,
          direction,
          reason,
          model: MODEL(),
          media_packet_count: mediaPacketCount,
          inbound_audio_bytes_approx: inboundAudioBytesApprox,
          outbound_audio_delta_count: outboundAudioDeltaCount,
          realtime_token_events_logged: realtimeTokenEventsLogged,
        },
      }),
      insertUsageEvent({
        organizationId,
        provider: "twilio",
        service: "media_stream",
        eventType: "twilio_media_stream_seconds",
        source: "openai_realtime_bridge",
        externalId: `${streamSid || callSid || callRecordId}:duration`,
        callId: callRecordId || null,
        voiceAgentId: agentId || null,
        knowledgeBaseId: primaryKnowledgeBaseId,
        unit: "seconds",
        quantity: mediaSeconds,
        billable: Boolean(organizationId),
        metadata: {
          call_sid: callSid || null,
          stream_sid: streamSid || null,
          direction,
          reason,
          media_packet_count: mediaPacketCount,
          inbound_audio_bytes_approx: inboundAudioBytesApprox,
          outbound_audio_delta_count: outboundAudioDeltaCount,
        },
      }),
    ]);
    await finalizeCallRecord({
      callRecordId,
      callSid,
      status: reason === "completed" ? "completed" : "failed",
      endReason: reason,
    });
  }

  twilioWs.on("close", () => finalizeAndClose("completed"));
  twilioWs.on("error", (err) => {
    console.error("[twilio media ws]", err.message);
    finalizeAndClose("websocket-error");
  });
  openAiWs.on("error", (err) => {
    console.error("[openai realtime ws]", err.message);
  });
  openAiWs.on("close", () => {
    if (!closed && twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });
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
        try {
          ws.close();
        } catch (_) {}
      });
    });
  });
  console.log(
    "[WS] Twilio Media Streams -> OpenAI Realtime attached at /api/twilio/media-stream",
  );
}

module.exports = {
  attachRealtimeMediaStreamWebSocket,
  handleOpenAIRealtimeMediaStream,
};
