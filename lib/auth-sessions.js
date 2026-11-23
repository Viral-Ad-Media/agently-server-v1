"use strict";
const { getSupabase } = require("./supabase");
function clamp(raw, fallback, min, max) {
 const value=Number(raw);
 return Number.isFinite(value)&&value>0?Math.min(Math.max(value,min),max):fallback;
}
// Business-app ceiling: 30 minutes idle, eight hours absolute, three sessions.
const SESSION_POLICY={
 absoluteSeconds:clamp(process.env.AUTH_SESSION_ABSOLUTE_SECONDS,28800,300,28800),
 idleSeconds:clamp(process.env.AUTH_SESSION_IDLE_SECONDS,1800,60,1800),
 touchIntervalSeconds:clamp(process.env.AUTH_SESSION_TOUCH_INTERVAL_SECONDS,60,10,60),
 maxConcurrentSessions:clamp(process.env.AUTH_MAX_CONCURRENT_SESSIONS,3,1,3),
};
function checked(result) {
 if(result?.error) {
  const error=new Error("Session security could not be saved. Please retry.");
  error.status=result.error.code==='42501'?401:503;
  error.code=error.status===401?'AUTH_SESSION_INVALID':'SESSION_STORAGE_UNAVAILABLE';
  error.cause=result.error;
  throw error;
 }
 return result?.data;
}
async function createSession({userId,organizationId,expectedEpoch=0,client="web",requestIp=null,userAgent=null}) {
 const data=checked(await getSupabase().rpc('auth_create_session',{
  p_user_id:userId,p_organization_id:organizationId,p_expected_epoch:expectedEpoch,
  p_client:String(client).slice(0,40),p_request_ip:requestIp,p_user_agent:userAgent,
  p_absolute_seconds:SESSION_POLICY.absoluteSeconds,p_idle_seconds:SESSION_POLICY.idleSeconds,p_max_sessions:SESSION_POLICY.maxConcurrentSessions,
 }));
 const row=Array.isArray(data)?data[0]:data;
 if(!row?.id||!row.absolute_expires_at) throw Object.assign(new Error('Session could not be established. Please retry.'),{status:503,code:'SESSION_STORAGE_UNAVAILABLE'});
 return {sessionId:row.id,absoluteExpiresAt:row.absolute_expires_at,createdAt:row.created_at,sessionEpoch:row.session_epoch};
}
async function loadSession(sessionId) {
 if(!sessionId) return {valid:false,reason:'not_found'};
 const result=await getSupabase().from('auth_sessions').select('id,user_id,organization_id,created_at,last_seen_at,absolute_expires_at,revoked_at,revoked_reason').eq('id',sessionId).maybeSingle();
 if(result.error) throw result.error;
 const session=result.data;
 if(!session) return {valid:false,reason:'not_found'};
 if(session.revoked_at) return {valid:false,reason:'revoked',session};
 const now=Date.now(),created=Date.parse(session.created_at),last=Date.parse(session.last_seen_at),expires=Date.parse(session.absolute_expires_at);
 if(![created,last,expires].every(Number.isFinite)||created>now+60000||last>now+60000||expires<=now||created+SESSION_POLICY.absoluteSeconds*1000<=now) return {valid:false,reason:'expired',session};
 if(now-last>=SESSION_POLICY.idleSeconds*1000) return {valid:false,reason:'idle',session};
 return {valid:true,session};
}
async function touchSession(sessionId,lastSeenAt) {
 if(Date.now()-Date.parse(lastSeenAt||0)<SESSION_POLICY.touchIntervalSeconds*1000) return false;
 checked(await getSupabase().from('auth_sessions').update({last_seen_at:new Date().toISOString()}).eq('id',sessionId).is('revoked_at',null));
 return true;
}
async function revokeSession(sessionId,reason='logout',userId=null) {
 if(!sessionId) throw Object.assign(new Error('Session not found.'),{status:401});
 let query=getSupabase().from('auth_sessions').update({revoked_at:new Date().toISOString(),revoked_reason:reason}).eq('id',sessionId);
 if(userId) query=query.eq('user_id',userId);
 const rows=checked(await query.select('id'));
 if(!Array.isArray(rows)||rows.length!==1) throw Object.assign(new Error('Session not found.'),{status:404});
}
async function revokeAllSessionsForUser(userId,reason='password_changed') {
 if(!userId) throw Object.assign(new Error('Account not found.'),{status:401});
 const epoch=checked(await getSupabase().rpc('auth_revoke_user_sessions',{p_user_id:userId,p_reason:reason}));
 if(!Number.isInteger(epoch)||epoch<1) throw Object.assign(new Error('Session revocation could not be confirmed.'),{status:503,code:'SESSION_STORAGE_UNAVAILABLE'});
}
async function listSessionsForUser(userId) {
 return checked(await getSupabase().from('auth_sessions').select('id,client,user_agent,request_ip,created_at,last_seen_at,absolute_expires_at').eq('user_id',userId).is('revoked_at',null).gt('absolute_expires_at',new Date().toISOString()).gt('last_seen_at',new Date(Date.now()-SESSION_POLICY.idleSeconds*1000).toISOString()).order('created_at',{ascending:false}))||[];
}
async function purgeDeadSessions(graceDays=7) {
 checked(await getSupabase().from('auth_sessions').delete().lt('absolute_expires_at',new Date(Date.now()-Math.max(1,graceDays)*86400000).toISOString()));
}
module.exports={SESSION_POLICY,createSession,loadSession,touchSession,revokeSession,revokeAllSessionsForUser,listSessionsForUser,purgeDeadSessions};

