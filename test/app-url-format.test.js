"use strict";
/*
 * The frontend's URL shape is configuration, because the API and the frontend
 * deploy separately and a link in the wrong shape fails silently — it renders
 * the marketing page with a 200 rather than erroring. A password-reset or
 * Stripe-return URL in the wrong shape is a dead end for a real customer, and
 * nothing in the logs says so.
 *
 * The default is the part that matters most. An unset APP_HASH_ROUTES must
 * keep emitting fragment links, because that is what production serves today;
 * a variable that is absent must never be the thing that breaks live links.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

/*
 * getAppBaseUrl() reads NODE_ENV when it is CALLED, not when the module loads,
 * so the assertions have to run inside the production window rather than after
 * it. An earlier version of this helper restored NODE_ENV before handing back
 * lazy functions, and every URL came out as localhost — the test was measuring
 * its own teardown.
 */
const APP_URL_MODULE = require.resolve("../lib/app-url");

function withAppUrl(value, fn) {
  /*
   * Evict only this one module. Purging the whole require cache also evicts
   * lib/email.js, which destructures buildAppUrl at load time — the next test
   * to re-require it got a half-built module and died on "buildAppUrl is not
   * a function". A test that reaches outside its own subject breaks whatever
   * runs after it in the shared process.
   */
  delete require.cache[APP_URL_MODULE];
  const had = Object.prototype.hasOwnProperty;
  const prevNodeEnv = had.call(process.env, "NODE_ENV") ? process.env.NODE_ENV : undefined;
  const prevFlag = had.call(process.env, "APP_HASH_ROUTES") ? process.env.APP_HASH_ROUTES : undefined;

  process.env.NODE_ENV = "production";
  if (value === undefined) delete process.env.APP_HASH_ROUTES;
  else process.env.APP_HASH_ROUTES = value;

  try {
    return fn(require("../lib/app-url"));
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevFlag === undefined) delete process.env.APP_HASH_ROUTES;
    else process.env.APP_HASH_ROUTES = prevFlag;
    // Leave a module built under the real environment behind, not one built
    // under this test's temporary production/flag overrides.
    delete require.cache[APP_URL_MODULE];
  }
}

test("an unset flag keeps the fragment shape production serves today", () => {
  withAppUrl(undefined, (u) => {
    assert.equal(u.usesHashRoutes(), true);
    assert.equal(
      u.buildAppUrl("/reset-password?resetToken=abc"),
      "https://www.agentlycall.com/#/reset-password?resetToken=abc",
    );
    assert.equal(u.buildAppPath("/billing"), "#/billing");
  });
});

test("only an explicit false switches to real paths", () => {
  withAppUrl("false", (u) => {
    assert.equal(u.usesHashRoutes(), false);
    assert.equal(
      u.buildAppUrl("/billing?stripe=success"),
      "https://www.agentlycall.com/billing?stripe=success",
    );
    assert.equal(u.buildAppPath("/billing"), "/billing");
  });
  // Case should not decide whether live links work.
  withAppUrl("FALSE", (u) => assert.equal(u.usesHashRoutes(), false));
});

test("anything unrecognised falls back to the fragment, not to real paths", () => {
  // A typo, a stray quote, an empty string left by a deploy script: every one
  // of those must land on the shape production can serve, never the other way.
  for (const value of ["", " ", "no", "0", "nonsense", "True", "hash"]) {
    withAppUrl(value, (u) =>
      assert.equal(
        u.usesHashRoutes(),
        true,
        `APP_HASH_ROUTES=${JSON.stringify(value)} must keep the fragment shape`,
      ),
    );
  }
});

test("the query string survives both shapes", () => {
  withAppUrl("true", (u) =>
    assert.ok(u.buildAppUrl("/billing?a=1&b=2").endsWith("/#/billing?a=1&b=2")),
  );
  withAppUrl("false", (u) =>
    assert.ok(u.buildAppUrl("/billing?a=1&b=2").endsWith(".com/billing?a=1&b=2")),
  );
});

test("a route given without a leading slash is still well formed", () => {
  withAppUrl("true", (u) =>
    assert.equal(u.buildAppUrl("billing"), "https://www.agentlycall.com/#/billing"),
  );
  withAppUrl("false", (u) =>
    assert.equal(u.buildAppUrl("billing"), "https://www.agentlycall.com/billing"),
  );
});

test("the old exported name still resolves, rather than emitting 'undefined'", () => {
  // Anything still importing buildAppHashUrl would otherwise interpolate
  // undefined straight into a customer's email.
  withAppUrl("false", (u) => {
    assert.equal(typeof u.buildAppHashUrl, "function");
    assert.equal(u.buildAppHashUrl, u.buildAppUrl);
  });
});
