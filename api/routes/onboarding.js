'use strict';

const express = require('express');
const { getSupabase } = require('../../lib/supabase');
const { requireAuth } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/error');
const { scrapeAndSave, getDefaultFaqs } = require('../../lib/scraper');
const { upsertVapiAssistant } = require('../../lib/vapi');

const router = express.Router();

// ── POST /api/onboarding/faqs ─────────────────────────────────
router.post('/faqs', requireAuth, asyncHandler(async (req, res) => {
  const { website } = req.body;
  if (!website) {
    return res.status(400).json({ error: { message: 'Website URL is required.' } });
  }

  let faqs;
  let meta = {};

  try {
    const result = await scrapeAndSave(req.orgId, null, website);
    faqs = result.faqs;
    meta = { chunks: result.chunks, strategy: result.strategy };
  } catch (e) {
    console.warn('Onboarding FAQ scrape failed, using defaults:', e.message);
    faqs = getDefaultFaqs();
    meta = { strategy: 'fallback', error: e.message };
  }

  res.json({ website, faqs, meta });
}));

// ── POST /api/onboarding/complete ─────────────────────────────
router.post('/complete', requireAuth, asyncHandler(async (req, res) => {
  const { profile, agent: agentConfig } = req.body;

  if (!profile || !agentConfig) {
    return res.status(400).json({ error: { message: 'Profile and agent config are required.' } });
  }

  const db = getSupabase();
  const orgId = req.orgId;

  // Update organization
  await db.from('organizations').update({
    name: profile.name || 'My Business',
    industry: profile.industry || '',
    website: profile.website || '',
    location: profile.location || '',
    timezone: profile.timezone || 'America/New_York',
    onboarded: true,
    updated_at: new Date().toISOString(),
  }).eq('id', orgId);

  // Create the first voice agent
  const { data: agentRow, error: agentErr } = await db.from('voice_agents').insert({
    organization_id: orgId,
    name: agentConfig.name || 'My AI Agent',
    direction: agentConfig.direction || 'inbound',
    voice: agentConfig.voice || 'Zephyr',
    language: agentConfig.language || 'English',
    greeting: agentConfig.greeting || 'Hello, thank you for calling. How can I help you today?',
    tone: agentConfig.tone || 'Professional',
    business_hours: agentConfig.businessHours || '9am-5pm Monday-Friday',
    escalation_phone: agentConfig.escalationPhone || '',
    voicemail_fallback: agentConfig.voicemailFallback ?? true,
    data_capture_fields: agentConfig.dataCaptureFields || ['name', 'phone', 'email', 'reason'],
    rules: agentConfig.rules || { autoBook: false, autoEscalate: true, captureAllLeads: true },
    is_active: true,
  }).select().single();

  if (agentErr || !agentRow) {
    return res.status(500).json({ error: { message: 'Failed to create AI agent.' } });
  }

  // Save FAQs
  const faqs = agentConfig.faqs || [];
  let insertedFaqs = [];
  if (faqs.length > 0) {
    const { data: faqData } = await db.from('faqs').insert(
      faqs.map(f => ({
        organization_id: orgId,
        voice_agent_id: agentRow.id,
        question: f.question,
        answer: f.answer,
      }))
    ).select();
    insertedFaqs = faqData || [];
  }

  // Set active agent
  await db.from('organizations').update({ active_voice_agent_id: agentRow.id }).eq('id', orgId);

  // Sync to Vapi
  if (process.env.VAPI_API_KEY) {
    try {
      const vapiAgent = await upsertVapiAssistant(agentRow, insertedFaqs);
      if (vapiAgent?.id) {
        await db.from('voice_agents').update({ vapi_assistant_id: vapiAgent.id }).eq('id', agentRow.id);
      }
    } catch (e) {
      console.warn('Vapi sync failed during onboarding:', e.message);
    }
  }

  // Create default chatbot with FAQs
  const chatbotFaqs = faqs.map(f => ({ question: f.question, answer: f.answer }));
  const { data: chatbotRow } = await db.from('chatbots').insert({
    organization_id: orgId,
    voice_agent_id: agentRow.id,
    name: `${profile.name || 'My'} Chat Assistant`,
    header_title: profile.name || 'Chat with us',
    welcome_message: `Hello! Welcome to ${profile.name || 'our business'}. How can I help you today?`,
    faqs: chatbotFaqs,
    suggested_prompts: ['What are your hours?', 'How do I book?', 'What services do you offer?'],
    is_active: true,
  }).select().single();

  if (chatbotRow) {
    const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');
    const widgetUrl = `${apiUrl}/chatbot-widget/${chatbotRow.id}`;
    const pos = chatbotRow.position || 'right';
    const opp = pos === 'left' ? 'right' : 'left';
    const embedScript = `<!-- Agently Chat Widget -->\n<iframe\n  id="agently-widget-${chatbotRow.id}"\n  src="${widgetUrl}"\n  style="position:fixed;bottom:20px;${pos}:20px;${opp}:auto;width:420px;height:700px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);border:none;background:transparent;z-index:2147483646;overflow:hidden;"\n  scrolling="no" frameborder="0" allow="microphone"\n  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"\n  title="Chat widget"\n></iframe>`;

    await db.from('chatbots').update({
      widget_script_url: widgetUrl,
      embed_script: embedScript,
    }).eq('id', chatbotRow.id);

    await db.from('organizations').update({ active_chatbot_id: chatbotRow.id }).eq('id', orgId);

    // Also scrape and save knowledge chunks if website provided
    if (profile.website && process.env.OPENAI_API_KEY) {
      scrapeAndSave(orgId, chatbotRow.id, profile.website).catch(e =>
        console.warn('Background scrape failed:', e.message)
      );
    }
  }

  const { data: updatedOrg } = await db.from('organizations').select('*').eq('id', orgId).single();
  res.json(updatedOrg);
}));

module.exports = router;
