"use strict";
/*
 * Google rejects an event id outside base32hex — lowercase a-v and 0-9, length
 * 5-1024 — with "Invalid resource id value."
 *
 * The id was built as `agently${hex}`. "y" is outside a-v, so EVERY booking
 * failed at the provider, and the error was swallowed into a caller-friendly
 * line about confirming by text. The feature had never worked once.
 *
 * One assertion on the alphabet would have caught it before a real calendar
 * was ever involved.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CALENDAR_TOKEN_KEY =
  process.env.CALENDAR_TOKEN_KEY || "a".repeat(64);

const {
  googleEventId,
  GOOGLE_EVENT_ID_ALPHABET,
} = require("../lib/calendar-booking");

test("the generated id uses only characters Google accepts", () => {
  const id = googleEventId("a382f382-1cc9-47ff-b84a-a2e901ba3444");
  assert.match(id, GOOGLE_EVENT_ID_ALPHABET);
});

test("no character outside a-v or 0-9 survives, whatever the appointment id", () => {
  // Every hex nibble appears across these, plus a non-hex control.
  for (const appointmentId of [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "01234567-89ab-cdef-0123-456789abcdef",
    "a382f382-1cc9-47ff-b84a-a2e901ba3444",
  ]) {
    const id = googleEventId(appointmentId);
    assert.match(id, GOOGLE_EVENT_ID_ALPHABET, `rejected for ${appointmentId}`);
    assert.equal(
      /[w-z]/.test(id),
      false,
      `${id} contains a letter past v, which is what broke booking before`,
    );
  }
});

test("the prefix itself is inside the alphabet", () => {
  // The original defect was entirely in the constant prefix, not the suffix.
  const prefix = googleEventId("00000000-0000-0000-0000-000000000000").replace(
    /0+$/,
    "",
  );
  assert.match(prefix, /^[a-v0-9]+$/);
});

test("the id stays within Google's length bounds", () => {
  const id = googleEventId("a382f382-1cc9-47ff-b84a-a2e901ba3444");
  assert.ok(id.length >= 5 && id.length <= 1024, `length ${id.length}`);
});

test("the same appointment always yields the same id, so a retry is idempotent", () => {
  // This is the whole reason the id is client-generated: a retried insert must
  // collide (409) rather than create a second event on someone's calendar.
  const a = googleEventId("a382f382-1cc9-47ff-b84a-a2e901ba3444");
  const b = googleEventId("a382f382-1cc9-47ff-b84a-a2e901ba3444");
  assert.equal(a, b);
  assert.notEqual(a, googleEventId("b382f382-1cc9-47ff-b84a-a2e901ba3444"));
});
