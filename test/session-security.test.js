"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
function load(name,dependencies,env={}) {
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib',name),'utf8'),{module,exports:module.exports,require:id=>dependencies[id]||require(id),process:{env},console,Date,Map,Buffer,Number,Promise,Set});
 return module.exports;
}
function authHarness(payload) {
 const state={valid:true,user:{id:'user',organization_id:'org',session_epoch:0,role:'owner'},row:{user_id:'user',organization_id:'org',last_seen_at:new Date().toISOString()}};
 const db={from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:table==='users'?state.user:{id:'org'}})};return q;}};
 const auth=load('auth.js',{'jsonwebtoken':{verify:()=>payload},'./supabase':{getSupabase:()=>db},'./auth-sessions':{loadSession:async()=>({valid:state.valid,session:state.row}),touchSession:async()=>{}}},{JWT_SECRET:'synthetic',NODE_ENV:'production'});
 return {auth,state};
}
test('general API rejects every non-session purpose and legacy token before database access',async()=>{
 for(const extra of [{purpose:'webcall'},{typ:'pending'},{typ:'session',purpose:'webcall'},{typ:'session',sid:null},{typ:'session',sev:undefined}]) {
  const {auth}=authHarness({userId:'user',orgId:'org',sid:'sid',sev:0,...extra});
  assert.equal(await auth.resolveSession('synthetic'),null);
 }
});
test('session row must belong to the signed user and organization',async()=>{
 const {auth,state}=authHarness({typ:'session',userId:'user',orgId:'org',sid:'sid',sev:0});
 state.row.user_id='other';assert.equal(await auth.resolveSession('synthetic'),null);
 state.row.user_id='user';state.row.organization_id='other';assert.equal(await auth.resolveSession('synthetic'),null);
});
test('revocation and epoch changes cannot be bypassed by a primed profile cache',async()=>{
 const {auth,state}=authHarness({typ:'session',userId:'user',orgId:'org',sid:'sid',sev:0});
 assert.ok(await auth.resolveSession('synthetic'));
 state.user.session_epoch=1;assert.equal(await auth.resolveSession('synthetic'),null);
 state.user.session_epoch=0;state.valid=false;assert.equal(await auth.resolveSession('synthetic'),null);
});
function sessionHarness() {
 const state={data:null,error:null};
 const db={rpc:async()=>state,from(){const q={select:()=>q,update:()=>q,eq:()=>q,is:()=>q,maybeSingle:async()=>state,then(resolve,reject){return Promise.resolve(state).then(resolve,reject)}};return q;}};
 return {state,sessions:load('auth-sessions.js',{'./supabase':{getSupabase:()=>db}})};
}
test('session defaults and environment overrides cannot exceed security ceilings',()=>{
 const {sessions}=sessionHarness();assert.equal(sessions.SESSION_POLICY.absoluteSeconds,28800);assert.equal(sessions.SESSION_POLICY.idleSeconds,1800);assert.equal(sessions.SESSION_POLICY.maxConcurrentSessions,3);
 const strict=load('auth-sessions.js',{'./supabase':{}},{AUTH_SESSION_ABSOLUTE_SECONDS:'9999999',AUTH_SESSION_IDLE_SECONDS:'9999999',AUTH_MAX_CONCURRENT_SESSIONS:'999'});
 assert.equal(strict.SESSION_POLICY.absoluteSeconds,28800);assert.equal(strict.SESSION_POLICY.idleSeconds,1800);assert.equal(strict.SESSION_POLICY.maxConcurrentSessions,3);
});
test('long-lived old rows, idle rows and invalid timestamps fail closed',async()=>{
 const {sessions,state}=sessionHarness();
 const row={user_id:'user',organization_id:'org',created_at:new Date(Date.now()-9*3600000).toISOString(),last_seen_at:new Date().toISOString(),absolute_expires_at:new Date(Date.now()+86400000).toISOString()};
 state.data=row;assert.equal((await sessions.loadSession('sid')).valid,false);
 row.created_at=new Date().toISOString();row.last_seen_at=new Date(Date.now()-1800001).toISOString();assert.equal((await sessions.loadSession('sid')).valid,false);
 row.last_seen_at='invalid';assert.equal((await sessions.loadSession('sid')).valid,false);
 row.last_seen_at=new Date().toISOString();assert.equal((await sessions.loadSession('sid')).valid,true);
});
test('failed logout and global revocation return a retryable error, never success',async()=>{
 const {sessions,state}=sessionHarness();state.error={code:'XX000'};
 await assert.rejects(sessions.revokeSession('sid','logout','user'),{status:503,code:'SESSION_STORAGE_UNAVAILABLE'});
 await assert.rejects(sessions.revokeAllSessionsForUser('user'),{status:503,code:'SESSION_STORAGE_UNAVAILABLE'});
 state.error=null;state.data=null;await assert.rejects(sessions.revokeAllSessionsForUser('user'),{status:503});
});
