"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeRecordingTranscript, recordingTranscriptLines } = require("../lib/recording-transcript");
test("human transfer speech is retained alongside the AI transcript and retries are idempotent", () => {
  const live = [{role:"assistant",text:"Let me connect you."}];
  const ctx = {recordingSid:"RE-test",source:"DialVerb"};
  const tx = {text:"Customer question and manager reply",raw:{}};
  const result = mergeRecordingTranscript(live,tx,ctx);
  assert.equal(result.length,2);
  assert.equal(result[0], live[0]);
  assert.equal(result[1].phase,"human_transfer");
  assert.deepEqual(mergeRecordingTranscript(result,tx,ctx),result);
});
test("speaker diarization keeps separate voices and recording-relative times without guessing identities", () => {
  const lines = recordingTranscriptLines({raw:{segments:[{speaker:"A",start:1,end:2,text:"Hello"},{speaker:"B",start:3,end:4,text:"How can I help?"}]}},{recordingSid:"RE-test",source:"DialVerb",startedAt:"2026-10-19T14:00:00Z"});
  assert.equal(lines.length,2);
  assert.equal(lines[0].ts,"2026-10-19T14:00:01.000Z");
  assert.notEqual(lines[0].speaker,lines[1].speaker);
});
test("an AI recording callback cannot replace existing realtime turns", () => {
  const live = [{role:"caller",text:"My name is Luqman"}];
  assert.deepEqual(mergeRecordingTranscript(live,{text:"Full audio",raw:{}},{recordingSid:"RE-ai",source:"OutboundAPI"}),live);
});
