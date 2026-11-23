"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { makeFakeSupabase } = require("./helpers/fake-supabase");

test("recording transcription survives an archive failure and preserves the human conversation", async () => {
  const supabase = require("../lib/supabase");
  const ledger = require("../lib/usage-ledger");
  const callSid='CA'+'1'.repeat(32),recordingSid='RE'+'1'.repeat(32),accountSid='AC'+'1'.repeat(32);
  const db = makeFakeSupabase({ call_records: [{ id:"rec", organization_id:"org", twilio_call_sid:callSid, transcript:[{role:"assistant",text:"Please hold"}], metadata:{} }] });
  db.storage = { from: () => ({ upload: async () => ({error:{message:"Bucket not found"}}) }) };
  const oldDb = supabase.getSupabase;
  const oldFetch = global.fetch;
  const oldLedger = ledger.logOpenAIUsage;
  const values = {API_URL:'https://api.example.test',TRANSCRIBE_CALL_RECORDINGS:"true",TRANSCRIPTION_PROVIDER:"openai",OPENAI_API_KEY:"test-key",TWILIO_ACCOUNT_SID:accountSid,TWILIO_AUTH_TOKEN:"test-token"};
  const previous = Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  Object.assign(process.env,values);
  let transcriptions = 0;
  global.fetch = async (url,options) => {
    if(String(url).startsWith("http://127.0.0.1:")) return oldFetch(url,options);
    assert.ok(String(url).startsWith('https://api.twilio.com/')||String(url).startsWith('https://api.openai.com/'));
    if(String(url).endsWith('.json')) return new Response(JSON.stringify({sid:recordingSid,call_sid:callSid,account_sid:accountSid,status:'completed'}));
    if(String(url).includes("audio/transcriptions")) {
      transcriptions++;
      assert.equal(options.body.get("response_format"),"diarized_json");
      return new Response(JSON.stringify({text:"I need help. Happy to help you.",segments:[{speaker:"A",start:0,end:1,text:"I need help."},{speaker:"B",start:1,end:2,text:"Happy to help you."}]}));
    }
    return new Response(Buffer.from("fake recording"),{headers:{"content-type":"audio/mpeg"}});
  };
  supabase.getSupabase = () => db;
  ledger.logOpenAIUsage = async () => {};
  delete require.cache[require.resolve("../api/routes/twilio")];
  const app = express(); app.use(express.urlencoded({extended:false})); app.use("/api/twilio", require("../api/routes/twilio"));
  const server = app.listen(0);
  try {
    const payload={AccountSid:accountSid,CallSid:callSid,RecordingSid:recordingSid,RecordingUrl:'https://untrusted.example/steal-credentials',RecordingStatus:'completed',RecordingSource:'DialVerb'};
    const post = () => oldFetch(`http://127.0.0.1:${server.address().port}/api/twilio/recording-status`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",'x-twilio-signature':require('../lib/twilio-request-auth').signatureFor(process.env.TWILIO_AUTH_TOKEN,'https://api.example.test/api/twilio/recording-status',payload)},body:new URLSearchParams(payload)});
    assert.equal((await post()).status,200);
    const {data:row} = await db.from("call_records").select("*").eq("id","rec").maybeSingle();
    assert.equal(row.recording_error,"Bucket not found");
    assert.equal(row.transcription_status,"completed");
    assert.equal(row.transcript.length,3);
    assert.equal(row.transcript[0].text,"Please hold");
    assert.equal(row.metadata.recordings[recordingSid].transcript.length,2);
    assert.equal((await post()).status,200);
    assert.equal(transcriptions,1);
  } finally {
    server.close(); supabase.getSupabase=oldDb; global.fetch=oldFetch; ledger.logOpenAIUsage=oldLedger;
    for(const [k,v] of Object.entries(previous)) { if(v === undefined) delete process.env[k]; else process.env[k]=v; }
    delete require.cache[require.resolve("../api/routes/twilio")];
  }
});
