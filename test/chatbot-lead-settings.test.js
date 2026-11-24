"use strict";

// Website chat lead collection must follow the tenant's Messenger settings:
// off means no lead is ever stored and the AI never asks for details; on means
// only the chosen details are asked for and stored.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { makeFakeSupabase } = require("./helpers/fake-supabase");
const settings = require("../lib/chatbot-lead-settings");

// Route under test, with its database swapped for the in-memory fake.
const SUPABASE = path.resolve(__dirname, "../lib/supabase.js");
let currentDb = null;
require(SUPABASE);
require.cache[SUPABASE].exports = { ...require.cache[SUPABASE].exports, getSupabase: () => currentDb };
const { captureLead } = require("../api/routes/chatbot-public");

function dbWith(chatbot) {
  currentDb = makeFakeSupabase({
    chatbots: [{ id: "bot-1", organization_id: "org-1", voice_agent_id: null, ...chatbot }],
    leads: [],
  });
  return currentDb;
}

test("settings: off when either column says off; fields normalised and ordered", () => {
  assert.equal(settings.chatbotLeadSettings({ collect_leads: false }).enabled, false);
  assert.equal(settings.chatbotLeadSettings({ lead_capture_enabled: false }).enabled, false);
  assert.equal(settings.chatbotLeadSettings({}).enabled, true);
  assert.deepEqual(settings.normalizeLeadFields(["Phone", "name", "fax", "name"]), ["name", "phone"]);
  assert.deepEqual(settings.normalizeLeadFields(null), ["name", "email", "phone"]);
  assert.throws(() => settings.validateLeadFieldsForSave(["name", "reason"]), /email or phone/);
});

test("collection off: nothing is stored", async () => {
  const db = dbWith({ collect_leads: false, lead_capture_enabled: false });
  await assert.rejects(
    captureLead({ chatbotId: "bot-1", lead: { name: "Pat", email: "pat@example.com" } }),
    (e) => e.code === "LEAD_CAPTURE_DISABLED",
  );
  assert.equal(db._rows("leads").length, 0);
});

test("collection on: only the chosen details are stored", async () => {
  const db = dbWith({ collect_leads: true, lead_capture_enabled: true, lead_capture_fields: ["name", "email"] });
  await captureLead({
    chatbotId: "bot-1",
    lead: { name: "Pat", email: "Pat@Example.com", phone: "+15125550142", reason: "Leaking roof" },
  });
  const [row] = db._rows("leads");
  assert.equal(row.name, "Pat");
  assert.equal(row.email, "pat@example.com");
  assert.equal(row.phone, null, "phone was not chosen, so it is not stored");
  assert.equal(row.reason, "Website chat lead", "reason was not chosen, so the visitor's words are not stored");
});

test("collection on: a contact detail from the chosen list is required", async () => {
  dbWith({ collect_leads: true, lead_capture_fields: ["name", "phone"] });
  await assert.rejects(
    captureLead({ chatbotId: "bot-1", lead: { name: "Pat", email: "pat@example.com" } }),
    /phone number/,
  );
});

test("prompt: off forbids asking; on lists exactly the chosen details", () => {
  const off = settings.leadCapturePromptLines({ enabled: false, fields: [] }).join("\n");
  assert.match(off, /switched OFF/);
  assert.match(off, /Never ask the visitor for their name, email, phone/);
  const on = settings.leadCapturePromptLines({ enabled: true, fields: ["name", "phone"] }).join("\n");
  assert.match(on, /collect ONLY these details: name and phone number\./);
  assert.doesNotMatch(on, /email/);
});
