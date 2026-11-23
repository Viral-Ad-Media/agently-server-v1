"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getBackendBaseUrl, AWS_API_URL } = require("../lib/backend-url");

test("a local caller cannot send Twilio callbacks to the retired Vercel API", () => {
  for (const NODE_ENV of ["development", "production"]) {
    assert.equal(getBackendBaseUrl({ API_URL: "https://agently-server-v1.vercel.app/", NODE_ENV }), AWS_API_URL);
  }
});
test("backend URL preserves explicit preview/tunnel hosts and strips trailing slashes", () => {
  assert.equal(getBackendBaseUrl({ API_URL: " https://api.example.test/// " }), "https://api.example.test");
  assert.equal(getBackendBaseUrl({ API_URL: "http://localhost:4000" }), "http://localhost:4000");
  assert.equal(getBackendBaseUrl({}), "");
  assert.throws(() => getBackendBaseUrl({ API_URL: "https://user:secret@example.test" }));
});
