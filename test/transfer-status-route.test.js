"use strict";
/*
 * POST /api/twilio/transfer-status over real HTTP: Twilio's <Dial action>
 * callback after the call server redirects a live call to a person.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { makeFakeSupabase } = require("./helpers/fake-supabase");

const CALL_SID = `CA${"1".repeat(32)}`;

async function withServer(fn) {
  const supabaseModule = require("../lib/supabase");
  const db = makeFakeSupabase({
    voice_agents: [{
      id: "agent-1",
      organization_id: "org-1",
      name: "Timi",
      escalation_phone: "(254) 268-8827",
      rules: { transferAttempts: 2 },
      direction: "outbound",
    }],
    organizations: [{ id: "org-1", name: "Viral-Ad Media", timezone: "America/Chicago" }],
    call_records: [{
      id: "rec-1",
      organization_id: "org-1",
      twilio_call_sid: CALL_SID,
      metadata: { human_transfer: { redirected: true, destination: "+12542688827" } },
    }],
  });
  const originalGet = supabaseModule.getSupabase;
  const prev = Object.fromEntries(['API_URL','TWILIO_WS_URL','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN'].map(k=>[k,process.env[k]]));
  process.env.TWILIO_ACCOUNT_SID='AC'+'1'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN='synthetic-test-secret';
  supabaseModule.getSupabase = () => db;
  process.env.API_URL = "https://api.example.test";
  process.env.TWILIO_WS_URL = "wss://calls.example.test";
  delete require.cache[require.resolve("../api/routes/twilio")];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/twilio", require("../api/routes/twilio"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).send(err.message));
  const server = app.listen(0);
  const post = async (query, body) => {
    const qs = new URLSearchParams({
      max: "2", orgId: "org-1", agentId: "agent-1", callRecordId: "rec-1",
      direction: "outbound", recipientName: "Rabiu", ...query,
    });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/twilio/transfer-status?${qs}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded",'x-twilio-signature':require('../lib/twilio-request-auth').signatureFor(process.env.TWILIO_AUTH_TOKEN,`https://api.example.test/api/twilio/transfer-status?${qs}`,{CallSid:CALL_SID,...body}) },
      body: new URLSearchParams({ CallSid: CALL_SID, ...body }).toString(),
    });
    return { status: r.status, text: await r.text() };
  };
  try {
    await fn(post, db);
  } finally {
    server.close();
    supabaseModule.getSupabase = originalGet;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve("../api/routes/twilio")];
  }
}

test("unanswered first attempt rings the number again with attempt=2", async () => {
  await withServer(async (post) => {
    const r = await post({ attempt: "1" }, { DialCallStatus: "no-answer" });
    assert.equal(r.status, 200);
    assert.match(r.text, /<Say>I'm still trying to reach someone for you\. Please hold\.<\/Say>/);
    // The retry also briefs the manager before connecting.
    assert.match(r.text, /<Number url="https:\/\/api\.example\.test\/api\/twilio\/transfer-whisper[^"]*" method="POST">\+12542688827<\/Number>/);
    assert.match(r.text, /action="https:\/\/api\.example\.test\/api\/twilio\/transfer-status\?[^"]*attempt=2/);
  });
});

test("last unanswered attempt reconnects the caller to the agent with the resume flag", async () => {
  await withServer(async (post, db) => {
    const r = await post({ attempt: "2" }, { DialCallStatus: "no-answer" });
    assert.equal(r.status, 200);
    assert.match(r.text, /<Connect>\s*<Stream url="wss:\/\/calls\.example\.test\/api\/twilio\/media-stream/);
    assert.match(r.text, /<Parameter name="transferResume" value="failed" \/>/);
    assert.match(r.text, /<Parameter name="agentId" value="agent-1" \/>/);
    assert.doesNotMatch(r.text, /<Hangup\/>/);
    const { data: rec } = await db.from("call_records").select("metadata").eq("id", "rec-1").maybeSingle();
    assert.equal(rec.metadata.human_transfer.outcome, "returned_to_agent");
    assert.equal(rec.metadata.human_transfer.attempts, 2);
  });
});

test("an answered transfer hangs up when the person is done", async () => {
  await withServer(async (post) => {
    const r = await post({ attempt: "1" }, { DialCallStatus: "completed", DialBridged: "true" });
    assert.match(r.text, /<Response><Hangup\/><\/Response>/);
  });
});

test("manager declines (or voicemail picks up) on attempt 1: caller goes straight back to the agent with the context", async () => {
  await withServer(async (post, db) => {
    const r = await post(
      { attempt: "1", brief: "Sarah from Texas is upset about last week's roof repair and wants a manager." },
      { DialCallStatus: "completed", DialBridged: "false" },
    );
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /still trying to reach someone/, "no redial after a decline");
    assert.match(r.text, /<Parameter name="transferResume" value="failed" \/>/);
    assert.match(r.text, /<Parameter name="transferBrief" value="Sarah from Texas is upset/);
    const meta = db._rows("call_records")[0].metadata.human_transfer;
    assert.equal(meta.outcome, "declined_returned_to_agent");
    assert.equal(meta.bridged, false);
  });
});

test("bridged only when Twilio says DialBridged=true", async () => {
  const flow = require("../lib/transfer-flow");
  assert.equal(flow.isBridged({ DialCallStatus: "completed", DialBridged: "true" }), true);
  assert.equal(flow.isBridged({ DialCallStatus: "completed", DialBridged: "false" }), false);
  assert.equal(flow.isBridged({ DialCallStatus: "completed" }), true, "older callbacks without DialBridged");
  assert.equal(flow.answeredButNotBridged({ DialCallStatus: "completed", DialBridged: "false" }), true);
  assert.equal(flow.answeredButNotBridged({ DialCallStatus: "no-answer", DialBridged: "false" }), false);
});

test("the manager hears a short brief and accepts with yes or 1", () => {
  const flow = require("../lib/transfer-flow");
  const twiml = flow.buildWhisperTwiml({
    brief: "Sarah from Texas is on the line. You worked on her property last week; she's upset and wants a manager.",
    businessName: "Summit Ridge Roofing",
    resultUrl: "https://api.example.test/api/twilio/transfer-whisper-result?parentCallSid=CA1",
  });
  assert.match(twiml, /<Gather input="dtmf speech" numDigits="1"/);
  assert.match(twiml, /Hi, this is the Agently assistant for Summit Ridge Roofing\. Sarah from Texas is on the line\./);
  assert.match(twiml, /Are you available to take this call\? Say yes or press 1/);
  assert.match(twiml, /<\/Gather><Say[^>]*>No problem, I'll let them know you're unavailable\. Goodbye\.<\/Say><Hangup\/>/);
  assert.equal(flow.managerAccepted({ Digits: "1" }), true);
  assert.equal(flow.managerAccepted({ Digits: "2" }), false);
  assert.equal(flow.managerAccepted({ SpeechResult: "Yes, put her through." }), true);
  assert.equal(flow.managerAccepted({ SpeechResult: "No, not now, I'm busy." }), false);
  assert.equal(flow.managerAccepted({}), false, "silence is not a yes");
  assert.doesNotMatch(flow.buildWhisperResultTwiml(true), /Hangup/, "accept ends the brief so Twilio connects the call");
  assert.match(flow.buildWhisperResultTwiml(false), /<Hangup\/>/);
});
