"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { countSegments, normalizeE164 } = require("../lib/sms");

test("sms: GSM-7 messages are 160 chars per single segment, 153 when split", () => {
  assert.deepEqual(countSegments("Hello"), { segments: 1, encoding: "GSM-7" });
  assert.equal(countSegments("a".repeat(160)).segments, 1);
  assert.equal(countSegments("a".repeat(161)).segments, 2);
  assert.equal(countSegments("a".repeat(306)).segments, 2);
  assert.equal(countSegments("a".repeat(307)).segments, 3);
});

test("sms: extension characters count double, emoji switch to UCS-2", () => {
  assert.equal(countSegments("€".repeat(80)).segments, 1);
  assert.equal(countSegments("€".repeat(81)).segments, 2);
  const emoji = countSegments("Thanks 😀");
  assert.equal(emoji.encoding, "UCS-2");
  assert.equal(countSegments("😀".repeat(36)).segments, 2);
});

test("sms: phone numbers normalise to E.164 or are rejected", () => {
  assert.equal(normalizeE164("(415) 555-1234"), "+14155551234");
  assert.equal(normalizeE164("1 415 555 1234"), "+14155551234");
  assert.equal(normalizeE164("+44 7700 900123"), "+447700900123");
  assert.equal(normalizeE164("555-1234"), "");
  assert.equal(normalizeE164(""), "");
});

test("feature flags: a non-production API reports every feature on", async () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    ENFORCE: process.env.FEATURE_FLAGS_ENFORCE_LOCALLY,
  };
  process.env.NODE_ENV = "development";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.FEATURE_FLAGS_ENFORCE_LOCALLY;
  try {
    const flags = require("../lib/feature-flags");
    assert.equal(flags.featureFlagsEnforced(), false);
    assert.deepEqual(await flags.getFeatureFlags(), { gmail: true, calendar: true, sms: true });
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: saved.NODE_ENV,
      VERCEL: saved.VERCEL,
      VERCEL_ENV: saved.VERCEL_ENV,
      FEATURE_FLAGS_ENFORCE_LOCALLY: saved.ENFORCE,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("feature flags: unfinished SMS defaults off, finished features default on", () => {
  const { FEATURES } = require("../lib/feature-flags");
  assert.equal(FEATURES.sms.defaultEnabled, false);
  assert.equal(FEATURES.gmail.defaultEnabled, true);
  assert.equal(FEATURES.calendar.defaultEnabled, true);
});
