"use strict";
/*
 * s8: export and erasure.
 *
 * The assertions that matter are about what must NOT happen — a secret
 * leaving in an export, a whole export failing because one table moved, and
 * erasure destroying a financial record it is obliged to keep.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  exportOrganization,
  planErasure,
  ORG_TABLES,
  FINANCIAL_TABLES,
  NEVER_EXPORT,
} = require("../lib/account-data");

const ORG = "org-1";

/* A Supabase-shaped stub: per-table rows, and per-table forced errors. */
function fakeDb({ rows = {}, errors = {} } = {}) {
  return {
    from(table) {
      const chain = {
        _head: false,
        select(_cols, opts) {
          if (opts && opts.head) chain._head = true;
          return chain;
        },
        eq() { return chain; },
        limit() { return chain._result(); },
        maybeSingle() {
          const r = chain._result();
          return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error });
        },
        range() { return chain._result(); },
        _result() {
          if (errors[table]) return Promise.resolve({ data: null, error: { message: errors[table] }, count: null });
          const data = rows[table] || [];
          return Promise.resolve({ data, error: null, count: data.length });
        },
        then(res, rej) { return chain._result().then(res, rej); },
      };
      return chain;
    },
  };
}

test("an export never contains a password hash or a secret", async () => {
  const db = fakeDb({
    rows: {
      organizations: [{ id: ORG, name: "Acme", twilio_auth_token_encrypted: "enc-xyz" }],
      users: [{ id: "u1", email: "a@b.c", password_hash: "$2b$10$notthis", organization_id: ORG }],
      auth_sessions: [{ id: "s1", token_hash: "deadbeef", organization_id: ORG }],
    },
  });

  const out = await exportOrganization(db, ORG);
  const text = JSON.stringify(out);

  assert.ok(!text.includes("$2b$10$notthis"), "a bcrypt hash is offline-crackable and must never be exported");
  assert.ok(!text.includes("deadbeef"), "a session token hash must not be exported");
  assert.ok(!text.includes("enc-xyz"), "a carrier credential must not be exported");
  assert.equal(out.data.users[0].email, "a@b.c", "the person's own data must still be there");
  assert.equal(out.data.users[0].id, "u1");
});

test("every never-export column is actually stripped", async () => {
  const row = { id: "x", organization_id: ORG, keep: "yes" };
  for (const k of NEVER_EXPORT) row[k] = `secret-${k}`;
  const out = await exportOrganization(fakeDb({ rows: { users: [row] } }), ORG);
  const got = out.data.users[0];
  for (const k of NEVER_EXPORT) assert.ok(!(k in got), `${k} leaked into the export`);
  assert.equal(got.keep, "yes");
});

test("one unreadable table does not deny somebody their whole export", async () => {
  const db = fakeDb({
    rows: { leads: [{ id: "l1", organization_id: ORG }] },
    errors: { call_records: 'relation "call_records" does not exist' },
  });

  const out = await exportOrganization(db, ORG);

  assert.equal(out.data.leads.length, 1, "readable tables must still be returned");
  assert.ok(out.problems.call_records, "the gap must be reported, not hidden");
  assert.match(out.problems.call_records, /does not exist/);
});

test("financial records are exported but are NOT on the delete list", async () => {
  for (const t of FINANCIAL_TABLES) {
    assert.ok(!ORG_TABLES.includes(t), `${t} must not be deleted — it is a financial audit trail`);
  }
  const out = await exportOrganization(fakeDb({ rows: { billing_usage_events: [{ id: "e1" }] } }), ORG);
  assert.equal(out.data.billing_usage_events.length, 1, "it must still be exportable");
});

test("the erasure plan separates what is deleted from what is anonymised", async () => {
  const db = fakeDb({
    rows: {
      leads: [{ id: 1 }, { id: 2 }],
      billing_usage_events: [{ id: 1 }, { id: 2 }, { id: 3 }],
    },
  });
  const plan = await planErasure(db, ORG);

  assert.equal(plan.deletes.leads, 2);
  assert.equal(plan.anonymise.billing_usage_events, 3);
  assert.ok(!("billing_usage_events" in plan.deletes));
  assert.ok(!("leads" in plan.anonymise));
});

test("an export refuses without an organization", async () => {
  await assert.rejects(() => exportOrganization(fakeDb(), null), /organizationId is required/);
});
