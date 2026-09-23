"use strict";

/**
 * Data export and erasure for one organization (s8).
 *
 * Not a launch nicety: 58 organizations and 38 users are already in
 * production, so the obligation is live now, not at launch.
 *
 * TWO DELIBERATE ASYMMETRIES.
 *
 * Export is SYNCHRONOUS and immediate — it is a read, it cannot damage
 * anything, and making people wait for a human is how these requests get
 * ignored.
 *
 * Erasure is a REQUEST, not a button. It is recorded and must be executed
 * deliberately, because it is irreversible, because it destroys billing
 * records that tax law requires be retained, and because "delete my account"
 * arriving from a hijacked session would otherwise be catastrophic and
 * unrecoverable. The right to erasure does not oblige anyone to build a
 * one-click self-service bomb.
 *
 * What erasure does NOT remove, and the reason:
 *   billing_usage_events / billing_wallet_transactions — a financial audit
 *   trail with its own statutory retention. These are ANONYMISED (the org and
 *   user links are severed) rather than deleted, so the money history survives
 *   without naming a person.
 */

/* Confirmed present in production on 22 Sep. Six plausible names were probed
   and do not exist (organization_members, chat_conversations, chat_sessions,
   lead_notes, notifications, team_invites) — listing them would fill every
   export's `problems` block with noise and hide a real gap. */
const ORG_TABLES = [
  "users",
  "leads",
  "lead_activities",
  "lead_outreach_schedules",
  "lead_outreach_runs",
  "call_records",
  "voice_agents",
  "chatbots",
  "chat_messages",
  "knowledge_bases",
  "knowledge_sources",
  "knowledge_chunks",
  "knowledge_discovered_pages",
  "faqs",
  "unanswered_questions",
  "whatsapp_messages",
  "scraped_products",
  "twilio_phone_numbers",
  "billing_wallets",
  "auth_sessions",
];

/* Retained for audit, anonymised instead of deleted. */
const FINANCIAL_TABLES = ["billing_usage_events", "billing_wallet_transactions"];

/* Columns never included in an export: secrets, and hashes that are useful
   only for cracking. Matched by exact name per table row. */
const NEVER_EXPORT = new Set([
  "password_hash",
  "totp_secret",
  "twilio_auth_token",
  "twilio_auth_token_encrypted",
  "token_hash",
  "code_hash",
  "session_token",
  "refresh_token",
  "api_key",
  "webhook_secret",
]);

function scrub(rows) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) if (!NEVER_EXPORT.has(k)) out[k] = v;
    return out;
  });
}

/**
 * Everything held about one organization, table by table.
 *
 * Reports per-table errors rather than failing the whole export: a missing or
 * renamed table must not deny somebody their data, and a silent gap would be
 * worse than a noted one.
 */
async function exportOrganization(db, organizationId, { pageSize = 1000 } = {}) {
  if (!organizationId) throw new Error("organizationId is required");

  const data = {};
  const counts = {};
  const problems = {};

  const org = await db.from("organizations").select("*").eq("id", organizationId).maybeSingle();
  if (org.error) problems.organizations = org.error.message;
  else data.organizations = scrub(org.data ? [org.data] : []);
  counts.organizations = data.organizations?.length || 0;

  for (const table of ORG_TABLES) {
    const rows = [];
    let from = 0;
    for (;;) {
      const { data: page, error } = await db
        .from(table)
        .select("*")
        .eq("organization_id", organizationId)
        .range(from, from + pageSize - 1);
      if (error) { problems[table] = error.message; break; }
      rows.push(...(page || []));
      if (!page || page.length < pageSize) break;
      from += pageSize;
    }
    data[table] = scrub(rows);
    counts[table] = data[table].length;
  }

  for (const table of FINANCIAL_TABLES) {
    const { data: page, error } = await db
      .from(table)
      .select("*")
      .eq("organization_id", organizationId)
      .limit(5000);
    if (error) problems[table] = error.message;
    data[table] = scrub(page || []);
    counts[table] = data[table].length;
  }

  return {
    generated_at: new Date().toISOString(),
    organization_id: organizationId,
    format: "agently-export/1",
    notes: [
      "Secrets and password hashes are excluded by design.",
      "Financial records are included here and are RETAINED after erasure, anonymised.",
    ],
    counts,
    ...(Object.keys(problems).length ? { problems } : {}),
    data,
  };
}

/**
 * Plan an erasure without performing it. Used by the request endpoint so the
 * requester is told exactly what would go, and by the operator tool so the
 * same plan is reviewed before it runs.
 */
async function planErasure(db, organizationId) {
  const deletes = {};
  const anonymise = {};
  for (const table of ORG_TABLES) {
    const { count, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    deletes[table] = error ? `unreadable: ${error.message}` : count || 0;
  }
  for (const table of FINANCIAL_TABLES) {
    const { count, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    anonymise[table] = error ? `unreadable: ${error.message}` : count || 0;
  }
  return { organization_id: organizationId, deletes, anonymise };
}

module.exports = { exportOrganization, planErasure, ORG_TABLES, FINANCIAL_TABLES, NEVER_EXPORT };
