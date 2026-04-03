"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeLead } = require("../../lib/serializers");

const router = express.Router();

// ── POST /api/leads ──────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, phone, email, reason, status } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ error: { message: "Lead name is required." } });
    }

    const db = getSupabase();

    const { data: lead, error } = await db
      .from("leads")
      .insert({
        organization_id: req.orgId,
        name: name.trim(),
        phone: phone || "",
        email: email || "",
        reason: reason || "",
        status: status || "new",
        source: "manual",
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create lead." } });
    }

    res.status(201).json(serializeLead(lead));
  }),
);

// ── PATCH /api/leads/:id ─────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, reason, status } = req.body;

    const db = getSupabase();
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (reason !== undefined) updates.reason = reason;
    if (status !== undefined) updates.status = status;
    updates.updated_at = new Date().toISOString();

    const { data: lead, error } = await db
      .from("leads")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !lead) {
      return res.status(404).json({ error: { message: "Lead not found." } });
    }

    res.json(serializeLead(lead));
  }),
);

// ── GET /api/leads/export.csv ────────────────────────────────
router.get(
  "/export.csv",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();

    const { data: leads, error } = await db
      .from("leads")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false });

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to export leads." } });
    }

    const headers = [
      "ID",
      "Name",
      "Phone",
      "Email",
      "Reason",
      "Status",
      "Source",
      "Created At",
    ];
    const rows = (leads || []).map((l) =>
      [
        l.id,
        `"${(l.name || "").replace(/"/g, '""')}"`,
        l.phone || "",
        l.email || "",
        `"${(l.reason || "").replace(/"/g, '""')}"`,
        l.status || "new",
        l.source || "call",
        new Date(l.created_at).toISOString(),
      ].join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="agently-leads.csv"',
    );
    res.send(csv);
  }),
);

module.exports = router;
