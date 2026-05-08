"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const { data, error } = await db
      .from("tenant_notifications")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, notifications: data || [] });
  }),
);

router.get(
  "/unread-count",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { count, error } = await db
      .from("tenant_notifications")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", req.orgId)
      .eq("is_read", false);
    if (error) throw error;
    res.json({ success: true, unreadCount: count || 0 });
  }),
);

router.patch(
  "/:notificationId/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("tenant_notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("id", req.params.notificationId)
      .eq("organization_id", req.orgId)
      .select("*")
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: { message: "Notification not found." } });
    res.json({ success: true, notification: data });
  }),
);

router.patch(
  "/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { error } = await db
      .from("tenant_notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("organization_id", req.orgId)
      .eq("is_read", false);
    if (error) throw error;
    res.json({ success: true });
  }),
);

router.delete(
  "/:notificationId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { error } = await db
      .from("tenant_notifications")
      .delete()
      .eq("id", req.params.notificationId)
      .eq("organization_id", req.orgId);
    if (error) throw error;
    res.json({ success: true });
  }),
);

module.exports = router;
