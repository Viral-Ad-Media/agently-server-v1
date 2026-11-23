"use strict";

/**
 * Send email from the tenant's own Gmail. SEND ONLY.
 *
 * Scope is gmail.send: Google classes it *sensitive* (same tier as Calendar),
 * not restricted, so it needs normal app verification and no CASA security
 * assessment. Agently never reads the inbox and never creates Gmail drafts
 * (gmail.compose is restricted) — the draft is written here, shown to the
 * tenant or used by an automation, and Gmail only delivers it.
 *
 * Tokens live in email_integrations, encrypted with the same vault as the
 * calendar (lib/crypto.js), bound to { organizationId, provider: "gmail",
 * connectionId }. Every query is scoped to organization_id: the table is RLS
 * enabled with zero policies and this is the service role.
 */

const { encryptSecret, decryptSecret } = require("./crypto");

const PROVIDER = "gmail";
const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DAILY_SEND_CAP = Number(process.env.GMAIL_DAILY_SEND_CAP || 200);
const PURPOSES = ["follow_up", "meeting_invite", "reschedule", "send_link", "booking_confirmation", "custom"];

// Columns safe to return to the browser: never the ciphertext.
const PUBLIC_COLUMNS =
  "id, provider, label, provider_user_email, status, last_error, is_default, automations, connected_at, updated_at";

function requireOrg(organizationId) {
  if (!organizationId || typeof organizationId !== "string") {
    const error = new Error("gmail-send requires an organizationId.");
    error.status = 500;
    throw error;
  }
}

function bindingFor(row) {
  return { organizationId: row.organization_id, provider: PROVIDER, connectionId: row.id };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function listEmailConnections(db, organizationId) {
  requireOrg(organizationId);
  const { data, error } = await db
    .from("email_integrations")
    .select(PUBLIC_COLUMNS)
    .eq("organization_id", organizationId);
  if (error) throw error;
  return (data || []).filter((r) => r.status !== "disconnected").sort((a, b) => Number(b.is_default) - Number(a.is_default));
}

async function getEmailConnectionRow(db, organizationId, connectionId = null) {
  requireOrg(organizationId);
  let query = db.from("email_integrations").select("*").eq("organization_id", organizationId);
  if (connectionId) query = query.eq("id", String(connectionId));
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []).filter((r) => r.status !== "disconnected");
  if (connectionId) return rows[0] || null;
  return rows.find((r) => r.is_default) || rows[0] || null;
}

/**
 * Save a Gmail grant. Keyed by Google account id so a second business's Gmail
 * becomes a second row, never an overwrite of the first. Google omits
 * refresh_token on a re-grant, so an existing refresh token is KEPT when the
 * new grant has none — nulling it destroyed live calendar grants before.
 */
async function saveGmailConnection(db, organizationId, { accessToken, refreshToken, expiresAt, scopes, providerUserId, providerUserEmail, providerUserName }) {
  requireOrg(organizationId);
  const { data: existingRows, error } = await db
    .from("email_integrations")
    .select("*")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const rows = existingRows || [];
  const existing =
    rows.find((r) => providerUserId && r.provider_user_id === String(providerUserId)) ||
    rows.find((r) => !r.provider_user_id && providerUserEmail && r.provider_user_email === providerUserEmail) ||
    null;
  const now = new Date().toISOString();

  let row = existing;
  if (!row) {
    const hasDefault = rows.some((r) => r.is_default && r.status !== "disconnected");
    const inserted = await db
      .from("email_integrations")
      .insert({
        organization_id: organizationId,
        provider: PROVIDER,
        label: String(providerUserName || providerUserEmail || "Gmail").slice(0, 120),
        provider_user_id: providerUserId ? String(providerUserId) : null,
        provider_user_email: providerUserEmail || null,
        status: "connected",
        is_default: !hasDefault,
        connected_at: now,
        updated_at: now,
      })
      .select("*")
      .single();
    if (inserted.error) throw inserted.error;
    row = inserted.data;
  }

  const binding = bindingFor(row);
  const update = {
    access_token_encrypted: encryptSecret(accessToken, binding),
    refresh_token_encrypted: refreshToken ? encryptSecret(refreshToken, binding) : row.refresh_token_encrypted || null,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    scopes: scopes || null,
    provider_user_email: providerUserEmail || row.provider_user_email || null,
    status: "connected",
    last_error: null,
    updated_at: now,
  };
  const saved = await db
    .from("email_integrations")
    .update(update)
    .eq("organization_id", organizationId)
    .eq("id", row.id)
    .select("*")
    .single();
  if (saved.error) throw saved.error;
  return saved.data;
}

async function setDefaultEmailConnection(db, organizationId, connectionId) {
  const target = await getEmailConnectionRow(db, organizationId, connectionId);
  if (!target) return null;
  // Clear first: the partial unique index rejects two defaults.
  await db.from("email_integrations").update({ is_default: false }).eq("organization_id", organizationId).eq("is_default", true);
  const { data, error } = await db
    .from("email_integrations")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", target.id)
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

async function updateEmailAutomations(db, organizationId, connectionId, automations = {}) {
  const target = await getEmailConnectionRow(db, organizationId, connectionId);
  if (!target) return null;
  // Whitelist: only known automations, only booleans.
  const next = { ...(target.automations || {}) };
  if (automations.booking_confirmation !== undefined) next.booking_confirmation = automations.booking_confirmation === true;
  const { data, error } = await db
    .from("email_integrations")
    .update({ automations: next, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", target.id)
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

async function disconnectEmailConnection(db, organizationId, connectionId, { fetchImpl = fetch } = {}) {
  const target = await getEmailConnectionRow(db, organizationId, connectionId);
  if (!target) return false;
  try {
    const token = target.refresh_token_encrypted
      ? decryptSecret(target.refresh_token_encrypted, bindingFor(target))
      : null;
    if (token) {
      await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
    }
  } catch (_) {
    /* best-effort revoke */
  }
  await db.from("email_integrations").delete().eq("organization_id", organizationId).eq("id", target.id);
  if (target.is_default) {
    const next = await getEmailConnectionRow(db, organizationId);
    if (next) await setDefaultEmailConnection(db, organizationId, next.id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function markNeedsReconnect(db, row, message) {
  await db
    .from("email_integrations")
    .update({
      status: "needs_reconnect",
      last_error: message,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", row.organization_id)
    .eq("id", row.id);
}

async function getValidGmailAccessToken(db, row, { fetchImpl = fetch } = {}) {
  if (row.status === "needs_reconnect") throw httpError(409, "needs_reconnect", "Reconnect Gmail to send email.");
  const binding = bindingFor(row);
  const fresh = row.expires_at && new Date(row.expires_at).getTime() - Date.now() > REFRESH_SKEW_MS;
  if (fresh && row.access_token_encrypted) return decryptSecret(row.access_token_encrypted, binding);

  const refreshToken = row.refresh_token_encrypted ? decryptSecret(row.refresh_token_encrypted, binding) : null;
  if (!refreshToken) {
    await markNeedsReconnect(db, row, "No refresh token stored.");
    throw httpError(409, "needs_reconnect", "Reconnect Gmail to send email.");
  }
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error === "invalid_grant") {
      await markNeedsReconnect(db, row, "Gmail access was revoked or expired. Reconnect to keep sending.");
      throw httpError(409, "needs_reconnect", "Reconnect Gmail to send email.");
    }
    throw httpError(502, "gmail_token_error", `Gmail token refresh failed (HTTP ${response.status}).`);
  }
  await db
    .from("email_integrations")
    .update({
      access_token_encrypted: encryptSecret(body.access_token, binding),
      refresh_token_encrypted: body.refresh_token ? encryptSecret(body.refresh_token, binding) : row.refresh_token_encrypted,
      expires_at: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null,
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", row.organization_id)
    .eq("id", row.id);
  return body.access_token;
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[^\s@<>(),;:"\[\]\\]+$/;

function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

/** Header values must never carry CR/LF: that is header injection (extra Bcc:). */
function headerSafe(value) {
  return String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
}

function encodeHeaderWord(value) {
  const clean = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Plain text -> minimal HTML, with bare URLs linked. */
function textToHtml(text) {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function buildMimeMessage({ fromEmail, fromName, to, subject, text }) {
  const boundary = `agently_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const from = fromName ? `${encodeHeaderWord(fromName)} <${headerSafe(fromEmail)}>` : headerSafe(fromEmail);
  const lines = [
    `From: ${from}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(String(text), "utf8").toString("base64"),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(textToHtml(text), "utf8").toString("base64"),
    `--${boundary}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function sentToday(db, organizationId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await db
    .from("email_sends")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("status", "sent")
    .gte("created_at", since);
  if (error) throw error;
  return (data || []).length;
}

async function logSend(db, entry) {
  try {
    await db.from("email_sends").insert({ ...entry, created_at: new Date().toISOString() });
  } catch (error) {
    console.warn("[gmail-send] send log failed:", error && error.message);
  }
}

/**
 * Send one email from the organization's Gmail.
 * Returns { success, messageId, from } or throws an http-shaped error.
 */
async function sendGmail(db, organizationId, params = {}, deps = {}) {
  requireOrg(organizationId);
  const fetchImpl = deps.fetchImpl || fetch;
  const assertAllowed = deps.assertAllowed || require("./email-delivery").assertEmailRecipientsAllowed;
  const to = String(params.to || "").trim();
  const subject = headerSafe(params.subject).slice(0, 250);
  const text = String(params.body || params.text || "").trim();
  const purpose = PURPOSES.includes(params.purpose) ? params.purpose : "custom";

  if (!isValidEmail(to)) throw httpError(400, "invalid_recipient", "That email address doesn't look valid.");
  if (!subject) throw httpError(400, "missing_subject", "A subject is required.");
  if (!text) throw httpError(400, "missing_body", "The email body is empty.");
  if (text.length > 20000) throw httpError(400, "body_too_long", "The email is too long.");

  const row = await getEmailConnectionRow(db, organizationId, params.connectionId || null);
  if (!row) throw httpError(409, "gmail_not_connected", "Connect Gmail in Integrations to send email.");

  const base = {
    organization_id: organizationId,
    integration_id: row.id,
    voice_agent_id: params.voiceAgentId || null,
    lead_id: params.leadId || null,
    appointment_id: params.appointmentId || null,
    sent_by_user_id: params.userId || null,
    purpose,
    to_email: to,
    subject,
  };

  if ((await sentToday(db, organizationId)) >= DAILY_SEND_CAP) {
    throw httpError(429, "daily_cap", `Daily email limit reached (${DAILY_SEND_CAP}). Try again tomorrow.`);
  }

  // Same suppression list as platform email: a recipient who complained or
  // bounced is not mailed again from any sender. Fails closed.
  try {
    await assertAllowed({ to });
  } catch (error) {
    await logSend(db, { ...base, status: "blocked", error: error.code || error.message });
    throw httpError(error.code === "EMAIL_RECIPIENT_BLOCKED" ? 422 : 503, error.code || "blocked", error.message);
  }

  const accessToken = await getValidGmailAccessToken(db, row, { fetchImpl });
  const raw = buildMimeMessage({
    fromEmail: row.provider_user_email,
    fromName: params.fromName || row.label || null,
    to,
    subject,
    text,
  });
  const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = (body.error && body.error.message) || `HTTP ${response.status}`;
    await logSend(db, { ...base, status: "failed", error: reason.slice(0, 500) });
    if (response.status === 401 || response.status === 403) {
      await markNeedsReconnect(db, row, `Gmail refused the send: ${reason}`);
      throw httpError(409, "needs_reconnect", "Gmail needs to be reconnected before it can send.");
    }
    throw httpError(502, "gmail_send_failed", `Gmail did not send the email: ${reason}`);
  }
  await logSend(db, { ...base, status: "sent", provider_message_id: body.id || null });
  return { success: true, messageId: body.id || null, from: row.provider_user_email };
}

// ---------------------------------------------------------------------------
// Drafting (Agently writes the email; Gmail only delivers it)
// ---------------------------------------------------------------------------

const PURPOSE_BRIEFS = {
  follow_up: "a short, warm follow-up after a recent conversation, moving them to the next step",
  meeting_invite: "an invitation to book a meeting, including the booking link if one is given",
  reschedule: "a note offering to move their appointment to a new time, with the link or new time if given",
  send_link: "a brief email sending them the link they asked for, saying what it is",
  booking_confirmation: "a confirmation of the appointment they just booked, with the date and time",
  custom: "the email the owner describes in the notes",
};

function draftPrompt({ purpose, businessName, senderName, lead, appointment, link, notes }) {
  const facts = [
    `Business: ${businessName || "our business"}`,
    senderName ? `Sender: ${senderName}` : null,
    lead && lead.name ? `Recipient name: ${lead.name}` : null,
    lead && lead.company ? `Recipient company: ${lead.company}` : null,
    lead && lead.notes ? `What we know about them: ${String(lead.notes).slice(0, 800)}` : null,
    lead && lead.summary ? `Last conversation summary: ${String(lead.summary).slice(0, 800)}` : null,
    appointment ? `Appointment: ${appointment.when}${appointment.title ? ` (${appointment.title})` : ""}` : null,
    link ? `Link to include exactly: ${link}` : null,
    notes ? `Owner's instructions: ${String(notes).slice(0, 1000)}` : null,
  ].filter(Boolean);
  return [
    `Write ${PURPOSE_BRIEFS[purpose] || PURPOSE_BRIEFS.custom}.`,
    "It must read as personally written by the sender to this one person: specific, plain, 60-140 words, no marketing tone, no placeholders like [Name], no invented facts, times or links.",
    'Return JSON only: {"subject": "...", "body": "..."} where body is plain text with blank lines between paragraphs and ends with the sender\'s name if known.',
    "",
    ...facts,
  ].join("\n");
}

async function draftEmail(input, { openai, usageContext } = {}) {
  const client = openai || require("./openai").getOpenAI();
  const purpose = PURPOSES.includes(input.purpose) ? input.purpose : "custom";
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.6,
    max_tokens: 500,
    messages: [
      { role: "system", content: "You write short, personal business emails. Output JSON only." },
      { role: "user", content: draftPrompt({ ...input, purpose }) },
    ],
  });
  try {
    const { logOpenAIUsage } = require("./usage-ledger");
    await logOpenAIUsage({
      organizationId: usageContext && usageContext.organizationId,
      userId: usageContext && usageContext.userId,
      service: "email_draft",
      eventType: "openai_text_tokens",
      model: completion.model || "gpt-4o-mini",
      usage: completion.usage || {},
      leadId: usageContext && usageContext.leadId,
      metadata: { purpose },
    });
  } catch (_) {
    /* usage logging never blocks a draft */
  }
  let parsed = {};
  try {
    parsed = JSON.parse((completion.choices[0] && completion.choices[0].message.content) || "{}");
  } catch (_) {
    parsed = {};
  }
  const subject = headerSafe(parsed.subject || "").slice(0, 250);
  const body = String(parsed.body || "").trim();
  if (!subject || !body) throw httpError(502, "draft_failed", "Couldn't draft that email. Please try again.");
  // A link we were given must survive drafting verbatim.
  const finalBody = input.link && !body.includes(input.link) ? `${body}\n\n${input.link}` : body;
  return { subject, body: finalBody, purpose };
}

/**
 * Automation: personal confirmation from the owner's Gmail after the agent
 * books. Runs only when the default sender has booking_confirmation switched
 * on and the attendee left an email. Returns a status string; never throws.
 */
async function sendBookingConfirmation(db, organizationId, appointment, deps = {}) {
  try {
    if (!appointment || !isValidEmail(appointment.attendee_email || "")) return "no_recipient";
    const row = await getEmailConnectionRow(db, organizationId);
    if (!row || !(row.automations && row.automations.booking_confirmation === true)) return "off";
    const { data: org } = await db.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    let when;
    try {
      when = new Date(appointment.starts_at).toLocaleString("en-US", {
        timeZone: appointment.timezone || "America/New_York",
        weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      });
    } catch (_) {
      when = appointment.starts_at;
    }
    const draft = await (deps.draft || draftEmail)(
      {
        purpose: "booking_confirmation",
        businessName: (org && org.name) || "",
        senderName: row.label || "",
        lead: { name: appointment.attendee_name || null },
        appointment: { when, title: appointment.title || null },
        link: appointment.reschedule_url || null,
      },
      { usageContext: { organizationId } },
    );
    await sendGmail(
      db,
      organizationId,
      {
        to: appointment.attendee_email,
        subject: draft.subject,
        body: draft.body,
        purpose: "booking_confirmation",
        appointmentId: appointment.id,
        voiceAgentId: deps.voiceAgentId || null,
        connectionId: row.id,
      },
      deps,
    );
    return "sent";
  } catch (error) {
    console.warn("[gmail-send] booking confirmation not sent:", error && (error.code || error.message));
    return "failed";
  }
}

module.exports = {
  sendBookingConfirmation,
  GMAIL_SCOPES,
  PURPOSES,
  PUBLIC_COLUMNS,
  DAILY_SEND_CAP,
  listEmailConnections,
  getEmailConnectionRow,
  saveGmailConnection,
  setDefaultEmailConnection,
  updateEmailAutomations,
  disconnectEmailConnection,
  getValidGmailAccessToken,
  sendGmail,
  draftEmail,
  _internals: { buildMimeMessage, headerSafe, isValidEmail, draftPrompt, textToHtml },
};
