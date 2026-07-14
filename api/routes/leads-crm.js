"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  CRM_STAGES,
  scoreLeadHeuristically,
  recordLeadActivity,
} = require("../../lib/lead-crm-events");

const router = express.Router();

router.use(requireAuth);

function userId(req) {
  return req.user?.id || null;
}

function applyOrg(query, req) {
  return query.eq("organization_id", req.orgId);
}

function asInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanSearchTerm(value) {
  return String(value || "")
    .replace(/[%,()]/g, " ")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function safeSort(value) {
  const sort = String(value || "priority");
  return ["priority", "newest", "oldest", "value", "due"].includes(sort)
    ? sort
    : "priority";
}

function serializeError(error, fallback = "CRM request failed.") {
  return {
    message: error?.message || fallback,
    code: error?.code || error?.status || undefined,
    details: error?.details || undefined,
  };
}

function legacyStatusForStage(stage) {
  if (stage === "new") return "new";
  if (stage === "won" || stage === "lost") return "closed";
  return "contacted";
}

function normalizeContactValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9@.+]/g, "")
    .trim();
}

function normalizePhoneValue(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .trim();
}

async function getDuplicateLeadIds(db, orgId) {
  const { data, error } = await db
    .from("leads")
    .select("id,email,phone")
    .eq("organization_id", orgId)
    .range(0, 19999);
  if (error) throw error;

  const byContact = new Map();
  for (const lead of data || []) {
    const email = normalizeContactValue(lead.email);
    const phone = normalizePhoneValue(lead.phone);
    for (const key of [
      email ? `email:${email}` : null,
      phone ? `phone:${phone}` : null,
    ]) {
      if (!key) continue;
      if (!byContact.has(key)) byContact.set(key, []);
      byContact.get(key).push(lead.id);
    }
  }

  const duplicateIds = new Set();
  for (const ids of byContact.values()) {
    if (ids.length > 1) ids.forEach((id) => duplicateIds.add(id));
  }
  return Array.from(duplicateIds);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\r?\n/g, " ");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows, columns) {
  const header = columns.map((column) => csvEscape(column.label)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => csvEscape(column.value(row))).join(","),
  );
  return [header, ...body].join("\n");
}

const ALLOWED_LEAD_PATCH_FIELDS = [
  "crm_stage",
  "lead_temperature",
  "ai_score",
  "ai_summary",
  "ai_intent",
  "ai_confidence",
  "next_action",
  "next_action_due_at",
  "estimated_value_cents",
  "currency",
  "owner_user_id",
  "needs_human_review",
  "human_review_reason",
  "lost_reason",
  "last_contacted_at",
  "appointment_at",
  "source_detail",
  "crm_metadata",
  "name",
  "email",
  "phone",
  "reason",
  "source",
];

function pickLeadPatch(input = {}) {
  const patch = {};
  for (const key of ALLOWED_LEAD_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
      patch[key] = input[key];
    }
  }
  if (patch.crm_stage && !CRM_STAGES.includes(patch.crm_stage)) {
    const error = new Error(`Invalid CRM stage: ${patch.crm_stage}`);
    error.status = 400;
    throw error;
  }
  if (patch.crm_stage) patch.status = legacyStatusForStage(patch.crm_stage);
  patch.updated_at = new Date().toISOString();
  return patch;
}

async function getLeadForOrg(db, req, leadId) {
  const { data, error } = await db
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("organization_id", req.orgId)
    .single();
  if (error) throw error;
  return data;
}

async function getRecentActivities(db, leadId, limit = 10) {
  const { data, error } = await db
    .from("lead_activities")
    .select("*")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

router.get(
  "/health",
  asyncHandler(async (req, res) => {
    res.json({ success: true, route: "leads-crm", organizationId: req.orgId });
  }),
);

router.get(
  "/stages",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("lead_pipeline_stages")
      .select("*")
      .or(`organization_id.is.null,organization_id.eq.${req.orgId}`)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    const seen = new Set();
    const stages = [];
    for (const stage of data || []) {
      if (seen.has(stage.key)) continue;
      seen.add(stage.key);
      stages.push(stage);
    }

    res.json({ stages });
  }),
);

router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("leads")
      .select(
        "id,organization_id,email,phone,source,crm_stage,lead_temperature,ai_score,estimated_value_cents,next_action_due_at,needs_human_review,created_at,last_activity_at",
      )
      .eq("organization_id", req.orgId);

    if (error) throw error;

    const now = Date.now();
    const leads = data || [];
    const byStage = {};
    const byTemperature = {};
    const bySource = {};
    const duplicateGroups = new Map();
    let hotLeads = 0;
    let overdueFollowUps = 0;
    let needsHumanReview = 0;
    let estimatedPipelineValueCents = 0;

    for (const lead of leads) {
      const stage = lead.crm_stage || "new";
      const temp = lead.lead_temperature || "warm";
      const source = lead.source || "Unknown";
      const emailKey = normalizeContactValue(lead.email);
      const phoneKey = normalizePhoneValue(lead.phone);
      byStage[stage] = (byStage[stage] || 0) + 1;
      byTemperature[temp] = (byTemperature[temp] || 0) + 1;
      bySource[source] = (bySource[source] || 0) + 1;
      for (const key of [
        emailKey ? `email:${emailKey}` : null,
        phoneKey ? `phone:${phoneKey}` : null,
      ]) {
        if (!key) continue;
        duplicateGroups.set(key, (duplicateGroups.get(key) || 0) + 1);
      }
      if ((Number(lead.ai_score) || 0) >= 80 || temp === "hot") hotLeads += 1;
      if (lead.needs_human_review) needsHumanReview += 1;
      if (
        lead.next_action_due_at &&
        new Date(lead.next_action_due_at).getTime() < now
      ) {
        overdueFollowUps += 1;
      }
      if (!["won", "lost"].includes(stage)) {
        estimatedPipelineValueCents += Number(lead.estimated_value_cents || 0);
      }
    }

    let duplicateContacts = 0;
    for (const count of duplicateGroups.values()) {
      if (count > 1) duplicateContacts += count;
    }

    res.json({
      totalLeads: leads.length,
      hotLeads,
      overdueFollowUps,
      needsHumanReview,
      duplicateContacts,
      estimatedPipelineValueCents,
      byStage,
      byTemperature,
      bySource,
    });
  }),
);

router.get(
  "/sources",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("leads")
      .select("source")
      .eq("organization_id", req.orgId)
      .range(0, 19999);

    if (error) throw error;

    const counts = new Map();
    for (const lead of data || []) {
      const source = String(lead.source || "Unknown").trim() || "Unknown";
      counts.set(source, (counts.get(source) || 0) + 1);
    }

    const sources = Array.from(counts.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
      .slice(0, 50);

    res.json({ sources });
  }),
);

router.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const limit = Math.min(Math.max(asInteger(req.query.limit, 2000), 1), 5000);
    let query = applyOrg(db.from("leads").select("*"), req);

    if (req.query.stage && req.query.stage !== "all")
      query = query.eq("crm_stage", req.query.stage);
    if (req.query.temperature && req.query.temperature !== "all")
      query = query.eq("lead_temperature", req.query.temperature);
    if (req.query.owner_user_id)
      query = query.eq("owner_user_id", req.query.owner_user_id);
    if (req.query.needs_human_review === "true")
      query = query.eq("needs_human_review", true);
    if (req.query.due === "overdue")
      query = query.lt("next_action_due_at", new Date().toISOString());
    if (req.query.due === "upcoming")
      query = query.gte("next_action_due_at", new Date().toISOString());
    if (req.query.source && req.query.source !== "all")
      query = query.eq("source", req.query.source);

    if (req.query.duplicates === "true") {
      const duplicateIds = await getDuplicateLeadIds(db, req.orgId);
      if (!duplicateIds.length) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="agently-crm-leads.csv"',
        );
        return res.send(
          toCsv(
            [],
            [
              { label: "Name", value: (row) => row.name },
              { label: "Email", value: (row) => row.email },
              { label: "Phone", value: (row) => row.phone },
            ],
          ),
        );
      }
      query = query.in("id", duplicateIds);
    }

    const term = cleanSearchTerm(req.query.search);
    if (term) {
      query = query.or(
        `name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,reason.ilike.%${term}%,ai_summary.ilike.%${term}%,next_action.ilike.%${term}%`,
      );
    }

    const sort = safeSort(req.query.sort);
    let ordered = query;
    if (sort === "newest")
      ordered = ordered.order("created_at", { ascending: false });
    else if (sort === "oldest")
      ordered = ordered.order("created_at", { ascending: true });
    else if (sort === "value")
      ordered = ordered.order("estimated_value_cents", {
        ascending: false,
        nullsFirst: false,
      });
    else if (sort === "due")
      ordered = ordered.order("next_action_due_at", {
        ascending: true,
        nullsFirst: false,
      });
    else
      ordered = ordered
        .order("ai_score", { ascending: false })
        .order("last_activity_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

    const { data, error } = await ordered.range(0, limit - 1);
    if (error) throw error;

    const columns = [
      { label: "Name", value: (row) => row.name },
      { label: "Email", value: (row) => row.email },
      { label: "Phone", value: (row) => row.phone },
      { label: "Source", value: (row) => row.source },
      { label: "Stage", value: (row) => row.crm_stage },
      { label: "Temperature", value: (row) => row.lead_temperature },
      { label: "AI Score", value: (row) => row.ai_score },
      { label: "AI Summary", value: (row) => row.ai_summary },
      { label: "Next Action", value: (row) => row.next_action },
      { label: "Next Action Due", value: (row) => row.next_action_due_at },
      {
        label: "Estimated Value Cents",
        value: (row) => row.estimated_value_cents,
      },
      {
        label: "Needs Human Review",
        value: (row) => (row.needs_human_review ? "yes" : "no"),
      },
      { label: "Last Activity", value: (row) => row.last_activity_at },
      { label: "Created At", value: (row) => row.created_at },
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="agently-crm-leads.csv"',
    );
    res.send(toCsv(data || [], columns));
  }),
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const limit = Math.min(Math.max(asInteger(req.query.limit, 50), 1), 100);
    const page = Math.max(asInteger(req.query.page, 1), 1);
    const offset = Object.prototype.hasOwnProperty.call(
      req.query || {},
      "offset",
    )
      ? Math.max(asInteger(req.query.offset, 0), 0)
      : (page - 1) * limit;

    let query = applyOrg(db.from("leads").select("*", { count: "exact" }), req);

    if (req.query.stage && req.query.stage !== "all") {
      query = query.eq("crm_stage", req.query.stage);
    }
    if (req.query.temperature && req.query.temperature !== "all") {
      query = query.eq("lead_temperature", req.query.temperature);
    }
    if (req.query.owner_user_id)
      query = query.eq("owner_user_id", req.query.owner_user_id);
    if (req.query.needs_human_review === "true")
      query = query.eq("needs_human_review", true);
    if (req.query.due === "overdue")
      query = query.lt("next_action_due_at", new Date().toISOString());
    if (req.query.due === "upcoming")
      query = query.gte("next_action_due_at", new Date().toISOString());
    if (req.query.source && req.query.source !== "all")
      query = query.eq("source", req.query.source);
    if (req.query.duplicates === "true") {
      const duplicateIds = await getDuplicateLeadIds(db, req.orgId);
      if (!duplicateIds.length) {
        return res.json({
          leads: [],
          count: 0,
          page,
          limit,
          offset,
          hasMore: false,
        });
      }
      query = query.in("id", duplicateIds);
    }

    const term = cleanSearchTerm(req.query.search);
    if (term) {
      query = query.or(
        `name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,reason.ilike.%${term}%,ai_summary.ilike.%${term}%,next_action.ilike.%${term}%`,
      );
    }

    const sort = safeSort(req.query.sort);
    let ordered = query;
    if (sort === "newest") {
      ordered = ordered.order("created_at", { ascending: false });
    } else if (sort === "oldest") {
      ordered = ordered.order("created_at", { ascending: true });
    } else if (sort === "value") {
      ordered = ordered.order("estimated_value_cents", {
        ascending: false,
        nullsFirst: false,
      });
    } else if (sort === "due") {
      ordered = ordered.order("next_action_due_at", {
        ascending: true,
        nullsFirst: false,
      });
    } else {
      ordered = ordered
        .order("ai_score", { ascending: false })
        .order("last_activity_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
    }

    const { data, error, count } = await ordered.range(
      offset,
      offset + limit - 1,
    );

    if (error) throw error;
    const rows = data || [];
    const total = count || 0;
    res.json({
      leads: rows,
      count: total,
      page,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);

router.patch(
  "/bulk",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const leadIds = Array.isArray(req.body?.lead_ids)
      ? req.body.lead_ids.map((id) => String(id)).filter(Boolean)
      : [];

    const uniqueLeadIds = Array.from(new Set(leadIds)).slice(0, 100);
    if (!uniqueLeadIds.length) {
      return res
        .status(400)
        .json({ error: { message: "At least one lead id is required." } });
    }

    let patch;
    try {
      patch = pickLeadPatch(req.body?.patch || {});
    } catch (error) {
      if (error.status === 400) {
        return res.status(400).json({ error: { message: error.message } });
      }
      throw error;
    }
    if (Object.keys(patch).length <= 1 && patch.updated_at) {
      return res
        .status(400)
        .json({
          error: { message: "No supported lead fields were provided." },
        });
    }

    const { data: leads, error } = await db
      .from("leads")
      .update(patch)
      .eq("organization_id", req.orgId)
      .in("id", uniqueLeadIds)
      .select("*");

    if (error) throw error;

    const title = patch.crm_stage
      ? `Bulk stage changed to ${patch.crm_stage}`
      : patch.needs_human_review === true
        ? "Bulk marked for human review"
        : patch.needs_human_review === false
          ? "Bulk human review cleared"
          : "Bulk CRM update";

    const activityPromises = (leads || []).map((lead) =>
      recordLeadActivity(db, {
        leadId: lead.id,
        organizationId: req.orgId,
        activityType: patch.crm_stage ? "stage_change" : "crm_update",
        title,
        body: req.body?.activity_note || null,
        createdBy: userId(req),
        metadata: { patch, bulk: true },
      }).catch(() => null),
    );
    await Promise.all(activityPromises);

    res.json({ leads: leads || [], count: (leads || []).length });
  }),
);

router.get(
  "/:leadId",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const lead = await getLeadForOrg(db, req, req.params.leadId);
    const activityLimit = Math.min(
      Math.max(asInteger(req.query.activity_limit, 25), 1),
      100,
    );
    const activityOffset = Math.max(asInteger(req.query.activity_offset, 0), 0);
    const taskLimit = Math.min(
      Math.max(asInteger(req.query.task_limit, 25), 1),
      100,
    );
    const taskOffset = Math.max(asInteger(req.query.task_offset, 0), 0);

    const [activityResult, taskResult] = await Promise.all([
      db
        .from("lead_activities")
        .select("*", { count: "exact" })
        .eq("lead_id", req.params.leadId)
        .eq("organization_id", req.orgId)
        .order("occurred_at", { ascending: false })
        .range(activityOffset, activityOffset + activityLimit - 1),
      db
        .from("lead_tasks")
        .select("*", { count: "exact" })
        .eq("lead_id", req.params.leadId)
        .eq("organization_id", req.orgId)
        .order("status", { ascending: true })
        .order("due_at", { ascending: true, nullsFirst: false })
        .range(taskOffset, taskOffset + taskLimit - 1),
    ]);

    if (activityResult.error) throw activityResult.error;
    if (taskResult.error) throw taskResult.error;

    res.json({
      lead,
      activities: activityResult.data || [],
      tasks: taskResult.data || [],
      activityCount: activityResult.count || 0,
      taskCount: taskResult.count || 0,
      activityLimit,
      activityOffset,
      taskLimit,
      taskOffset,
    });
  }),
);

router.patch(
  "/:leadId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    let patch;
    try {
      patch = pickLeadPatch(req.body || {});
    } catch (error) {
      if (error.status === 400) {
        return res.status(400).json({ error: { message: error.message } });
      }
      throw error;
    }

    const { data: lead, error } = await db
      .from("leads")
      .update(patch)
      .eq("id", req.params.leadId)
      .eq("organization_id", req.orgId)
      .select("*")
      .single();

    if (error) throw error;

    await recordLeadActivity(db, {
      leadId: req.params.leadId,
      organizationId: req.orgId,
      activityType: patch.crm_stage ? "stage_change" : "crm_update",
      title: patch.crm_stage
        ? `Stage changed to ${patch.crm_stage}`
        : "Lead updated",
      body: req.body?.activity_note || null,
      createdBy: userId(req),
      metadata: { patch },
    });

    res.json({ lead });
  }),
);

router.post(
  "/:leadId/notes",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    await getLeadForOrg(db, req, req.params.leadId);

    const body = String(req.body?.body || "").trim();
    if (!body)
      return res
        .status(400)
        .json({ error: { message: "Note body is required." } });

    const activity = await recordLeadActivity(db, {
      leadId: req.params.leadId,
      organizationId: req.orgId,
      activityType: "manual_note",
      title: req.body?.title || "Internal note",
      body,
      createdBy: userId(req),
      metadata: req.body?.metadata || {},
    });

    res.status(201).json({ activity });
  }),
);

router.post(
  "/:leadId/tasks",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    await getLeadForOrg(db, req, req.params.leadId);

    const title = String(req.body?.title || "").trim();
    if (!title)
      return res
        .status(400)
        .json({ error: { message: "Task title is required." } });

    const payload = {
      lead_id: req.params.leadId,
      organization_id: req.orgId,
      title,
      description: req.body?.description || null,
      task_type: req.body?.task_type || "follow_up",
      priority: req.body?.priority || "normal",
      status: req.body?.status || "open",
      assigned_to: req.body?.assigned_to || null,
      due_at: req.body?.due_at || null,
      created_by: userId(req),
      metadata: req.body?.metadata || {},
    };

    const { data: task, error } = await db
      .from("lead_tasks")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;

    await recordLeadActivity(db, {
      leadId: req.params.leadId,
      organizationId: req.orgId,
      activityType: "task_created",
      title: `Task created: ${title}`,
      body: req.body?.description || null,
      createdBy: userId(req),
      metadata: {
        task_id: task.id,
        due_at: task.due_at,
        priority: task.priority,
      },
    });

    res.status(201).json({ task });
  }),
);

router.patch(
  "/tasks/:taskId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const allowed = [
      "title",
      "description",
      "task_type",
      "priority",
      "status",
      "assigned_to",
      "due_at",
      "completed_at",
      "metadata",
    ];
    const patch = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key))
        patch[key] = req.body[key];
    }
    if (patch.status === "done" && !patch.completed_at)
      patch.completed_at = new Date().toISOString();
    patch.updated_at = new Date().toISOString();

    const { data: task, error } = await db
      .from("lead_tasks")
      .update(patch)
      .eq("id", req.params.taskId)
      .eq("organization_id", req.orgId)
      .select("*")
      .single();

    if (error) throw error;
    res.json({ task });
  }),
);

router.post(
  "/:leadId/ai-refresh",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const lead = await getLeadForOrg(db, req, req.params.leadId);
    const activities = await getRecentActivities(db, req.params.leadId, 15);
    const score = scoreLeadHeuristically(lead, activities);

    const patch = {
      ai_score: score.ai_score,
      lead_temperature: score.lead_temperature,
      ai_summary: score.ai_summary,
      ai_intent: score.ai_intent,
      ai_confidence: score.ai_confidence,
      next_action: score.next_action,
      needs_human_review:
        lead.needs_human_review ||
        /human|representative|agent|review/.test(
          String(score.next_action).toLowerCase(),
        ),
      updated_at: new Date().toISOString(),
    };

    const { data: updatedLead, error: updateError } = await db
      .from("leads")
      .update(patch)
      .eq("id", req.params.leadId)
      .eq("organization_id", req.orgId)
      .select("*")
      .single();

    if (updateError) throw updateError;

    await recordLeadActivity(db, {
      leadId: req.params.leadId,
      organizationId: req.orgId,
      activityType: "ai_score",
      title: `AI score refreshed: ${score.ai_score}/100`,
      body: score.ai_summary,
      createdBy: userId(req),
      metadata: {
        reasons: score.reasons,
        intent: score.ai_intent,
        confidence: score.ai_confidence,
      },
    });

    res.json({ lead: updatedLead, scoring: score });
  }),
);

module.exports = router;
