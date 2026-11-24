"use strict";

/*
 * /api/sms — outbound SMS (lib/sms.js). Every tenant route is behind the "sms"
 * feature switch, so production refuses them until the Super Admin turns SMS on.
 *
 *   GET  /api/sms/numbers            SMS-capable numbers + price estimate inputs
 *   POST /api/sms/send               { leadId?, to?, body, fromNumberId? }
 *   GET  /api/sms/messages?leadId=   history for one lead
 *   POST /api/sms/status             Twilio delivery callback (signed)
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { requireFeature } = require("../../lib/feature-flags");
const { ensureWalletCreditOrRespond } = require("../../lib/billing-credit-enforcement");
const {
  sendSms,
  listSmsNumbers,
  countSegments,
  vendorCostPerSegment,
} = require("../../lib/sms");

const router = express.Router();

// Twilio delivery status. Signed by Twilio, not a browser session.
router.post(
  "/status",
  (req, res, next) => require("../../lib/twilio-request-auth").requireTwilio(req, res, next),
  asyncHandler(async (req, res) => {
    const sid = String(req.body?.MessageSid || "");
    const status = String(req.body?.MessageStatus || "").toLowerCase();
    if (sid && status) {
      await getSupabase()
        .from("sms_messages")
        .update({
          status,
          error_code: req.body?.ErrorCode ? String(req.body.ErrorCode) : null,
          updated_at: new Date().toISOString(),
        })
        .eq("twilio_sid", sid);
    }
    res.status(204).end();
  }),
);

router.use(requireAuth, requireFeature("sms"));

router.get(
  "/numbers",
  asyncHandler(async (req, res) => {
    const numbers = await listSmsNumbers(getSupabase(), req.orgId);
    res.json({
      numbers: numbers.map((row) => ({
        id: row.id,
        phoneNumber: row.phone_number,
        outboundSmsStatus: row.outbound_sms_status || null,
      })),
      vendorCostPerSegmentUsd: vendorCostPerSegment(),
    });
  }),
);

router.get(
  "/messages",
  asyncHandler(async (req, res) => {
    const leadId = String(req.query.leadId || "");
    let query = getSupabase()
      .from("sms_messages")
      .select("id,lead_id,from_number,to_number,body,segments,status,error_code,created_at")
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (leadId) query = query.eq("lead_id", leadId);
    const { data, error } = await query;
    if (error) return res.json({ messages: [] });
    res.json({
      messages: (data || []).map((row) => ({
        id: row.id,
        leadId: row.lead_id,
        from: row.from_number,
        to: row.to_number,
        body: row.body,
        segments: row.segments,
        status: row.status,
        errorCode: row.error_code,
        createdAt: row.created_at,
      })),
    });
  }),
);

router.post(
  "/send",
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = String(req.body?.body || "");
    const leadId = req.body?.leadId ? String(req.body.leadId) : null;
    let to = req.body?.to ? String(req.body.to) : "";

    if (leadId) {
      const { data: lead } = await db
        .from("leads")
        .select("id,phone")
        .eq("id", leadId)
        .eq("organization_id", req.orgId)
        .maybeSingle();
      if (!lead) return res.status(404).json({ error: { message: "Lead not found." } });
      to = to || lead.phone || "";
    }

    // Same credit gate as calls: block when the wallet can't cover a small
    // floor. The exact charge is posted by the usage ledger after sending.
    const { segments } = countSegments(body);
    const floor = Math.max(
      Number(process.env.SMS_MIN_CREDIT_USD) || 0.25,
      Math.max(1, segments) * vendorCostPerSegment() * 4,
    );
    const allowed = await ensureWalletCreditOrRespond(req, res, {
      action: "sms",
      minimumUsd: floor,
    });
    if (allowed !== true) return undefined;

    try {
      const result = await sendSms({
        organizationId: req.orgId,
        userId: req.user?.id || null,
        to,
        body,
        leadId,
        fromNumberId: req.body?.fromNumberId || null,
      });
      return res.status(201).json({ message: result });
    } catch (err) {
      return res.status(err.status || 500).json({
        error: { code: err.code || "SMS_FAILED", message: err.message || "The text could not be sent." },
      });
    }
  }),
);

module.exports = router;
