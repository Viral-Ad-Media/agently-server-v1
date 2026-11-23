"use strict";

/**
 * Send-from-Gmail for tenants. Connecting goes through the shared OAuth flow
 * (POST /api/integrations/gmail/start-token). These routes manage the
 * connected senders, draft a personal email with AI, and send it.
 *
 *   GET    /api/email/gmail/connections
 *   POST   /api/email/gmail/connections/:id/default
 *   PATCH  /api/email/gmail/connections/:id/automations  { booking_confirmation }
 *   DELETE /api/email/gmail/connections/:id
 *   POST   /api/email/gmail/draft  { purpose, leadId?, appointmentId?, link?, notes?, to? }
 *   POST   /api/email/gmail/send   { to, subject, body, purpose?, leadId?, appointmentId?, connectionId? }
 *
 * Everything is scoped to req.orgId. A leadId / appointmentId from the client
 * is only ever read through an organization_id filter.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const gmail = require("../../lib/gmail-send");

const router = express.Router();

async function loadLead(db, organizationId, leadId) {
  if (!leadId) return null;
  const { data } = await db
    .from("leads")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", String(leadId))
    .maybeSingle();
  return data || null;
}

async function loadAppointment(db, organizationId, appointmentId) {
  if (!appointmentId) return null;
  const { data } = await db
    .from("appointments")
    .select("id, title, attendee_name, attendee_email, starts_at, timezone, reschedule_url")
    .eq("organization_id", organizationId)
    .eq("id", String(appointmentId))
    .maybeSingle();
  return data || null;
}

function formatWhen(iso, timeZone) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: timeZone || "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch (_) {
    return new Date(iso).toISOString();
  }
}

router.get(
  "/connections",
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const connections = await gmail.listEmailConnections(getSupabase(), req.orgId);
      res.json({ connections, dailyCap: gmail.DAILY_SEND_CAP, setupRequired: false });
    } catch (error) {
      // The table does not exist until migrations/20261007_gmail_send.sql
      // runs. Say so plainly instead of surfacing a PostgREST error.
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        return res.json({ connections: [], dailyCap: gmail.DAILY_SEND_CAP, setupRequired: true });
      }
      throw error;
    }
  }),
);

router.post(
  "/connections/:id/default",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await gmail.setDefaultEmailConnection(getSupabase(), req.orgId, req.params.id);
    if (!row) return res.status(404).json({ error: { message: "Gmail connection not found." } });
    res.json({ connection: row });
  }),
);

router.patch(
  "/connections/:id/automations",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await gmail.updateEmailAutomations(getSupabase(), req.orgId, req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: { message: "Gmail connection not found." } });
    res.json({ connection: row });
  }),
);

router.delete(
  "/connections/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ok = await gmail.disconnectEmailConnection(getSupabase(), req.orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: { message: "Gmail connection not found." } });
    res.json({ ok: true });
  }),
);

router.post(
  "/draft",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const [lead, appointment, orgResult] = await Promise.all([
      loadLead(db, req.orgId, body.leadId),
      loadAppointment(db, req.orgId, body.appointmentId),
      db.from("organizations").select("name").eq("id", req.orgId).maybeSingle(),
    ]);
    const link = body.link ? String(body.link).trim().slice(0, 1000) : appointment && appointment.reschedule_url ? appointment.reschedule_url : null;
    if (link && !/^https?:\/\//i.test(link)) {
      return res.status(400).json({ error: { message: "The link must start with http:// or https://." } });
    }
    const draft = await gmail.draftEmail(
      {
        purpose: body.purpose,
        businessName: (orgResult && orgResult.data && orgResult.data.name) || "",
        senderName: (req.user && req.user.name) || "",
        lead: lead && {
          name: lead.name || lead.full_name || null,
          company: lead.company || null,
          notes: lead.notes || null,
          summary: lead.summary || lead.call_summary || null,
        },
        appointment: appointment && {
          when: formatWhen(appointment.starts_at, appointment.timezone),
          title: appointment.title,
        },
        link,
        notes: body.notes || null,
      },
      { usageContext: { organizationId: req.orgId, userId: req.user && req.user.id, leadId: lead && lead.id } },
    );
    res.json({
      ...draft,
      to: body.to || (lead && lead.email) || (appointment && appointment.attendee_email) || "",
    });
  }),
);

router.post(
  "/send",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    // Ids are re-read through the org filter so a foreign id is dropped, not logged.
    const [lead, appointment] = await Promise.all([
      loadLead(db, req.orgId, body.leadId),
      loadAppointment(db, req.orgId, body.appointmentId),
    ]);
    const result = await gmail.sendGmail(db, req.orgId, {
      to: body.to,
      subject: body.subject,
      body: body.body,
      purpose: body.purpose,
      connectionId: body.connectionId || null,
      leadId: lead ? lead.id : null,
      appointmentId: appointment ? appointment.id : null,
      userId: req.user && req.user.id,
    });
    res.json(result);
  }),
);

module.exports = router;
