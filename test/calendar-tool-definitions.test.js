"use strict";
/*
 * lib/calendar-tool-definitions.js — canonical tool definitions for the
 * webcall bridge. The ws-server keeps its own copy (separate deployment);
 * this test guards against drift between the two.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const {
  calendarToolDefinitions,
  isCalendarTool,
} = require("../lib/calendar-tool-definitions");

test("advertises exactly the three booking tools", () => {
  const defs = calendarToolDefinitions();
  assert.equal(defs.length, 3);
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, [
    "book_appointment",
    "cancel_appointment",
    "check_calendar_availability",
  ]);
  for (const d of defs) {
    assert.equal(d.type, "function");
    assert.ok(d.description && d.description.length > 20);
    assert.equal(d.parameters.type, "object");
  }
  const book = defs.find((d) => d.name === "book_appointment");
  assert.deepEqual(book.parameters.required, ["start_time", "attendee_name"]);
  const cancel = defs.find((d) => d.name === "cancel_appointment");
  assert.deepEqual(cancel.parameters.required, ["appointment_id"]);
});

test("isCalendarTool routes only calendar tools", () => {
  assert.ok(isCalendarTool("check_calendar_availability"));
  assert.ok(isCalendarTool("book_appointment"));
  assert.ok(isCalendarTool("cancel_appointment"));
  assert.ok(!isCalendarTool("search_business_knowledge"));
});

test("definitions match the ws-server copy (no drift)", () => {
  const wsPath = path.join(
    __dirname,
    "..",
    "..",
    "agently-ws-server",
    "lib",
    "calendar-tools.js",
  );
  if (!fs.existsSync(wsPath)) {
    // The ws-server repo is not always checked out next to the server repo.
    return;
  }
  const wsSource = fs.readFileSync(wsPath, "utf8");
  for (const def of calendarToolDefinitions()) {
    assert.ok(
      wsSource.includes(`name: "${def.name}"`),
      `ws-server copy is missing tool ${def.name}`,
    );
  }
  // Required-field contract must match on both sides.
  const book = calendarToolDefinitions().find((d) => d.name === "book_appointment");
  assert.ok(
    wsSource.includes('"start_time", "attendee_name"'),
    "ws-server book_appointment required fields drifted",
  );
  assert.deepEqual(book.parameters.required, ["start_time", "attendee_name"]);
});
