"use strict";

const { getOpenAI } = require("./openai-client");
const { getSupabase } = require("./supabase");
const { recordLeadActivity, temperatureFromScore } = require("./lead-crm-events");

function transcriptText(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((line) => `${line?.speaker || "Unknown"}: ${line?.text || ""}`)
    .join("\n")
    .trim();
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function cleanRules(value) {
  const rules = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    qualified_min_score: Math.round(clamp(rules.qualified_min_score, 0, 100, 80)),
    nurture_min_score: Math.round(clamp(rules.nurture_min_score, 0, 100, 50)),
    booking_criteria: String(rules.booking_criteria || "").trim().slice(0, 2000),
    disqualify_signals: (Array.isArray(rules.disqualify_signals) ? rules.disqualify_signals : [])
      .map((signal) => String(signal || "").trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 20),
  };
}

async function qualifyLeadFromCall({
  leadId,
  organizationId,
  voiceAgentId,
  transcript,
  db = getSupabase(),
  openai,
  callId,
  now = new Date(),
}) {
  const text = transcriptText(transcript);
  if (!leadId || !organizationId || !voiceAgentId || !text) return null;

  try {
    const [{ data: agent, error: agentError }, { data: lead, error: leadError }] = await Promise.all([
      db
        .from("voice_agents")
        .select("id,qualification_playbook,qualification_rules")
        .eq("id", voiceAgentId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
      db
        .from("leads")
        .select("id,crm_stage,voice_agent_id")
        .eq("id", leadId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
    ]);
    if (agentError || leadError || !agent || !lead || lead.voice_agent_id !== voiceAgentId) return null;
    if (callId) {
      const previous = await db.from("lead_activities").select("id").eq("organization_id",organizationId)
        .eq("lead_id",leadId).eq("call_id",callId).eq("activity_type","ai_qualification").limit(1);
      if (previous.error || previous.data?.length) return null;
    }

    const playbook = String(agent.qualification_playbook || "").trim().slice(0, 8000);
    if (!playbook) return null;
    const rules = cleanRules(agent.qualification_rules);

    const completion = await (openai || getOpenAI()).chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Assess a sales lead using only evidence stated in the call transcript.",
            `OWNER PLAYBOOK:\n${playbook}`,
            `RULES:\n${JSON.stringify(rules)}`,
            "A score is analysis only. Never claim an appointment was booked, never promote to appointment_set/won, and never invent budget, timing, identity, or intent.",
            "A possible disqualification must be flagged for owner review; it does not automatically mark the lead lost.",
            'Return only JSON: {"score":0-100,"confidence":0-1,"summary":"2-3 sentences","intent":"appointment_request|pricing_or_quote|urgent_service_need|human_callback_request|general_interest|not_interested|wrong_number","next_action":"concrete next step","next_action_days":0-30,"estimated_value_usd":0,"disqualified":false,"disqualify_reason":"","evidence":["short transcript-grounded fact"]}',
          ].join("\n\n"),
        },
        { role: "user", content: `CALL TRANSCRIPT:\n${text.slice(0, 15000)}` },
      ],
    });

    const raw = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    const score = Math.round(clamp(raw.score, 0, 100, 50));
    const confidence = clamp(raw.confidence, 0, 1, 0.5);
    const disqualified = raw.disqualified === true;
    const dueDays = Math.round(clamp(raw.next_action_days, 0, 30, 1));
    const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map((item) => String(item || "").trim().slice(0, 240))
      .filter(Boolean)
      .slice(0, 8);
    const summary = String(raw.summary || "").trim().slice(0, 2000) || null;
    const nextAction = String(raw.next_action || "").trim().slice(0, 500) || null;
    const intent = String(raw.intent || "general_interest").trim().slice(0, 80);
    const disqualifyReason = String(raw.disqualify_reason || "").trim().slice(0, 500);

    const updates = {
      ai_score: score,
      lead_temperature: temperatureFromScore(score),
      ai_summary: summary,
      ai_intent: intent,
      ai_confidence: confidence,
      next_action: nextAction,
      next_action_due_at: new Date(now.getTime() + dueDays * 86400000).toISOString(),
      last_activity_at: now.toISOString(),
      needs_human_review: disqualified || confidence < 0.55,
      human_review_reason: disqualified
        ? disqualifyReason || "Possible disqualification found; owner review required."
        : confidence < 0.55
          ? "Qualification confidence is low; owner review required."
          : null,
    };

    const valueUsd = clamp(raw.estimated_value_usd, 0, 21000000, 0);
    if (valueUsd > 0) updates.estimated_value_cents = Math.round(valueUsd * 100);

    const protectedStages = new Set(["appointment_set", "proposal_sent", "won", "lost"]);
    if (
      !disqualified &&
      !protectedStages.has(String(lead.crm_stage || "")) &&
      confidence >= 0.55 && score >= rules.qualified_min_score
    ) {
      updates.crm_stage = "qualified";
      updates.status = "contacted";
    }

    const { error: updateError } = await db
      .from("leads")
      .update(updates)
      .eq("id", leadId)
      .eq("organization_id", organizationId);
    if (updateError) throw updateError;

    await recordLeadActivity(db, {
      leadId,
      organizationId,
      activityType: "ai_qualification",
      title: `AI qualification: ${score}/100 (${temperatureFromScore(score)})`,
      body: summary,
      channel: "voice",
      provider: "openai",
      voiceAgentId,
      callId,
      metadata: {
        score,
        confidence,
        evidence,
        possible_disqualification: disqualified,
        review_required: updates.needs_human_review,
      },
      occurredAt: now.toISOString(),
    });

    return { score, confidence, evidence, ...updates };
  } catch (error) {
    console.warn("[lead-qualifier] qualification skipped:", error?.message || "unknown error");
    return null;
  }
}

module.exports = { cleanRules, qualifyLeadFromCall, transcriptText };
