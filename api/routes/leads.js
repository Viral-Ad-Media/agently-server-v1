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
        tags: [],
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
    const { name, phone, email, reason, status, tags, voiceAgentId } = req.body;

    const db = getSupabase();
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (reason !== undefined) updates.reason = reason;
    if (status !== undefined) updates.status = status;
    if (tags !== undefined) updates.tags = tags;
    if (voiceAgentId !== undefined) updates.voice_agent_id = voiceAgentId;
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

// ── PATCH /api/leads/bulk/tags ───────────────────────────────
router.patch(
  "/bulk/tags",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { ids, tags, action = "add" } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "ids array is required." } });
    }
    if (!Array.isArray(tags) || tags.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "tags array is required." } });
    }

    const db = getSupabase();
    const { data: leads } = await db
      .from("leads")
      .select("id, tags")
      .in("id", ids)
      .eq("organization_id", req.orgId);

    if (!leads || leads.length === 0) {
      return res.status(404).json({ error: { message: "No leads found." } });
    }

    for (const lead of leads) {
      let currentTags = Array.isArray(lead.tags) ? lead.tags : [];
      let newTags;
      if (action === "add") {
        newTags = [...new Set([...currentTags, ...tags])];
      } else if (action === "remove") {
        newTags = currentTags.filter((t) => !tags.includes(t));
      } else {
        newTags = tags;
      }
      await db
        .from("leads")
        .update({ tags: newTags, updated_at: new Date().toISOString() })
        .eq("id", lead.id);
    }

    // Return updated leads
    const { data: updatedLeads } = await db
      .from("leads")
      .select("*")
      .in("id", ids)
      .order("created_at", { ascending: false });

    res.json({ success: true, leads: updatedLeads.map(serializeLead) });
  }),
);

// ── PATCH /api/leads/bulk/assign-agent ───────────────────────
router.patch(
  "/bulk/assign-agent",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { ids, voiceAgentId } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "ids array is required." } });
    }
    if (!voiceAgentId) {
      return res
        .status(400)
        .json({ error: { message: "voiceAgentId is required." } });
    }

    const db = getSupabase();

    // Verify agent belongs to this org
    const { data: agent } = await db
      .from("voice_agents")
      .select("id")
      .eq("id", voiceAgentId)
      .eq("organization_id", req.orgId)
      .single();

    if (!agent) {
      return res
        .status(404)
        .json({ error: { message: "Voice agent not found." } });
    }

    // Update leads
    const { data: updatedLeads, error } = await db
      .from("leads")
      .update({
        voice_agent_id: voiceAgentId,
        updated_at: new Date().toISOString(),
      })
      .in("id", ids)
      .eq("organization_id", req.orgId)
      .select();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to assign agent." } });
    }

    res.json({
      success: true,
      updated: updatedLeads.length,
      leads: updatedLeads.map(serializeLead),
    });
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
      "Tags",
      "Voice Agent ID",
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
        Array.isArray(l.tags) ? l.tags.join(",") : "",
        l.voice_agent_id || "",
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

// ── POST /api/leads/import-csv ───────────────────────────────
router.post(
  "/import-csv",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { csv } = req.body;
    if (!csv || typeof csv !== "string") {
      return res
        .status(400)
        .json({ error: { message: "csv field with CSV text is required." } });
    }

    const db = getSupabase();
    const orgId = req.orgId;
    const lines = csv
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return res.status(400).json({
        error: {
          message: "CSV must have a header row and at least one data row.",
        },
      });
    }

    const headers = lines[0]
      .split(",")
      .map((h) => h.replace(/"/g, "").trim().toLowerCase());
    const idx = {
      name: headers.findIndex((h) => h.includes("name")),
      phone: headers.findIndex(
        (h) => h.includes("phone") || h.includes("mobile"),
      ),
      email: headers.findIndex((h) => h.includes("email")),
      reason: headers.findIndex(
        (h) =>
          h.includes("reason") || h.includes("note") || h.includes("message"),
      ),
      tags: headers.findIndex((h) => h.includes("tag")),
    };

    const parseCell = (row, i) =>
      i >= 0 ? (row[i] || "").replace(/^"|"$/g, "").trim() : "";

    const rows = lines
      .slice(1)
      .map((line) => {
        const cells = line.split(",");
        const tagsStr = parseCell(cells, idx.tags);
        let tags = [];
        if (tagsStr) {
          tags = tagsStr
            .split("|")
            .map((t) => t.trim())
            .filter(Boolean);
        }
        return {
          organization_id: orgId,
          name: parseCell(cells, idx.name) || "Unknown",
          phone: parseCell(cells, idx.phone) || "",
          email: parseCell(cells, idx.email) || "",
          reason: parseCell(cells, idx.reason) || "",
          tags,
          status: "new",
          source: "csv_import",
        };
      })
      .filter((r) => r.name !== "Unknown" || r.phone || r.email);

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "No valid leads found in CSV." } });
    }

    let imported = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { data } = await db.from("leads").insert(chunk).select("id");
      imported += (data || []).length;
    }

    res.json({ success: true, imported, total: rows.length });
  }),
);

module.exports = router;
