"use strict";

/**
 * Build the DashboardData object from raw DB rows.
 * leads array now has a source field — 'chatbot' leads come from the chat widget,
 * 'call' leads come from voice calls, 'manual' / 'csv_import' from CRM.
 */
function buildDashboard(org, calls, leads, activeAgent) {
  const totalCalls = calls.length;

  // Break leads down by source so the dashboard can show chatbot vs voice capture
  const chatbotLeads = leads.filter((l) => l.source === "chatbot");
  const callLeads = leads.filter(
    (l) => l.source === "call" || l.source === "voice",
  );
  const manualLeads = leads.filter(
    (l) => !l.source || l.source === "manual" || l.source === "csv_import",
  );

  const leadsCaptured = leads.length;
  const chatbotLeadsCaptured = chatbotLeads.length;
  const callLeadsCaptured = callLeads.length;

  const missedCalls = calls.filter(
    (c) => c.outcome === "Voicemail" || c.outcome === "Escalated",
  ).length;
  const totalDuration = calls.reduce((sum, c) => sum + (c.duration || 0), 0);
  const avgDurationMinutes =
    totalCalls > 0 ? totalDuration / totalCalls / 60 : 0;

  // Weekly flow - last 7 days (now split by source)
  const weeklyFlow = buildWeeklyFlow(calls, leads);

  // Chatbot-specific weekly flow (last 7 days)
  const chatbotWeeklyFlow = buildWeeklyLeadsFlow(chatbotLeads);

  // Outcome breakdown for voice calls
  const outcomeCounts = {};
  calls.forEach((c) => {
    const key = c.outcome || "FAQ Answered";
    outcomeCounts[key] = (outcomeCounts[key] || 0) + 1;
  });

  const outcomeColors = {
    "Lead Captured": "bg-emerald-500",
    "Appointment Booked": "bg-indigo-500",
    "FAQ Answered": "bg-blue-500",
    Escalated: "bg-amber-500",
    Voicemail: "bg-slate-400",
  };

  const outcomeBreakdown = Object.entries(outcomeCounts).map(
    ([label, count]) => ({
      label,
      count: totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0,
      color: outcomeColors[label] || "bg-slate-400",
    }),
  );

  if (outcomeBreakdown.length === 0) {
    outcomeBreakdown.push(
      { label: "Lead Captured", count: 0, color: "bg-emerald-500" },
      { label: "FAQ Answered", count: 0, color: "bg-blue-500" },
      { label: "Escalated", count: 0, color: "bg-amber-500" },
    );
  }

  return {
    stats: {
      totalCalls,
      leadsCaptured,
      chatbotLeadsCaptured,
      callLeadsCaptured,
      missedCalls,
      avgDurationMinutes: Math.round(avgDurationMinutes * 10) / 10,
    },
    weeklyFlow,
    chatbotWeeklyFlow,
    outcomeBreakdown,
    recentCalls: calls.slice(0, 5).map(serializeCallSimple),
    recentLeads: leads.slice(0, 5).map(serializeLeadSimple),
    recentChatbotLeads: chatbotLeads.slice(0, 5).map(serializeLeadSimple),
    usage: {
      calls: org.usage_calls || 0,
      minutes: org.usage_minutes || 0,
      callLimit: org.call_limit || 100,
      minuteLimit: org.minute_limit || 500,
    },
    agentStatus: {
      online: !!activeAgent,
      agentName: activeAgent ? activeAgent.name : "No agent configured",
      phoneNumber: activeAgent ? activeAgent.twilio_phone_number || "" : "",
      direction: activeAgent ? activeAgent.direction || "inbound" : "inbound",
    },
  };
}

function buildWeeklyFlow(calls, leads) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const result = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayName = days[d.getDay()];
    const dateStr = d.toISOString().split("T")[0];

    const dayCalls = calls.filter((c) => {
      const callDate = new Date(c.timestamp || c.created_at)
        .toISOString()
        .split("T")[0];
      return callDate === dateStr;
    }).length;

    const dayLeads = leads.filter((l) => {
      const leadDate = new Date(l.created_at).toISOString().split("T")[0];
      return leadDate === dateStr;
    }).length;

    result.push({ name: dayName, calls: dayCalls, leads: dayLeads });
  }

  return result;
}

// Chat-widget leads by day (last 7 days) — used for the chatbot leads mini-chart
function buildWeeklyLeadsFlow(leads) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayName = days[d.getDay()];
    const dateStr = d.toISOString().split("T")[0];
    const count = leads.filter((l) => {
      return new Date(l.created_at).toISOString().split("T")[0] === dateStr;
    }).length;
    result.push({ name: dayName, leads: count });
  }
  return result;
}

function serializeCallSimple(row) {
  return {
    id: row.id,
    callerName: row.caller_name || "Unknown Caller",
    callerPhone: row.caller_phone || "",
    duration: row.duration || 0,
    timestamp: row.timestamp || row.created_at,
    outcome: row.outcome || "FAQ Answered",
    summary: row.summary || "",
    transcript: row.transcript || [],
  };
}

function serializeLeadSimple(row) {
  return {
    id: row.id,
    name: row.name || "Unknown",
    phone: row.phone || "",
    email: row.email || "",
    reason: row.reason || "",
    status: row.status || "new",
    createdAt: row.created_at,
  };
}

/**
 * Build per‑agent analytics.
 * Returns an array of objects, one per agent, containing:
 *   agentId, agentName, totalCalls, leadsCaptured, missedCalls,
 *   avgDurationMinutes, weeklyFlow, outcomeBreakdown.
 */
async function buildAgentStats(db, orgId, agentRows, calls, leads) {
  if (!agentRows || agentRows.length === 0) return [];

  // Group calls and leads by agentId
  const callsByAgent = new Map();
  const leadsByAgent = new Map();

  // Initialize maps
  for (const agent of agentRows) {
    callsByAgent.set(agent.id, []);
    leadsByAgent.set(agent.id, []);
  }

  // Distribute calls (assuming call_records has voice_agent_id)
  for (const call of calls) {
    const agentId = call.voice_agent_id;
    if (agentId && callsByAgent.has(agentId)) {
      callsByAgent.get(agentId).push(call);
    }
  }

  // Distribute leads (assuming leads have voice_agent_id – optional)
  for (const lead of leads) {
    const agentId = lead.voice_agent_id;
    if (agentId && leadsByAgent.has(agentId)) {
      leadsByAgent.get(agentId).push(lead);
    }
  }

  const agentStats = [];

  for (const agent of agentRows) {
    const agentCalls = callsByAgent.get(agent.id) || [];
    const agentLeads = leadsByAgent.get(agent.id) || [];

    const totalCalls = agentCalls.length;
    const leadsCaptured = agentLeads.length;
    const missedCalls = agentCalls.filter(
      (c) => c.outcome === "Voicemail" || c.outcome === "Escalated",
    ).length;
    const totalDuration = agentCalls.reduce(
      (sum, c) => sum + (c.duration || 0),
      0,
    );
    const avgDurationMinutes =
      totalCalls > 0 ? totalDuration / totalCalls / 60 : 0;

    // Weekly flow (last 7 days) for this agent
    const weeklyFlow = buildWeeklyFlow(agentCalls, agentLeads);

    // Outcome breakdown
    const outcomeCounts = {};
    agentCalls.forEach((c) => {
      const key = c.outcome || "FAQ Answered";
      outcomeCounts[key] = (outcomeCounts[key] || 0) + 1;
    });
    const outcomeColors = {
      "Lead Captured": "bg-emerald-500",
      "Appointment Booked": "bg-indigo-500",
      "FAQ Answered": "bg-blue-500",
      Escalated: "bg-amber-500",
      Voicemail: "bg-slate-400",
    };
    const outcomeBreakdown = Object.entries(outcomeCounts).map(
      ([label, count]) => ({
        label,
        count: totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0,
        color: outcomeColors[label] || "bg-slate-400",
      }),
    );
    if (outcomeBreakdown.length === 0) {
      outcomeBreakdown.push(
        { label: "Lead Captured", count: 0, color: "bg-emerald-500" },
        { label: "FAQ Answered", count: 0, color: "bg-blue-500" },
        { label: "Escalated", count: 0, color: "bg-amber-500" },
      );
    }

    agentStats.push({
      agentId: agent.id,
      agentName: agent.name,
      totalCalls,
      leadsCaptured,
      missedCalls,
      avgDurationMinutes: Math.round(avgDurationMinutes * 10) / 10,
      weeklyFlow,
      outcomeBreakdown,
    });
  }

  return agentStats;
}

module.exports = { buildDashboard, buildAgentStats };
