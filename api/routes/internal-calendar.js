"use strict";

/**
 * Internal calendar endpoints for the ws-server (Twilio voice path).
 *
 * The ws-server runs in its own container and cannot import this repo's lib/
 * directly, so the booking service is exposed here over HTTP. Authentication
 * is a shared secret (INTERNAL_API_SECRET) in the x-agently-internal-secret
 * header — the same trust model as the existing /_internal/billing-sync
 * route. The secret must be set on BOTH containers; when it is missing the
 * endpoints fail closed with 503.
 *
 * POST /api/internal/calendar/availability
 *   { organizationId, fromISO?, toISO?, timezone? }
 * POST /api/internal/calendar/book
 *   { organizationId, startISO, attendeeName, attendeeEmail?, attendeePhone?,
 *     title?, notes?, leadId?, callRecordId?, voiceAgentId? }
 * POST /api/internal/calendar/cancel
 *   { organizationId, appointmentId }
 * POST /api/internal/calendar/sweep
 *   {} — renew Google watch channels expiring within 24h. Hit daily from the
 *   deployment's scheduler (e.g. EventBridge Scheduler on Lightsail).
 *
 * Responses are the booking service's plain-JSON results ({ success, ... }).
 * HTTP 200 always carries the result; 4xx/5xx are reserved for transport and
 * auth failures, never for "slot taken" (that is success:false in the body).
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const {
  checkAvailability,
  bookAppointment,
  cancelAppointment,
} = require("../../lib/calendar-booking");
const { sweepWatchChannels } = require("../../lib/calendar-sync");

const router = express.Router();
const INTERNAL_HEADER = "x-agently-internal-secret";

function requireInternalSecret(req, res, next) {
  const expected = String(process.env.INTERNAL_API_SECRET || "");
  if (!expected) {
    return res.status(503).json({
      error: {
        code: "internal_not_configured",
        message: "Calendar booking is not configured on the API server.",
      },
    });
  }
  const provided = String(req.headers[INTERNAL_HEADER] || "");
  if (!provided || provided.length !== expected.length) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } });
  }
  // Constant-time compare: the header value is attacker-controlled.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } });
  }
  next();
}

router.use(requireInternalSecret);

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.post(
  "/availability",
  asyncHandler(async (req, res) => {
    const { organizationId, fromISO, toISO, timezone } = req.body || {};
    if (!organizationId) {
      return res.status(400).json({ error: { code: "missing_organization", message: "organizationId is required." } });
    }
    const result = await checkAvailability(
      organizationId,
      { from: toDate(fromISO), to: toDate(toISO), timeZone: timezone },
      getSupabase(),
    );
    res.json(result);
  }),
);

router.post(
  "/book",
  asyncHandler(async (req, res) => {
    const {
      organizationId,
      startISO,
      attendeeName,
      attendeeEmail,
      attendeePhone,
      title,
      notes,
      leadId,
      callRecordId,
      voiceAgentId,
    } = req.body || {};
    if (!organizationId || !startISO || !attendeeName) {
      return res.status(400).json({
        error: {
          code: "missing_params",
          message: "organizationId, startISO and attendeeName are required.",
        },
      });
    }
    const result = await bookAppointment(
      organizationId,
      {
        startISO,
        attendeeName,
        attendeeEmail,
        attendeePhone,
        title,
        notes,
        leadId,
        callRecordId,
        voiceAgentId,
      },
      getSupabase(),
    );
    res.json(result);
  }),
);

router.post(
  "/cancel",
  asyncHandler(async (req, res) => {
    const { organizationId, appointmentId } = req.body || {};
    if (!organizationId || !appointmentId) {
      return res.status(400).json({
        error: { code: "missing_params", message: "organizationId and appointmentId are required." },
      });
    }
    const result = await cancelAppointment(organizationId, appointmentId, getSupabase());
    res.json(result);
  }),
);

router.post(
  "/sweep",
  asyncHandler(async (req, res) => {
    const summary = await sweepWatchChannels(getSupabase());
    res.json({ ok: true, ...summary });
  }),
);

module.exports = router;
