"use strict";
/*
 * N008: a call outcome must not assert something that did not happen.
 *
 * "Appointment Booked" is not a label — it writes crm_stage = appointment_set
 * onto the lead and drives the dashboard. It used to be produced by a
 * substring match on the transcript, with no calendar consulted because none
 * exists. These tests exist so that reinstating that shortcut fails loudly.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* determineOutcome is module-private and its module pulls in Supabase and
   OpenAI at require time, so evaluate just the two functions it needs. */
function loadDetermineOutcome() {
  const src = fs.readFileSync(path.join(__dirname, "../lib/conversation-relay.js"), "utf8");
  const pick = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} not found — did conversation-relay.js move?`);

    // Skip the parameter list first. A default like `signals = {}` contains
    // braces, and counting from the signature ends the slice on it.
    let parens = 0, bodyStart = -1;
    for (let i = src.indexOf("(", start); i < src.length; i++) {
      if (src[i] === "(") parens++;
      else if (src[i] === ")") {
        parens--;
        if (parens === 0) { bodyStart = src.indexOf("{", i); break; }
      }
    }
    assert.ok(bodyStart !== -1, `could not find the body of ${name}`);

    let depth = 0, end = bodyStart;
    for (let i = bodyStart; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return src.slice(start, end);
  };

  const context = { module: {} };
  vm.createContext(context);
  vm.runInContext(
    `const UNANSWERED_PHRASES = ${JSON.stringify([
      "i don't know", "i'm not sure", "i cannot", "i can't",
      "i do not have that information", "someone can follow up",
      "take a message", "unable to answer",
    ])};\n` +
      pick("isUnanswered") + "\n" +
      pick("containsUnansweredResponse") + "\n" +
      pick("determineOutcome") + "\n" +
      "module.exports = determineOutcome;",
    context,
  );
  return context.module.exports;
}

const determineOutcome = loadDetermineOutcome();
const said = (...lines) => lines.map((t) => ({ speaker: "Caller", text: t }));

test("declining an appointment is NOT recorded as a booking", () => {
  const out = determineOutcome(said("I do not want to book an appointment right now"));
  assert.notEqual(out, "Appointment Booked", "the exact false positive this row exists for");
  assert.equal(out, "Booking Enquiry");
});

test("an agent merely offering to book is not a booking", () => {
  const out = determineOutcome([
    { speaker: "Agent", text: "We can book you in later this week if you like." },
  ]);
  assert.notEqual(out, "Appointment Booked");
});

test("the word 'book' in any other sense is not a booking", () => {
  for (const line of [
    "I am calling about the book you published",
    "Can you book me a callback? Actually never mind",
    "your bookkeeping service",
  ]) {
    assert.notEqual(determineOutcome(said(line)), "Appointment Booked", line);
  }
});

test("Appointment Booked requires an actual booking reference", () => {
  const transcript = said("yes please book me in for Tuesday");
  assert.equal(determineOutcome(transcript), "Booking Enquiry", "text alone is never enough");
  assert.equal(
    determineOutcome(transcript, { appointmentId: "appt_123" }),
    "Appointment Booked",
    "a real booking reference is what makes the claim true",
  );
});

test("Escalated requires a transfer to have actually happened", () => {
  const transcript = said("please transfer me to a human");
  assert.equal(
    determineOutcome(transcript),
    "Escalation Requested",
    "asking to be transferred is not being transferred",
  );
  assert.equal(determineOutcome(transcript, { transferred: true }), "Escalated");
});

test("Voicemail requires a recording, not the word", () => {
  const transcript = said("I got your voicemail earlier");
  assert.notEqual(determineOutcome(transcript), "Voicemail");
  assert.equal(determineOutcome(transcript, { voicemailRecorded: true }), "Voicemail");
});

test("the categories that are genuinely about what was said still work", () => {
  assert.equal(determineOutcome(said("my name is Ada and my phone is 555")), "Lead Captured");
  assert.equal(
    determineOutcome([{ speaker: "Agent", text: "I don't know, someone can follow up." }]),
    "Message Captured",
  );
  assert.equal(determineOutcome(said("what are your opening hours")), "FAQ Answered");
});

test("no signal can produce Appointment Booked from text alone", () => {
  // Belt and braces: every phrase that used to trigger it.
  for (const line of ["appointment", "book", "booking an appointment", "APPOINTMENT"]) {
    assert.notEqual(determineOutcome(said(line)), "Appointment Booked", line);
  }
});
