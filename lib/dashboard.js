'use strict';

/**
 * Build the DashboardData object from raw DB rows.
 */
function buildDashboard(org, calls, leads, activeAgent) {
  const totalCalls = calls.length;
  const leadsCaptured = leads.length;
  const missedCalls = calls.filter(c => c.outcome === 'Voicemail' || c.outcome === 'Escalated').length;
  const totalDuration = calls.reduce((sum, c) => sum + (c.duration || 0), 0);
  const avgDurationMinutes = totalCalls > 0 ? (totalDuration / totalCalls) / 60 : 0;

  // Weekly flow - last 7 days
  const weeklyFlow = buildWeeklyFlow(calls, leads);

  // Outcome breakdown
  const outcomeCounts = {};
  calls.forEach(c => {
    const key = c.outcome || 'FAQ Answered';
    outcomeCounts[key] = (outcomeCounts[key] || 0) + 1;
  });

  const outcomeColors = {
    'Lead Captured': 'bg-emerald-500',
    'Appointment Booked': 'bg-indigo-500',
    'FAQ Answered': 'bg-blue-500',
    'Escalated': 'bg-amber-500',
    'Voicemail': 'bg-slate-400',
  };

  const outcomeBreakdown = Object.entries(outcomeCounts).map(([label, count]) => ({
    label,
    count: totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0,
    color: outcomeColors[label] || 'bg-slate-400',
  }));

  // Fill with zeros if empty
  if (outcomeBreakdown.length === 0) {
    outcomeBreakdown.push(
      { label: 'Lead Captured', count: 0, color: 'bg-emerald-500' },
      { label: 'FAQ Answered', count: 0, color: 'bg-blue-500' },
      { label: 'Escalated', count: 0, color: 'bg-amber-500' },
    );
  }

  return {
    stats: {
      totalCalls,
      leadsCaptured,
      missedCalls,
      avgDurationMinutes: Math.round(avgDurationMinutes * 10) / 10,
    },
    weeklyFlow,
    outcomeBreakdown,
    recentCalls: calls.slice(0, 5).map(serializeCallSimple),
    recentLeads: leads.slice(0, 5).map(serializeLeadSimple),
    usage: {
      calls: org.usage_calls || 0,
      minutes: org.usage_minutes || 0,
      callLimit: org.call_limit || 100,
      minuteLimit: org.minute_limit || 500,
    },
    agentStatus: {
      online: !!(activeAgent),
      agentName: activeAgent ? activeAgent.name : 'No agent configured',
      phoneNumber: activeAgent ? (activeAgent.twilio_phone_number || '') : '',
      direction: activeAgent ? (activeAgent.direction || 'inbound') : 'inbound',
    },
  };
}

function buildWeeklyFlow(calls, leads) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const result = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayName = days[d.getDay()];
    const dateStr = d.toISOString().split('T')[0];

    const dayCalls = calls.filter(c => {
      const callDate = new Date(c.timestamp || c.created_at).toISOString().split('T')[0];
      return callDate === dateStr;
    }).length;

    const dayLeads = leads.filter(l => {
      const leadDate = new Date(l.created_at).toISOString().split('T')[0];
      return leadDate === dateStr;
    }).length;

    result.push({ name: dayName, calls: dayCalls, leads: dayLeads });
  }

  return result;
}

function serializeCallSimple(row) {
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

function serializeLeadSimple(row) {
  return {
    id: row.id,
    name: row.name || 'Unknown',
    phone: row.phone || '',
    email: row.email || '',
    reason: row.reason || '',
    status: row.status || 'new',
    createdAt: row.created_at,
  };
}

module.exports = { buildDashboard };
