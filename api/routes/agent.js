"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeAgent } = require("../../lib/serializers");
const { generateFaqsFromWebsite } = require("../../lib/openai");
const {
  getAssignedKnowledgeBaseIdsForVoiceAgent,
  verifyKnowledgeBase,
  findOrCreateKnowledgeSource,
} = require("../../lib/knowledge-bases");

const router = express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function requestedAgentId(req) {
  return String(
    req.body?.voiceAgentId ||
      req.body?.voice_agent_id ||
      req.query?.voiceAgentId ||
      req.query?.voice_agent_id ||
      "",
  ).trim();
}

async function resolveFaqAgentId(db, req) {
  const requested = requestedAgentId(req);
  if (requested) {
    if (!isUuid(requested)) return null;
    const { data: agent } = await db
      .from("voice_agents")
      .select("id")
      .eq("id", requested)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    return agent?.id || null;
  }
  return req.organization.active_voice_agent_id || null;
}

function requestedKnowledgeBaseId(req) {
  return String(
    req.body?.knowledgeBaseId ||
      req.body?.knowledge_base_id ||
      req.query?.knowledgeBaseId ||
      req.query?.knowledge_base_id ||
      "",
  ).trim();
}

async function resolveFaqKnowledgeBaseId(db, req, agentId) {
  const requested = requestedKnowledgeBaseId(req);
  if (requested) {
    if (!isUuid(requested)) return null;
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: requested,
    });
    return base?.id || null;
  }
  const ids = await getAssignedKnowledgeBaseIdsForVoiceAgent(db, {
    organizationId: req.orgId,
    agentId,
    organization: req.organization,
  });
  return ids[0] || null;
}

async function loadActiveAgent(db, org) {
  const agentId = org.active_voice_agent_id;
  if (!agentId) return null;

  const { data: agent } = await db
    .from("voice_agents")
    .select("*")
    .eq("id", agentId)
    .single();

  if (!agent) return null;

  const knowledgeBaseIds = await getAssignedKnowledgeBaseIdsForVoiceAgent(db, {
    organizationId: org.id,
    agentId,
    organization: org,
  });
  let faqsQuery = db.from("faqs").select("*").eq("organization_id", org.id);
  if (knowledgeBaseIds.length) {
    faqsQuery = faqsQuery
      .in("knowledge_base_id", knowledgeBaseIds)
      .or(`voice_agent_id.eq.${agentId},voice_agent_id.is.null`);
  } else {
    faqsQuery = faqsQuery
      .eq("voice_agent_id", agentId)
      .is("knowledge_base_id", null);
  }
  const { data: faqs } = await faqsQuery.order("created_at", {
    ascending: true,
  });

  return serializeAgent(agent, faqs || []);
}

router.patch(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const agentId = req.organization.active_voice_agent_id;

    if (!agentId) {
      return res
        .status(404)
        .json({ error: { message: "No active agent found." } });
    }

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.direction !== undefined) updates.direction = body.direction;
    if (body.voice !== undefined) updates.voice = body.voice;
    if (body.language !== undefined) updates.language = body.language;
    if (body.greeting !== undefined) updates.greeting = body.greeting;
    if (body.tone !== undefined) updates.tone = body.tone;
    if (body.businessHours !== undefined)
      updates.business_hours = body.businessHours;
    if (body.escalationPhone !== undefined)
      updates.escalation_phone = body.escalationPhone;
    if (body.voicemailFallback !== undefined)
      updates.voicemail_fallback = body.voicemailFallback;
    if (body.voicemailBehavior !== undefined)
      updates.voicemail_behavior = body.voicemailBehavior;
    if (body.voicemailMessage !== undefined)
      updates.voicemail_message = body.voicemailMessage || "";
    if (body.voicemailCallbackDelayMinutes !== undefined)
      updates.voicemail_callback_delay_minutes =
        Number(body.voicemailCallbackDelayMinutes) || 60;
    if (body.voicemailMaxRedialAttempts !== undefined)
      updates.voicemail_max_redial_attempts =
        Number(body.voicemailMaxRedialAttempts) || 1;
    if (body.voicemailSettings !== undefined)
      updates.voicemail_settings = body.voicemailSettings || {};
    if (body.callScreeningEnabled !== undefined)
      updates.call_screening_enabled = body.callScreeningEnabled !== false;
    if (body.callScreeningMessage !== undefined)
      updates.call_screening_message = body.callScreeningMessage || "";
    if (body.callScreeningSettings !== undefined)
      updates.call_screening_settings = body.callScreeningSettings || {};
    if (body.dataCaptureFields !== undefined)
      updates.data_capture_fields = body.dataCaptureFields;
    if (body.rules !== undefined) updates.rules = body.rules;
    if (body.webhookUrl !== undefined) updates.webhook_url = body.webhookUrl;
    if (body.escalationWorkingHoursStart !== undefined)
      updates.escalation_hours_start = body.escalationWorkingHoursStart;
    if (body.escalationWorkingHoursEnd !== undefined)
      updates.escalation_hours_end = body.escalationWorkingHoursEnd;
    updates.updated_at = new Date().toISOString();

    const { error } = await db
      .from("voice_agents")
      .update(updates)
      .eq("id", agentId)
      .eq("organization_id", req.orgId);

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to update agent." },
      });
    }

    const agent = await loadActiveAgent(db, req.organization);
    res.json(agent);
  }),
);

router.post(
  "/restart",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      message: "Agent configuration reloaded successfully.",
      restartedAt: new Date().toISOString(),
    });
  }),
);

router.post(
  "/faqs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { question, answer } = req.body || {};
    if (!question || !answer) {
      return res
        .status(400)
        .json({ error: { message: "Question and answer are required." } });
    }

    const db = getSupabase();
    const agentId = await resolveFaqAgentId(db, req);
    if (!agentId) {
      return res.status(404).json({
        error: {
          message: "Select a valid voice agent before creating FAQ entries.",
        },
      });
    }

    const knowledgeBaseId = await resolveFaqKnowledgeBaseId(db, req, agentId);
    if (requestedKnowledgeBaseId(req) && !knowledgeBaseId) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const insertPayload = {
      organization_id: req.orgId,
      voice_agent_id: agentId,
      question,
      answer,
      source_type: "manual",
    };
    if (knowledgeBaseId) insertPayload.knowledge_base_id = knowledgeBaseId;

    const { data: faq, error } = await db
      .from("faqs")
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: error.message || "Failed to create FAQ." } });
    }

    res
      .status(201)
      .json({ id: faq.id, question: faq.question, answer: faq.answer });
  }),
);

router.patch(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { question, answer } = req.body || {};
    const db = getSupabase();
    const agentId = await resolveFaqAgentId(db, req);
    if (requestedAgentId(req) && !agentId) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }
    const knowledgeBaseId = agentId
      ? await resolveFaqKnowledgeBaseId(db, req, agentId)
      : null;
    if (requestedKnowledgeBaseId(req) && !knowledgeBaseId) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (question !== undefined) updates.question = question;
    if (answer !== undefined) updates.answer = answer;

    let query = db
      .from("faqs")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId);
    if (agentId) query = query.eq("voice_agent_id", agentId);
    if (requestedKnowledgeBaseId(req) && knowledgeBaseId) {
      query = query.eq("knowledge_base_id", knowledgeBaseId);
    }

    const { data: faq, error } = await query.select().single();

    if (error || !faq) {
      return res.status(404).json({ error: { message: "FAQ not found." } });
    }

    res.json({ id: faq.id, question: faq.question, answer: faq.answer });
  }),
);

router.delete(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const agentId = await resolveFaqAgentId(db, req);
    if (requestedAgentId(req) && !agentId) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }
    const knowledgeBaseId = agentId
      ? await resolveFaqKnowledgeBaseId(db, req, agentId)
      : null;
    if (requestedKnowledgeBaseId(req) && !knowledgeBaseId) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    let query = db
      .from("faqs")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);
    if (agentId) query = query.eq("voice_agent_id", agentId);
    if (requestedKnowledgeBaseId(req) && knowledgeBaseId) {
      query = query.eq("knowledge_base_id", knowledgeBaseId);
    }
    await query;
    res.json({ success: true });
  }),
);

router.post(
  "/faqs/sync",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { website } = req.body || {};
    const db = getSupabase();
    const targetWebsite = website || req.organization.website;

    if (!targetWebsite) {
      return res
        .status(400)
        .json({ error: { message: "No website URL provided or configured." } });
    }

    const faqs = await generateFaqsFromWebsite(targetWebsite, {
      organizationId: req.orgId,
      userId: req.user?.id,
      metadata: { route: "agent.faqs.sync" },
    });
    const agentId = await resolveFaqAgentId(db, req);
    if (!agentId) {
      return res.status(404).json({
        error: { message: "Select a valid voice agent before syncing FAQs." },
      });
    }

    const knowledgeBaseId = await resolveFaqKnowledgeBaseId(db, req, agentId);
    if (requestedKnowledgeBaseId(req) && !knowledgeBaseId) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }
    const source = knowledgeBaseId
      ? await findOrCreateKnowledgeSource(db, {
          organizationId: req.orgId,
          knowledgeBaseId,
          url: targetWebsite,
          isPrimary: false,
        })
      : null;

    let deleteQuery = db
      .from("faqs")
      .delete()
      .eq("voice_agent_id", agentId)
      .eq("organization_id", req.orgId);
    if (knowledgeBaseId)
      deleteQuery = deleteQuery.eq("knowledge_base_id", knowledgeBaseId);
    await deleteQuery;

    if (faqs.length > 0) {
      await db.from("faqs").insert(
        faqs.map((faq) => {
          const row = {
            organization_id: req.orgId,
            voice_agent_id: agentId,
            question: faq.question,
            answer: faq.answer,
            source_type: "website_sync",
          };
          if (knowledgeBaseId) row.knowledge_base_id = knowledgeBaseId;
          if (source?.id) row.knowledge_source_id = source.id;
          return row;
        }),
      );
    }

    let updatedFaqsQuery = db
      .from("faqs")
      .select("*")
      .eq("organization_id", req.orgId)
      .eq("voice_agent_id", agentId);
    if (knowledgeBaseId) {
      updatedFaqsQuery = updatedFaqsQuery.eq(
        "knowledge_base_id",
        knowledgeBaseId,
      );
    }
    const { data: updatedFaqs } = await updatedFaqsQuery.order("created_at", {
      ascending: true,
    });

    res.json({
      website: targetWebsite,
      faqs: (updatedFaqs || []).map((faq) => ({
        id: faq.id,
        question: faq.question,
        answer: faq.answer,
      })),
    });
  }),
);

module.exports = router;
