"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { sendUnreadNotificationsDigestEmail } = require("../../lib/email");

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

function metadataOf(row) {
  const parsed = parseJsonish(row && row.metadata, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function notificationKey(item) {
  return `${item.type}:${item.entity_type}:${item.entity_id}`;
}

function hasTruthyFlag(metadata, keys) {
  return keys.some((key) => {
    const value = metadata[key];
    return value === true || value === "true" || value === 1 || value === "1";
  });
}

function getFirstText(metadata, keys) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value;
      for (const nestedKey of [
        "message",
        "text",
        "summary",
        "body",
        "reason",
      ]) {
        if (typeof nested[nestedKey] === "string" && nested[nestedKey].trim())
          return nested[nestedKey].trim();
      }
    }
  }
  return "";
}

function getCallDisplay(call) {
  const caller = asString(
    call.caller_name || call.caller_phone,
    "Unknown caller",
  );
  const phone = asString(call.caller_phone);
  return phone ? `${caller} · ${phone}` : caller;
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

  const createdAt =
    call.completed_at ||
    call.ended_at ||
    call.timestamp ||
    call.created_at ||
    new Date().toISOString();

  return {
    type: failed ? "call_failed" : "call_completed",
    title: failed ? "Call failed" : "Call completed",
    body: truncate(getCallDisplay(call), 120),
    entity_type: "call",
    entity_id: call.id,
    voice_agent_id: call.voice_agent_id || null,
    call_record_id: call.id,
    metadata: {
      derived: true,
      source: "call_records",
      status: call.status || (failed ? "failed" : "completed"),
      direction: call.direction || "",
      duration: Number(call.duration || 0),
    },
    created_at: createdAt,
  };
}

function buildCallbackNotification(call) {
  const metadata = metadataOf(call);
  const requested = hasTruthyFlag(metadata, [
    "callbackRequested",
    "callback_requested",
    "requestedCallback",
    "requested_callback",
    "lead_requested_follow_up",
    "followUpRequested",
    "follow_up_requested",
  ]);
  const reason = getFirstText(metadata, [
    "callbackRequest",
    "callback_request",
    "followUpRequest",
    "follow_up_request",
    "callbackReason",
    "callback_reason",
  ]);
  if (!requested && !reason) return null;
  return {
    type: "lead_requested_follow_up",
    title: "Callback requested",
    body: truncate(reason || getCallDisplay(call), 140),
    entity_type: "call",
    entity_id: call.id,
    voice_agent_id: call.voice_agent_id || null,
    call_record_id: call.id,
    metadata: {
      derived: true,
      source: "call_records.metadata",
      notificationGroup: "callback",
    },
    created_at:
      call.completed_at ||
      call.ended_at ||
      call.timestamp ||
      call.created_at ||
      new Date().toISOString(),
  };
}

function buildMessageNotification(call) {
  const metadata = metadataOf(call);
  const message = getFirstText(metadata, [
    "capturedMessage",
    "captured_message",
    "messageCaptured",
    "message_captured",
    "callerMessage",
    "caller_message",
    "message",
  ]);
  if (!message) return null;
  return {
    type: "message_captured",
    title: "Message captured",
    body: truncate(message, 160),
    entity_type: "call",
    entity_id: call.id,
    voice_agent_id: call.voice_agent_id || null,
    call_record_id: call.id,
    metadata: {
      derived: true,
      source: "call_records.metadata",
      notificationGroup: "message",
    },
    created_at:
      call.completed_at ||
      call.ended_at ||
      call.timestamp ||
      call.created_at ||
      new Date().toISOString(),
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
  const body = recipientCount
    ? `${recipientCount} recipient${recipientCount === 1 ? "" : "s"}`
    : truncate(name, 120);

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

function groupUnansweredQuestions(questions) {
  const grouped = new Map();
  for (const question of questions || []) {
    const resolved =
      question.is_resolved === true ||
      normalizeStatus(question.status) === "resolved";
    if (resolved) continue;
    const callId = question.call_record_id || question.id;
    const key = question.call_record_id
      ? `call:${question.call_record_id}`
      : `question:${question.id}`;
    const existing = grouped.get(key) || {
      entity_type: question.call_record_id ? "call" : "unanswered_question",
      entity_id: callId,
      call_record_id: question.call_record_id || null,
      voice_agent_id: question.voice_agent_id || null,
      questions: [],
      created_at: question.created_at || new Date().toISOString(),
    };
    existing.questions.push(
      asString(
        question.question ||
          "A caller asked a question the agent could not answer.",
      ),
    );
    if (
      new Date(question.created_at || 0).getTime() >
      new Date(existing.created_at || 0).getTime()
    ) {
      existing.created_at = question.created_at;
    }
    grouped.set(key, existing);
  }
  return Array.from(grouped.values()).map((group) => {
    const count = group.questions.length;
    const first =
      group.questions[0] ||
      "A caller asked a question the agent could not answer.";
    return {
      type: "unanswered_question_captured",
      title:
        count > 1
          ? `${count} unanswered questions`
          : "Unanswered question captured",
      body: truncate(first, 160),
      entity_type: group.entity_type,
      entity_id: group.entity_id,
      voice_agent_id: group.voice_agent_id || null,
      call_record_id: group.call_record_id || null,
      metadata: {
        derived: true,
        source: "unanswered_questions",
        notificationGroup: "unanswered_questions",
        count,
      },
      created_at: group.created_at || new Date().toISOString(),
    };
  });
}

async function ensureDerivedNotifications(db, orgId, userId) {
  try {
    const [callsResult, schedulesResult, questionsResult] = await Promise.all([
      db
        .from("call_records")
        .select(
          "id, voice_agent_id, caller_name, caller_phone, direction, status, duration, timestamp, created_at, completed_at, ended_at, metadata",
        )
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(40),
      db
        .from("lead_outreach_schedules")
        .select(
          "id, voice_agent_id, name, status, schedule_type, direct_recipients, created_at, updated_at",
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
        .limit(80),
    ]);

    const candidates = [];
    if (!callsResult.error) {
      for (const call of callsResult.data || []) {
        const items = [
          buildCallNotification(call),
          buildCallbackNotification(call),
          buildMessageNotification(call),
        ].filter(Boolean);
        candidates.push(...items);
      }
    }
    if (!schedulesResult.error) {
      for (const schedule of schedulesResult.data || []) {
        const item = buildScheduleNotification(schedule);
        if (item) candidates.push(item);
      }
    }
    if (!questionsResult.error) {
      candidates.push(...groupUnansweredQuestions(questionsResult.data || []));
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

async function maybeSendUnreadThresholdEmail(db, req, metrics) {
  const threshold = Number(process.env.NOTIFICATION_EMAIL_THRESHOLD || 20);
  if (!metrics || Number(metrics.unread || 0) < threshold) return;

  const now = Date.now();
  const latest = await db
    .from("tenant_notifications")
    .select("id,created_at,metadata")
    .eq("organization_id", req.orgId)
    .eq("type", "notification_digest_sent")
    .order("created_at", { ascending: false })
    .limit(1);

  const last = latest.data && latest.data[0];
  if (last && now - new Date(last.created_at).getTime() < 24 * 60 * 60 * 1000)
    return;

  try {
    await sendUnreadNotificationsDigestEmail(
      req.user.email,
      req.user.name,
      req.organization.name,
      metrics.unread,
    );
    await db.from("tenant_notifications").insert({
      organization_id: req.orgId,
      user_id: req.user.id,
      type: "notification_digest_sent",
      title: "Unread notifications email sent",
      body: `An email reminder was sent because ${metrics.unread} notifications are unread.`,
      entity_type: "notification_digest",
      entity_id: req.orgId,
      is_read: true,
      read_at: new Date().toISOString(),
      metadata: {
        threshold,
        unreadCount: metrics.unread,
        sentTo: req.user.email,
      },
    });
  } catch (error) {
    console.warn(
      "[notifications] unread threshold email failed:",
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
    await maybeSendUnreadThresholdEmail(db, req, metrics);

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
    await maybeSendUnreadThresholdEmail(db, req, metrics);
    res.json({ success: true, unreadCount: metrics.unread, metrics });
  }),
);

router.post(
  "/bulk",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const ids = Array.isArray(req.body && req.body.notificationIds)
      ? req.body.notificationIds
          .map((id) => asString(id).trim())
          .filter(Boolean)
      : [];
    const action = normalizeStatus(req.body && req.body.action);
    if (!ids.length)
      return res
        .status(400)
        .json({ error: { message: "No notifications selected." } });
    if (!["read", "unread", "delete"].includes(action))
      return res
        .status(400)
        .json({ error: { message: "Unsupported bulk action." } });

    if (action === "delete") {
      const { error } = await db
        .from("tenant_notifications")
        .delete()
        .eq("organization_id", req.orgId)
        .in("id", ids);
      if (error) throw error;
      return res.json({ success: true, action, notificationIds: ids });
    }

    const patch =
      action === "read"
        ? { is_read: true, read_at: new Date().toISOString() }
        : { is_read: false, read_at: null };
    const { error } = await db
      .from("tenant_notifications")
      .update(patch)
      .eq("organization_id", req.orgId)
      .in("id", ids);
    if (error) throw error;
    res.json({ success: true, action, notificationIds: ids });
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
  "/:notificationId/unread",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data, error } = await db
      .from("tenant_notifications")
      .update({ is_read: false, read_at: null })
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
