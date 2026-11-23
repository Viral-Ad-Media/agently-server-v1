"use strict";
const router = require("express").Router();
const { asyncHandler } = require("../../middleware/error");
const { getSupabase } = require("../../lib/supabase");
const { getOperatorScope, scopeError } = require("../../lib/operator-scope");
const { decryptSecret } = require("../../lib/crypto");

router.get("/:agentId/access", asyncHandler(async (req, res) => {
  const db = getSupabase();
  const scope = await getOperatorScope(db, req.orgId, req.params.agentId);
  const [calendars, senders] = await Promise.all([
    db.from("calendar_integrations").select("id,label,timezone,status").eq("organization_id",req.orgId),
    db.from("email_integrations").select("id,label,provider_user_email,status").eq("organization_id",req.orgId),
  ]);
  if(calendars.error || senders.error) throw calendars.error || senders.error;
  res.json({scope, calendars:calendars.data || [],senders:senders.data || []});
}));
router.put("/:agentId/access", asyncHandler(async (req,res) => {
  const db = getSupabase();
  const scope = await getOperatorScope(db,req.orgId,req.params.agentId);
  const {calendarId,emailIntegrationId,allowSharedLeads} = req.body;
  for(const [table,id] of [["calendar_integrations",calendarId],["email_integrations",emailIntegrationId]]) {
    if(!id) continue;
    const {data,error} = await db.from(table).select("id,status").eq("organization_id",req.orgId).eq("id",id).maybeSingle();
    if(error) throw error;
    if(!data || data.status !== "connected") throw scopeError("Choose a connected account in this workspace.");
  }
  const settings = await db.from("agent_operator_settings").upsert({voice_agent_id:scope.id,organization_id:req.orgId,email_integration_id:emailIntegrationId || null,allow_shared_leads:allowSharedLeads === true,updated_at:new Date().toISOString()});
  if(settings.error) throw settings.error;
  const agent = await db.from("voice_agents").update({calendar_integration_id:calendarId || null}).eq("organization_id",req.orgId).eq("id",scope.id);
  if(agent.error) throw agent.error;
  res.json({success:true});
}));

router.get("/:agentId/knowledge", asyncHandler(async (req,res) => {
  const db = getSupabase();
  const scope = await getOperatorScope(db,req.orgId,req.params.agentId);
  if(!scope.knowledge_base_id) return res.json({sources:[],files:[],message:"No knowledge base is assigned. Attach one in Voice Agent settings.",salesConnected:false});
  const base = () => db.from("knowledge_bases").select("name,business_name,last_synced_at").eq("organization_id",req.orgId).eq("id",scope.knowledge_base_id).maybeSingle();
  const [kb,sources,files] = await Promise.all([base(),
    db.from("knowledge_sources").select("title,url,scrape_status,page_count,product_count").eq("organization_id",req.orgId).eq("knowledge_base_id",scope.knowledge_base_id),
    db.from("knowledge_source_files").select("filename,status,file_type").eq("organization_id",req.orgId).eq("knowledge_base_id",scope.knowledge_base_id)]);
  for(const result of [kb,sources,files]) if(result.error) throw result.error;
  res.json({knowledgeBase:kb.data,sources:sources.data || [],files:(files.data || []).filter(f=>f.status!=="deleted"),salesConnected:false,
    message:"Product knowledge describes the catalog. Sales rankings require sales records, which are not connected here."});
}));

router.get("/:agentId/actions", asyncHandler(async (req,res) => {
  const db = getSupabase();
  await getOperatorScope(db,req.orgId,req.params.agentId);
  const {data,error} = await db.from("owner_operator_actions").select("*").eq("organization_id",req.orgId).eq("user_id",req.user.id).eq("voice_agent_id",req.params.agentId).order("created_at",{ascending:false}).limit(50);
  if(error) throw error;
  res.json({actions:(data || []).map(row=> {
    let preview = {};
    try { preview=JSON.parse(decryptSecret(row.encrypted_payload,{organizationId:req.orgId,provider:"owner_operator_action",connectionId:row.id})).preview || {}; } catch (_) { /* Retain result without a stale preview. */ }
    return {id:row.id,type:row.action_type,...preview,summary:row.action_type === "send_emails" ? "Review prepared email recipients and content." : "Review the calendar change.",expiresAt:row.expires_at,state:row.status === "pending" && Date.parse(row.expires_at)<Date.now() ? "expired" : row.status,result:row.result};
  })});
}));

router.get("/:agentId/automations",asyncHandler(async(req,res)=>{
  const db=getSupabase();await getOperatorScope(db,req.orgId,req.params.agentId);
  const rules=await db.from("agent_automations").select("*").eq("organization_id",req.orgId).eq("voice_agent_id",req.params.agentId).order("created_at",{ascending:false});
  if(rules.error) throw rules.error;
  const runs=await db.from("agent_automation_runs").select("*").eq("organization_id",req.orgId).order("created_at",{ascending:false}).limit(100);
  if(runs.error) throw runs.error;
  const ids=new Set((rules.data || []).map(r=>r.id));
  res.json({rules:rules.data || [],runs:(runs.data || []).filter(r=>ids.has(r.automation_id)).map(row=>{
    let preview={};try{preview=JSON.parse(decryptSecret(row.encrypted_payload,require("../../lib/agent-automations").binding(row)));}catch(_){}
    return {id:row.id,automationId:row.automation_id,status:row.status,createdAt:row.created_at,result:row.result,preview};
  })});
}));
router.post("/:agentId/automations",asyncHandler(async(req,res)=>{
  const db=getSupabase(),scope=await getOperatorScope(db,req.orgId,req.params.agentId);
  const {TYPES}=require("../../lib/agent-automations");
  if(!TYPES.includes(req.body.trigger)) throw scopeError("Choose a supported automation trigger.");
  const automatic=req.body.approvalMode === "automatic";
  if(automatic && req.body.confirmAutomatic !== true) throw scopeError("Confirm that this rule may send future emails automatically.");
  const {requireCalendar,requireSender}=require("../../lib/operator-scope");
  if(req.body.trigger!=="lead_nurture_follow_up" && req.body.trigger!=="missed_call_follow_up") await requireCalendar(db,req.orgId,scope);
  await requireSender(db,req.orgId,scope);
  const config={hoursBefore:Math.min(168,Math.max(1,Number(req.body.hoursBefore)||24)),hour:Math.min(23,Math.max(0,Number(req.body.hour)||8)),minimumScore:Math.min(100,Math.max(0,Number(req.body.minimumScore)||50))};
  const result=await db.from("agent_automations").upsert({organization_id:req.orgId,voice_agent_id:scope.id,user_id:req.user.id,name:String(req.body.name || req.body.trigger).slice(0,100),trigger_type:req.body.trigger,approval_mode:automatic ? "automatic" : "review",status:"paused",config,updated_at:new Date().toISOString()},{onConflict:"voice_agent_id,trigger_type"}).select("id").single();
  if(result.error) throw result.error;
  res.json({success:true,id:result.data.id,message:"Saved paused. Review the rule, then activate it."});
}));
router.post("/:agentId/automations/:id/status",asyncHandler(async(req,res)=>{
  const db=getSupabase();await getOperatorScope(db,req.orgId,req.params.agentId);
  if(!["active","paused"].includes(req.body.status)) throw scopeError("Choose active or paused.");
  const {data:rule,error}=await db.from("agent_automations").select("*").eq("organization_id",req.orgId).eq("voice_agent_id",req.params.agentId).eq("id",req.params.id).maybeSingle();
  if(error) throw error;if(!rule) throw scopeError("Automation not found for this business.");
  const result=await db.from("agent_automations").update({status:req.body.status,config:{...rule.config,...(req.body.status==="active" ? {activeSince:new Date().toISOString()} : {})},updated_at:new Date().toISOString()}).eq("organization_id",req.orgId).eq("id",rule.id);
  if(result.error) throw result.error;
  res.json({success:true});
}));
router.post("/:agentId/runs/:id/:decision",asyncHandler(async(req,res)=>{
  if(!["approve","cancel","retry"].includes(req.params.decision)) throw scopeError("Unknown action.");
  const db=getSupabase();await getOperatorScope(db,req.orgId,req.params.agentId);
  const lookup=await db.from("agent_automation_runs").select("*").eq("organization_id",req.orgId).eq("id",req.params.id).maybeSingle();
  if(lookup.error)throw lookup.error;if(!lookup.data)throw scopeError("Review not found.");
  const {data:rule,error}=await db.from("agent_automations").select("*").eq("organization_id",req.orgId).eq("voice_agent_id",req.params.agentId).eq("id",lookup.data.automation_id).maybeSingle();
  if(error)throw error;if(!rule)throw scopeError("Switch to the business for this review.");
  const expected=req.params.decision==="retry" ? "failed" : "review";
  const claim=await db.from("agent_automation_runs").update({status:req.params.decision==="cancel" ? "cancelled" : "processing"}).eq("organization_id",req.orgId).eq("id",lookup.data.id).eq("status",expected).select("*").maybeSingle();
  if(claim.error)throw claim.error;if(!claim.data)throw scopeError("This action has already been handled or requires checking its delivery status.");
  res.json(req.params.decision==="cancel" ? {success:true} : await require("../../lib/agent-automations").executeRun(db,rule,claim.data));
}));
module.exports=router;
