/**
 * agently-server/lib/tenant-teardown.js   <-- NEW FILE
 *
 * PATCH 03 — P0. Implements CURRENT_ISSUES → General Settings → 2(d).
 *
 * PROBLEM TODAY
 *   super-admin.js:444  DELETE /users/:userId  calls exactly one thing:
 *       db.rpc("billing_admin_delete_user_or_org_everything", {...})
 *   There is no releaseIncomingNumber, no subaccount close, no Twilio call of
 *   any kind anywhere in the delete path. Supabase rows vanish; the numbers stay
 *   rented on the master account and keep billing you every month, forever,
 *   with no tenant left to attribute them to.
 *
 * WHAT THIS DOES  (order matters — provider first, database last)
 *   1. Enumerate every number the org owns, from BOTH sides:
 *        a. twilio_phone_numbers rows for the org
 *        b. a live IncomingPhoneNumbers listing on the org's subaccount
 *      (b) is essential: it catches ORPHANS created by the P0-1 purchase bug,
 *      which exist on the carrier but were never written to the database.
 *   2. Release each number. 404 counts as success (already gone).
 *   3. Close the subaccount (Status=closed). Twilio makes this IRREVERSIBLE and
 *      it permanently stops all billing for that subaccount.
 *   4. Only if every release succeeded, run the Supabase purge RPC.
 *      If ANY release failed we stop and report — deleting the rows first would
 *      destroy the only record of which numbers still need releasing.
 *
 * TWILIO REFERENCE (per your note to follow official docs)
 *   Release number : DELETE /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/{Sid}.json
 *                    -> 204 No Content. Billing stops immediately, no proration.
 *   Close subaccnt : POST   /2010-04-01/Accounts/{AccountSid}.json  Status=closed
 *                    -> permanent, cannot be reopened, releases remaining
 *                       resources and halts all charges.
 *   Both authenticate with the PARENT (master) credentials, which is exactly
 *   what lib/twilio-platform.twilioRequest() already does by default.
 *
 * NO WEBHOOK IS REQUIRED for release. Release is synchronous and the 204 is the
 * confirmation. (An optional webhook is only useful for the reverse direction —
 * carrier-initiated number loss — which is out of scope here.)
 */

"use strict";

const { getSupabase } = require("./supabase");
const {
  twilioRequest,
  releaseIncomingNumber,
  listIncomingNumbers,
  masterSid,
} = require("./twilio-platform");

function nowIso() {
  return new Date().toISOString();
}

function maskSid(sid) {
  const s = String(sid || "");
  return s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "";
}

/**
 * Build the definitive list of numbers to release for an organization.
 * Merges the database view with the live carrier view so orphans are caught.
 */
async function collectOrganizationNumbers(db, organizationId) {
  const byS0id = new Map();

  const { data: rows } = await db
    .from("twilio_phone_numbers")
    .select("id,phone_sid,phone_number,account_sid,lifecycle_status")
    .eq("organization_id", organizationId);

  for (const row of rows || []) {
    if (!row?.phone_sid) continue;
    if (String(row.lifecycle_status || "").toLowerCase() === "released") continue;
    byS0id.set(row.phone_sid, {
      phoneSid: row.phone_sid,
      phoneNumber: row.phone_number || "",
      accountSid: row.account_sid || null,
      rowId: row.id,
      knownToDatabase: true,
    });
  }

  // Live carrier listing on the tenant subaccount — catches orphans.
  const { data: accounts } = await db
    .from("twilio_accounts")
    .select("account_sid")
    .eq("organization_id", organizationId);

  for (const account of accounts || []) {
    const sid = account?.account_sid;
    if (!sid || sid === masterSid()) continue;
    try {
      const live = await listIncomingNumbers({ accountSid: sid });
      for (const n of live || []) {
        if (!n?.sid) continue;
        if (byS0id.has(n.sid)) {
          byS0id.get(n.sid).accountSid = byS0id.get(n.sid).accountSid || sid;
          continue;
        }
        byS0id.set(n.sid, {
          phoneSid: n.sid,
          phoneNumber: n.phoneNumber || "",
          accountSid: sid,
          rowId: null,
          knownToDatabase: false, // <-- orphan from the P0-1 purchase bug
        });
      }
    } catch (error) {
      console.warn(
        "[tenant-teardown] could not list live numbers for",
        maskSid(sid),
        error?.message || String(error),
      );
    }
  }

  return [...byS0id.values()];
}

/**
 * Dry run. Powers the super-admin confirmation modal so the operator sees
 * exactly what will be destroyed and released BEFORE typing the confirmation.
 */
async function previewTenantTeardown({ organizationId }) {
  const db = getSupabase();

  const [numbers, { data: org }, { data: accounts }] = await Promise.all([
    collectOrganizationNumbers(db, organizationId),
    db
      .from("organizations")
      .select("id,name")
      .eq("id", organizationId)
      .maybeSingle(),
    db
      .from("twilio_accounts")
      .select("account_sid,friendly_name,status")
      .eq("organization_id", organizationId),
  ]);

  const subaccounts = (accounts || []).filter(
    (a) => a?.account_sid && a.account_sid !== masterSid(),
  );

  return {
    organizationId,
    organizationName: org?.name || null,
    numbers: numbers.map((n) => ({
      phoneNumber: n.phoneNumber,
      phoneSid: n.phoneSid,
      knownToDatabase: n.knownToDatabase,
    })),
    numberCount: numbers.length,
    orphanCount: numbers.filter((n) => !n.knownToDatabase).length,
    subaccounts: subaccounts.map((a) => ({
      accountSid: a.account_sid,
      friendlyName: a.friendly_name,
      status: a.status,
    })),
    subaccountCount: subaccounts.length,
    warnings: [
      "All phone numbers listed above will be permanently released back to the carrier.",
      "Released numbers cannot be recovered and may be resold to another business.",
      "The tenant's dedicated calling account will be permanently closed.",
      "All workspace data will be permanently erased from Agently.",
      "This cannot be undone.",
    ],
  };
}

/**
 * Release every number, then close subaccounts. Provider side only.
 * Returns a per-number result so a partial failure is fully auditable.
 */
async function releaseTenantProviderResources({ organizationId }) {
  const db = getSupabase();
  const numbers = await collectOrganizationNumbers(db, organizationId);

  const released = [];
  const failed = [];

  for (const number of numbers) {
    try {
      await releaseIncomingNumber({
        accountSid: number.accountSid || undefined,
        phoneSid: number.phoneSid,
      });
      released.push(number);
    } catch (error) {
      // 404 => already released upstream. Treat as success, not failure.
      if (Number(error?.status || 0) === 404) {
        released.push({ ...number, alreadyGone: true });
      } else {
        failed.push({
          ...number,
          error: error?.message || String(error),
        });
      }
    }

    if (number.rowId) {
      await db
        .from("twilio_phone_numbers")
        .update({
          lifecycle_status: failed.some((f) => f.phoneSid === number.phoneSid)
            ? "release_pending"
            : "released",
          released_at: nowIso(),
          release_reason: "tenant_account_deleted",
          assigned_voice_agent_id: null,
          updated_at: nowIso(),
        })
        .eq("id", number.rowId)
        .eq("organization_id", organizationId);
    }
  }

  // Close subaccounts only when every number is off them.
  const closedSubaccounts = [];
  const failedSubaccounts = [];

  if (failed.length === 0) {
    const { data: accounts } = await db
      .from("twilio_accounts")
      .select("id,account_sid")
      .eq("organization_id", organizationId);

    for (const account of accounts || []) {
      const sid = account?.account_sid;
      if (!sid || sid === masterSid()) continue; // never touch the master
      try {
        await twilioRequest({
          method: "POST",
          fullUrl: `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
          params: { Status: "closed" },
        });
        closedSubaccounts.push(sid);
        await db
          .from("twilio_accounts")
          .update({ status: "closed", updated_at: nowIso() })
          .eq("id", account.id);
      } catch (error) {
        failedSubaccounts.push({
          accountSid: sid,
          error: error?.message || String(error),
        });
      }
    }
  }

  return {
    organizationId,
    releasedCount: released.length,
    released: released.map((n) => ({
      phoneNumber: n.phoneNumber,
      phoneSid: n.phoneSid,
      wasOrphan: !n.knownToDatabase,
      alreadyGone: n.alreadyGone === true,
    })),
    failedCount: failed.length,
    failed,
    closedSubaccounts,
    failedSubaccounts,
    providerFullyReleased: failed.length === 0 && failedSubaccounts.length === 0,
  };
}

module.exports = {
  previewTenantTeardown,
  releaseTenantProviderResources,
  collectOrganizationNumbers,
};
