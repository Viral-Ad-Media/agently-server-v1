"use strict";

const { getSupabase } = require("./supabase");
const { generateCallSummary } = require("./openai");
const { getOpenAI } = require("./openai-client");

function nowIso() { return new Date().toISOString(); }

async function createCallRecord({ organizationId, voiceAgentId, callerName, callerPhone, direction, status, twilioCallSid, leadId, metadata }) {
  const row = { organization_id: organizationId, voice_agent_id: voiceAgentId || null, caller_name: callerName || "Unknown Caller", caller_phone: callerPhone || "", duration: 0, outcome: status || "queued", summary: "", transcript: [], lead_id: leadId || null, timestamp: nowIso(), provider: "twilio", twilio_call_sid: twilioCallSid || "", direction: direction || "inbound", status: status || "queued", started_at: nowIso(), metadata: metadata || {} };
  const { data, error } = await getSupabase().from("call_records").insert(row).select().single();
  if (error) throw new Error(`createCallRecord failed: ${error.message}`);
  return data;
}

async function updateCallRecordById(id, patch) {
  if (!id) return null;
  const { data, error } = await getSupabase().from("call_records").update(patch).eq("id", id).select().maybeSingle();
  if (error) console.warn("[call-records] update by id failed:", error.message);
  return data || null;
}
async function updateCallRecordBySid(callSid, patch) {
  if (!callSid) return null;
  const { data, error } = await getSupabase().from("call_records").update(patch).eq("twilio_call_sid", callSid).select().maybeSingle();
  if (error) console.warn("[call-records] update by sid failed:", error.message);
  return data || null;
}
async function appendTranscript(callRecordId, line) {
  if (!callRecordId || !line?.text) return null;
  const db = getSupabase();
  const { data: existing } = await db.from("call_records").select("transcript").eq("id", callRecordId).maybeSingle();
  const transcript = Array.isArray(existing?.transcript) ? existing.transcript : [];
  transcript.push({ speaker: line.speaker || "Unknown", text: line.text, at: line.at || nowIso() });
  return updateCallRecordById(callRecordId, { transcript });
}

function transcriptText(transcript) {
  return (Array.isArray(transcript) ? transcript : []).map((l) => `${l.speaker || "Unknown"}: ${l.text || ""}`).join("\n");
}
async function extractCallFollowup({ record, summary }) {
  const text = transcriptText(record.transcript);
  if (!text.trim()) return {};
  try {
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Extract call CRM data. Return only JSON: {\"lead\":{\"name\":\"\",\"phone\":\"\",\"email\":\"\",\"reason\":\"\"},\"unanswered\": [{\"question\":\"\",\"bot_response\":\"\"}],\"needs_followup\": true|false}. If absent use empty strings/array." },
        { role: "user", content: `Caller phone: ${record.caller_phone || ""}\nSummary: ${summary || ""}\n\nTranscript:\n${text.slice(0, 12000)}` },
      ],
    });
    return JSON.parse(completion.choices[0]?.message?.content || "{}");
  } catch (e) {
    console.warn("[call-records] CRM extraction failed:", e.message);
    return {};
  }
}
async function createLeadFromCall(record, extracted) {
  const lead = extracted?.lead || {};
  const phone = String(lead.phone || record.caller_phone || "").trim();
  const email = String(lead.email || "").trim().toLowerCase();
  const reason = String(lead.reason || record.summary || "Voice call follow-up").slice(0, 1000);
  if (!record.organization_id || (!phone && !email && !extracted?.needs_followup)) return null;
  const db = getSupabase();
  const row = { organization_id: record.organization_id, voice_agent_id: record.voice_agent_id || null, name: String(lead.name || record.caller_name || "Unknown Caller").trim() || "Unknown Caller", phone, email, reason, status: "new", source: record.direction === "web" ? "web_voice" : "call", tags: ["voice-call", record.direction || "inbound"], assignment_context: `Created automatically from ${record.direction || "voice"} call ${record.twilio_call_sid || record.id}` };
  const { data, error } = await db.from("leads").insert(row).select().maybeSingle();
  if (error) { console.warn("[call-records] lead insert failed:", error.message); return null; }
  await updateCallRecordById(record.id, { lead_id: data.id });
  return data;
}
async function saveUnansweredFromCall(record, extracted) {
  const items = Array.isArray(extracted?.unanswered) ? extracted.unanswered : [];
  if (!record.organization_id || !items.length) return;
  const rows = items.filter((x) => x && x.question).slice(0, 5).map((x) => ({ organization_id: record.organization_id, chatbot_id: null, question: String(x.question).slice(0, 1000), bot_response: String(x.bot_response || "Captured from voice call; assistant could not fully answer.").slice(0, 2000), is_resolved: false }));
  if (rows.length) await getSupabase().from("unanswered_questions").insert(rows).then(null, () => {});
}

async function finalizeCallRecord({ callRecordId, callSid, durationSeconds, status = "completed", endReason = "completed" }) {
  const db = getSupabase();
  let query = db.from("call_records").select("*");
  if (callRecordId) query = query.eq("id", callRecordId); else query = query.eq("twilio_call_sid", callSid);
  const { data: record } = await query.maybeSingle();
  if (!record) return null;
  const transcript = Array.isArray(record.transcript) ? record.transcript : [];
  let summary = record.summary || "";
  if (!summary && transcript.length) {
    try { summary = await generateCallSummary(transcriptText(transcript), status); } catch (_) { summary = "Call completed."; }
  }
  const extracted = await extractCallFollowup({ record: { ...record, summary }, summary });
  if (!record.lead_id) await createLeadFromCall({ ...record, summary }, extracted);
  await saveUnansweredFromCall(record, extracted);
  const started = record.started_at ? new Date(record.started_at).getTime() : Date.now();
  const calculatedDuration = Math.max(0, Math.round((Date.now() - started) / 1000));
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : calculatedDuration;
  const updated = await updateCallRecordById(record.id, { status, outcome: status, duration, summary, ended_at: nowIso(), end_reason: endReason });
  if (record.organization_id) await finalizeUsage({ organizationId: record.organization_id, durationSeconds: duration });
  return updated;
}
async function finalizeUsage({ organizationId, durationSeconds }) {
  if (!organizationId) return;
  const db = getSupabase();
  const { data: org } = await db.from("organizations").select("usage_calls,usage_minutes").eq("id", organizationId).maybeSingle();
  if (!org) return;
  const minutes = Math.max(1, Math.ceil((durationSeconds || 0) / 60));
  await db.from("organizations").update({ usage_calls: (org.usage_calls || 0) + 1, usage_minutes: (org.usage_minutes || 0) + minutes }).eq("id", organizationId);
}
module.exports = { createCallRecord, updateCallRecordById, updateCallRecordBySid, appendTranscript, finalizeCallRecord, finalizeUsage };
