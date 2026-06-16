"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

function serialize(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    voiceAgentId: row.voice_agent_id,
    name: row.name,
    status: row.status,
    isActive: row.is_active,
    scheduleType: row.schedule_type,
    startAt: row.start_at,
    timezone: row.timezone,
    callPurpose: row.call_purpose,
    customInstructions: row.custom_instructions,
    leadIds: row.lead_ids || [],
    directRecipients: row.direct_recipients || [],
    progress: row.progress || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const voiceAgentId =
      body.voiceAgentId ||
      body.voice_agent_id ||
      req.organization.active_voice_agent_id;
    if (!voiceAgentId)
      return res
        .status(400)
        .json({ error: { message: "voiceAgentId is required." } });
    const row = {
      organization_id: req.orgId,
      voice_agent_id: voiceAgentId,
      name: body.name || "Scheduled outreach",
      target_type: body.targetType || body.target_type || "direct_number",
      lead_id: body.leadId || body.lead_id || null,
      lead_ids: body.leadIds || body.lead_ids || [],
      direct_recipients: body.directRecipients || body.direct_recipients || [],
      from_number_id: body.fromNumberId || body.from_number_id || null,
      from_number: body.fromNumber || body.from_number || "",
      call_purpose: body.callPurpose || body.call_purpose || "",
      custom_instructions:
        body.customInstructions || body.custom_instructions || "",
      schedule_type: body.scheduleType || body.schedule_type || "one_time",
      start_at: body.startAt || body.start_at || new Date().toISOString(),
      timezone: body.timezone || "America/Chicago",
      status: body.status || "active",
      is_active: (body.status || "active") === "active",
      metadata:
        body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    };
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .insert(row)
      .select("*")
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, schedule: serialize(data) });
  }),
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    let q = db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false });
    if (req.query.status) q = q.eq("status", String(req.query.status));
    if (req.query.agentId)
      q = q.eq("voice_agent_id", String(req.query.agentId));
    const { data, error } = await q.limit(
      Math.min(100, Number(req.query.limit || 50)),
    );
    if (error) throw error;
    res.json({ success: true, schedules: (data || []).map(serialize) });
  }),
);

router.get(
  "/:scheduleId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", req.params.scheduleId)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    res.json({ success: true, schedule: serialize(data) });
  }),
);

router.patch(
  "/:scheduleId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    for (const [input, column] of Object.entries({
      name: "name",
      status: "status",
      callPurpose: "call_purpose",
      call_purpose: "call_purpose",
      customInstructions: "custom_instructions",
      custom_instructions: "custom_instructions",
      startAt: "start_at",
      start_at: "start_at",
      timezone: "timezone",
    })) {
      if (body[input] !== undefined) updates[column] = body[input];
    }
    if (updates.status !== undefined)
      updates.is_active = updates.status === "active";
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .update(updates)
      .eq("id", req.params.scheduleId)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    res.json({ success: true, schedule: serialize(data) });
  }),
);

router.post(
  "/:scheduleId/cancel",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .update({
        status: "cancelled",
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.scheduleId)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    await db
      .from("lead_outreach_runs")
      .update({
        status: "failed",
        error_message: "Schedule cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("schedule_id", data.id)
      .eq("organization_id", req.orgId)
      .eq("status", "queued");
    res.json({ success: true, schedule: serialize(data) });
  }),
);

router.delete(
  "/:scheduleId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    await db
      .from("lead_outreach_schedules")
      .delete()
      .eq("id", req.params.scheduleId)
      .eq("organization_id", req.orgId);
    res.json({ success: true });
  }),
);

router.post(
  "/:scheduleId/run-now",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: schedule, error } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", req.params.scheduleId)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!schedule)
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    const { data: run, error: runError } = await db
      .from("lead_outreach_runs")
      .insert({
        organization_id: req.orgId,
        schedule_id: schedule.id,
        voice_agent_id: schedule.voice_agent_id,
        lead_id: schedule.lead_id || null,
        run_key: `manual-${schedule.id}-${Date.now()}`,
        status: "queued",
        scheduled_for: new Date().toISOString(),
        target_name: req.body?.targetName || "Manual run",
        target_phone: req.body?.targetPhone || schedule.from_number || "",
        metadata: { manualRun: true, requestedBy: req.user?.id || null },
      })
      .select("*")
      .single();
    if (runError) throw runError;
    res.json({ success: true, schedule: serialize(schedule), run });
  }),
);

module.exports = router;
