'use strict';

function serializeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || 'Owner',
    avatar: row.avatar || '',
  };
}

const VALID_VOICES = ['Rachel','Domi','Bella','Josh','Arnold','Wavenet-F','Wavenet-D','Polly-Joanna','Polly-Matthew'];
const VOICE_MIGRATION = { Zephyr:'Rachel', Puck:'Josh', Charon:'Arnold', Kore:'Bella', Fenrir:'Domi' };

function serializeAgent(row, faqs = []) {
  let voice = row.voice || 'Rachel';
  if (VOICE_MIGRATION[voice]) voice = VOICE_MIGRATION[voice];
  if (!VALID_VOICES.includes(voice)) voice = 'Rachel';

  return {
    id: row.id,
    name: row.name || 'My AI Agent',
    direction: row.direction || 'inbound',
    twilioPhoneNumber: row.twilio_phone_number || '',
    twilioPhoneSid: row.twilio_phone_sid || '',
    voice,
    language: row.language || 'English',
    greeting: row.greeting || 'Hello, thank you for calling. How can I help you today?',
    tone: row.tone || 'Professional',
    businessHours: row.business_hours || '9am-5pm Monday-Friday',
    faqs: faqs.map(serializeFaq),
    escalationPhone: row.escalation_phone || '',
    voicemailFallback: row.voicemail_fallback ?? true,
    dataCaptureFields: row.data_capture_fields || ['name', 'phone', 'email', 'reason'],
    rules: row.rules || { autoBook: false, autoEscalate: true, captureAllLeads: true },
    isActive: row.is_active || false,
  };
}

/**
 * FIX: serializeChatbot now includes chatVoice and chatLanguages so they
 * survive page refresh and are embedded into the widget iframe src.
 */
function serializeChatbot(row) {
  const apiBase = (process.env.API_URL || '').replace(/\/$/, '');
  const widgetUrl = apiBase + '/chatbot-widget/' + row.id;
  const pos = row.position === 'left' ? 'left' : 'right';
  const opp = pos === 'left' ? 'right' : 'left';

  // FIX: persist language + voice into iframe src as query params
  const chatLanguages = Array.isArray(row.chat_languages) ? row.chat_languages : ['en'];
  const chatVoice = row.chat_voice || 'alloy';
  const widgetSrc = `${widgetUrl}?langs=${chatLanguages.join(',')}&voice=${encodeURIComponent(chatVoice)}`;

  const lines = [
    '<!-- Agently Chat Widget -->',
    '<iframe',
    `  id="agently-widget-${row.id}"`,
    `  src="${widgetSrc}"`,
    `  style="position:fixed;bottom:20px;${pos}:20px;${opp}:auto;width:420px;height:800px;max-width:90vw;max-height:90vh;border:none;background:transparent;z-index:2147483646;overflow:hidden;outline:none;display:block;visibility:visible;pointer-events:auto;"`,
    '  scrolling="no" frameborder="0" allow="microphone"',
    '  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"',
    '  referrerpolicy="no-referrer-when-downgrade"',
    '  loading="eager"',
    '  onload="console.info(\'Agently widget iframe loaded\')"',
    '  onerror="this.style.display=\'none\'; console.error(\'Agently widget iframe failed to load\')"',
    '  title="Chat widget"',
    '></iframe>',
  ];
  const embedScript = lines.join('\n');

  return {
    id: row.id,
    name: row.name || 'My Chatbot',
    voiceAgentId: row.voice_agent_id || '',
    faqs: row.faqs || [],
    headerTitle: row.header_title || 'Chat with us',
    welcomeMessage: row.welcome_message || 'Hello! How can I help you today?',
    placeholder: row.placeholder || 'Type your message...',
    launcherLabel: row.launcher_label || 'Chat',
    accentColor: row.accent_color || '#4f46e5',
    position: row.position || 'right',
    avatarLabel: row.avatar_label || 'A',
    customPrompt: row.custom_prompt || '',
    suggestedPrompts: row.suggested_prompts || [],
    embedScript,
    widgetScriptUrl: widgetUrl,
    // FIX: these fields are now included so they persist across refreshes
    chatVoice,
    chatLanguages,
  };
}

function buildEmbedScript(row) {
  const apiUrl = process.env.API_URL || '';
  return `<iframe
    id="agently-chatbot-${row.id}"
    src="${apiUrl}/chatbot-widget/${row.id}"
    style="position:fixed;bottom:20px;right:${row.position === 'left' ? 'auto' : '20px'};left:${row.position === 'left' ? '20px' : 'auto'};width:420px;height:800px;max-width:90vw;max-height:90vh;border:none;background:transparent;z-index:1000000;overflow:hidden;outline:none;display:block;visibility:visible;pointer-events:auto;"
    scrolling="no" frameborder="0" allow="microphone"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"
    referrerpolicy="no-referrer-when-downgrade"
    onload="console.info('Agently widget iframe loaded')"
    onerror="this.style.display='none'; console.error('Agently widget iframe failed to load')"
></iframe>`;
}

function serializeFaq(row) {
  return { id: row.id, question: row.question, answer: row.answer };
}

function serializeLead(row) {
  return {
    id: row.id,
    name: row.name || 'Unknown',
    phone: row.phone || '',
    email: row.email || '',
    reason: row.reason || '',
    status: row.status || 'new',
    source: row.source || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    voiceAgentId: row.voice_agent_id || '',
    assignmentContext: row.assignment_context || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function serializeCall(row) {
  return {
    id: row.id,
    callerName: row.caller_name || 'Unknown Caller',
    callerPhone: row.caller_phone || '',
    duration: row.duration || 0,
    timestamp: row.timestamp || row.created_at,
    outcome: row.outcome || 'FAQ Answered',
    summary: row.summary || '',
    transcript: row.transcript || [],
  };
}

function serializeMessage(row) {
  return { id: row.id, role: row.role, text: row.text, timestamp: row.created_at };
}

function serializeInvoice(row) {
  return {
    id: row.id,
    date: row.date || row.created_at,
    amount: parseFloat(row.amount) || 0,
    status: row.status || 'Paid',
    pdfUrl: row.pdf_url || '',
  };
}

function serializeOrganization(org, voiceAgents = [], chatbots = [], members = [], invoices = []) {
  const activeAgent = voiceAgents.find(a => a.id === org.active_voice_agent_id) || voiceAgents[0] || null;

  return {
    id: org.id,
    profile: {
      name: org.name,
      industry: org.industry || '',
      website: org.website || '',
      location: org.location || '',
      onboarded: org.onboarded ?? false,
      timezone: org.timezone || 'America/New_York',
    },
    activeVoiceAgentId: org.active_voice_agent_id || '',
    voiceAgents,
    agent: activeAgent || buildDefaultAgent(),
    activeChatbotId: org.active_chatbot_id || '',
    chatbots,
    subscription: {
      plan: org.plan || 'Starter',
      status: org.subscription_status || 'trialing',
      currentPeriodEnd: org.subscription_period_end,
      usage: {
        calls: org.usage_calls || 0,
        minutes: org.usage_minutes || 0,
        callLimit: org.call_limit || 100,
        minuteLimit: org.minute_limit || 500,
      },
    },
    phoneNumber: org.phone_number || '',
    settings: {
      timezone: org.timezone || 'America/New_York',
      phoneNumber: org.phone_number || '',
      twilio: {
        accountSid: org.twilio_account_sid || '',
        authTokenConfigured: !!(org.twilio_auth_token_encrypted),
        authTokenLastFour: org.twilio_auth_token_last_four || '',
        validateRequests: org.twilio_validate_requests ?? true,
        webhookBaseUrl: org.twilio_webhook_base_url || (process.env.API_URL || ''),
      },
    },
    members,
    invoices,
  };
}

function buildDefaultAgent() {
  return {
    id: '', name: 'My AI Agent', direction: 'inbound',
    twilioPhoneNumber: '', twilioPhoneSid: '', voice: 'Rachel',
    language: 'English',
    greeting: 'Hello, thank you for calling. How can I help you today?',
    tone: 'Professional', businessHours: '9am-5pm Monday-Friday',
    faqs: [], escalationPhone: '', voicemailFallback: true,
    dataCaptureFields: ['name', 'phone', 'email', 'reason'],
    rules: { autoBook: false, autoEscalate: true, captureAllLeads: true },
    isActive: false,
  };
}

function serializeBootstrap(user, org, voiceAgents, chatbots, members, invoices, leads, calls, messages, dashboard) {
  return {
    user: serializeUser(user),
    organization: serializeOrganization(org, voiceAgents, chatbots, members, invoices),
    leads: leads.map(serializeLead),
    calls: calls.map(serializeCall),
    conversation: messages.map(serializeMessage),
    dashboard,
  };
}

module.exports = {
  serializeUser, serializeAgent, serializeChatbot, serializeFaq,
  serializeLead, serializeCall, serializeMessage, serializeInvoice,
  serializeOrganization, serializeBootstrap, buildEmbedScript,
};
