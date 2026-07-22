#!/usr/bin/env node
/**
 * agently-server/scripts/reconcile-orphan-numbers.js   <-- NEW FILE
 *
 * RUN THIS BEFORE ANYTHING ELSE. You are paying for numbers right now.
 *
 * WHY ORPHANS EXIST
 *   The P0-1 bug (missing isRecommendedForAutomaticPurchase export) meant every
 *   purchase threw AFTER Twilio had already sold and configured the number, but
 *   BEFORE saveNumberRecord() wrote it to twilio_phone_numbers. The number is
 *   therefore live and billing on your master/sub accounts, and completely
 *   invisible to both the tenant and the admin UI.
 *
 *   Secondary source: the "release_pending" path in
 *   rollbackPurchasedNumberAfterBillingFailure() when the carrier DELETE failed.
 *
 * WHAT IT DOES
 *   Walks the master account and every subaccount in twilio_accounts, lists all
 *   IncomingPhoneNumbers, and compares against twilio_phone_numbers.
 *   Classifies each number as:
 *     MATCHED           - on carrier + active row.               keep, no action
 *     ORPHAN            - on carrier, no row at all.             candidate
 *     RELEASE_PENDING   - row says released/pending, still live. candidate
 *     GHOST_ROW         - active row, not on carrier.            db cleanup only
 *
 * USAGE
 *   Dry run  (default, touches nothing):
 *     node scripts/reconcile-orphan-numbers.js
 *   Release candidates for real:
 *     node scripts/reconcile-orphan-numbers.js --apply
 *   Protect recent purchases from being reaped mid-flight (default 60 min):
 *     node scripts/reconcile-orphan-numbers.js --apply --min-age-minutes=120
 *   Limit to one account:
 *     node scripts/reconcile-orphan-numbers.js --account=ACxxxxxxxx
 *
 * SAFETY
 *   - Dry run is the default. --apply is required to release anything.
 *   - Numbers newer than --min-age-minutes are NEVER released. This is what
 *     stops the script from killing a purchase that is still in flight.
 *   - GHOST_ROW never triggers a carrier call. Database only.
 *   - Every release is printed with its SID and number before and after.
 */

"use strict";

require("dotenv").config();

const { getSupabase } = require("../lib/supabase");
const {
  listIncomingNumbers,
  releaseIncomingNumber,
  masterSid,
} = require("../lib/twilio-platform");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const MIN_AGE_MINUTES = Number(
  (args.find((a) => a.startsWith("--min-age-minutes=")) || "").split("=")[1] ||
    60,
);
const ONLY_ACCOUNT =
  (args.find((a) => a.startsWith("--account=")) || "").split("=")[1] || null;

function mask(sid) {
  const s = String(sid || "");
  return s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "(none)";
}

function ageMinutes(dateCreated) {
  if (!dateCreated) return Infinity;
  const t = new Date(dateCreated).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

async function main() {
  const db = getSupabase();

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  AGENTLY — ORPHANED NUMBER RECONCILIATION");
  console.log(`  mode           : ${APPLY ? "APPLY (will release)" : "DRY RUN"}`);
  console.log(`  min age        : ${MIN_AGE_MINUTES} minutes`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  // 1. Every account we might own numbers on.
  const { data: accountRows } = await db
    .from("twilio_accounts")
    .select("account_sid,organization_id,status");

  const accounts = new Map();
  accounts.set(masterSid(), { accountSid: masterSid(), organizationId: null });
  for (const row of accountRows || []) {
    if (!row?.account_sid) continue;
    accounts.set(row.account_sid, {
      accountSid: row.account_sid,
      organizationId: row.organization_id,
      status: row.status,
    });
  }

  // 2. Database view.
  const { data: dbRows } = await db
    .from("twilio_phone_numbers")
    .select(
      "id,phone_sid,phone_number,organization_id,account_sid,lifecycle_status,created_at",
    );

  const dbBySid = new Map();
  for (const row of dbRows || []) {
    if (row?.phone_sid) dbBySid.set(row.phone_sid, row);
  }

  const buckets = {
    MATCHED: [],
    ORPHAN: [],
    RELEASE_PENDING: [],
    GHOST_ROW: [],
    TOO_NEW: [],
  };

  const seenOnCarrier = new Set();

  // 3. Carrier view, per account.
  for (const account of accounts.values()) {
    if (ONLY_ACCOUNT && account.accountSid !== ONLY_ACCOUNT) continue;

    let live = [];
    try {
      live = await listIncomingNumbers({ accountSid: account.accountSid });
    } catch (error) {
      console.log(
        `  ! could not list ${mask(account.accountSid)} — ${error?.message || error}`,
      );
      continue;
    }

    console.log(
      `  account ${mask(account.accountSid)}  org=${account.organizationId || "MASTER"}  numbers=${live.length}`,
    );

    for (const n of live) {
      seenOnCarrier.add(n.sid);
      const row = dbBySid.get(n.sid);
      const age = ageMinutes(n.dateCreated);
      const record = {
        phoneSid: n.sid,
        phoneNumber: n.phoneNumber,
        accountSid: account.accountSid,
        organizationId: account.organizationId,
        ageMinutes: Math.round(age),
        lifecycle: row?.lifecycle_status || null,
      };

      if (!row) {
        if (age < MIN_AGE_MINUTES) buckets.TOO_NEW.push(record);
        else buckets.ORPHAN.push(record);
        continue;
      }

      const lifecycle = String(row.lifecycle_status || "active").toLowerCase();
      if (["released", "release_pending"].includes(lifecycle)) {
        if (age < MIN_AGE_MINUTES) buckets.TOO_NEW.push(record);
        else buckets.RELEASE_PENDING.push({ ...record, rowId: row.id });
      } else {
        buckets.MATCHED.push(record);
      }
    }
  }

  // 4. Ghost rows — active in db, absent on carrier.
  for (const row of dbRows || []) {
    if (!row?.phone_sid) continue;
    if (seenOnCarrier.has(row.phone_sid)) continue;
    const lifecycle = String(row.lifecycle_status || "active").toLowerCase();
    if (["released"].includes(lifecycle)) continue;
    buckets.GHOST_ROW.push({
      rowId: row.id,
      phoneSid: row.phone_sid,
      phoneNumber: row.phone_number,
      organizationId: row.organization_id,
      lifecycle,
    });
  }

  // 5. Report.
  const line = (label, list) =>
    console.log(`  ${label.padEnd(18)} ${String(list.length).padStart(5)}`);

  console.log("");
  console.log("  ─── SUMMARY ────────────────────────────────────────────");
  line("MATCHED", buckets.MATCHED);
  line("ORPHAN", buckets.ORPHAN);
  line("RELEASE_PENDING", buckets.RELEASE_PENDING);
  line("GHOST_ROW", buckets.GHOST_ROW);
  line("TOO_NEW (skipped)", buckets.TOO_NEW);
  console.log("");

  const candidates = [...buckets.ORPHAN, ...buckets.RELEASE_PENDING];

  if (candidates.length) {
    console.log("  ─── RELEASE CANDIDATES ─────────────────────────────────");
    for (const c of candidates) {
      console.log(
        `    ${(c.phoneNumber || "?").padEnd(16)} ${mask(c.phoneSid)}  ` +
          `acct=${mask(c.accountSid)}  age=${c.ageMinutes}m  lifecycle=${c.lifecycle || "NO ROW"}`,
      );
    }
    console.log("");
  }

  if (buckets.GHOST_ROW.length) {
    console.log("  ─── GHOST ROWS (database cleanup only) ─────────────────");
    for (const g of buckets.GHOST_ROW) {
      console.log(
        `    ${(g.phoneNumber || "?").padEnd(16)} ${mask(g.phoneSid)}  org=${g.organizationId}`,
      );
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("  DRY RUN — nothing was changed.");
    console.log("  Re-run with --apply to release the candidates above.");
    console.log("");
    return;
  }

  // 6. Apply.
  let releasedOk = 0;
  let releasedFail = 0;

  for (const c of candidates) {
    try {
      await releaseIncomingNumber({
        accountSid: c.accountSid,
        phoneSid: c.phoneSid,
      });
      releasedOk += 1;
      console.log(`    released ${c.phoneNumber} (${mask(c.phoneSid)})`);
    } catch (error) {
      if (Number(error?.status || 0) === 404) {
        releasedOk += 1;
        console.log(`    already gone ${c.phoneNumber}`);
      } else {
        releasedFail += 1;
        console.log(
          `    FAILED ${c.phoneNumber} — ${error?.message || String(error)}`,
        );
        continue;
      }
    }

    if (c.rowId) {
      await db
        .from("twilio_phone_numbers")
        .update({
          lifecycle_status: "released",
          released_at: new Date().toISOString(),
          release_reason: "orphan_reconciliation",
          updated_at: new Date().toISOString(),
        })
        .eq("id", c.rowId);
    }
  }

  for (const g of buckets.GHOST_ROW) {
    await db
      .from("twilio_phone_numbers")
      .update({
        lifecycle_status: "released",
        released_at: new Date().toISOString(),
        release_reason: "ghost_row_not_on_provider",
        updated_at: new Date().toISOString(),
      })
      .eq("id", g.rowId);
  }

  console.log("");
  console.log(`  released ok      : ${releasedOk}`);
  console.log(`  released failed  : ${releasedFail}`);
  console.log(`  ghost rows fixed : ${buckets.GHOST_ROW.length}`);
  console.log("");
}

main().catch((error) => {
  console.error("reconcile-orphan-numbers failed:", error);
  process.exit(1);
});
