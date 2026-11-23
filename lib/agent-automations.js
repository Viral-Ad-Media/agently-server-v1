"use strict";
const crypto = require("crypto");
const {getOperatorScope,requireCalendar,requireSender,ownsLead} = require("./operator-scope");
const {encryptSecret,decryptSecret} = require("./crypto");
const {sendOnce} = require("./operator-send");
const TYPES = ["booking_confirmation","appointment_reminder","missed_call_follow_up","lead_nurture_follow_up","daily_summary"];
const binding = row => ({organizationId:row.organization_id,provider:"agent_automation_run",connectionId:row.id});
const unwrap = result => {if(result.error) throw result.error; return result.data || [];};
function localParts(now,timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone || "UTC",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(now).map(p=>[p.type,p.value]));
}
function when(value,timezone) {return new Date(value).toLocaleString("en-US",{timeZone:timezone || "UTC",dateStyle:"full",timeStyle:"short"})+` (${timezone || "UTC"})`;}
async function candidates(db,rule,scope,calendar,now) {
  const since = new Date(Math.max(Date.parse(rule.config.activeSince || rule.created_at),now.getTime()-86400000)).toISOString();
  if(rule.trigger_type === "daily_summary") {
    const parts=localParts(now,calendar.timezone);
    if(Number(parts.hour)!==Number(rule.config.hour ?? 8)) return [];
    const date=`${parts.year}-${parts.month}-${parts.day}`;
    const range=require("../api/routes/owner-operator")._internals.localDateWindow(date,1,calendar.timezone);
    const [appointments,leads,calls,owner] = await Promise.all([
      db.from("appointments").select("attendee_name,starts_at,status").eq("organization_id",rule.organization_id).eq("integration_id",calendar.id).gte("starts_at",range.from.toISOString()).lt("starts_at",range.to.toISOString()),
      db.from("leads").select("id").eq("organization_id",rule.organization_id).eq("voice_agent_id",scope.id).gte("created_at",new Date(now.getTime()-86400000).toISOString()),
      db.from("call_records").select("id").eq("organization_id",rule.organization_id).eq("voice_agent_id",scope.id).gte("timestamp",new Date(now.getTime()-86400000).toISOString()),
      db.from("users").select("email").eq("id",rule.user_id).maybeSingle()]);
    const rows=unwrap(appointments).filter(a=>a.status!=="cancelled");
    const body=`${scope.name}: ${rows.length} appointments today.\n${rows.map(a=>`${a.attendee_name || "Guest"}: ${when(a.starts_at,calendar.timezone)}`).join("\n")}\n\nLast 24 hours: ${unwrap(leads).length} new assigned leads, ${unwrap(calls).length} calls.`;
    if(owner.error) throw owner.error;
    return [{key:date,to:owner.data?.email,subject:`${scope.name}: daily business summary`,body,ownerId:rule.user_id}];
  }
  if(rule.trigger_type === "missed_call_follow_up") {
    const rows=unwrap(await db.from("call_records").select("id,lead_id,status").eq("organization_id",rule.organization_id).eq("voice_agent_id",scope.id).gte("timestamp",since).limit(100));
    const results=[];
    for(const call of rows.filter(c=>["missed","no-answer","busy","failed"].includes(c.status))) {
      if(!call.lead_id) continue;
      const result=await db.from("leads").select("id,name,email,voice_agent_id").eq("organization_id",rule.organization_id).eq("id",call.lead_id).maybeSingle();
      if(result.error) throw result.error;
      if(ownsLead(scope,result.data)) results.push({key:call.id,leadId:result.data.id,to:result.data.email,subject:`Following up from ${scope.name}`,body:`Hello ${result.data.name || "there"},\n\nWe missed connecting with you. Please reply with a convenient time for us to reach you.\n\n${scope.name}`});
    }
    return results;
  }
  if(rule.trigger_type === "lead_nurture_follow_up") {
    const minimum=Math.min(100,Math.max(0,Number(rule.config.minimumScore) || 50));
    const rows=unwrap(await db.from("leads").select("id,name,email,voice_agent_id,crm_stage,ai_score,next_action,next_action_due_at")
      .eq("organization_id",rule.organization_id).eq("voice_agent_id",scope.id)
      .in("crm_stage",["new","contacted","qualified"])
      .gte("next_action_due_at",since).lte("next_action_due_at",now.toISOString()).limit(100));
    return rows.filter(lead=>ownsLead(scope,lead) && Number(lead.ai_score || 0)>=minimum && lead.next_action)
      .map(lead=>({key:`${lead.id}:${lead.next_action_due_at}`,leadId:lead.id,to:lead.email,
        subject:`Following up from ${scope.name}`,
        body:`Hello ${lead.name || "there"},\n\nI’m following up as promised. ${lead.next_action}\n\nReply to this email if you would like help with the next step.\n\n${scope.name}`}));
  }
  let query=db.from("appointments").select("id,attendee_name,attendee_email,starts_at,status").eq("organization_id",rule.organization_id).eq("integration_id",calendar.id);
  query=rule.trigger_type === "booking_confirmation" ? query.gte("created_at",since) : query.gte("starts_at",now.toISOString()).lte("starts_at",new Date(now.getTime()+Number(rule.config.hoursBefore || 24)*3600000).toISOString());
  return unwrap(await query.limit(100)).filter(a=>a.status!=="cancelled").map(a=>({key:`${a.id}:${a.starts_at}`,appointmentId:a.id,startsAt:a.starts_at,to:a.attendee_email,
    subject:rule.trigger_type === "appointment_reminder" ? "Appointment reminder" : "Appointment confirmation",
    body:`Hello ${a.attendee_name || "there"},\n\n${rule.trigger_type === "appointment_reminder" ? "This is a reminder of" : "This confirms"} your appointment on ${when(a.starts_at,calendar.timezone)}.\n\n${scope.name}`}));
}
async function deliverRun(db,rule,row) {
  const payload=JSON.parse(decryptSecret(row.encrypted_payload,binding(row)));
  const scope=await getOperatorScope(db,rule.organization_id,rule.voice_agent_id);
  const sender=await requireSender(db,rule.organization_id,scope);
  if(payload.connectionId!==sender.id) throw new Error("The assigned sender changed. Cancel this draft and create a new automation run.");
  let currentEmail;
  if(payload.appointmentId) {
    const calendar=await requireCalendar(db,rule.organization_id,scope);
    const result=await db.from("appointments").select("attendee_email,integration_id,status,starts_at").eq("organization_id",rule.organization_id).eq("id",payload.appointmentId).maybeSingle();
    if(result.error) throw result.error;
    if(result.data?.integration_id===calendar.id && result.data.status!=="cancelled" && Date.parse(payload.startsAt)===Date.parse(result.data.starts_at)) currentEmail=result.data.attendee_email;
  } else if(payload.leadId) {
    const result=await db.from("leads").select("email,voice_agent_id").eq("organization_id",rule.organization_id).eq("id",payload.leadId).maybeSingle();
    if(result.error) throw result.error;
    if(ownsLead(scope,result.data)) currentEmail=result.data.email;
  } else if(payload.ownerId===rule.user_id) {
    const result=await db.from("users").select("email").eq("id",rule.user_id).maybeSingle();
    if(result.error) throw result.error;
    currentEmail=result.data?.email;
  }
  if(!currentEmail || currentEmail.toLowerCase()!==payload.to.toLowerCase()) throw new Error("The recipient or appointment changed. This draft was not sent.");
  return sendOnce(db,rule.organization_id,`automation:${row.id}`,{...payload,voiceAgentId:scope.id,userId:rule.user_id,purpose:"custom"});
}
async function executeRun(db,rule,row) {
  try {
    const result=await deliverRun(db,rule,row);
    const saved=await db.from("agent_automation_runs").update({status:"completed",result,completed_at:new Date().toISOString()}).eq("id",row.id).eq("organization_id",rule.organization_id);
    if(saved.error) throw saved.error;
    return {success:true,...result};
  } catch(error) {
    const uncertain=error.code==="delivery_uncertain";
    await db.from("agent_automation_runs").update({status:uncertain ? "uncertain" : "failed",result:{message:error.message},completed_at:new Date().toISOString()}).eq("id",row.id).eq("organization_id",rule.organization_id);
    return {success:false,uncertain,message:error.message};
  }
}
async function runSweep(db,now=new Date()) {
  const rules=unwrap(await db.from("agent_automations").select("*").eq("status","active").limit(500));
  let prepared=0;
  for(const rule of rules) {
    try {
      const scope=await getOperatorScope(db,rule.organization_id,rule.voice_agent_id);
      const sender=await requireSender(db,rule.organization_id,scope);
      const calendar=rule.trigger_type === "lead_nurture_follow_up" || rule.trigger_type === "missed_call_follow_up"
        ? {timezone:"UTC"} : await requireCalendar(db,rule.organization_id,scope);
      const events=await candidates(db,rule,scope,calendar,now);
      for(const event of events) {
        if(!require("./gmail-send")._internals.isValidEmail(event.to || "")) continue;
        const row={id:crypto.randomUUID(),automation_id:rule.id,organization_id:rule.organization_id,event_key:event.key,status:rule.approval_mode==="automatic" ? "processing" : "review"};
        row.encrypted_payload=encryptSecret(JSON.stringify({...event,connectionId:sender.id,from:sender.provider_user_email}),binding(row));
        const inserted=await db.from("agent_automation_runs").insert(row);
        if(inserted.error?.code==="23505") continue;
        if(inserted.error) throw inserted.error;
        prepared++;
        if(rule.approval_mode==="automatic") await executeRun(db,rule,row);
      }
    } catch(error) { console.warn("[agent-automations] rule failed",rule.id,error.code || "configuration_or_provider_error"); }
  }
  return {prepared};
}
function startScheduler(db) {
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await runSweep(db);}catch(error){console.warn("[agent-automations] sweep unavailable",error.code || "error");}finally{running=false;}};
  const timer=setInterval(tick,60000);timer.unref();void tick();return ()=>clearInterval(timer);
}
module.exports={TYPES,binding,candidates,runSweep,executeRun,startScheduler};
