"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const {
  requireAuth,
  requireAdmin,
  requireOwner,
} = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { serializeUser } = require("../../lib/serializers");
const { sendTeamInviteEmail, sendContactEmail } = require("../../lib/email");

const router = express.Router();

// ============================================================
// TEAM
// ============================================================

// ── POST /api/team/invitations ───────────────────────────────
router.post(
  "/team/invitations",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { email, role, name } = req.body;

    if (!email || !role) {
      return res
        .status(400)
        .json({ error: { message: "Email and role are required." } });
    }

    if (!["Admin", "Viewer"].includes(role)) {
      return res
        .status(400)
        .json({ error: { message: "Role must be Admin or Viewer." } });
    }

    const db = getSupabase();
    const normalizedEmail = email.toLowerCase().trim();
    const memberName = (name || "").trim() || normalizedEmail.split("@")[0];

    // Check if already a member
    const { data: existing } = await db
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .eq("organization_id", req.orgId)
      .single();

    if (existing) {
      return res.status(409).json({
        error: {
          message: "This user is already a member of your organization.",
        },
      });
    }

    // Create placeholder user
    const { data: member, error } = await db
      .from("users")
      .insert({
        organization_id: req.orgId,
        name: memberName,
        email: normalizedEmail,
        role,
      })
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Failed to invite team member." } });
    }

    // Generate a magic link so they can sign in immediately
    try {
      const { v4: uuidv4 } = require("uuid");
      const token = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(); // 7 days
      await db
        .from("magic_link_tokens")
        .insert({ email: normalizedEmail, token, expires_at: expiresAt });

      const appUrl = (
        process.env.APP_URL || "https://agently.vercel.app"
      ).replace(/\/$/, "");
      const magicLinkUrl = `${appUrl}/#/login?magic=${token}`;

      await sendTeamInviteEmail(
        normalizedEmail,
        memberName,
        req.user.name,
        req.organization.name,
        role,
        magicLinkUrl,
      );
    } catch (e) {
      console.warn("Invite email failed:", e.message);
    }

    res.status(201).json({ member: serializeUser(member) });
  }),
);

// ── DELETE /api/team/members/:id ─────────────────────────────
router.delete(
  "/team/members/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    // Cannot remove yourself or the owner
    const { data: target } = await db
      .from("users")
      .select("role")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!target) {
      return res
        .status(404)
        .json({ error: { message: "Team member not found." } });
    }

    if (target.role === "Owner") {
      return res
        .status(403)
        .json({ error: { message: "Cannot remove the organization owner." } });
    }

    if (id === req.user.id) {
      return res
        .status(400)
        .json({ error: { message: "You cannot remove yourself." } });
    }

    await db
      .from("users")
      .delete()
      .eq("id", id)
      .eq("organization_id", req.orgId);

    res.json({ success: true });
  }),
);

// ============================================================
// BILLING
// ============================================================

// ── PATCH /api/billing/plan ──────────────────────────────────
router.patch(
  "/billing/plan",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { plan } = req.body;

    if (!["Starter", "Pro"].includes(plan)) {
      return res
        .status(400)
        .json({ error: { message: "Plan must be Starter or Pro." } });
    }

    const db = getSupabase();
    const planLimits = {
      Starter: { call_limit: 100, minute_limit: 500 },
      Pro: { call_limit: 500, minute_limit: 2500 },
    };

    const { data: org } = await db
      .from("organizations")
      .update({
        plan,
        subscription_status: "active",
        subscription_period_end: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        ...planLimits[plan],
      })
      .eq("id", req.orgId)
      .select()
      .single();

    // Create an invoice entry
    const amount = plan === "Pro" ? 99 : 49;
    await db.from("invoices").insert({
      id: `INV-${Date.now()}`,
      organization_id: req.orgId,
      amount,
      status: "Paid",
      date: new Date().toISOString(),
    });

    res.json({
      plan: org.plan,
      status: org.subscription_status,
      currentPeriodEnd: org.subscription_period_end,
      usage: {
        calls: org.usage_calls || 0,
        minutes: org.usage_minutes || 0,
        callLimit: org.call_limit || 100,
        minuteLimit: org.minute_limit || 500,
      },
    });
  }),
);

// ── POST /api/billing/cancel ─────────────────────────────────
router.post(
  "/billing/cancel",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = getSupabase();

    const { data: org } = await db
      .from("organizations")
      .update({ subscription_status: "canceled" })
      .eq("id", req.orgId)
      .select()
      .single();

    res.json({
      plan: org.plan,
      status: org.subscription_status,
      currentPeriodEnd: org.subscription_period_end,
      usage: {
        calls: org.usage_calls || 0,
        minutes: org.usage_minutes || 0,
        callLimit: org.call_limit || 100,
        minuteLimit: org.minute_limit || 500,
      },
    });
  }),
);

// ── GET /api/billing/invoices/:id/download ───────────────────
router.get(
  "/billing/invoices/:id/download",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getSupabase();

    const { data: invoice } = await db
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("organization_id", req.orgId)
      .single();

    if (!invoice) {
      return res.status(404).json({ error: { message: "Invoice not found." } });
    }

    const content = `AGENTLY INVOICE
===============
Invoice ID:   ${invoice.id}
Date:         ${new Date(invoice.date || invoice.created_at).toLocaleDateString()}
Organization: ${req.organization.name}
Amount:       $${parseFloat(invoice.amount || 0).toFixed(2)}
Status:       ${invoice.status || "Paid"}
Plan:         ${req.organization.plan}

Thank you for using Agently.
For questions, contact billing@agently.ai
`;

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.txt"`);
    res.send(content);
  }),
);

// ============================================================
// SETTINGS
// ============================================================

// ── PATCH /api/settings ──────────────────────────────────────
router.patch(
  "/settings",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { timezone, phoneNumber, twilio } = req.body;

    const db = getSupabase();
    const updates = {};

    if (timezone !== undefined) updates.timezone = timezone;
    if (phoneNumber !== undefined) updates.phone_number = phoneNumber;

    if (twilio) {
      if (twilio.clearCredentials) {
        updates.twilio_account_sid = "";
        updates.twilio_auth_token_encrypted = "";
        updates.twilio_auth_token_last_four = "";
      } else {
        if (twilio.accountSid !== undefined)
          updates.twilio_account_sid = twilio.accountSid;
        if (twilio.authToken) {
          // In production you'd encrypt this; for now store with last 4
          updates.twilio_auth_token_encrypted = twilio.authToken; // Store securely in prod
          updates.twilio_auth_token_last_four = twilio.authToken.slice(-4);
        }
        if (twilio.validateRequests !== undefined)
          updates.twilio_validate_requests = twilio.validateRequests;
      }
    }

    updates.updated_at = new Date().toISOString();

    const { data: org } = await db
      .from("organizations")
      .update(updates)
      .eq("id", req.orgId)
      .select()
      .single();

    res.json({
      timezone: org.timezone,
      phoneNumber: org.phone_number,
      twilio: {
        accountSid: org.twilio_account_sid || "",
        authTokenConfigured: !!org.twilio_auth_token_encrypted,
        authTokenLastFour: org.twilio_auth_token_last_four || "",
        validateRequests: org.twilio_validate_requests ?? true,
        webhookBaseUrl:
          org.twilio_webhook_base_url || process.env.API_URL || "",
      },
    });
  }),
);

// ============================================================
// CONTACT
// ============================================================

// ── POST /api/contact ────────────────────────────────────────
router.post(
  "/contact",
  asyncHandler(async (req, res) => {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res
        .status(400)
        .json({ error: { message: "Name, email, and message are required." } });
    }

    const db = getSupabase();

    await db.from("contact_submissions").insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      subject: subject || "",
      message: message.trim(),
      type: "contact",
    });

    try {
      await sendContactEmail({ name, email, subject, message });
    } catch (e) {
      console.warn("Contact email failed:", e.message);
    }

    res.json({
      success: true,
      message: "Your message has been sent successfully.",
    });
  }),
);

// ── POST /api/contact-sales ──────────────────────────────────
router.post(
  "/contact-sales",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, email, companyName, expectedVolume, message } = req.body;

    const db = getSupabase();

    await db.from("contact_submissions").insert({
      name: name || req.user.name,
      email: email || req.user.email,
      subject: "Sales Inquiry",
      message: message || `Interested in enterprise plan for ${companyName}.`,
      type: "sales",
      company_name: companyName || req.organization.name,
      expected_volume: expectedVolume || "",
    });

    try {
      await sendContactEmail({
        name: name || req.user.name,
        email: email || req.user.email,
        subject: "Sales Inquiry",
        message: `Company: ${companyName}\nVolume: ${expectedVolume}\n${message || ""}`,
        companyName,
        expectedVolume,
      });
    } catch (e) {
      console.warn("Sales contact email failed:", e.message);
    }

    res.json({
      success: true,
      message:
        "Sales inquiry submitted. Our team will be in touch within 24 hours.",
    });
  }),
);

// ============================================================
// DASHBOARD METRICS
// ============================================================

const secondsBetween = (start, end) => {
  if (!start || !end) return 0;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 1000);
};

const estimateUtf8Bytes = (value) =>
  Buffer.byteLength(String(value || ""), "utf8");

const normalizeCallDurationSeconds = (call) => {
  const direct = Number(call.duration || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const recording = Number(call.recording_duration || 0);
  if (Number.isFinite(recording) && recording > 0) return recording;

  const metadata =
    call.metadata && typeof call.metadata === "object" ? call.metadata : {};
  const nestedDuration = Number(
    metadata.durationSeconds ||
      metadata.duration_seconds ||
      metadata.duration ||
      (metadata.call_end_details && metadata.call_end_details.duration) ||
      0,
  );
  if (Number.isFinite(nestedDuration) && nestedDuration > 0)
    return nestedDuration;

  return secondsBetween(
    call.started_at || call.answered_at,
    call.ended_at || call.completed_at,
  );
};

// ── GET /api/dashboard/metrics ───────────────────────────────
router.get(
  "/dashboard/metrics",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();

    const [
      orgResult,
      callsResult,
      leadsResult,
      chatMessagesResult,
      knowledgeResult,
    ] = await Promise.all([
      db
        .from("organizations")
        .select("usage_calls,usage_minutes,call_limit,minute_limit,plan")
        .eq("id", req.orgId)
        .single(),
      db
        .from("call_records")
        .select(
          "id,duration,recording_duration,status,direction,outcome,started_at,answered_at,ended_at,completed_at,metadata,created_at,voice_agent_id",
        )
        .eq("organization_id", req.orgId)
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("leads")
        .select("id,status,source,created_at,voice_agent_id")
        .eq("organization_id", req.orgId)
        .limit(10000),
      db
        .from("chat_messages")
        .select("id,role,created_at,chatbot_id")
        .eq("organization_id", req.orgId)
        .limit(20000),
      db
        .from("knowledge_chunks")
        .select("id,content,source_url,source_title,created_at")
        .eq("organization_id", req.orgId)
        .limit(20000),
    ]);

    const org = orgResult.data || req.organization || {};
    const calls = Array.isArray(callsResult.data) ? callsResult.data : [];
    const leads = Array.isArray(leadsResult.data) ? leadsResult.data : [];
    const chatMessages = Array.isArray(chatMessagesResult.data)
      ? chatMessagesResult.data
      : [];
    const knowledgeChunks = Array.isArray(knowledgeResult.data)
      ? knowledgeResult.data
      : [];

    const totalCallSeconds = calls.reduce(
      (sum, call) => sum + normalizeCallDurationSeconds(call),
      0,
    );
    const totalCallMinutes = Math.round((totalCallSeconds / 60) * 10) / 10;
    const planName = String(
      org.plan || req.organization?.plan || "Starter",
    ).toLowerCase();
    const storedMinuteLimit = Number(
      org.minute_limit || req.organization?.minute_limit || 500,
    );
    const minuteLimit = planName === "starter" ? 500 : storedMinuteLimit || 500;
    const callLimit = Number(
      org.call_limit || req.organization?.call_limit || 100,
    );

    const completedCalls = calls.filter((call) => {
      const status = String(call.status || "").toLowerCase();
      return (
        status.includes("complete") ||
        call.completed_at ||
        call.ended_at ||
        normalizeCallDurationSeconds(call) > 0
      );
    }).length;
    const failedCalls = calls.filter((call) => {
      const status = String(call.status || "").toLowerCase();
      return (
        status.includes("fail") ||
        status.includes("busy") ||
        status.includes("no-answer") ||
        status.includes("cancel")
      );
    }).length;

    const chatbotMessagesAnswered = chatMessages.filter((message) =>
      ["model", "assistant", "bot"].includes(
        String(message.role || "").toLowerCase(),
      ),
    ).length;
    const chatbotTotalMessages = chatMessages.length;

    const chatbotLeadsCaptured = leads.filter(
      (lead) => String(lead.source || "").toLowerCase() === "chatbot",
    ).length;
    const callLeadsCaptured = leads.filter((lead) => {
      const source = String(lead.source || "").toLowerCase();
      return source === "call" || source === "voice" || source === "outbound";
    }).length;
    const convertedLeads = leads.filter((lead) => {
      const status = String(lead.status || "").toLowerCase();
      return status === "closed" || status === "converted" || status === "won";
    }).length;

    const estimatedStorageBytes = knowledgeChunks.reduce((sum, chunk) => {
      return (
        sum +
        estimateUtf8Bytes(chunk.content) +
        estimateUtf8Bytes(chunk.source_url) +
        estimateUtf8Bytes(chunk.source_title)
      );
    }, 0);

    const estimatedStorageLabel =
      estimatedStorageBytes < 1024 * 1024
        ? `${Math.max(0, Math.round(estimatedStorageBytes / 1024))} KB`
        : `${(estimatedStorageBytes / (1024 * 1024)).toFixed(1)} MB`;

    res.json({
      success: true,
      organizationId: req.orgId,
      metrics: {
        calls: {
          total: calls.length,
          completed: completedCalls,
          failed: failedCalls,
        },
        usage: {
          totalCallSeconds,
          totalCallMinutes,
          minuteLimit,
          remainingMinutes: Math.max(0, minuteLimit - totalCallMinutes),
          usagePercent: minuteLimit
            ? Math.min(100, (totalCallMinutes / minuteLimit) * 100)
            : 0,
          callsUsed: Number(org.usage_calls || calls.length || 0),
          callLimit,
        },
        chatbot: {
          messagesAnswered: chatbotMessagesAnswered,
          totalMessages: chatbotTotalMessages,
          leadsCaptured: chatbotLeadsCaptured,
        },
        leads: {
          totalCaptured: leads.length,
          chatbotLeadsCaptured,
          callLeadsCaptured,
          converted: convertedLeads,
          conversionRate: leads.length
            ? Math.round((convertedLeads / leads.length) * 1000) / 10
            : 0,
        },
        knowledge: {
          chunks: knowledgeChunks.length,
          estimatedStorageBytes,
          estimatedStorageLabel,
        },
      },
    });
  }),
);

module.exports = router;
