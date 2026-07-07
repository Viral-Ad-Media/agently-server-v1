"use strict";

const WebSocket = require("ws");
const { URL } = require("url");
const { getSupabase } = require("./supabase");
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
const REALTIME_BARGE_IN_ENABLED = () =>
  String(process.env.REALTIME_BARGE_IN_ENABLED || "false").toLowerCase() ===
  "true";
const REALTIME_VAD_THRESHOLD = () =>
  safeNumber(process.env.REALTIME_VAD_THRESHOLD, 0.68);
const REALTIME_VAD_PREFIX_PADDING_MS = () =>
  safeNumber(process.env.REALTIME_VAD_PREFIX_PADDING_MS, 350);
const REALTIME_VAD_SILENCE_MS = () =>
  safeNumber(process.env.REALTIME_VAD_SILENCE_MS, 900);

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

function mergeStartParameters(existing = {}, start = {}) {
  const custom = start.customParameters || start.custom_parameters || {};
  const merged = { ...(existing || {}), ...(custom || {}) };
  if (start.callSid && !merged.callSid) merged.callSid = start.callSid;
  if (start.accountSid && !merged.accountSid)
    merged.accountSid = start.accountSid;
  if (start.from && !merged.callerPhone) merged.callerPhone = start.from;
  if (start.to && !merged.recipientPhone) merged.recipientPhone = start.to;
  return merged;
}

function cleanSpeech(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function kbDisplayName(kb) {
  return cleanSpeech(
    kb?.business_name || kb?.name || kb?.domain || kb?.primary_url || "",
  );
}

function inferFastBusinessFacts({
  knowledgeBase = null,
  knowledgeSources = [],
  params = {},
} = {}) {
  const hay = [
    knowledgeBase?.name,
    knowledgeBase?.business_name,
    knowledgeBase?.description,
    knowledgeBase?.industry,
    knowledgeBase?.primary_url,
    knowledgeBase?.domain,
    JSON.stringify(knowledgeBase?.metadata || {}),
    ...(knowledgeSources || []).flatMap((source) => [
      source.title,
      source.domain,
      source.url,
      source.normalized_url,
    ]),
    params.knowledgeBaseName,
    params.businessName,
  ]
    .map(cleanSpeech)
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const facts = [];
  const add = (value) => {
    const text = cleanSpeech(value);
    if (text && !facts.includes(text)) facts.push(text);
  };
  const metadata =
    knowledgeBase?.metadata && typeof knowledgeBase.metadata === "object"
      ? knowledgeBase.metadata
      : {};
  add(
    metadata.runtimeProfile ||
      metadata.runtime_profile ||
      metadata.businessProfile ||
      metadata.business_profile,
  );
  if (Array.isArray(metadata.services) && metadata.services.length) {
    add(
      `Configured business topics/services: ${metadata.services.slice(0, 20).join(", ")}.`,
    );
  }
  const sourceTopics = (knowledgeSources || [])
    .flatMap((source) => [source.title, source.domain, source.url])
    .map(cleanSpeech)
    .filter(Boolean)
    .slice(0, 12);
  if (sourceTopics.length) {
    add(
      `Runtime source signals from selected KB only: ${sourceTopics.join("; ")}.`,
    );
  }
  add(
    "Never invent service categories. Describe only products, services, prices, URLs, and business categories that are present in the selected KB profile, selected KB sources, selected KB FAQs, selected KB chunks, or selected KB products. Do not infer services from the agent name, organization name, old calls, other tenants, or generic SaaS examples.",
  );
  add(
    "If a business-specific detail is missing from the selected KB, do not say so directly — help with the closest relevant thing available, or warmly offer to take a message/schedule a callback so someone can confirm the exact detail.",
  );
  return facts;
}

function scopedBusinessName({
  context = {},
  knowledgeBase = null,
  organization = null,
  agent = null,
  params = {},
} = {}) {
  const kb =
    knowledgeBase ||
    (Array.isArray(context.knowledgeBases)
      ? context.knowledgeBases[0]
      : null) ||
    context.knowledgeBase ||
    null;
  return (
    kbDisplayName(kb) ||
    cleanSpeech(
      params.knowledgeBaseName ||
        params.businessName ||
        params.organizationName,
    ) ||
    cleanSpeech(agent?.business_name || agent?.businessName || agent?.name) ||
    cleanSpeech(
      organization?.name ||
        organization?.business_name ||
        organization?.company_name,
    ) ||
    "this business"
  );
}

function greetingMentionsWrongWorkspace(greeting, scopedName, organization) {
  const text = cleanSpeech(greeting).toLowerCase();
  const scoped = cleanSpeech(scopedName).toLowerCase();
  const orgNames = [
    organization?.name,
    organization?.business_name,
    organization?.company_name,
  ]
    .map((v) => cleanSpeech(v).toLowerCase())
    .filter(Boolean);
  if (!text || !scoped || !orgNames.length) return false;
  return orgNames.some(
    (name) => name && name !== scoped && text.includes(name),
  );
}

async function quickLoadAgent(agentId) {
  if (!agentId)
    return {
      agent: null,
      organization: null,
      knowledgeBase: null,
      knowledgeSources: [],
    };
  try {
    const db = getSupabase();
    const { data: agent } = await db
      .from("voice_agents")
      .select(
        "id,organization_id,name,greeting,voice,voice_provider,voice_id,language,tone,knowledge_base_id,custom_prompt,core_purpose,call_purpose,updated_at",
      )
      .eq("id", agentId)
      .maybeSingle();
    if (!agent?.id)
      return {
        agent: null,
        organization: null,
        knowledgeBase: null,
        knowledgeSources: [],
      };
    let organization = null;
    let knowledgeBase = null;
    let knowledgeSources = [];
    if (agent.organization_id) {
      const { data: org } = await db
        .from("organizations")
        .select("id,name,industry,website,location,phone_number,timezone")
        .eq("id", agent.organization_id)
        .maybeSingle();
      organization = org || null;
    }
    if (agent.organization_id && agent.knowledge_base_id) {
      const [{ data: kb }, { data: sources }] = await Promise.all([
        db
          .from("knowledge_bases")
          .select(
            "id,organization_id,name,business_name,description,industry,primary_url,domain,metadata",
          )
          .eq("id", agent.knowledge_base_id)
          .eq("organization_id", agent.organization_id)
          .maybeSingle(),
        db
          .from("knowledge_sources")
          .select(
            "id,knowledge_base_id,url,normalized_url,domain,title,is_primary",
          )
          .eq("organization_id", agent.organization_id)
          .eq("knowledge_base_id", agent.knowledge_base_id)
          .order("is_primary", { ascending: false })
          .limit(5),
      ]);
      knowledgeBase = kb || null;
      knowledgeSources = sources || [];
    }
    return { agent, organization, knowledgeBase, knowledgeSources };
  } catch (err) {
    console.warn(
      "[openai realtime] quick agent load skipped",
      err.message || String(err),
    );
    return {
      agent: null,
      organization: null,
      knowledgeBase: null,
      knowledgeSources: [],
    };
  }
}

function buildFastInstructions({
  agent,
  organization,
  knowledgeBase,
  knowledgeSources = [],
  direction,
  params = {},
}) {
  const name = scopedBusinessName({
    agent,
    organization,
    knowledgeBase,
    params,
  });
  const lines = [
    `You are ${agent?.name || "the AI voice agent"}, the phone representative for ${name}.`,
    `ACTIVE BUSINESS: ${name}. This selected Knowledge Base identity overrides the parent workspace/organization name.`,
  ];
  if (knowledgeBase?.id)
    lines.push(`ACTIVE KNOWLEDGE BASE ID: ${knowledgeBase.id}.`);
  if (knowledgeBase?.primary_url || knowledgeBase?.domain) {
    lines.push(
      `ACTIVE BUSINESS WEBSITE/SOURCE: ${knowledgeBase.primary_url || knowledgeBase.domain}.`,
    );
  }
  if (knowledgeBase?.description)
    lines.push(`ACTIVE BUSINESS DESCRIPTION: ${knowledgeBase.description}.`);
  if (knowledgeBase?.industry)
    lines.push(`ACTIVE BUSINESS TYPE/INDUSTRY: ${knowledgeBase.industry}.`);
  if (
    Array.isArray(knowledgeBase?.metadata?.services) &&
    knowledgeBase.metadata.services.length
  ) {
    lines.push(
      `ACTIVE BUSINESS SERVICES: ${knowledgeBase.metadata.services.slice(0, 12).join(", ")}.`,
    );
  }
  const fastFacts = inferFastBusinessFacts({
    knowledgeBase,
    knowledgeSources,
    params,
  });
  if (fastFacts.length) {
    lines.push(
      `ACTIVE BUSINESS FACTS AND GUARDS:\n${fastFacts.map((fact) => `- ${fact}`).join("\n")}`,
    );
  }
  if (agent?.core_purpose)
    lines.push(`AGENT CORE PURPOSE: ${agent.core_purpose}.`);
  if (agent?.call_purpose)
    lines.push(`AGENT CALL PURPOSE: ${agent.call_purpose}.`);
  if (agent?.custom_prompt)
    lines.push(`MANDATORY CUSTOM AGENT PROMPT: ${agent.custom_prompt}`);
  lines.push(
    "Do not introduce yourself as being from the parent workspace unless that exact workspace is the selected Knowledge Base identity.",
    "Start the call immediately with the provided greeting. Keep the first response short and natural.",
    "Use only the selected Knowledge Base once it is loaded. If you do not have the answer yet, do not mention checking any knowledge base — say you want to make sure they get the exact detail and offer follow-up instead of inventing.",
    "If asked for the business name or website, use the ACTIVE BUSINESS/selected Knowledge Base identity already provided, not the parent workspace name.",
    "If asked what services are offered before full chunks load, answer only from ACTIVE BUSINESS FACTS AND GUARDS. Do not guess generic services.",
    direction === "outbound"
      ? "This is an outbound call. Be respectful, concise, and do not read internal notes verbatim."
      : "This is an inbound call. Be helpful, concise, and phone-friendly.",
  );
  return lines.filter(Boolean).join("\n");
}

function buildInstructionsFromLoadedContext({
  agent,
  context,
  direction,
  callPurpose,
  recipientName,
}) {
  const selectedName = scopedBusinessName({ context, agent });
  const identityGuard = [
    "ACTIVE BUSINESS IDENTITY OVERRIDE:",
    `- The selected Knowledge Base business is: ${selectedName}.`,
    "- This identity overrides the parent organization/workspace name used for billing or login.",
    "- Never say you are from the parent workspace unless it is the selected Knowledge Base business.",
    "- If asked what the business does, answer only from the selected Knowledge Base FAQs and chunks below.",
  ].join("\n");
  const baseInstructions = buildAssistantPrompt({
    context,
    message:
      direction === "outbound"
        ? ["outbound phone call", callPurpose].filter(Boolean).join(" ")
        : "inbound phone call",
    mode: "voice",
    direction,
    languageName: agent?.language || "English",
  });
  return direction === "outbound"
    ? [
        identityGuard,
        baseInstructions,
        voiceBehavior.outboundBehaviorRules({ callPurpose, recipientName }),
        callPurpose
          ? `Raw operator call purpose note. Understand it but do not read it verbatim: ${callPurpose}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n---\n\n")
    : [
        identityGuard,
        baseInstructions,
        voiceBehavior.inboundBehaviorRules(),
      ].join("\n\n---\n\n");
}

async function handleOpenAIRealtimeMediaStream(twilioWs, request) {
  let params = getParams(request);
  let agentId = params.agentId;
  let callRecordId = params.callRecordId;
  let callSid = params.callSid || "";
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
  let openAiReady = false;
  let fullContextApplied = false;
  let greetingStarted = false;
  const fullContextGreetingWaitMs = safeNumber(
    process.env.REALTIME_FULL_CONTEXT_GREETING_WAIT_MS,
    900,
  );

  let direction = params.direction || "inbound";
  let callPurpose = params.callPurpose || params.purpose || "";
  let recipientName = voiceBehavior.cleanRecipientNameForSpeech(
    params.recipientName || params.targetName || params.customerName || "",
  );

  const quick = await quickLoadAgent(agentId);
  let agent = quick.agent || {
    id: agentId || "",
    name: params.agentName || "AI voice agent",
  };
  let context = {
    organization_id:
      params.organizationId || params.orgId || agent?.organization_id || null,
    organization: quick.organization || {
      id:
        params.organizationId || params.orgId || agent?.organization_id || null,
      name: params.organizationName || "",
    },
    knowledgeBaseIds: agent?.knowledge_base_id ? [agent.knowledge_base_id] : [],
    knowledgeBases: quick.knowledgeBase ? [quick.knowledgeBase] : [],
    knowledgeBase: quick.knowledgeBase || null,
    knowledgeSources: quick.knowledgeSources || [],
    stats: {
      mode: "fast_start",
      selectedKnowledgeBaseId: agent?.knowledge_base_id || null,
    },
  };
  let organizationId =
    agent?.organization_id ||
    context?.organization_id ||
    params.organizationId ||
    params.orgId ||
    null;
  let primaryKnowledgeBaseId = Array.isArray(context?.knowledgeBaseIds)
    ? context.knowledgeBaseIds[0] || null
    : agent?.knowledge_base_id || null;
  let instructions = buildFastInstructions({
    agent,
    organization: context.organization,
    knowledgeBase: quick.knowledgeBase || null,
    knowledgeSources: quick.knowledgeSources || [],
    direction,
    params,
  });

  function buildRetrievalQuery(currentParams = params) {
    return direction === "outbound"
      ? [
          "outbound phone call",
          callPurpose,
          currentParams.recipientName ||
            currentParams.targetName ||
            currentParams.customerName ||
            "",
        ]
          .filter(Boolean)
          .join(" ")
      : "inbound phone call";
  }

  async function applyFullContext(currentParams = params) {
    if (!agentId) return;
    try {
      const loaded = await loadAgentContext(
        agentId,
        direction,
        buildRetrievalQuery(currentParams),
      );
      agent = loaded.agent || agent;
      context = loaded.context || context;
      organizationId =
        agent?.organization_id || context?.organization_id || organizationId;
      primaryKnowledgeBaseId = Array.isArray(context?.knowledgeBaseIds)
        ? context.knowledgeBaseIds[0] || null
        : agent?.knowledge_base_id || primaryKnowledgeBaseId;
      instructions = buildInstructionsFromLoadedContext({
        agent,
        context,
        direction,
        callPurpose,
        recipientName,
      });
      if (openAiReady) {
        safeSend(openAiWs, {
          type: "session.update",
          session: buildRealtimeSessionPayload(),
        });
        fullContextApplied = true;
      }
      console.log("[kb-scope] realtime call context loaded", {
        callSid: callSid || "",
        agentId: agent?.id || agentId || "",
        organizationId: organizationId || "",
        selectedKnowledgeBaseId: primaryKnowledgeBaseId || null,
        stats: context?.stats || null,
      });
    } catch (err) {
      console.error(
        "[openai realtime] full context load failed",
        err.message || String(err),
      );
    }
  }

  const fullContextPromise = applyFullContext(params);

  await updateCallRecordById(callRecordId, {
    status: "in-progress",
    twilio_call_sid: callSid,
    direction,
    metadata: {
      ...(params || {}),
      realtimeModel: MODEL(),
      fastStart: true,
      vadThreshold: REALTIME_VAD_THRESHOLD(),
      vadSilenceMs: REALTIME_VAD_SILENCE_MS(),
      bargeInEnabled: REALTIME_BARGE_IN_ENABLED(),
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

  function buildRealtimeSessionPayload() {
    return {
      type: "realtime",
      model: MODEL(),
      output_modalities: ["audio"],
      instructions,
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: {
            type: "server_vad",
            threshold: REALTIME_VAD_THRESHOLD(),
            prefix_padding_ms: REALTIME_VAD_PREFIX_PADDING_MS(),
            silence_duration_ms: REALTIME_VAD_SILENCE_MS(),
          },
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: mapVoice(
            agent?.openai_voice || agent?.voice_id || agent?.voice,
          ),
        },
      },
    };
  }

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
    if (!REALTIME_BARGE_IN_ENABLED()) {
      return;
    }
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

  function maybeStartOpeningGreeting() {
    if (greetingStarted || !openAiReady || !streamSid) return;
    if (
      primaryKnowledgeBaseId &&
      !fullContextApplied &&
      Date.now() - sessionStartedAt < fullContextGreetingWaitMs
    ) {
      setTimeout(maybeStartOpeningGreeting, 120);
      return;
    }
    greetingStarted = true;
    // Let OpenAI speak first only after Twilio has supplied streamSid.
    // If audio is generated before streamSid exists, the first audio deltas are dropped,
    // which sounds like 6-10 seconds of silence and missing words.
    const selectedBusinessName = scopedBusinessName({ context, agent, params });
    const queryGreeting = cleanSpeech(
      params.openingGreeting || params.greetingMessage || "",
    );
    const trustQueryGreeting =
      direction !== "outbound" &&
      queryGreeting &&
      !greetingMentionsWrongWorkspace(
        queryGreeting,
        selectedBusinessName,
        context.organization,
      );
    const greeting = trustQueryGreeting
      ? queryGreeting
      : direction === "outbound"
        ? voiceBehavior.buildOutboundGreeting({
            recipientName,
            agentName: agent?.name || params.agentName || "your assistant",
            organizationName: selectedBusinessName,
            callPurpose,
          })
        : agent?.greeting &&
            !greetingMentionsWrongWorkspace(
              agent.greeting,
              selectedBusinessName,
              context.organization,
            )
          ? agent.greeting
          : voiceBehavior.buildInboundGreeting({
              agentName: agent?.name || params.agentName || "your assistant",
              organizationName: selectedBusinessName,
            });
    console.log("[kb-scope] realtime opening identity", {
      callSid: callSid || "",
      streamSid: streamSid || "",
      agentId: agent?.id || agentId || "",
      selectedBusinessName,
      selectedKnowledgeBaseId: primaryKnowledgeBaseId || null,
      trustedQueryGreeting: trustQueryGreeting,
      parentOrganizationName:
        context.organization?.name || params.organizationName || "",
    });
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

  function initializeRealtimeSession() {
    openAiReady = true;
    safeSend(openAiWs, {
      type: "session.update",
      session: buildRealtimeSessionPayload(),
    });
    maybeStartOpeningGreeting();
  }

  openAiWs.on("open", initializeRealtimeSession);
  fullContextPromise.catch(() => {});

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
      params = mergeStartParameters(params, data.start || {});
      agentId = agentId || params.agentId;
      callRecordId = callRecordId || params.callRecordId;
      callSid = callSid || params.callSid || data.start?.callSid || "";
      direction = params.direction || direction;
      callPurpose = params.callPurpose || params.purpose || callPurpose;
      recipientName = voiceBehavior.cleanRecipientNameForSpeech(
        params.recipientName ||
          params.targetName ||
          params.customerName ||
          recipientName ||
          "",
      );
      streamSid = data.start?.streamSid || streamSid;
      streamStartedAt = streamStartedAt || Date.now();
      if (!fullContextApplied && agentId && !primaryKnowledgeBaseId) {
        applyFullContext(params).catch(() => {});
      }
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
      maybeStartOpeningGreeting();
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
