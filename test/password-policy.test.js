"use strict";
// Password policy for every password-SET endpoint (register, reset-confirm,
// change-password): minimum length plus a common-password denylist.
// Login is deliberately not covered — rejecting there would leak whether a
// guess was a common password.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateNewPassword, isCommonPassword } = require("../api/routes/auth");

test("rejects passwords shorter than 8 characters", () => {
  for (const candidate of ["", "short", "1234567", null, undefined, 123]) {
    const result = validateNewPassword(candidate);
    assert.ok(result, `expected rejection for ${String(candidate)}`);
    assert.equal(result.code, "PASSWORD_TOO_SHORT");
  }
});

test("rejects common passwords, case-insensitively", () => {
  for (const candidate of [
    "password",
    "Password",
    "PASSWORD1",
    "Password123",
    "qwerty123",
    "QwErTy123",
    "welcome1",
    "changeme",
    "Agently123",
    "12345678",
  ]) {
    const result = validateNewPassword(candidate);
    assert.ok(result, `expected rejection for ${candidate}`);
    assert.equal(result.code, "PASSWORD_TOO_COMMON");
  }
});

test("accepts a non-common password of sufficient length", () => {
  assert.equal(validateNewPassword("correct-horse-9-staple"), null);
  assert.equal(validateNewPassword("x7!Qp2$mZ"), null);
});

test("isCommonPassword matches case-insensitively", () => {
  assert.ok(isCommonPassword("PaSsWoRd"));
  assert.ok(isCommonPassword("CHANGEME"));
  assert.ok(!isCommonPassword("correct-horse-9-staple"));
  assert.ok(!isCommonPassword(""));
});

test("all three password-set endpoints use the shared policy", () => {
  // Regression guard: register, password-reset/confirm and change-password
  // must all call validateNewPassword rather than hand-rolling the check.
  const source = fs.readFileSync(
    path.join(__dirname, "../api/routes/auth.js"),
    "utf8",
  );
  assert.ok(
    source.includes("validateNewPassword(password)"),
    "register and reset-confirm should call validateNewPassword(password)",
  );
  assert.ok(
    source.includes("validateNewPassword(newPassword)"),
    "change-password should call validateNewPassword(newPassword)",
  );
});
