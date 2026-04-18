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

// Try to import buildAgentStats, but provide a fallback if not available
let buildAgentStats;
try {
  const dashboardLib = require("../../lib/dashboard");
  buildAgentStats = dashboardLib.buildAgentStats;
} catch (err) {
  console.warn(
    "[bootstrap] buildAgentStats not available, using empty stats:",
    err.message,
  );
  buildAgentStats = async () => [];
}

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

    // Build global dashboard (using a simple inline function if dashboard module missing)
    let dashboard;
    try {
      const { buildDashboard } = require("../../lib/dashboard");
      dashboard = buildDashboard(org, calls, leads, agentRows[0] || null);
    } catch (err) {
      console.warn("[bootstrap] buildDashboard fallback:", err.message);
      // Minimal dashboard fallback
      dashboard = {
        stats: {
          totalCalls: calls.length,
          leadsCaptured: leads.length,
          missedCalls: 0,
          avgDurationMinutes: 0,
        },
        weeklyFlow: [],
        outcomeBreakdown: [],
        recentCalls: calls.slice(0, 5).map(serializeCall),
        recentLeads: leads.slice(0, 5).map(serializeLead),
        usage: {
          calls: org.usage_calls || 0,
          minutes: org.usage_minutes || 0,
          callLimit: org.call_limit || 100,
          minuteLimit: org.minute_limit || 500,
        },
        agentStatus: {
          online: !!agentRows[0],
          agentName: agentRows[0]?.name || "No agent",
          phoneNumber: agentRows[0]?.twilio_phone_number || "",
          direction: agentRows[0]?.direction || "inbound",
        },
      };
    }

    // Build per‑agent stats (safe fallback)
    let agentStats = [];
    try {
      agentStats = await buildAgentStats(db, orgId, agentRows, calls, leads);
    } catch (err) {
      console.error("[bootstrap] buildAgentStats error:", err.message);
      agentStats = [];
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
    });
  }),
);

module.exports = router;
