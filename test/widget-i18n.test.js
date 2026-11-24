"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const widgetI18n = require("../lib/widget-i18n");
const widget = require("../api/routes/widget");

test("widget i18n: English needs no UI translation", async () => {
  assert.deepEqual(await widgetI18n.getUiTranslations("en"), {});
});

test("widget i18n: unsupported languages return the original text without a model call", async () => {
  assert.deepEqual(await widgetI18n.getUiTranslations("xx"), {});
  const content = await widgetI18n.getContentTranslations("bot", "xx", {
    headerTitle: "Chat",
    welcomeMessage: "Hi",
    placeholder: "Type",
    leadAsk: "",
    suggestedPrompts: ["One", "Two"],
  });
  assert.deepEqual(content, {
    headerTitle: "Chat",
    welcomeMessage: "Hi",
    placeholder: "Type",
    leadAsk: "",
    suggestedPrompts: ["One", "Two"],
  });
});

test("widget i18n: every UI string the widget looks up is in the translation list", () => {
  const html = widget.buildWidgetHtml({
    chatbotId: "cb", apiUrl: "http://x", accentColor: "#000", headerTitle: "H", welcomeMessage: "W",
    placeholder: "P", avatarLabel: "A", rawAvatarLabel: "", rawAvatarDataUri: "", rawApiUrl: "http://x",
    rawChatbotId: "cb", position: "right", serviceHalted: false, suggestedPrompts: "[]", faqs: "[]",
    chatLanguages: '["en","es"]', chatVoice: "alloy", realtimeWsUrl: "", collectLeads: true,
    leadFields: ["name", "phone"], leadAsk: "name and phone number", mediaUploads: false, agentName: "A",
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  const looked = new Set();
  for (const m of script.matchAll(/\bTH?\('((?:[^'\\]|\\.)*)'\)/g)) looked.add(m[1]);
  for (const m of script.matchAll(/\bTH?\([^)]*\?\s*'([^']+)'\s*:\s*'([^']+)'\)/g)) { looked.add(m[1]); looked.add(m[2]); }
  const missing = [...looked].filter((s) => !widgetI18n.UI_STRINGS.includes(s));
  assert.deepEqual(missing, []);
  assert.ok(looked.size >= 30, `expected many lookups, found ${looked.size}`);
});
