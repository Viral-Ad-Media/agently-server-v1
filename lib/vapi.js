'use strict';

const VAPI_BASE = (process.env.VAPI_BASE_URL || 'https://api.vapi.ai').replace(/\/$/, '');

function getKey() {
  const k = process.env.VAPI_API_KEY;
  if (!k) throw new Error('VAPI_API_KEY is not configured.');
  return k;
}

async function vapiRequest(method, path, body) {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getKey()}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!res.ok) throw new Error(`Vapi ${res.status} ${path}: ${data?.message || text}`);
  return data;
}

const VOICE_MAP = {
  Zephyr: { provider: '11labs', voiceId: 'sarah' },
  Puck:   { provider: '11labs', voiceId: 'charlie' },
  Charon: { provider: 'openai', voiceId: 'onyx' },
  Kore:   { provider: 'openai', voiceId: 'nova' },
  Fenrir: { provider: 'openai', voiceId: 'alloy' },
};

const LANG_MAP = {
  English: 'en-US', Spanish: 'es-ES', French: 'fr-FR', German: 'de-DE',
};

function buildAssistantPayload(agentRow, faqs = []) {
  const faqsText = faqs.length
    ? faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : 'No FAQs configured yet.';

  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');

  const systemPrompt =
    `You are ${agentRow.name}, a professional AI receptionist with a ${agentRow.tone || 'Professional'} tone.\n` +
    `Business Hours: ${agentRow.business_hours || '9am-5pm Monday-Friday'}\n\n` +
    `KNOWLEDGE BASE:\n${faqsText}\n\n` +
    `RULES:\n` +
    `- Keep every response to 1-3 sentences. Voice conversations must be concise.\n` +
    `- If the caller asks for a human, says "operator", or says "press 0", tell them you are transferring them and end the call.\n` +
    `- Capture the caller's name, phone number, and reason for calling when possible.\n` +
    `- If you cannot answer a question, offer to take a message.\n` +
    `- Never say you are an AI language model. You are ${agentRow.name}.`;

  const voice = VOICE_MAP[agentRow.voice] || VOICE_MAP.Zephyr;

  return {
    name: agentRow.name,
    firstMessage: agentRow.greeting || 'Hello, thank you for calling. How can I help you today?',
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }],
      maxTokens: 150,
      temperature: 0.45,
    },
    voice: {
      provider: voice.provider,
      voiceId: voice.voiceId,
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: LANG_MAP[agentRow.language] || 'en-US',
    },
    // Vapi will POST to this URL when each call ends
    serverUrl: `${apiUrl}/api/vapi/webhook`,
    ...(process.env.VAPI_WEBHOOK_SECRET
      ? { serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET }
      : {}),
    endCallFunctionEnabled: true,
    recordingEnabled: true,
    silenceTimeoutSeconds: 25,
    maxDurationSeconds: 3600,
    metadata: {
      organizationId: agentRow.organization_id,
      agentId: agentRow.id,
    },
  };
}

async function upsertVapiAssistant(agentRow, faqs = []) {
  const payload = buildAssistantPayload(agentRow, faqs);
  if (agentRow.vapi_assistant_id) {
    try {
      return await vapiRequest('PATCH', `/assistant/${agentRow.vapi_assistant_id}`, payload);
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('not_found')) {
        return vapiRequest('POST', '/assistant', payload);
      }
      throw e;
    }
  }
  return vapiRequest('POST', '/assistant', payload);
}

async function deleteVapiAssistant(id) {
  if (!id) return;
  try { await vapiRequest('DELETE', `/assistant/${id}`); }
  catch (e) { console.warn('Vapi delete assistant (ignored):', e.message); }
}

async function listPhoneNumbers() {
  return vapiRequest('GET', '/phone-number') || [];
}

async function importTwilioNumber({ twilioPhoneNumber, twilioAccountSid, twilioAuthToken, vapiAssistantId }) {
  const payload = {
    provider: 'twilio',
    number: twilioPhoneNumber,
    twilioAccountSid,
    twilioAuthToken,
  };
  if (vapiAssistantId) payload.assistantId = vapiAssistantId;
  return vapiRequest('POST', '/phone-number', payload);
}

async function updatePhoneNumberAssistant(phoneNumberId, assistantId) {
  return vapiRequest('PATCH', `/phone-number/${phoneNumberId}`, { assistantId });
}

async function deletePhoneNumber(id) {
  if (!id) return;
  try { await vapiRequest('DELETE', `/phone-number/${id}`); }
  catch (e) { console.warn('Vapi delete phone (ignored):', e.message); }
}

async function makeOutboundCall({ toPhone, vapiAssistantId, vapiPhoneNumberId, customerName }) {
  return vapiRequest('POST', '/call/phone', {
    assistantId: vapiAssistantId,
    phoneNumberId: vapiPhoneNumberId,
    customer: { number: toPhone, name: customerName || '' },
  });
}

// ── Webhook parsing ───────────────────────────────────────────
// Vapi sends `end-of-call-report` after every call.
// Full schema: https://docs.vapi.ai/server-url/events

function parseWebhookEvent(body) {
  // Vapi wraps events in body.message
  const msg  = body.message || body;
  const type = msg.type || body.type || '';

  if (type === 'end-of-call-report') {
    const call = msg.call || {};
    const meta = call.metadata || msg.metadata || {};

    // Transcript comes as an array of {role, message} objects
    const rawTranscript = msg.transcript || msg.messages || call.messages || [];
    const transcript = parseTranscript(rawTranscript);

    const startedAt = call.startedAt || call.start_time;
    const endedAt   = call.endedAt   || call.end_time;
    const duration  = startedAt && endedAt
      ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000)
      : (msg.durationSeconds || 0);

    return {
      event:         'call-ended',
      callId:        call.id || msg.callId || '',
      orgId:         meta.organizationId || '',
      agentId:       meta.agentId || '',
      callerPhone:   call.customer?.number || call.to || '',
      callerName:    call.customer?.name || extractCallerName(transcript) || 'Unknown Caller',
      duration,
      transcript,
      summary:       msg.summary || msg.analysis?.summary || '',
      recordingUrl:  msg.recordingUrl || call.recordingUrl || '',
      endedReason:   msg.endedReason || call.endedReason || '',
      structuredData: msg.analysis?.structuredData || {},
    };
  }

  if (type === 'status-update') {
    return { event: 'status-update', callId: msg.call?.id, status: msg.status };
  }

  if (type === 'function-call') {
    return {
      event: 'function-call',
      callId: msg.call?.id,
      functionName: msg.functionCall?.name,
      parameters: msg.functionCall?.parameters || {},
    };
  }

  return { event: type || 'unknown' };
}

function parseTranscript(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(m => ({
        speaker: m.role === 'assistant' || m.role === 'bot' ? 'Agent' : 'Caller',
        text: String(m.message || m.content || m.text || '').trim(),
      }))
      .filter(m => m.text);
  }
  // Plain string transcript
  return String(raw).split('\n').map(line => {
    const idx = line.indexOf(':');
    if (idx > -1) return { speaker: line.slice(0, idx).trim(), text: line.slice(idx + 1).trim() };
    return { speaker: 'Unknown', text: line.trim() };
  }).filter(m => m.text);
}

function extractCallerName(transcript) {
  for (const m of transcript) {
    if (m.speaker === 'Caller') {
      const match = m.text.match(/(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
      if (match) return match[1];
    }
  }
  return '';
}

function determineOutcome(endedReason, transcript, structuredData) {
  const text = transcript.map(m => m.text).join(' ').toLowerCase();

  if (structuredData?.appointmentBooked === true ||
      (text.includes('book') && text.includes('appointment'))) {
    return 'Appointment Booked';
  }
  if (endedReason === 'transfer' || text.includes('transfer') ||
      text.includes('speak to a human') || text.includes('speak with someone')) {
    return 'Escalated';
  }
  if (endedReason === 'voicemail' || text.includes('leave a message') || text.includes('voicemail')) {
    return 'Voicemail';
  }
  if (structuredData?.name || structuredData?.phone || structuredData?.email ||
      text.includes('my name is') || text.includes('my number is') || text.includes('my email')) {
    return 'Lead Captured';
  }
  return 'FAQ Answered';
}

module.exports = {
  upsertVapiAssistant,
  deleteVapiAssistant,
  listPhoneNumbers,
  importTwilioNumber,
  updatePhoneNumberAssistant,
  deletePhoneNumber,
  makeOutboundCall,
  parseWebhookEvent,
  determineOutcome,
  extractCallerName,
};
