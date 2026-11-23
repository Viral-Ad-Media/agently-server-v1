"use strict";

function scopeError(message) { const error = new Error(message); error.status = 409; error.code = "business_setup_required"; return error; }
async function getOperatorScope(db, organizationId, voiceAgentId) {
  const { data: agent, error } = await db.from("voice_agents")
    .select("id,name,knowledge_base_id,calendar_integration_id").eq("organization_id", organizationId)
    .eq("id", String(voiceAgentId || "")).maybeSingle();
  if (error) throw error;
  if (!agent) throw scopeError("Choose an agent belonging to this workspace.");
  const settings = await db.from("agent_operator_settings").select("email_integration_id,allow_shared_leads")
    .eq("organization_id", organizationId).eq("voice_agent_id", agent.id).maybeSingle();
  if (settings.error) throw settings.error;
  return { ...agent, emailIntegrationId: settings.data?.email_integration_id || null, allowSharedLeads: settings.data?.allow_shared_leads === true };
}
function ownsLead(scope, lead) { return Boolean(lead && (lead.voice_agent_id === scope.id || (!lead.voice_agent_id && scope.allowSharedLeads))); }
async function requireCalendar(db, organizationId, scope) {
  if (!scope.calendar_integration_id) throw scopeError("Assign a calendar to this agent in Business access before using calendar actions.");
  const { data, error } = await db.from("calendar_integrations").select("id,timezone,label,status")
    .eq("organization_id", organizationId).eq("id", scope.calendar_integration_id).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "connected") throw scopeError("This agent's calendar needs to be connected again.");
  return data;
}
async function requireSender(db, organizationId, scope) {
  if (!scope.emailIntegrationId) throw scopeError("Assign a Gmail sender to this agent in Business access before sending email.");
  const row = await require("./gmail-send").getEmailConnectionRow(db, organizationId, scope.emailIntegrationId);
  if (!row || row.status !== "connected") throw scopeError("This agent's Gmail sender needs to be connected again.");
  return row;
}
module.exports = { getOperatorScope, ownsLead, requireCalendar, requireSender, scopeError };
