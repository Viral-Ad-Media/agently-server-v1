"use strict";
/*
 * Owner inbox for website chats (Front Desk port).
 *
 * Lets the business owner see a chat as it happens, take it over from the
 * assistant, reply from the dashboard, and bring a customer back into the
 * same conversation later through a link sent by email.
 *
 * PRIVACY. Until now the API kept no chat transcripts at all. This stores
 * them, on the same terms as chat media: a conversation from a visitor who
 * never leaves contact details gets an expires_at and is purged after 24h;
 * once it belongs to a lead it is kept until the lead (or the conversation)
 * is deleted. A business can switch storage off entirely in Front Desk
 * settings (conversations_enabled = false), which restores the old behaviour.
 *
 * Statuses: "ai" (assistant answers), "human" (owner has taken over, the
 * assistant stays quiet), "closed".
 */

const jwt = require("jsonwebtoken");

const PENDING_TTL_MS = Number(process.env.CHAT_MEDIA_PENDING_TTL_MS || 24 * 60 * 60 * 1000);
const BODY_MAX = 4000;
const ROLES = new Set(["visitor", "assistant", "owner", "system"]);
const STATUSES = new Set(["ai", "human", "closed"]);

function preview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);
}

function resumeSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not configured.");
  return `chat-resume:${s}`;
}
/** Link token that reopens ONE conversation on ONE chatbot. */
function signResumeToken({ conversationId, chatbotId }) {
  return jwt.sign({ c: conversationId, b: chatbotId }, resumeSecret(), { expiresIn: "30d" });
}
function verifyResumeToken(token, chatbotId) {
  try {
    const p = jwt.verify(String(token || ""), resumeSecret());
    return p.b === chatbotId && typeof p.c === "string" ? p.c : null;
  } catch (_) {
    return null;
  }
}

async function findConversation(db, { chatbotId, sessionId }) {
  if (!chatbotId || !sessionId) return null;
  const { data } = await db
    .from("chat_conversations")
    .select("*")
    .eq("chatbot_id", chatbotId)
    .eq("session_id", sessionId)
    .maybeSingle();
  return data || null;
}

async function ensureConversation(db, { organizationId, chatbotId, sessionId, leadId = null, now = new Date() }) {
  const existing = await findConversation(db, { chatbotId, sessionId });
  if (existing) return existing;
  const row = {
    organization_id: organizationId,
    chatbot_id: chatbotId,
    session_id: sessionId,
    lead_id: leadId,
    status: "ai",
    unread_owner: 0,
    last_message_at: now.toISOString(),
    last_preview: "",
    expires_at: leadId ? null : new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
  };
  const { data, error } = await db.from("chat_conversations").insert(row).select("*").single();
  if (error) {
    // Two first messages raced on the unique (chatbot_id, session_id): use the winner.
    const again = await findConversation(db, { chatbotId, sessionId });
    if (again) return again;
    throw new Error(error.message);
  }
  return data;
}

/**
 * Appends messages to a conversation and updates its summary columns.
 * messages: [{ role, body, mediaId? }]. Returns the stored rows.
 */
async function appendMessages(db, conversation, messages, { now = new Date() } = {}) {
  const rows = [];
  let t = now.getTime();
  for (const m of messages || []) {
    const body = String(m?.body || "").slice(0, BODY_MAX);
    if (!ROLES.has(m?.role) || (!body && !m.mediaId)) continue;
    rows.push({
      conversation_id: conversation.id,
      organization_id: conversation.organization_id,
      role: m.role,
      body,
      media_id: m.mediaId || null,
      // Distinct, ordered timestamps even for messages stored together.
      created_at: new Date(t++).toISOString(),
    });
  }
  if (!rows.length) return [];
  const { data, error } = await db.from("chat_inbox_messages").insert(rows).select("*");
  if (error) throw new Error(error.message);
  const last = rows[rows.length - 1];
  const fromVisitor = rows.filter((r) => r.role === "visitor").length;
  const ownerSpoke = rows.some((r) => r.role === "owner");
  const patch = {
    last_message_at: last.created_at,
    last_preview: preview(last.body) || (last.media_id ? "Sent a photo or video" : ""),
    unread_owner: ownerSpoke ? 0 : Number(conversation.unread_owner || 0) + fromVisitor,
    updated_at: last.created_at,
  };
  if (conversation.status === "closed" && fromVisitor) patch.status = "ai";
  await db.from("chat_conversations").update(patch).eq("id", conversation.id);
  Object.assign(conversation, patch);
  return data || rows;
}

/** The visitor left details: the conversation is the lead's now and stops expiring. */
async function linkSessionConversationToLead(db, { chatbotId, sessionId, leadId }) {
  if (!chatbotId || !sessionId || !leadId) return 0;
  const { data, error } = await db
    .from("chat_conversations")
    .update({ lead_id: leadId, expires_at: null, updated_at: new Date().toISOString() })
    .eq("chatbot_id", chatbotId)
    .eq("session_id", sessionId)
    .select("id");
  if (error) throw new Error(error.message);
  return (data || []).length;
}

async function purgeExpiredConversations(db, { now = new Date() } = {}) {
  const { data, error } = await db
    .from("chat_conversations")
    .delete()
    .is("lead_id", null)
    .lt("expires_at", now.toISOString())
    .select("id");
  if (error) throw new Error(error.message);
  return (data || []).length;
}

let lastPurgeAt = 0;
function maybePurge(db, log = console) {
  const now = Date.now();
  if (now - lastPurgeAt < 10 * 60 * 1000) return;
  lastPurgeAt = now;
  purgeExpiredConversations(db).catch((e) => log.warn?.("[chat-inbox] purge skipped:", e.message));
}

function serializeMessage(row) {
  return { id: row.id, role: row.role, body: row.body || "", mediaId: row.media_id || null, createdAt: row.created_at };
}

function serializeConversation(row, lead) {
  return {
    id: row.id,
    chatbotId: row.chatbot_id,
    leadId: row.lead_id || null,
    leadName: lead?.name || null,
    leadEmail: lead?.email || null,
    leadPhone: lead?.phone || null,
    status: row.status,
    unread: Number(row.unread_owner || 0),
    lastMessageAt: row.last_message_at,
    lastPreview: row.last_preview || "",
    temporary: !row.lead_id,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  };
}

/** Messages after `after` (ISO) that the VISITOR should see: everything except their own. */
async function messagesForVisitor(db, conversationId, { after = null, all = false, limit = 50 } = {}) {
  let q = db
    .from("chat_inbox_messages")
    .select("id,role,body,media_id,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (after) q = q.gt("created_at", after);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || [])
    .filter((m) => m.role !== "system" && (all || m.role !== "visitor"))
    .map(serializeMessage);
}

async function listConversations(db, { organizationId, status = null, limit = 50 }) {
  let q = db
    .from("chat_conversations")
    .select("*")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));
  if (status && STATUSES.has(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data || [];
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const leads = new Map();
  if (leadIds.length) {
    const { data: ls } = await db
      .from("leads")
      .select("id,name,email,phone")
      .eq("organization_id", organizationId)
      .in("id", leadIds);
    for (const l of ls || []) leads.set(l.id, l);
  }
  return rows.map((r) => serializeConversation(r, leads.get(r.lead_id)));
}

async function getConversation(db, { organizationId, conversationId }) {
  const { data: row } = await db
    .from("chat_conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!row) return null;
  let lead = null;
  if (row.lead_id) {
    const { data } = await db
      .from("leads")
      .select("id,name,email,phone")
      .eq("id", row.lead_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    lead = data || null;
  }
  const { data: msgs, error } = await db
    .from("chat_inbox_messages")
    .select("id,role,body,media_id,created_at")
    .eq("conversation_id", row.id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return { row, lead, conversation: serializeConversation(row, lead), messages: (msgs || []).map(serializeMessage) };
}

function widgetResumeUrl(conversation) {
  const base = String(process.env.API_PUBLIC_URL || process.env.PUBLIC_API_URL || process.env.API_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const token = signResumeToken({ conversationId: conversation.id, chatbotId: conversation.chatbot_id });
  return `${base}/chatbot-widget/${conversation.chatbot_id}?resume=${encodeURIComponent(token)}`;
}

/** The visitor is "here" if the widget polled recently; otherwise a reply needs email to reach them. */
function visitorIsLive(row, now = Date.now()) {
  const seen = Date.parse(row.visitor_seen_at || "");
  return Number.isFinite(seen) && now - seen < 45000;
}

module.exports = {
  STATUSES,
  preview,
  signResumeToken,
  verifyResumeToken,
  findConversation,
  ensureConversation,
  appendMessages,
  linkSessionConversationToLead,
  purgeExpiredConversations,
  maybePurge,
  serializeMessage,
  serializeConversation,
  messagesForVisitor,
  listConversations,
  getConversation,
  widgetResumeUrl,
  visitorIsLive,
};
