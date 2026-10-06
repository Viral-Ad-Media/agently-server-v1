"use strict";
/*
 * lib/calendar-booking.js — timezone math, slot computation, settings.
 *
 * The timezone helpers are the subtle part (DST, day boundaries), so they get
 * the most coverage. Provider HTTP calls are tested with a stubbed fetch.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _internals: {
    computeFreeSlots,
    wallClockToUtc,
    tzOffsetMinutes,
    formatSlotLabel,
    bookingSettings,
  },
} = require("../lib/calendar-booking");

const NY = "America/New_York";

test("tzOffsetMinutes matches known EST/EDT offsets", () => {
  // January: EST (UTC-5). July: EDT (UTC-4).
  assert.equal(tzOffsetMinutes(NY, new Date(Date.UTC(2026, 0, 15, 12, 0))), -300);
  assert.equal(tzOffsetMinutes(NY, new Date(Date.UTC(2026, 6, 15, 12, 0))), -240);
});

test("wallClockToUtc converts a New York morning to UTC", () => {
  // 2026-10-06 10:00 in New York (EDT, UTC-4) == 14:00 UTC.
  const d = wallClockToUtc(2026, 10, 6, 10, 0, NY);
  assert.equal(d.toISOString(), "2026-10-06T14:00:00.000Z");
});

test("wallClockToUtc is correct across a DST boundary", () => {
  // DST ends 2026-11-01 in the US. Nov 2 10:00 EST (UTC-5) == 15:00 UTC.
  const d = wallClockToUtc(2026, 11, 2, 10, 0, NY);
  assert.equal(d.toISOString(), "2026-11-02T15:00:00.000Z");
});

test("computeFreeSlots carves slots out of working hours minus busy blocks", () => {
  const from = new Date("2026-10-06T00:00:00Z"); // a Tuesday
  const to = new Date("2026-10-07T00:00:00Z");
  const slots = computeFreeSlots({
    busy: [{ start: "2026-10-06T14:00:00Z", end: "2026-10-06T15:00:00Z" }], // 10:00-11:00 NY
    from,
    to,
    timeZone: NY,
    slotMinutes: 30,
    workingHours: { tue: [["09:00", "12:00"]] },
  });
  const labels = slots.map((s) => s.label);
  // 09:00, 09:30 free; 10:00, 10:30 busy; 11:00, 11:30 free.
  assert.equal(slots.length, 4);
  assert.ok(labels[0].includes("9:00"), labels[0]);
  assert.ok(labels[1].includes("9:30"), labels[1]);
  assert.ok(labels[2].includes("11:00"), labels[2]);
  assert.ok(labels[3].includes("11:30"), labels[3]);
  assert.equal(slots[0].start, "2026-10-06T13:00:00.000Z");
  assert.equal(slots[0].end, "2026-10-06T13:30:00.000Z");
});

test("computeFreeSlots skips days with no working hours", () => {
  const from = new Date("2026-10-04T00:00:00Z"); // a Sunday
  const to = new Date("2026-10-05T00:00:00Z");
  const slots = computeFreeSlots({
    busy: [],
    from,
    to,
    timeZone: NY,
    slotMinutes: 30,
    workingHours: { sun: [] },
  });
  assert.equal(slots.length, 0);
});

test("computeFreeSlots caps the number of slots", () => {
  const from = new Date("2026-10-06T00:00:00Z");
  const to = new Date("2026-10-20T00:00:00Z");
  const slots = computeFreeSlots({
    busy: [],
    from,
    to,
    timeZone: NY,
    slotMinutes: 15,
    workingHours: {
      mon: [["00:00", "23:45"]],
      tue: [["00:00", "23:45"]],
      wed: [["00:00", "23:45"]],
      thu: [["00:00", "23:45"]],
      fri: [["00:00", "23:45"]],
    },
  });
  assert.equal(slots.length, 20);
});

test("computeFreeSlots ignores malformed busy blocks", () => {
  const from = new Date("2026-10-06T00:00:00Z");
  const to = new Date("2026-10-06T12:00:00Z");
  const slots = computeFreeSlots({
    busy: [{ start: "garbage", end: "also-garbage" }, { start: "2026-10-06T14:00:00Z", end: "2026-10-06T13:00:00Z" }],
    from,
    to,
    timeZone: "UTC",
    slotMinutes: 60,
    workingHours: { tue: [["09:00", "12:00"]] },
  });
  assert.equal(slots.length, 3);
});

test("bookingSettings applies defaults and respects overrides", () => {
  const d = bookingSettings({ booking_settings: {} });
  assert.equal(d.slotMinutes, 30);
  assert.equal(d.windowDays, 14);
  assert.equal(d.sendUpdates, "all");
  const o = bookingSettings({
    booking_settings: { slotMinutes: 60, windowDays: 7, sendUpdates: "none" },
  });
  assert.equal(o.slotMinutes, 60);
  assert.equal(o.windowDays, 7);
  assert.equal(o.sendUpdates, "none");
  const broken = bookingSettings({ booking_settings: { slotMinutes: -5 } });
  assert.equal(broken.slotMinutes, 30);
});

test("formatSlotLabel renders a readable label", () => {
  const label = formatSlotLabel(new Date("2026-10-06T14:00:00Z"), NY);
  assert.match(label, /Tue/i);
  assert.match(label, /Oct/i);
  assert.match(label, /10:00/);
});
