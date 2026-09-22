"use strict";

const { createHash } = require("crypto");
const { Webhook } = require("svix");
const { getSupabase } = require("./supabase");

const BLOCKING_EVENTS = new Set(["email.bounced", "email.complained", "email.suppressed"]);

function recipientHash(address) {
  const normalized = String(address || "").trim().toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(normalized) || normalized.length > 320) {
    throw new Error("Invalid email recipient.");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function mailbox(value) {
  const text = String(value || "").trim();
  return (text.match(/<([^<>]+)>$/)?.[1] || text).trim().toLowerCase();
}

async function assertEmailRecipientsAllowed(options) {
  const addresses = [options.to, options.cc, options.bcc].flat().filter(Boolean);
  const hashes = [...new Set(addresses.map((address) => recipientHash(mailbox(address))))];
  if (!hashes.length) throw new Error("Email recipient is required.");
  const { data, error } = await getSupabase()
    .from("email_delivery_blocks")
    .select("recipient_hash")
    .in("recipient_hash", hashes)
    .eq("blocked", true);
  if (error || !Array.isArray(data)) {
    const failure = new Error("Email delivery protection is temporarily unavailable.");
    failure.code = "EMAIL_DELIVERY_UNAVAILABLE";
    throw failure;
  }
  if (data.length) {
    const failure = new Error("Email delivery is unavailable for this recipient. Contact support for help.");
    failure.code = "EMAIL_RECIPIENT_BLOCKED";
    throw failure;
  }
}

function createResendWebhookHandler({
  getDb = getSupabase,
  getSecret = () => process.env.RESEND_WEBHOOK_SECRET,
  getSender = () => process.env.RESEND_FROM_EMAIL || "hello@agently.ai",
} = {}) {
  return async function resendWebhook(req, res) {
    const secret = getSecret();
    if (!secret) return res.status(503).json({ error: { code: "EMAIL_WEBHOOK_NOT_CONFIGURED" } });
    let event;
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error("Raw body required");
      event = new Webhook(secret).verify(req.body.toString("utf8"), {
        "svix-id": req.headers["svix-id"],
        "svix-timestamp": req.headers["svix-timestamp"],
        "svix-signature": req.headers["svix-signature"],
      });
    } catch (_) {
      return res.status(400).json({ error: { code: "INVALID_EMAIL_WEBHOOK" } });
    }
    // Unrelated event types/senders must not change this application's blocks.
    if (!BLOCKING_EVENTS.has(event?.type)) return res.json({ received: true, ignored: true });
    if (mailbox(event.data?.from) !== mailbox(getSender())) {
      return res.json({ received: true, ignored: true });
    }
    let hashes, occurredAt;
    try {
      const recipients = event.data?.to;
      if (!Array.isArray(recipients) || recipients.length !== 1) {
        // Resend's delivery events identify one recipient. Never guess which
        // address bounced in a legacy multi-recipient event.
        throw new Error("Expected one event recipient");
      }
      if (typeof event.data.email_id !== "string" || !event.data.email_id) throw new Error("Missing email ID");
      hashes = recipients.map(recipientHash);
      const timestamp = Date.parse(event.created_at);
      if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300000) throw new Error("Invalid event time");
      occurredAt = new Date(timestamp).toISOString();
    } catch (_) {
      return res.status(400).json({ error: { code: "INVALID_EMAIL_EVENT" } });
    }
    try {
      const { error } = await getDb().rpc("record_email_delivery_block", {
        p_recipient_hash: hashes[0],
        p_event_id: req.headers["svix-id"],
        p_message_id: event.data.email_id,
        p_reason: event.type,
        p_occurred_at: occurredAt,
      });
      if (error) throw error;
      return res.json({ received: true });
    } catch (_) {
      // Non-2xx asks Resend to retry; never acknowledge an unsaved block.
      console.error("[email-delivery] Could not persist verified delivery failure.");
      return res.status(503).json({ error: { code: "EMAIL_EVENT_STORAGE_UNAVAILABLE" } });
    }
  };
}

module.exports = { recipientHash, assertEmailRecipientsAllowed, createResendWebhookHandler };
