"use strict";
/*
 * Cross-business double-booking guard (business groups).
 *
 * Covered here: overlap detection, group lookup, sibling-slot filtering
 * (both directions: linked orgs are checked, unlinked orgs are not), and
 * group-aware cache invalidation. The booking-path conflict policy is
 * exercised through filterSlotsForGroup + findOverlappingBlock, which carry
 * the same checks bookAppointment performs pre-provider-call.
 *
 * The DB is an in-memory fake implementing the query-builder chains the
 * module uses. No provider HTTP: sibling Google checks are skipped in these
 * tests by leaving the sibling with no Google connection row.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getBusinessGroup,
  invalidateAvailabilityCache,
  invalidateGroupAvailabilityCache,
  _internals: {
    findOverlappingBlock,
    filterSlotsForGroup,
    writeAvailabilityCache,
    readAvailabilityCache,
  },
} = require("../lib/calendar-booking");

// --- In-memory Supabase fake ------------------------------------------------

function makeFakeSupabase(seed = {}) {
  const tables = {
    appointments: [],
    tenant_notifications: [],
    calendar_integrations: [],
    business_groups: [],
    business_group_members: [],
    organizations: [],
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]) ),
  };
  let seq = 1;

  function matches(row, filters) {
    return filters.every(([op, col, val]) => {
      if (op === "eq") return row[col] === val;
      if (op === "lt") return row[col] < val;
      if (op === "gt") return row[col] > val;
      return true;
    });
  }

  function from(tableName) {
    const rows = tables[tableName];
    if (!rows) throw new Error(`fake: unknown table ${tableName}`);
    const state = { filters: [] };
    const api = {
      select() {
        return api;
      },
      eq(col, val) {
        state.filters.push(["eq", col, val]);
        return api;
      },
      lt(col, val) {
        state.filters.push(["lt", col, val]);
        return api;
      },
      gt(col, val) {
        state.filters.push(["gt", col, val]);
        return api;
      },
      in(col, vals) {
        state.filters.push(["in", col, vals]);
        return api;
      },
      _run() {
        return rows.filter((r) =>
          state.filters.every(([op, c, v]) => {
            if (op === "eq") return r[c] === v;
            if (op === "lt") return r[c] < v;
            if (op === "gt") return r[c] > v;
            if (op === "in") return v.includes(r[c]);
            return true;
          }),
        );
      },
      // Awaiting the bare builder returns the full row list (supabase-style).
      then(resolve, reject) {
        return Promise.resolve({ data: api._run(), error: null }).then(resolve, reject);
      },
      async maybeSingle() {
        const out = api._run();
        return { data: out[0] || null, error: null };
      },
    };
    return api;
  }

  return { from, _tables: tables };
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const ORG_C = "org-c"; // not in any group

function seededGroupDb() {
  return makeFakeSupabase({
    business_groups: [{ id: "group-1", policy: "flag_for_review", owner_label: "Lawal" }],
    business_group_members: [
      { group_id: "group-1", organization_id: ORG_A },
      { group_id: "group-1", organization_id: ORG_B },
    ],
    organizations: [
      { id: ORG_A, name: "Business A" },
      { id: ORG_B, name: "Business B" },
    ],
    // Business B has an Agently booking 14:00–15:00 UTC on 2026-10-06.
    appointments: [
      {
        id: "appt-1",
        organization_id: ORG_B,
        status: "booked",
        starts_at: "2026-10-06T14:00:00.000Z",
        ends_at: "2026-10-06T15:00:00.000Z",
        attendee_name: "Jane Doe",
        title: null,
      },
    ],
  });
}

function twoSlots() {
  return [
    { start: "2026-10-06T13:30:00.000Z", end: "2026-10-06T14:00:00.000Z", label: "1:30 PM" },
    { start: "2026-10-06T14:00:00.000Z", end: "2026-10-06T14:30:00.000Z", label: "2:00 PM" },
  ];
}

// --- findOverlappingBlock ----------------------------------------------------

test("findOverlappingBlock detects partial, full and boundary overlaps", () => {
  const blocks = [{ start: "2026-10-06T14:00:00.000Z", end: "2026-10-06T15:00:00.000Z" }];
  // Partial overlap at the start.
  assert.ok(findOverlappingBlock(blocks, "2026-10-06T13:30:00.000Z", "2026-10-06T14:30:00.000Z"));
  // Fully inside.
  assert.ok(findOverlappingBlock(blocks, "2026-10-06T14:10:00.000Z", "2026-10-06T14:20:00.000Z"));
  // Fully covering.
  assert.ok(findOverlappingBlock(blocks, "2026-10-06T13:00:00.000Z", "2026-10-06T16:00:00.000Z"));
  // Adjacent: block ends exactly when the slot starts — no overlap.
  assert.equal(findOverlappingBlock(blocks, "2026-10-06T13:00:00.000Z", "2026-10-06T14:00:00.000Z"), null);
  assert.equal(findOverlappingBlock(blocks, "2026-10-06T15:00:00.000Z", "2026-10-06T16:00:00.000Z"), null);
  // Garbage inputs never throw, never match.
  assert.equal(findOverlappingBlock(blocks, "nope", "2026-10-06T16:00:00.000Z"), null);
  assert.equal(findOverlappingBlock([], "2026-10-06T14:10:00.000Z", "2026-10-06T14:20:00.000Z"), null);
});

// --- getBusinessGroup --------------------------------------------------------

test("getBusinessGroup returns null for an unlinked org", async () => {
  const db = seededGroupDb();
  assert.equal(await getBusinessGroup(db, ORG_C), null);
});

test("getBusinessGroup returns the group with all member orgs and policy", async () => {
  const db = seededGroupDb();
  const group = await getBusinessGroup(db, ORG_A);
  assert.ok(group);
  assert.equal(group.id, "group-1");
  assert.equal(group.policy, "flag_for_review");
  assert.deepEqual(group.memberOrgIds.sort(), [ORG_A, ORG_B]);
});

// --- filterSlotsForGroup -----------------------------------------------------

test("filterSlotsForGroup removes slots busy on a linked business's calendar", async () => {
  const db = seededGroupDb();
  const { slots, filtered, siblingCount } = await filterSlotsForGroup(
    db,
    ORG_A,
    twoSlots(),
    new Date("2026-10-06T00:00:00Z"),
    new Date("2026-10-07T00:00:00Z"),
  );
  // 13:30 slot survives (ends exactly when B's booking starts); 14:00 slot is removed.
  assert.equal(slots.length, 1);
  assert.equal(slots[0].start, "2026-10-06T13:30:00.000Z");
  assert.equal(filtered, 1);
  assert.equal(siblingCount, 1);
});

test("filterSlotsForGroup leaves unlinked orgs untouched", async () => {
  const db = seededGroupDb();
  const before = twoSlots();
  const { slots, filtered } = await filterSlotsForGroup(
    db,
    ORG_C,
    before,
    new Date("2026-10-06T00:00:00Z"),
    new Date("2026-10-07T00:00:00Z"),
  );
  assert.equal(slots.length, 2);
  assert.equal(filtered, 0);
});

test("filterSlotsForGroup never breaks on DB failure", async () => {
  const broken = {
    from() {
      throw new Error("db down");
    },
  };
  const before = twoSlots();
  const { slots, filtered } = await filterSlotsForGroup(
    broken,
    ORG_A,
    before,
    new Date("2026-10-06T00:00:00Z"),
    new Date("2026-10-07T00:00:00Z"),
  );
  assert.equal(slots.length, 2);
  assert.equal(filtered, 0);
});

// --- group-aware cache invalidation ------------------------------------------

test("invalidateGroupAvailabilityCache clears every linked business's cache", async () => {
  const db = seededGroupDb();
  writeAvailabilityCache(ORG_A, "google", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z", {
    success: true,
    slots: [{ start: "2026-10-06T13:30:00.000Z" }],
  });
  writeAvailabilityCache(ORG_B, "google", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z", {
    success: true,
    slots: [{ start: "2026-10-06T13:30:00.000Z" }],
  });
  writeAvailabilityCache(ORG_C, "google", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z", {
    success: true,
    slots: [{ start: "2026-10-06T13:30:00.000Z" }],
  });
  // A change on business B must clear A and B, but not the unlinked C.
  await invalidateGroupAvailabilityCache(db, ORG_B);
  assert.equal(
    readAvailabilityCache(ORG_A, "google", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z"),
    null,
  );
  assert.equal(
    readAvailabilityCache(ORG_B, "google", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z"),
    null,
  );
  assert.ok(
    readAvailabilityCache(ORG_C, "google", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z"),
  );
  invalidateAvailabilityCache(ORG_C); // cleanup
});
