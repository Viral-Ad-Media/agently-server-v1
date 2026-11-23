"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

test("manual cancellation requires an admin and uses the authenticated organization", async () => {
  const auth = require("../middleware/auth");
  const booking = require("../lib/calendar-booking");
  const database = require("../lib/supabase");
  const saved = { auth: auth.requireAuth, cancel: booking.cancelAppointment, db: database.getSupabase };
  const calls = [];
  auth.requireAuth = (req, res, next) => {
    if (!req.headers.authorization) return res.sendStatus(401);
    req.user = { role: req.headers.authorization }; req.orgId = "trusted-org"; next();
  };
  database.getSupabase = () => ({});
  booking.cancelAppointment = async (org, id) => { calls.push({ org, id }); return { success: id === "own-booking" }; };
  const routePath = require.resolve("../api/routes/integrations");
  delete require.cache[routePath];
  const app = express(); app.use(express.json()); app.use(require(routePath));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/bookings/own-booking/cancel`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Member" } })).status, 403);
    assert.equal(calls.length, 0);
    const result = await fetch(url, { method: "POST", headers: { authorization: "Owner", "content-type": "application/json" }, body: JSON.stringify({ organizationId: "victim-org" }) });
    assert.equal((await result.json()).success, true);
    assert.deepEqual(calls, [{ org: "trusted-org", id: "own-booking" }]);
  } finally {
    server.close(); auth.requireAuth = saved.auth; booking.cancelAppointment = saved.cancel; database.getSupabase = saved.db; delete require.cache[routePath];
  }
});
