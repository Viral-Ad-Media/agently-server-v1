"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeLead } = require("../../lib/serializers");

const router = express.Router();

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [
    ...new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean)),
  ];
}

function serializeSchedule(row) {
  return {
    id: row.id,
    name: row.name || "",
    targetType: row.target_type,
    leadId: row.lead_id || "",
    tag: row.tag || "",
    voiceAgentId: row.voice_agent_id || "",
    windows: Array.isArray(row.windows) ? row.windows : [],
    timezone: row.timezone || "America/New_York",
    extraContext: row.extra_context || "",
    isActive: row.is_active ?? true,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function parseCsv(csv) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  row.push(current);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

function cell(row, index) {
  if (index < 0) return "";
  return String(row[index] || "").trim();
}

// Validate a string is a UUID; return it if valid, else null.
// Prevents CSV-supplied voice_agent_id strings from breaking the FK constraint.
function validUuidOrNull(s) {
  if (!s) return null;
  const v = String(s).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

function parseScheduleWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return [{ weekdays: ["mon", "tue", "wed", "thu", "fri"], time: "10:00" }];
  }
  return windows
    .map((window) => ({
      weekdays: Array.isArray(window?.weekdays)
        ? [
            ...new Set(
              window.weekdays
                .map((value) => String(value || "").toLowerCase())
                .filter(Boolean),
            ),
          ]
        : [],
      time: String(window?.time || "10:00").slice(0, 5),
    }))
    .filter(
      (window) =>
        window.weekdays.length > 0 && /^\d{2}:\d{2}$/.test(window.time),
    );
}

// ── POST /api/leads ────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const {
      name,
      phone,
      email,
      reason,
      status,
      tags,
      voiceAgentId,
      assignmentContext,
    } = req.body || {};
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
        tags: normalizeTags(tags),
        voice_agent_id: voiceAgentId || null,
        assignment_context: assignmentContext || "",
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to create lead." },
      });
    }

    res.status(201).json(serializeLead(lead));
  }),
);

// ── GET /api/leads/export.csv ──────────────────────────────────
// NOTE: Must be before /:id to avoid "export.csv" being treated as an id
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
      return res.status(500).json({
        error: { message: error.message || "Failed to export leads." },
      });
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
      "Assignment Context",
      "Created At",
    ];
    const rows = (leads || []).map((lead) =>
      [
        lead.id,
        `"${String(lead.name || "").replace(/"/g, '""')}"`,
        lead.phone || "",
        lead.email || "",
        `"${String(lead.reason || "").replace(/"/g, '""')}"`,
        lead.status || "new",
        lead.source || "call",
        normalizeTags(lead.tags).join("|"),
        lead.voice_agent_id || "",
        `"${String(lead.assignment_context || "").replace(/"/g, '""')}"`,
        new Date(lead.created_at).toISOString(),
      ].join(","),
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="agently-leads.csv"',
    );
    res.send([headers.join(","), ...rows].join("\n"));
  }),
);

// ── POST /api/leads/import-csv ─────────────────────────────────
// NOTE: Must be before /:id
router.post(
  "/import-csv",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { csv } = req.body || {};
    if (!csv || typeof csv !== "string") {
      return res
        .status(400)
        .json({ error: { message: "csv field with CSV text is required." } });
    }

    const rows = parseCsv(csv);
    if (rows.length < 2) {
      return res.status(400).json({
        error: {
          message: "CSV must have a header row and at least one data row.",
        },
      });
    }

    const headers = rows[0].map((header) =>
      String(header || "")
        .replace(/"/g, "")
        .trim()
        .toLowerCase(),
    );
    const indexMap = {
      name: headers.findIndex((header) => header.includes("name")),
      phone: headers.findIndex(
        (header) => header.includes("phone") || header.includes("mobile"),
      ),
      email: headers.findIndex((header) => header.includes("email")),
      reason: headers.findIndex(
        (header) =>
          header.includes("reason") ||
          header.includes("note") ||
          header.includes("message"),
      ),
      tags: headers.findIndex((header) => header.includes("tag")),
      voiceAgentId: headers.findIndex(
        (header) =>
          header.includes("voice agent") || header.includes("agent id"),
      ),
      assignmentContext: headers.findIndex(
        (header) => header.includes("context") || header.includes("assignment"),
      ),
    };

    const payload = rows
      .slice(1)
      .map((row) => {
        const tagsCell = cell(row, indexMap.tags);
        const parsedTags = normalizeTags(
          tagsCell ? tagsCell.split(/[|;,]/g) : [],
        );
        return {
          organization_id: req.orgId,
          name: cell(row, indexMap.name) || "Unknown",
          phone: cell(row, indexMap.phone) || "",
          email: cell(row, indexMap.email) || "",
          reason: cell(row, indexMap.reason) || "",
          tags: parsedTags,
          voice_agent_id: validUuidOrNull(cell(row, indexMap.voiceAgentId)),
          assignment_context: cell(row, indexMap.assignmentContext) || "",
          status: "new",
          source: "csv_import",
        };
      })
      .filter((lead) => lead.name !== "Unknown" || lead.phone || lead.email);

    if (payload.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "No valid leads found in CSV." } });
    }

    const db = getSupabase();
    let imported = 0;
    for (let index = 0; index < payload.length; index += 100) {
      const chunk = payload.slice(index, index + 100);
      const { data, error } = await db.from("leads").insert(chunk).select("id");
      if (error) {
        return res.status(500).json({
          error: {
            message: error.message || "Failed while importing CSV leads.",
          },
        });
      }
      imported += (data || []).length;
    }

    res.json({ success: true, imported, total: payload.length });
  }),
);

// ── PATCH /api/leads/bulk/tags ─────────────────────────────────
// NOTE: All /bulk/* routes MUST be before PATCH /:id
router.patch(
  "/bulk/tags",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { ids, tags, action = "add" } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "ids array is required." } });
    }

    const normalizedTags = normalizeTags(tags);
    if (normalizedTags.length === 0) {
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
      const currentTags = normalizeTags(lead.tags);
      let nextTags = currentTags;
      if (action === "add")
        nextTags = normalizeTags([...currentTags, ...normalizedTags]);
      if (action === "remove")
        nextTags = currentTags.filter((tag) => !normalizedTags.includes(tag));
      if (action === "set") nextTags = normalizedTags;
      await db
        .from("leads")
        .update({ tags: nextTags, updated_at: new Date().toISOString() })
        .eq("id", lead.id)
        .eq("organization_id", req.orgId);
    }

    const { data: updatedLeads } = await db
      .from("leads")
      .select("*")
      .in("id", ids)
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false });

    res.json({ success: true, leads: (updatedLeads || []).map(serializeLead) });
  }),
);

// ── PATCH /api/leads/bulk/assign-agent ────────────────────────
router.patch(
  "/bulk/assign-agent",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { ids, voiceAgentId } = req.body || {};
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
      return res.status(500).json({
        error: { message: error.message || "Failed to assign agent." },
      });
    }

    res.json({
      success: true,
      updated: (updatedLeads || []).length,
      leads: (updatedLeads || []).map(serializeLead),
    });
  }),
);

// ── PATCH /api/leads/bulk/assign-agent-by-tag ─────────────────
router.patch(
  "/bulk/assign-agent-by-tag",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { tag, voiceAgentId } = req.body || {};
    if (!tag) {
      return res.status(400).json({ error: { message: "tag is required." } });
    }
    if (!voiceAgentId) {
      return res
        .status(400)
        .json({ error: { message: "voiceAgentId is required." } });
    }

    const db = getSupabase();
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

    const { data: matchingLeads } = await db
      .from("leads")
      .select("*")
      .eq("organization_id", req.orgId)
      .contains("tags", [tag]);

    if (!matchingLeads || matchingLeads.length === 0) {
      return res
        .status(404)
        .json({ error: { message: "No leads found for that tag." } });
    }

    const ids = matchingLeads.map((lead) => lead.id);
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
      return res.status(500).json({
        error: {
          message: error.message || "Failed to assign agent by tag.",
        },
      });
    }

    res.json({
      success: true,
      updated: (updatedLeads || []).length,
      leads: (updatedLeads || []).map(serializeLead),
    });
  }),
);

// ── DELETE /api/leads/bulk ─────────────────────────────────────
// FIX: MUST be before DELETE /:id — otherwise "bulk" is treated as an id
router.delete(
  "/bulk",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: { message: "ids array is required." } });
    }

    const db = getSupabase();
    const { error } = await db
      .from("leads")
      .delete()
      .in("id", ids)
      .eq("organization_id", req.orgId);

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to delete leads." },
      });
    }
    res.json({ success: true, deleted: ids.length });
  }),
);

// ── GET /api/leads/schedules ───────────────────────────────────
// NOTE: Must be before /:id
router.get(
  "/schedules",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to load schedules." },
      });
    }

    res.json({ schedules: (data || []).map(serializeSchedule) });
  }),
);

// ── POST /api/leads/schedules ──────────────────────────────────
router.post(
  "/schedules",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const {
      name = "",
      targetType,
      leadIds = [],
      tag = "",
      voiceAgentId,
      windows = [],
      timezone = "America/New_York",
      extraContext = "",
      syncExistingLeads = false,
    } = req.body || {};

    if (!voiceAgentId) {
      return res
        .status(400)
        .json({ error: { message: "voiceAgentId is required." } });
    }
    if (!["lead", "tag"].includes(targetType)) {
      return res
        .status(400)
        .json({ error: { message: "targetType must be lead or tag." } });
    }

    const normalizedWindows = parseScheduleWindows(windows);
    if (normalizedWindows.length === 0) {
      return res.status(400).json({
        error: { message: "At least one valid schedule window is required." },
      });
    }

    const db = getSupabase();
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

    let rows = [];
    if (targetType === "lead") {
      if (!Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(400).json({
          error: { message: "leadIds is required for lead schedules." },
        });
      }
      rows = leadIds.map((leadId) => ({
        organization_id: req.orgId,
        voice_agent_id: voiceAgentId,
        target_type: "lead",
        lead_id: leadId,
        tag: "",
        name,
        windows: normalizedWindows,
        timezone,
        extra_context: extraContext || "",
      }));
    } else {
      if (!String(tag || "").trim()) {
        return res
          .status(400)
          .json({ error: { message: "tag is required for tag schedules." } });
      }
      rows = [
        {
          organization_id: req.orgId,
          voice_agent_id: voiceAgentId,
          target_type: "tag",
          lead_id: null,
          tag: String(tag).trim(),
          name,
          windows: normalizedWindows,
          timezone,
          extra_context: extraContext || "",
        },
      ];
    }

    const { data, error } = await db
      .from("lead_outreach_schedules")
      .insert(rows)
      .select();
    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to create schedules." },
      });
    }

    if (targetType === "tag" && syncExistingLeads) {
      await db
        .from("leads")
        .update({
          voice_agent_id: voiceAgentId,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", req.orgId)
        .contains("tags", [String(tag).trim()]);
    }

    res.status(201).json({ schedules: (data || []).map(serializeSchedule) });
  }),
);

// ── PATCH /api/leads/schedules/:id ────────────────────────────
router.patch(
  "/schedules/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.voiceAgentId !== undefined)
      updates.voice_agent_id = body.voiceAgentId || null;
    if (body.windows !== undefined)
      updates.windows = parseScheduleWindows(body.windows);
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (body.extraContext !== undefined)
      updates.extra_context = body.extraContext || "";
    if (body.isActive !== undefined) updates.is_active = !!body.isActive;
    updates.updated_at = new Date().toISOString();

    const db = getSupabase();
    const { data, error } = await db
      .from("lead_outreach_schedules")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ error: { message: "Schedule not found." } });
    }

    res.json({ schedule: serializeSchedule(data) });
  }),
);

// ── DELETE /api/leads/schedules/:id ───────────────────────────
router.delete(
  "/schedules/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const { error } = await db
      .from("lead_outreach_schedules")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to delete schedule." },
      });
    }

    res.json({ success: true });
  }),
);

// ── PATCH /api/leads/:id ───────────────────────────────────────
// NOTE: Wildcard — must come AFTER all named PATCH routes
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
      name,
      phone,
      email,
      reason,
      status,
      tags,
      voiceAgentId,
      assignmentContext,
    } = req.body || {};

    const db = getSupabase();
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (reason !== undefined) updates.reason = reason;
    if (status !== undefined) updates.status = status;
    if (tags !== undefined) updates.tags = normalizeTags(tags);
    if (voiceAgentId !== undefined)
      updates.voice_agent_id = voiceAgentId || null;
    if (assignmentContext !== undefined)
      updates.assignment_context = assignmentContext || "";
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

// ── DELETE /api/leads/:id ──────────────────────────────────────
// NOTE: Wildcard — must come AFTER DELETE /bulk and DELETE /schedules/:id
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();
    const { error } = await db
      .from("leads")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to delete lead." },
      });
    }
    res.json({ success: true });
  }),
);

module.exports = router;
