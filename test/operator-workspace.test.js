"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {makeFakeSupabase}=require("./helpers/fake-supabase");
const {getOperatorScope,ownsLead,requireCalendar,requireSender}=require("../lib/operator-scope");
const {sendOnce}=require("../lib/operator-send");
const {candidates,runSweep}=require("../lib/agent-automations");
const seed=()=>({voice_agents:[{id:"a",organization_id:"o",name:"Clinic",calendar_integration_id:"c"}],agent_operator_settings:[{organization_id:"o",voice_agent_id:"a",email_integration_id:"e",allow_shared_leads:false}],calendar_integrations:[{id:"c",organization_id:"o",status:"connected",timezone:"Africa/Lagos"}],email_integrations:[{id:"e",organization_id:"o",status:"connected"}]});
test("operator scope never falls back to another business's calendar or sender",async()=>{
 const db=makeFakeSupabase(seed()),scope=await getOperatorScope(db,"o","a");
 assert.equal(ownsLead(scope,{voice_agent_id:"a"}),true);assert.equal(ownsLead(scope,{voice_agent_id:"other"}),false);assert.equal(ownsLead(scope,{voice_agent_id:null}),false);
 assert.equal((await requireCalendar(db,"o",scope)).id,"c");assert.equal((await requireSender(db,"o",scope)).id,"e");
 await assert.rejects(()=>requireCalendar(db,"o",{...scope,calendar_integration_id:null}),/Assign a calendar/);
 await assert.rejects(()=>requireSender(db,"o",{...scope,emailIntegrationId:"foreign"}),/connected again/);
 await assert.rejects(()=>getOperatorScope(db,"other","a"),/belonging/);
});
test("durable send claims prevent duplicate and concurrent delivery",async()=>{
 const db=makeFakeSupabase();let sends=0,finish;
 const pending=sendOnce(db,"o","k",{},async()=>{sends++;await new Promise(r=>finish=r);return {success:true,messageId:"m"};});
 await new Promise(r=>setImmediate(r));
 await assert.rejects(()=>sendOnce(db,"o","k",{},async()=>{sends++;}),/previous send/);
 finish();await pending;
 const replay=await sendOnce(db,"o","k",{},async()=>{sends++;});assert.equal(replay.messageId,"m");assert.equal(sends,1);
});
test("uncertain delivery blocks retry; a known rejection can be retried",async()=>{
 const db=makeFakeSupabase();let calls=0;
 await assert.rejects(()=>sendOnce(db,"o","uncertain",{},async()=>{calls++;throw new Error("socket closed");}));
 await assert.rejects(()=>sendOnce(db,"o","uncertain",{},async()=>{calls++;}),/previous send/);assert.equal(calls,1);
 await assert.rejects(()=>sendOnce(db,"o","cap",{},async()=>{throw Object.assign(new Error("cap"),{code:"daily_cap"});}));
 assert.equal((await sendOnce(db,"o","cap",{},async()=>({success:true}))).success,true);
});
test("reminder candidates use only the assigned calendar and exclude cancelled appointments",async()=>{
 const db=makeFakeSupabase({...seed(),appointments:[
  {id:"yes",organization_id:"o",integration_id:"c",starts_at:"2026-10-10T09:00:00.000Z",attendee_email:"a@example.test",status:"confirmed"},
  {id:"no",organization_id:"o",integration_id:"different",starts_at:"2026-10-10T09:00:00.000Z",status:"confirmed"},
  {id:"cancelled",organization_id:"o",integration_id:"c",starts_at:"2026-10-10T09:00:00.000Z",status:"cancelled"}]});
 const scope=await getOperatorScope(db,"o","a");
 const result=await candidates(db,{trigger_type:"appointment_reminder",organization_id:"o",config:{hoursBefore:24},created_at:"2026-10-09T00:00:00Z"},scope,await requireCalendar(db,"o",scope),new Date("2026-10-09T12:00:00Z"));
 assert.deepEqual(result.map(r=>r.appointmentId),["yes"]);assert.match(result[0].body,/Africa\/Lagos/);
});
test("review automations stage encrypted drafts once and never send on sweep",async()=>{
 const previous=process.env.CALENDAR_TOKEN_KEY;process.env.CALENDAR_TOKEN_KEY="c".repeat(64);
 try {
  const db=makeFakeSupabase({...seed(),agent_automations:[{id:"r",organization_id:"o",voice_agent_id:"a",user_id:"u",trigger_type:"booking_confirmation",status:"active",approval_mode:"review",config:{},created_at:"2026-10-09T00:00:00Z"}],appointments:[{id:"p",organization_id:"o",integration_id:"c",created_at:"2026-10-09T10:00:00.000Z",starts_at:"2026-10-10T10:00:00Z",status:"confirmed",attendee_email:"lead@example.test"}]});
  const now=new Date("2026-10-09T12:00:00Z");assert.equal((await runSweep(db,now)).prepared,1);assert.equal((await runSweep(db,now)).prepared,0);
  assert.equal(db._tables.agent_automation_runs[0].status,"review");assert.ok(!db._tables.agent_automation_runs[0].encrypted_payload.includes("lead@example.test"));
 }finally{if(previous===undefined)delete process.env.CALENDAR_TOKEN_KEY;else process.env.CALENDAR_TOKEN_KEY=previous;}
});
test("lead nurture prepares only due, scored, assigned leads and excludes booked work",async()=>{
 const db=makeFakeSupabase({...seed(),leads:[
  {id:"due",organization_id:"o",voice_agent_id:"a",name:"Ada",email:"ada@example.test",crm_stage:"qualified",ai_score:82,next_action:"Confirm the service package.",next_action_due_at:"2026-10-10T09:00:00Z"},
  {id:"other-agent",organization_id:"o",voice_agent_id:"b",email:"b@example.test",crm_stage:"qualified",ai_score:99,next_action:"Follow up.",next_action_due_at:"2026-10-09T09:00:00Z"},
  {id:"booked",organization_id:"o",voice_agent_id:"a",email:"booked@example.test",crm_stage:"appointment_set",ai_score:99,next_action:"Follow up.",next_action_due_at:"2026-10-09T09:00:00Z"},
  {id:"low",organization_id:"o",voice_agent_id:"a",email:"low@example.test",crm_stage:"contacted",ai_score:30,next_action:"Follow up.",next_action_due_at:"2026-10-09T09:00:00Z"}]});
 const scope=await getOperatorScope(db,"o","a");
 const result=await candidates(db,{trigger_type:"lead_nurture_follow_up",organization_id:"o",config:{minimumScore:50},created_at:"2026-10-08T00:00:00Z"},scope,{timezone:"UTC"},new Date("2026-10-10T12:00:00Z"));
 assert.deepEqual(result.map(item=>item.leadId),["due"]);assert.match(result[0].body,/Confirm the service package/);
});
