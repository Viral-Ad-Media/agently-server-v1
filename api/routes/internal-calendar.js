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
 *   { organizationId, fromISO?, toISO?, timezone?, voiceAgentId? }
 * POST /api/internal/calendar/book
 *   { organizationId, startISO, attendeeName, attendeeEmail?, attendeePhone?,
 *     title?, notes?, leadId?, callRecordId?, voiceAgentId? }
 * POST /api/internal/calendar/cancel
 *   { organizationId, appointmentId }
 * POST /api/internal/calendar/schedule
 *   { organizationId, fromISO?, toISO? } — owner-mode agenda: every
 *   non-cancelled appointment across ALL of the org's connected business
 *   calendars, each labelled with its business. The ws-server only calls this
 *   from a webcall session it verified as the owner; the phone path never
 *   advertises the tool.
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
  listMergedBookings,
} = require("../../lib/calendar-booking");
const { getOperatorScope, requireCalendar } = require("../../lib/operator-scope");
const { sweepWatchChannels } = require("../../lib/calendar-sync");

const router = express.Router();
const { requireInternalSecret } = require("../../middleware/internal-secret");

router.use(requireInternalSecret);
router.use(asyncHandler(async (req,res,next) => {
  if(req.body.requireAssignment && ["/book","/availability"].includes(req.path)) {
    const scope=await getOperatorScope(getSupabase(),req.body.organizationId,req.body.voiceAgentId);
    await requireCalendar(getSupabase(),req.body.organizationId,scope);
  }
  next();
}));

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatLocalDateTime(value, timeZone) {
  const date = toDate(value);
  if (!date) return null;
  const zone = timeZone || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: zone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
    }).format(date);
  }
}

router.post(
  "/availability",
  asyncHandler(async (req, res) => {
    const { organizationId, fromISO, toISO, timezone, voiceAgentId } = req.body || {};
    if (!organizationId) {
      return res.status(400).json({ error: { code: "missing_organization", message: "organizationId is required." } });
    }
    const result = await checkAvailability(
      organizationId,
      { from: toDate(fromISO), to: toDate(toISO), timeZone: timezone, voiceAgentId: voiceAgentId || null },
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
    if (req.body.voiceAgentId) {
      const db = getSupabase();
      const scope = await getOperatorScope(db, organizationId, req.body.voiceAgentId);
      const calendar = await requireCalendar(db, organizationId, scope);
      const {data: appointment, error} = await db.from("appointments").select("integration_id").eq("organization_id",organizationId).eq("id",appointmentId).maybeSingle();
      if(error) throw error;
      if(!appointment || appointment.integration_id !== calendar.id) return res.json({success:false,message:"Switch to the agent assigned to that appointment's calendar."});
    }
    const result = await cancelAppointment(organizationId, appointmentId, getSupabase());
    res.json(result);
  }),
);

router.post(
  "/schedule",
  asyncHandler(async (req, res) => {
    const { organizationId, fromISO, toISO } = req.body || {};
    if (!organizationId) {
      return res.status(400).json({ error: { code: "missing_organization", message: "organizationId is required." } });
    }
    const scope = await getOperatorScope(getSupabase(), organizationId, req.body.voiceAgentId);
    const calendar = await requireCalendar(getSupabase(), organizationId, scope);
    const from = toDate(fromISO) || new Date();
    const to = toDate(toISO) || new Date(from.getTime() + 24 * 3600 * 1000);
    const { bookings, truncated } = await listMergedBookings(
      organizationId,
      { from: from.toISOString(), to: to.toISOString(), connectionId: calendar.id, limit: 100 },
      getSupabase(),
    );
    const live = bookings.filter((b) => b.status !== "cancelled");
    // Spoken back to the owner, so keep it compact: no emails, no raw rows.
    res.json({
      success: true,
      count: live.length,
      truncated,
      appointments: live.map((b) => ({
        id: b.id,
        business: b.connectionLabel || null,
        attendee: b.attendee_name || null,
          title: b.title || null,
          startsAt: b.starts_at,
          endsAt: b.ends_at,
          timezone: b.timezone,
          localStart: formatLocalDateTime(b.starts_at, b.timezone),
          localEnd: formatLocalDateTime(b.ends_at, b.timezone),
          status: b.status,
      })),
      message: live.length === 0 ? "Nothing on the schedule in that window." : `${live.length} appointment${live.length === 1 ? "" : "s"}.`,
    });
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
