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
const { buildDashboard } = require("../../lib/dashboard");

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

    // Fetch FAQs for each agent
    const agentRows = agentsResult.data || [];
    const agentsWithFaqs = await Promise.all(
      agentRows.map(async (agent) => {
        const { data: faqs } = await db
          .from("faqs")
          .select("*")
          .eq("voice_agent_id", agent.id)
          .order("created_at", { ascending: true });
        return serializeAgent(agent, faqs || []);
      }),
    );

    const chatbots = (chatbotsResult.data || []).map(serializeChatbot);
    const members = (membersResult.data || []).map(serializeUser);
    const invoices = (invoicesResult.data || []).map(serializeInvoice);
    const leads = leadsResult.data || [];
    const calls = callsResult.data || [];
    const messages = messagesResult.data || [];

    // Find active agent for dashboard
    const activeAgentRow =
      agentRows.find((a) => a.id === org.active_voice_agent_id) ||
      agentRows[0] ||
      null;
    const dashboard = buildDashboard(org, calls, leads, activeAgentRow);

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
    });
  }),
);

module.exports = router;
