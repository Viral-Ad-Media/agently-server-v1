"use strict";
/*
 * p3: run against Supabase, not only the stubs.
 *
 * The 103 tests in `npm test` are hermetic by design — they stub the database
 * so they are fast, deterministic and runnable with no credentials. That is
 * the right default, and it is also exactly why they could not have caught the
 * near-outage before v15: `assertEmailRecipientsAllowed` failed CLOSED against
 * production because `email_delivery_blocks` did not exist there, and no stub
 * can tell you a table is missing.
 *
 * So this is the other half: a small suite that touches the REAL database and
 * asserts the things only the real one knows — that the tables exist, that the
 * RPCs the product depends on are callable with the arguments the code passes,
 * and that the app's own client can read them.
 *
 * It is NOT part of `npm test`. It needs credentials and a network, and a test
 * suite that cannot run offline is a test suite people stop running.
 *
 *   npm run test:integration
 *
 * SAFETY: read-only except for one rate-limit row under a synthetic key, which
 * is deleted and the deletion verified. It sends no email, creates no call,
 * charges nothing and touches no billing record.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `integration tests need ${missing.join(", ")} in agently-server/.env — skipping.\n` +
      "Note SUPABASE_SERVICE_KEY, not SUPABASE_SERVICE_ROLE_KEY: lib/supabase.js reads the " +
      "former, and using the wrong one is how a table was once reported present when the app " +
      "could not see it.",
  );
  process.exit(0);
}

/* The app's own client, deliberately — not a hand-rolled one. The point is to
   test what the product will actually experience. */
const { getSupabase } = require("../../lib/supabase");
const db = getSupabase();

/* Tables the product cannot function without. A missing one here is the v15
   near-outage, caught before deploying rather than after. */
const REQUIRED_TABLES = [
  "organizations",
  "users",
  "auth_sessions",
  "auth_codes",
  "leads",
  "call_records",
  "voice_agents",
  "chatbots",
  "knowledge_chunks",
  "faqs",
  "billing_usage_events",
  "billing_wallets",
  "email_delivery_blocks",
  "account_erasure_requests",
  "webhook_deliveries",
];

test("every table the product depends on exists and is readable by the app's client", async () => {
  const absent = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await db.from(table).select("*", { count: "exact", head: true });
    if (error) absent.push(`${table}: ${error.message}`);
  }
  assert.deepEqual(absent, [], "a stub cannot tell you a table is missing — this can");
});

test("the retrieval RPCs are callable with the arguments the code actually passes", async () => {
  // Signature drift here is invisible to unit tests and fatal in production:
  // lib/knowledge-retrieval.js calls these by name with these parameters.
  const chunks = await db.rpc("search_knowledge_chunks", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_knowledge_base_ids: null,
    p_query: "integration probe",
    p_limit: 1,
    p_max_chars: 500,
  });
  assert.equal(chunks.error, null, `search_knowledge_chunks: ${chunks.error?.message}`);

  const faqs = await db.rpc("search_faqs", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_query: "integration probe",
    p_limit: 1,
  });
  assert.equal(faqs.error, null, `search_faqs: ${faqs.error?.message}`);
});

test("the email guard ALLOWS a known-good address against the real table", async () => {
  // The standing pre-flight, as a test. Before v15 this threw
  // EMAIL_DELIVERY_UNAVAILABLE for every address, including good ones.
  const { assertEmailRecipientsAllowed } = require("../../lib/email-delivery");
  await assert.doesNotReject(
    () => assertEmailRecipientsAllowed({ to: "viraladmediacontent@gmail.com" }),
    "if this fails, deploying would stop every OTP in the product",
  );
});

test("the auth rate limiter round-trips against the real function", async () => {
  const key = `integration-probe-${Date.now()}@example.invalid`;
  const { hit } = require("../../lib/auth-rate-limit");

  const first = await hit("login_email", key);
  assert.equal(first.allowed, true, "a fresh identifier must be allowed");
  assert.notEqual(first.degraded, true, "degraded means the RPC failed — the limiter is guessing");

  const { error } = await db.from("auth_rate_limits").delete().like("identifier", `%${key}%`);
  if (!error) {
    const { count } = await db
      .from("auth_rate_limits")
      .select("*", { count: "exact", head: true })
      .like("identifier", `%${key}%`);
    assert.equal(count, 0, "probe rows must not be left behind");
  }
});

test("export reads real rows for a real organization", async () => {
  const { exportOrganization } = require("../../lib/account-data");
  const { data: org } = await db.from("organizations").select("id").limit(1).maybeSingle();
  if (!org) return; // empty database is not a failure

  const out = await exportOrganization(db, org.id);
  assert.ok(out.counts, "an export must report counts");
  assert.equal(out.problems, undefined, `unreadable tables: ${JSON.stringify(out.problems)}`);

  const text = JSON.stringify(out);
  assert.ok(!/\$2[aby]\$\d{2}\$/.test(text), "a bcrypt hash reached a real export");
  assert.ok(!/"password_hash"/.test(text), "password_hash reached a real export");
});

test("the anon key cannot read tenant data — RLS is doing its job", async () => {
  // t5 concluded that RLS is a blanket deny and isolation rests on the API
  // scoping every query as service_role. That conclusion is only safe while
  // the anon key really can read nothing. A stub cannot check this.
  const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!anon) return; // the server no longer carries one; not a failure

  const { createClient } = require("@supabase/supabase-js");
  const publicClient = createClient(process.env.SUPABASE_URL, anon, {
    auth: { persistSession: false },
  });

  for (const table of ["leads", "call_records", "organizations", "users"]) {
    const { data, error } = await publicClient.from(table).select("*").limit(1);
    assert.ok(
      error || (data || []).length === 0,
      `the anon key read ${table} — tenant data is public`,
    );
  }
});
