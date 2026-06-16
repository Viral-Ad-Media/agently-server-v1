"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  serializeAgent,
  serializeChatbot,
  serializeUser,
  serializeInvoice,
  serializeLead,
  serializeCall,
  serializeMessage,
  serializeOrganization,
} = require("../../lib/serializers");
const { buildDashboard, buildAgentStats } = require("../../lib/dashboard");
const {
  ensureDefaultKnowledgeBaseForOrg,
  listKnowledgeBasesForOrg,
  getAssignedKnowledgeBaseIdsForVoiceAgent,
} = require("../../lib/knowledge-bases");

const router = express.Router();

// ── GET /api/bootstrap ───────────────────────────────────────
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const orgId = req.orgId;

    // Run all queries in parallel
    const [
      agentsResult,
      chatbotsResult,
      membersResult,
      invoicesResult,
      leadsResult,
      callsResult,
      messagesResult,
    ] = await Promise.all([
      db
        .from("voice_agents")
        .select("*")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: true }),
      db
        .from("chatbots")
        .select("*")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: true }),
      db
        .from("users")
        .select("id, name, email, role, avatar")
        .eq("organization_id", orgId),
      db
        .from("invoices")
        .select("*")
        .eq("organization_id", orgId)
        .order("date", { ascending: false }),
      db
        .from("leads")
        .select("*")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false }),
      db
        .from("call_records")
        .select("*")
        .eq("organization_id", orgId)
        .order("timestamp", { ascending: false })
        .limit(100),
      db
        .from("chat_messages")
        .select("*")
        .eq("organization_id", orgId)
        .is("chatbot_id", null)
        .order("created_at", { ascending: true })
        .limit(100),
    ]);

    const org = req.organization;
    await ensureDefaultKnowledgeBaseForOrg(db, org);
    const knowledgeBases = await listKnowledgeBasesForOrg(db, orgId);

    // Fetch FAQs for each visible tenant agent. Platform beta-test agents are
    // internal utility agents and must not appear in the normal dashboard flow.
    const allAgentRows = agentsResult.data || [];
    const agentRows = allAgentRows.filter(
      (agent) => agent?.is_platform_test_agent !== true,
    );
    const agentsWithFaqs = await Promise.all(
      agentRows.map(async (agent) => {
        const knowledgeBaseIds = await getAssignedKnowledgeBaseIdsForVoiceAgent(
          db,
          {
            organizationId: orgId,
            agentId: agent.id,
            organization: org,
          },
        );
        let faqsQuery = db
          .from("faqs")
          .select("*")
          .eq("voice_agent_id", agent.id);
        if (knowledgeBaseIds.length) {
          faqsQuery = faqsQuery.in("knowledge_base_id", knowledgeBaseIds);
        }
        const { data: faqs } = await faqsQuery.order("created_at", {
          ascending: true,
        });
        const serialized = serializeAgent(agent, faqs || []);
        if (!serialized.knowledgeBaseId && knowledgeBaseIds.length) {
          serialized.knowledgeBaseId = knowledgeBaseIds[0];
        }
        return serialized;
      }),
    );

    const chatbots = (chatbotsResult.data || []).map(serializeChatbot);
    const members = (membersResult.data || []).map(serializeUser);
    const invoices = (invoicesResult.data || []).map(serializeInvoice);
    const leads = leadsResult.data || [];
    const calls = callsResult.data || [];
    const messages = messagesResult.data || [];

    // Build global dashboard
    const dashboard = buildDashboard(org, calls, leads, agentRows[0] || null);

    // Build per‑agent analytics (only if function exists, otherwise empty array)
    let agentStats = [];
    if (typeof buildAgentStats === "function") {
      agentStats = await buildAgentStats(db, orgId, agentRows, calls, leads);
    } else {
      console.warn(
        "[bootstrap] buildAgentStats not available, skipping agent stats",
      );
    }

    const serializedOrg = serializeOrganization(
      org,
      agentsWithFaqs,
      chatbots,
      members,
      invoices,
    );

    res.json({
      user: serializeUser(req.user),
      organization: serializedOrg,
      leads: leads.map(serializeLead),
      calls: calls.map(serializeCall),
      conversation: messages.map(serializeMessage),
      dashboard,
      agentStats,
      knowledgeBases,
    });
  }),
);

module.exports = router;
