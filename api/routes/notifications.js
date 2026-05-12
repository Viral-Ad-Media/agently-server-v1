"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

const TERMINAL_FAILED = new Set([
  "failed",
  "busy",
  "no-answer",
  "no_answer",
  "canceled",
  "cancelled",
  "undelivered",
]);

const TERMINAL_COMPLETED = new Set([
  "completed",
  "answered",
  "success",
  "succeeded",
  "done",
]);

function asString(value, fallback = "") {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function normalizeStatus(value) {
  return asString(value).trim().toLowerCase().replace(/\s+/g, "_");
}

function truncate(value, length = 120) {
  const text = asString(value).trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trim()}…`;
}

function parseJsonish(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }
  return value;
}

function notificationKey(item) {
  return `${item.type}:${item.entity_type}:${item.entity_id}`;
}

function buildCallNotification(call) {
  const status = normalizeStatus(call.status);
  const hasFinished = Boolean(
    call.completed_at || call.ended_at || Number(call.duration || 0) > 0,
  );
  const failed =
    TERMINAL_FAILED.has(status) ||
    ["failed", "busy", "no-answer", "no_answer"].includes(status);
  const completed = TERMINAL_COMPLETED.has(status) || hasFinished;

  if (!failed && !completed) return null;

  const caller = asString(
    call.caller_name || call.caller_phone,
    "Unknown caller",
  );
  const phone = asString(call.caller_phone);
  const createdAt =
    call.completed_at ||
    call.ended_at ||
    call.timestamp ||
    call.created_at ||
    new Date().toISOString();

  if (failed) {
    return {
      type: "call_failed",
      title: "Call failed",
      body: truncate(phone ? `${caller} · ${phone}` : caller),
      entity_type: "call",
      entity_id: call.id,
      voice_agent_id: call.voice_agent_id || null,
      call_record_id: call.id,
      metadata: {
        derived: true,
        source: "call_records",
        status: call.status || "failed",
        direction: call.direction || "",
      },
      created_at: createdAt,
    };
  }

  return {
    type: "call_completed",
    title: "Call completed",
    body: truncate(phone ? `${caller} · ${phone}` : caller),
    entity_type: "call",
    entity_id: call.id,
    voice_agent_id: call.voice_agent_id || null,
    call_record_id: call.id,
    metadata: {
      derived: true,
      source: "call_records",
      status: call.status || "completed",
      direction: call.direction || "",
      duration: Number(call.duration || 0),
    },
    created_at: createdAt,
  };
}

function buildScheduleNotification(schedule) {
  const status = normalizeStatus(schedule.status);
  if (!TERMINAL_COMPLETED.has(status) && !TERMINAL_FAILED.has(status))
    return null;

  const failed = TERMINAL_FAILED.has(status);
  const directRecipients = parseJsonish(schedule.direct_recipients, []);
  const recipientCount = Array.isArray(directRecipients)
    ? directRecipients.length
    : 0;
  const name = asString(schedule.name, "Scheduled call");
  const purpose = asString(
    schedule.call_purpose || schedule.custom_instructions,
  );
  const body = recipientCount
    ? `${recipientCount} recipient${recipientCount === 1 ? "" : "s"}${purpose ? ` · ${truncate(purpose, 80)}` : ""}`
    : truncate(purpose || name, 120);

  return {
    type: failed ? "schedule_failed" : "schedule_completed",
    title: failed ? "Schedule failed" : "Schedule completed",
    body,
    entity_type: "schedule",
    entity_id: schedule.id,
    voice_agent_id: schedule.voice_agent_id || null,
    call_record_id: null,
    metadata: {
      derived: true,
      source: "lead_outreach_schedules",
      status: schedule.status || "",
      scheduleType: schedule.schedule_type || "",
    },
    created_at:
      schedule.updated_at || schedule.created_at || new Date().toISOString(),
  };
}

function buildUnansweredQuestionNotification(question) {
  const resolved =
    question.is_resolved === true ||
    normalizeStatus(question.status) === "resolved";
  if (resolved) return null;
  return {
    type: "unanswered_question_captured",
    title: "Unanswered question captured",
    body: truncate(
      question.question ||
        "A caller asked a question the agent could not answer.",
    ),
    entity_type: "unanswered_question",
    entity_id: question.id,
    voice_agent_id: question.voice_agent_id || null,
    call_record_id: question.call_record_id || null,
    metadata: {
      derived: true,
      source: "unanswered_questions",
      status: question.status || "unresolved",
    },
    created_at: question.created_at || new Date().toISOString(),
  };
}

async function ensureDerivedNotifications(db, orgId, userId) {
  try {
    const [callsResult, schedulesResult, questionsResult] = await Promise.all([
      db
        .from("call_records")
        .select(
          "id, voice_agent_id, caller_name, caller_phone, direction, status, duration, timestamp, created_at, completed_at, ended_at",
        )
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(30),
      db
        .from("lead_outreach_schedules")
        .select(
          "id, voice_agent_id, name, status, schedule_type, call_purpose, custom_instructions, direct_recipients, created_at, updated_at",
        )
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(30),
      db
        .from("unanswered_questions")
        .select(
          "id, voice_agent_id, call_record_id, question, status, is_resolved, created_at",
        )
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(30),
    ]);

    const candidates = [];
    if (!callsResult.error) {
      for (const call of callsResult.data || []) {
        const item = buildCallNotification(call);
        if (item) candidates.push(item);
      }
    }
    if (!schedulesResult.error) {
      for (const schedule of schedulesResult.data || []) {
        const item = buildScheduleNotification(schedule);
        if (item) candidates.push(item);
      }
    }
    if (!questionsResult.error) {
      for (const question of questionsResult.data || []) {
        const item = buildUnansweredQuestionNotification(question);
        if (item) candidates.push(item);
      }
    }

    if (!candidates.length) return;

    const ids = Array.from(
      new Set(candidates.map((item) => item.entity_id).filter(Boolean)),
    );
    const existingResult = await db
      .from("tenant_notifications")
      .select("type, entity_type, entity_id")
      .eq("organization_id", orgId)
      .in("entity_id", ids);

    if (existingResult.error) return;

    const existing = new Set((existingResult.data || []).map(notificationKey));
    const rows = candidates
      .filter((item) => !existing.has(notificationKey(item)))
      .map((item) => ({
        organization_id: orgId,
        user_id: userId || null,
        type: item.type,
        title: item.title,
        body: item.body,
        entity_type: item.entity_type,
        entity_id: item.entity_id,
        voice_agent_id: item.voice_agent_id || null,
        call_record_id: item.call_record_id || null,
        is_read: false,
        metadata: item.metadata || {},
        created_at: item.created_at,
      }));

    if (!rows.length) return;
    await db.from("tenant_notifications").insert(rows);
  } catch (error) {
    console.warn(
      "[notifications] derived notification sync skipped:",
      error && error.message ? error.message : error,
    );
  }
}

async function getNotificationMetrics(db, orgId) {
  const [totalResult, unreadResult, latestResult] = await Promise.all([
    db
      .from("tenant_notifications")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    db
      .from("tenant_notifications")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("is_read", false),
    db
      .from("tenant_notifications")
      .select("created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  return {
    total: totalResult.count || 0,
    unread: unreadResult.count || 0,
    read: Math.max(0, (totalResult.count || 0) - (unreadResult.count || 0)),
    latestAt:
      latestResult.data && latestResult.data[0]
        ? latestResult.data[0].created_at
        : null,
  };
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    await ensureDerivedNotifications(db, req.orgId, req.user && req.user.id);

    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const page = Math.max(1, Number(req.query.page || 1));
    const unreadOnly = ["true", "1", "yes"].includes(
      asString(req.query.unreadOnly || req.query.unread).toLowerCase(),
    );
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = db
      .from("tenant_notifications")
      .select("*", { count: "exact" })
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (unreadOnly) query = query.eq("is_read", false);
    if (req.query.type) query = query.eq("type", asString(req.query.type));

    const { data, error, count } = await query;
    if (error) throw error;

    const metrics = await getNotificationMetrics(db, req.orgId);

    res.json({
      success: true,
      organizationId: req.orgId,
      notifications: data || [],
      page,
      limit,
      total: count || 0,
      unreadCount: metrics.unread,
      metrics,
    });
  }),
);

router.get(
  "/unread-count",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    await ensureDerivedNotifications(db, req.orgId, req.user && req.user.id);
    const metrics = await getNotificationMetrics(db, req.orgId);
    res.json({ success: true, unreadCount: metrics.unread, metrics });
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
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Notification not found." } });
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
    const { data, error } = await db
      .from("tenant_notifications")
      .delete()
      .eq("id", req.params.notificationId)
      .eq("organization_id", req.orgId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return res
        .status(404)
        .json({ error: { message: "Notification not found." } });
    res.json({
      success: true,
      deleted: true,
      notificationId: req.params.notificationId,
    });
  }),
);

module.exports = router;
