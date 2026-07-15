"use strict";

const { getSupabase } = require("./supabase");
const { releaseIncomingNumber } = require("./twilio-platform");
const {
  sendNumberRetentionWarningEmail,
  sendNumberRetentionReleasedEmail,
} = require("./email");

const ACTIVE_CASE_STATUSES = ["warning", "release_pending", "releasing"];
const TERMINAL_CASE_STATUSES = ["resolved", "released"];

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function envNumber(name, fallback) {
  const value = safeNumber(process.env[name], fallback);
  return Number.isFinite(value) ? value : fallback;
}

function graceDays() {
  return Math.max(1, Math.floor(envNumber("BILLING_NUMBER_GRACE_DAYS", 5)));
}

function minimumActiveCreditUsd() {
  return Math.max(
    0,
    envNumber(
      "BILLING_NUMBER_RETENTION_MIN_CREDIT_USD",
      envNumber(
        "BILLING_MIN_ACTIVE_CREDIT_USD",
        envNumber("BILLING_MIN_CALL_CREDIT_USD", 1),
      ),
    ),
  );
}

function isOrgExempt(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return false;
  return String(process.env.BILLING_CREDIT_EXEMPT_ORG_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(orgId);
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function deadlineFrom(now = new Date()) {
  return new Date(now.getTime() + graceDays() * 24 * 60 * 60 * 1000);
}

function maskPhoneNumber(value) {
  const phone = String(value || "").trim();
  if (!phone) return "Business number";
  const digits = phone.replace(/\D/g, "");
  const suffix = digits.slice(-4);
  return suffix ? `Number ending ${suffix}` : "Business number";
}

function isManagedPurchasedNumber(row) {
  if (!row || !row.phone_sid) return false;
  if (String(row.lifecycle_status || "active").toLowerCase() === "released") {
    return false;
  }
  if (row.is_platform_test_number === true) return false;

  const source = String(row.source || "").toLowerCase();
  const origin = String(row.purchase_origin || "").toLowerCase();
  const verification = String(row.verification_method || "").toLowerCase();
  const excluded = `${source} ${origin} ${verification}`;

  if (
    /user_owned|caller_id|verified|external|ported|hosted|platform_test|beta_test/.test(
      excluded,
    )
  ) {
    return false;
  }

  return (
    origin === "in_app_purchase" ||
    source === "purchased" ||
    source === "in_app_purchase"
  );
}

async function loadWallet(db, organizationId) {
  const { data, error } = await db
    .from("billing_wallets")
    .select("id,balance_usd,status,minimum_recharge_usd,updated_at")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function loadManagedNumbers(db, organizationId) {
  const { data, error } = await db
    .from("twilio_phone_numbers")
    .select(
      "id,organization_id,phone_number,phone_sid,account_sid,source,purchase_origin,verification_method,lifecycle_status,released_at,is_platform_test_number",
    )
    .eq("organization_id", organizationId)
    .not("phone_sid", "is", null);

  if (error) throw error;
  return (data || []).filter(isManagedPurchasedNumber);
}

async function loadOrganizationPhoneAccountSid(db, organizationId) {
  try {
    const { data, error } = await db
      .from("twilio_accounts")
      .select("account_sid")
      .eq("organization_id", organizationId)
      .eq("is_primary", true)
      .maybeSingle();
    if (!error && String(data?.account_sid || "").trim()) {
      return String(data.account_sid).trim();
    }
  } catch (_) {
    // Older installations may not have the dedicated account table yet.
  }

  try {
    const { data, error } = await db
      .from("organizations")
      .select("twilio_account_sid")
      .eq("id", organizationId)
      .maybeSingle();
    if (!error && String(data?.twilio_account_sid || "").trim()) {
      return String(data.twilio_account_sid).trim();
    }
  } catch (_) {
    // The release attempt below will remain pending until the mapping is fixed.
  }

  return "";
}

async function loadActiveCase(db, organizationId) {
  const { data, error } = await db
    .from("number_retention_cases")
    .select("*")
    .eq("organization_id", organizationId)
    .in("status", ACTIVE_CASE_STATUSES)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function loadLatestCase(db, organizationId) {
  const { data, error } = await db
    .from("number_retention_cases")
    .select("*")
    .eq("organization_id", organizationId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function createCase(db, organizationId, wallet, numbers, now) {
  const startedAt = nowIso(now);
  const deadlineAt = deadlineFrom(now).toISOString();
  const payload = {
    organization_id: organizationId,
    status: "warning",
    minimum_credit_usd: minimumActiveCreditUsd(),
    balance_at_start_usd: safeNumber(wallet?.balance_usd, 0),
    started_at: startedAt,
    deadline_at: deadlineAt,
    number_count: numbers.length,
    phone_numbers_masked: numbers.map((number) =>
      maskPhoneNumber(number.phone_number),
    ),
    last_checked_at: startedAt,
    metadata: {
      grace_days: graceDays(),
      trigger: "wallet_below_minimum",
    },
    created_at: startedAt,
    updated_at: startedAt,
  };

  const { data, error } = await db
    .from("number_retention_cases")
    .insert(payload)
    .select("*")
    .single();

  if (!error) return data;

  // A partial unique index allows only one active case per organization.
  // If two serverless invocations race, reuse the case created by the winner.
  if (error.code === "23505") {
    return loadActiveCase(db, organizationId);
  }
  throw error;
}

async function loadOrganizationRecipients(db, organizationId) {
  const [{ data: organization }, { data: preferredUsers }] = await Promise.all([
    db
      .from("organizations")
      .select("id,name")
      .eq("id", organizationId)
      .maybeSingle(),
    db
      .from("users")
      .select("id,name,email,role")
      .eq("organization_id", organizationId)
      .in("role", ["Owner", "Admin"])
      .order("created_at", { ascending: true }),
  ]);

  let users = (preferredUsers || []).filter((user) => user.email);
  if (!users.length) {
    const { data: fallbackUsers } = await db
      .from("users")
      .select("id,name,email,role")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true })
      .limit(5);
    users = (fallbackUsers || []).filter((user) => user.email);
  }

  return {
    organizationName: organization?.name || "your workspace",
    users,
    emails: [...new Set(users.map((user) => user.email).filter(Boolean))],
  };
}

async function createTenantNotification(db, payload) {
  const { data, error } = await db
    .from("tenant_notifications")
    .insert({
      organization_id: payload.organizationId,
      user_id: payload.userId || null,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      entity_type: "billing",
      entity_id: payload.caseId,
      is_read: false,
      metadata: payload.metadata || {},
      created_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data?.id || null;
}

async function sendInitialWarning(db, retentionCase, numbers) {
  if (!retentionCase) return;

  const recipients = await loadOrganizationRecipients(
    db,
    retentionCase.organization_id,
  );
  const numberLabels = numbers.map((number) =>
    maskPhoneNumber(number.phone_number),
  );

  if (!retentionCase.warning_email_sent_at && recipients.emails.length) {
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await db
      .from("number_retention_cases")
      .update({ warning_email_sent_at: claimedAt, updated_at: claimedAt })
      .eq("id", retentionCase.id)
      .is("warning_email_sent_at", null)
      .select("id")
      .maybeSingle();

    if (!claimError && claimed?.id) {
      try {
        await sendNumberRetentionWarningEmail({
          toEmails: recipients.emails,
          organizationName: recipients.organizationName,
          deadlineAt: retentionCase.deadline_at,
          minimumCreditUsd: safeNumber(retentionCase.minimum_credit_usd, 1),
          numberLabels,
          usageContext: {
            organizationId: retentionCase.organization_id,
            userId: recipients.users[0]?.id || null,
            route: "number_retention.warning",
            billable: false,
            metadata: { retention_case_id: retentionCase.id },
          },
        });
      } catch (error) {
        await db
          .from("number_retention_cases")
          .update({
            warning_email_sent_at: null,
            last_error: error?.message || String(error),
            updated_at: new Date().toISOString(),
          })
          .eq("id", retentionCase.id);
        console.warn(
          "[number-retention] warning email failed",
          retentionCase.organization_id,
          error?.message || String(error),
        );
      }
    }
  }

  if (!retentionCase.warning_notification_id) {
    try {
      const notificationId = await createTenantNotification(db, {
        organizationId: retentionCase.organization_id,
        userId: recipients.users[0]?.id || null,
        caseId: retentionCase.id,
        type: "number_retention_warning",
        title: "Action required to keep your business number",
        body: `Add at least $${safeNumber(retentionCase.minimum_credit_usd, 1).toFixed(2)} in usage credit by ${new Date(retentionCase.deadline_at).toLocaleString()} or your business ${numbers.length === 1 ? "number will" : "numbers will"} be permanently released.`,
        metadata: {
          deadline_at: retentionCase.deadline_at,
          minimum_credit_usd: retentionCase.minimum_credit_usd,
          number_count: numbers.length,
          phone_numbers_masked: numberLabels,
        },
      });

      await db
        .from("number_retention_cases")
        .update({
          warning_notification_id: notificationId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", retentionCase.id);
    } catch (error) {
      console.warn(
        "[number-retention] warning notification failed",
        retentionCase.organization_id,
        error?.message || String(error),
      );
    }
  }
}

async function resolveCase(db, retentionCase, reason, wallet, now) {
  if (!retentionCase) return null;
  const timestamp = nowIso(now);
  const { data, error } = await db
    .from("number_retention_cases")
    .update({
      status: "resolved",
      resolved_at: timestamp,
      resolution_reason: reason,
      balance_at_resolution_usd: safeNumber(wallet?.balance_usd, 0),
      last_checked_at: timestamp,
      updated_at: timestamp,
    })
    .eq("id", retentionCase.id)
    .in("status", ACTIVE_CASE_STATUSES)
    .select("*")
    .maybeSingle();
  if (error) throw error;

  if (retentionCase.warning_notification_id) {
    try {
      await db
        .from("tenant_notifications")
        .update({
          title: "Business number release canceled",
          body: "The required usage credit is available. The scheduled business-number release has been canceled.",
          is_read: true,
          read_at: timestamp,
          metadata: {
            ...(retentionCase.metadata || {}),
            retention_status: "resolved",
            resolution_reason: reason,
            resolved_at: timestamp,
          },
        })
        .eq("id", retentionCase.warning_notification_id)
        .eq("organization_id", retentionCase.organization_id);
    } catch (_) {}
  }

  return data || retentionCase;
}

async function markNumberReleased(db, number, retentionCase, releasedAt) {
  await db
    .from("twilio_phone_numbers")
    .update({
      lifecycle_status: "released",
      released_at: releasedAt,
      release_reason: "insufficient_credit_grace_expired",
      retention_case_id: retentionCase.id,
      assigned_voice_agent_id: null,
      provider_release_error: null,
      updated_at: releasedAt,
    })
    .eq("id", number.id)
    .eq("organization_id", number.organization_id);

  await db
    .from("voice_agents")
    .update({
      twilio_phone_number: "",
      twilio_phone_sid: "",
      updated_at: releasedAt,
    })
    .eq("organization_id", number.organization_id)
    .eq("twilio_phone_sid", number.phone_sid);

  try {
    await db
      .from("agent_phone_number_assignments")
      .delete()
      .eq("organization_id", number.organization_id)
      .eq("phone_number_id", number.id);
  } catch (_) {}

  try {
    await db
      .from("agent_phone_number_assignments")
      .delete()
      .eq("organization_id", number.organization_id)
      .eq("phone_sid", number.phone_sid);
  } catch (_) {}
}

async function recordNumberReleaseFailure(db, number, error, now) {
  try {
    await db
      .from("twilio_phone_numbers")
      .update({
        provider_release_error: error?.message || String(error),
        updated_at: nowIso(now),
      })
      .eq("id", number.id)
      .eq("organization_id", number.organization_id);
  } catch (_) {}
}

async function sendReleaseConfirmation(db, retentionCase, numberLabels) {
  if (!retentionCase) return;

  const recipients = await loadOrganizationRecipients(
    db,
    retentionCase.organization_id,
  );
  const releasedLabels = (numberLabels || []).filter(Boolean);

  if (!retentionCase.release_email_sent_at && recipients.emails.length) {
    const claimedAt = new Date().toISOString();
    const { data: claimed } = await db
      .from("number_retention_cases")
      .update({ release_email_sent_at: claimedAt, updated_at: claimedAt })
      .eq("id", retentionCase.id)
      .is("release_email_sent_at", null)
      .select("id")
      .maybeSingle();

    if (claimed?.id) {
      try {
        await sendNumberRetentionReleasedEmail({
          toEmails: recipients.emails,
          organizationName: recipients.organizationName,
          numberLabels: releasedLabels,
          usageContext: {
            organizationId: retentionCase.organization_id,
            userId: recipients.users[0]?.id || null,
            route: "number_retention.released",
            billable: false,
            metadata: { retention_case_id: retentionCase.id },
          },
        });
      } catch (error) {
        await db
          .from("number_retention_cases")
          .update({
            release_email_sent_at: null,
            last_error: error?.message || String(error),
            updated_at: new Date().toISOString(),
          })
          .eq("id", retentionCase.id);
        console.warn(
          "[number-retention] release email failed",
          retentionCase.organization_id,
          error?.message || String(error),
        );
      }
    }
  }

  try {
    const existing = await db
      .from("tenant_notifications")
      .select("id")
      .eq("organization_id", retentionCase.organization_id)
      .eq("type", "number_retention_released")
      .eq("entity_id", retentionCase.id)
      .limit(1)
      .maybeSingle();

    if (!existing.data?.id) {
      await createTenantNotification(db, {
        organizationId: retentionCase.organization_id,
        userId: recipients.users[0]?.id || null,
        caseId: retentionCase.id,
        type: "number_retention_released",
        title: "Your business number was permanently released",
        body: `${releasedLabels.length === 1 ? "The business number" : `${releasedLabels.length} business numbers`} linked to this workspace can no longer be recovered. Add credit to reactivate services and purchase a new number.`,
        metadata: {
          released_at: retentionCase.released_at,
          number_count: releasedLabels.length,
          phone_numbers_masked: releasedLabels,
        },
      });
    }
  } catch (error) {
    console.warn(
      "[number-retention] release notification failed",
      retentionCase.organization_id,
      error?.message || String(error),
    );
  }
}

async function releaseNumbers(db, retentionCase, numbers, now) {
  const releaseStartedAt = nowIso(now);
  await db
    .from("number_retention_cases")
    .update({
      status: "releasing",
      release_started_at: releaseStartedAt,
      last_checked_at: releaseStartedAt,
      updated_at: releaseStartedAt,
    })
    .eq("id", retentionCase.id)
    .in("status", ACTIVE_CASE_STATUSES);

  const results = [];
  const organizationAccountSid = await loadOrganizationPhoneAccountSid(
    db,
    retentionCase.organization_id,
  );

  for (const number of numbers) {
    try {
      const accountSid = String(
        number.account_sid || organizationAccountSid || "",
      ).trim();
      if (!accountSid) {
        throw Object.assign(
          new Error(
            "The business number is missing its organization account mapping.",
          ),
          { code: "NUMBER_ACCOUNT_MAPPING_REQUIRED" },
        );
      }
      await releaseIncomingNumber({
        accountSid,
        phoneSid: number.phone_sid,
      });
      const releasedAt = new Date().toISOString();
      await markNumberReleased(db, number, retentionCase, releasedAt);
      results.push({
        numberId: number.id,
        phoneSid: number.phone_sid,
        phoneNumberMasked: maskPhoneNumber(number.phone_number),
        status: "released",
        releasedAt,
      });
    } catch (error) {
      // A 404 means the number is already gone from the provider account. Treat it
      // as released locally so the cleanup remains idempotent.
      if (Number(error?.status || 0) === 404) {
        const releasedAt = new Date().toISOString();
        await markNumberReleased(db, number, retentionCase, releasedAt);
        results.push({
          numberId: number.id,
          phoneSid: number.phone_sid,
          phoneNumberMasked: maskPhoneNumber(number.phone_number),
          status: "already_released",
          releasedAt,
        });
      } else {
        await recordNumberReleaseFailure(db, number, error, now);
        results.push({
          numberId: number.id,
          phoneSid: number.phone_sid,
          phoneNumberMasked: maskPhoneNumber(number.phone_number),
          status: "failed",
          error: error?.message || String(error),
        });
      }
    }
  }

  const previousResults = Array.isArray(retentionCase.release_results)
    ? retentionCase.release_results
    : [];
  const mergedByNumber = new Map();
  for (const item of [...previousResults, ...results]) {
    if (item?.numberId) mergedByNumber.set(item.numberId, item);
  }
  const mergedResults = [...mergedByNumber.values()];
  const failedCount = mergedResults.filter(
    (item) => item.status === "failed",
  ).length;
  const releasedCount = mergedResults.filter(
    (item) => item.status !== "failed",
  ).length;
  const finishedAt = new Date().toISOString();
  const status = failedCount > 0 ? "release_pending" : "released";

  const { data: updatedCase, error } = await db
    .from("number_retention_cases")
    .update({
      status,
      released_at: status === "released" ? finishedAt : null,
      released_number_count: releasedCount,
      failed_number_count: failedCount,
      release_results: mergedResults,
      last_checked_at: finishedAt,
      last_error:
        failedCount > 0
          ? `${failedCount} number release ${failedCount === 1 ? "attempt is" : "attempts are"} pending retry.`
          : null,
      updated_at: finishedAt,
    })
    .eq("id", retentionCase.id)
    .select("*")
    .single();

  if (error) throw error;
  if (status === "released") {
    const allReleasedLabels = mergedResults
      .filter((item) => item.status !== "failed")
      .map((item) => item.phoneNumberMasked)
      .filter(Boolean);
    await sendReleaseConfirmation(db, updatedCase, allReleasedLabels);
  }

  return {
    case: updatedCase,
    releasedCount,
    failedCount,
    results,
  };
}

async function reconcileOrganizationNumberRetention({
  organizationId,
  allowRelease = true,
  now = new Date(),
} = {}) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) throw new Error("organizationId is required.");

  const db = getSupabase();
  const numbers = await loadManagedNumbers(db, orgId);
  let retentionCase = await loadActiveCase(db, orgId);

  if (!numbers.length) {
    if (retentionCase) {
      retentionCase = await resolveCase(
        db,
        retentionCase,
        "no_managed_numbers",
        null,
        now,
      );
    }
    return { organizationId: orgId, active: false, numbers: 0, case: retentionCase };
  }

  const wallet = await loadWallet(db, orgId);
  const balanceUsd = safeNumber(wallet?.balance_usd, 0);
  const minimumUsd = minimumActiveCreditUsd();
  const hasEnoughCredit =
    isOrgExempt(orgId) ||
    (String(wallet?.status || "active").toLowerCase() === "active" &&
      balanceUsd >= minimumUsd);

  if (hasEnoughCredit) {
    if (retentionCase) {
      retentionCase = await resolveCase(
        db,
        retentionCase,
        isOrgExempt(orgId) ? "organization_exempt" : "credit_restored",
        wallet,
        now,
      );
    }
    return {
      organizationId: orgId,
      active: false,
      balanceUsd,
      minimumUsd,
      numbers: numbers.length,
      case: retentionCase,
    };
  }

  if (!retentionCase) {
    retentionCase = await createCase(db, orgId, wallet, numbers, now);
  } else {
    await db
      .from("number_retention_cases")
      .update({
        balance_last_seen_usd: balanceUsd,
        number_count: numbers.length,
        phone_numbers_masked: numbers.map((number) =>
          maskPhoneNumber(number.phone_number),
        ),
        last_checked_at: nowIso(now),
        updated_at: nowIso(now),
      })
      .eq("id", retentionCase.id);
  }

  await sendInitialWarning(db, retentionCase, numbers);

  const deadline = new Date(retentionCase.deadline_at).getTime();
  if (allowRelease && Number.isFinite(deadline) && now.getTime() >= deadline) {
    // Final balance check immediately before releasing any number.
    const latestWallet = await loadWallet(db, orgId);
    const latestBalance = safeNumber(latestWallet?.balance_usd, 0);
    if (
      String(latestWallet?.status || "active").toLowerCase() === "active" &&
      latestBalance >= minimumUsd
    ) {
      const resolved = await resolveCase(
        db,
        retentionCase,
        "credit_restored_before_release",
        latestWallet,
        now,
      );
      return {
        organizationId: orgId,
        active: false,
        balanceUsd: latestBalance,
        minimumUsd,
        numbers: numbers.length,
        case: resolved,
      };
    }

    const release = await releaseNumbers(db, retentionCase, numbers, now);
    return {
      organizationId: orgId,
      active: release.failedCount > 0,
      balanceUsd: latestBalance,
      minimumUsd,
      numbers: numbers.length,
      ...release,
    };
  }

  return {
    organizationId: orgId,
    active: true,
    balanceUsd,
    minimumUsd,
    numbers: numbers.length,
    case: retentionCase,
  };
}

async function getNumberRetentionStatus(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return null;

  const db = getSupabase();
  const retentionCase = await loadLatestCase(db, orgId);
  if (!retentionCase) return null;

  const now = Date.now();
  const deadline = new Date(retentionCase.deadline_at || 0).getTime();
  const remainingMs = Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
  const status = String(retentionCase.status || "").toLowerCase();
  const warningActive = ACTIVE_CASE_STATUSES.includes(status);
  const releasedRecently =
    status === "released" &&
    new Date(retentionCase.released_at || 0).getTime() >
      now - 30 * 24 * 60 * 60 * 1000;

  if (!warningActive && !releasedRecently) return null;

  return {
    active: warningActive,
    status,
    caseId: retentionCase.id,
    startedAt: retentionCase.started_at,
    deadlineAt: retentionCase.deadline_at,
    releasedAt: retentionCase.released_at,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    graceDays: graceDays(),
    minimumCreditUsd: safeNumber(
      retentionCase.minimum_credit_usd,
      minimumActiveCreditUsd(),
    ),
    numberCount: Number(
      retentionCase.number_count || retentionCase.released_number_count || 0,
    ),
    phoneNumbersMasked: retentionCase.phone_numbers_masked || [],
    releasedNumberCount: Number(retentionCase.released_number_count || 0),
    failedNumberCount: Number(retentionCase.failed_number_count || 0),
  };
}

async function listOrganizationsWithManagedNumbers(db) {
  const maxRows = Math.max(
    100,
    Math.min(10000, Math.floor(envNumber("NUMBER_RETENTION_SWEEP_MAX_NUMBERS", 5000))),
  );
  const pageSize = 500;
  const rows = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await db
      .from("twilio_phone_numbers")
      .select(
        "id,organization_id,phone_number,phone_sid,account_sid,source,purchase_origin,verification_method,lifecycle_status,released_at,is_platform_test_number",
      )
      .not("phone_sid", "is", null)
      .range(from, Math.min(from + pageSize - 1, maxRows - 1));
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return [
    ...new Set(
      rows
        .filter(isManagedPurchasedNumber)
        .map((row) => row.organization_id)
        .filter(Boolean),
    ),
  ];
}

async function runNumberRetentionSweep({ limit = 250, now = new Date() } = {}) {
  const db = getSupabase();
  const organizationIds = await listOrganizationsWithManagedNumbers(db);
  const selected = organizationIds.slice(0, Math.max(1, Number(limit) || 250));
  const results = [];

  for (const organizationId of selected) {
    try {
      const result = await reconcileOrganizationNumberRetention({
        organizationId,
        allowRelease: true,
        now,
      });
      results.push({ organizationId, ok: true, ...result });
    } catch (error) {
      results.push({
        organizationId,
        ok: false,
        error: error?.message || String(error),
      });
      console.error(
        "[number-retention] sweep failed",
        organizationId,
        error?.message || String(error),
      );
    }
  }

  return {
    checkedAt: nowIso(now),
    organizationsFound: organizationIds.length,
    organizationsProcessed: selected.length,
    warningsActive: results.filter((item) => item.active).length,
    organizationsWithReleaseFailures: results.filter(
      (item) => Number(item.failedCount || 0) > 0,
    ).length,
    releasedNumbers: results.reduce(
      (sum, item) => sum + Number(item.releasedCount || 0),
      0,
    ),
    results,
  };
}

module.exports = {
  ACTIVE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  graceDays,
  minimumActiveCreditUsd,
  isManagedPurchasedNumber,
  maskPhoneNumber,
  reconcileOrganizationNumberRetention,
  getNumberRetentionStatus,
  runNumberRetentionSweep,
};
