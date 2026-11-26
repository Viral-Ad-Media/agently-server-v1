"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isViewerWriteBlocked } = require("../middleware/auth");
const stripeBilling = require("../lib/stripe-billing");
const {
  getCardWaiver,
  getActivationState,
  assertCanActivate,
} = require("../lib/activation-gate");

const req = (role, method, url) => ({
  user: { role },
  method,
  originalUrl: url,
});

test("viewer: every read is allowed", () => {
  assert.equal(isViewerWriteBlocked(req("Viewer", "GET", "/api/leads")), false);
  assert.equal(
    isViewerWriteBlocked(req("Viewer", "HEAD", "/api/settings")),
    false,
  );
});

test("viewer: writes to the workspace are refused", () => {
  for (const [method, url] of [
    ["PATCH", "/api/settings"],
    ["POST", "/api/twilio/numbers/purchase"],
    ["DELETE", "/api/leads/123"],
    ["PUT", "/api/billing/stripe/auto-topup"],
    ["POST", "/api/team/invitations"],
    ["POST", "/api/organization/delete-request"],
  ]) {
    assert.equal(
      isViewerWriteBlocked(req("Viewer", method, url)),
      true,
      `${method} ${url}`,
    );
  }
});

test("viewer: own account, notifications, help and tour stay writable", () => {
  for (const url of [
    "/api/auth/change-password",
    "/api/auth/logout",
    "/api/auth/sessions/0b7c6a52-9f0e-4c1a-9d1e-1f2a3b4c5d6e",
    "/api/notifications/read-all",
    "/api/platform-assistant/chat?x=1",
    "/api/tour/progress",
  ]) {
    assert.equal(isViewerWriteBlocked(req("Viewer", "POST", url)), false, url);
  }
});

test("owner and admin are not affected by the viewer guard", () => {
  assert.equal(isViewerWriteBlocked(req("Owner", "PATCH", "/api/settings")), false);
  assert.equal(isViewerWriteBlocked(req("Admin", "POST", "/api/leads")), false);
});

function fakeDb(walletMetadata) {
  const chain = (table) => {
    const result =
      table === "billing_wallets"
        ? { data: walletMetadata === undefined ? null : { metadata: walletMetadata }, error: null }
        : { data: null, error: null };
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => result,
      single: async () => result,
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return builder;
  };
  return { from: chain };
}

test("card waiver: read from the wallet, only when explicitly waived", async () => {
  assert.equal(await getCardWaiver(fakeDb(undefined), "org"), null);
  assert.equal(await getCardWaiver(fakeDb({}), "org"), null);
  assert.equal(
    await getCardWaiver(fakeDb({ card_gate_waiver: { waived: false } }), "org"),
    null,
  );
  const waiver = await getCardWaiver(
    fakeDb({ card_gate_waiver: { waived: true, by: "admin@example.com" } }),
    "org",
  );
  assert.equal(waiver.waived, true);
});

test("card waiver: lets a card-less workspace through the activation gate", async (t) => {
  const original = stripeBilling.listSavedCards;
  stripeBilling.listSavedCards = async () => [];
  t.after(() => {
    stripeBilling.listSavedCards = original;
  });

  const blocked = fakeDb({});
  const stateBlocked = await getActivationState(blocked, "org");
  assert.equal(stateBlocked.requiresCard, true);
  await assert.rejects(
    assertCanActivate(blocked, "org", "purchase_number"),
    (error) => error.code === "CARD_REQUIRED" && error.status === 402,
  );

  const waived = fakeDb({ card_gate_waiver: { waived: true } });
  const stateWaived = await getActivationState(waived, "org");
  assert.equal(stateWaived.requiresCard, false);
  assert.equal(stateWaived.cardRequirementWaived, true);
  assert.equal(stateWaived.hasCardOnFile, false);
  await assertCanActivate(waived, "org", "purchase_number");
});
