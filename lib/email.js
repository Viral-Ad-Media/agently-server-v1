"use strict";

let _resend = null;

function getResend() {
  if (_resend) return _resend;
  const { Resend } = require("resend");
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured.");
  _resend = new Resend(key);
  return _resend;
}

const FROM = () =>
  `${process.env.RESEND_FROM_NAME || "Agently"} <${process.env.RESEND_FROM_EMAIL || "hello@agently.ai"}>`;

const contactRecipient = () =>
  process.env.CONTACT_TO_EMAIL ||
  process.env.SUPPORT_EMAIL ||
  process.env.RESEND_FROM_EMAIL ||
  "hello@agently.ai";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendMagicLinkEmail(toEmail, magicLinkUrl) {
  const resend = getResend();
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: "Your Agently Sign-In Link",
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f8fafc">
<div style="background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.06)">
<div style="text-align:center;margin-bottom:28px">
  <span style="background:#4f46e5;color:#fff;font-size:22px;font-weight:900;padding:10px 22px;border-radius:10px;letter-spacing:-.04em">Agently</span>
</div>
<h2 style="color:#0f172a;text-align:center;margin:0 0 10px;font-size:24px;font-weight:800">Sign in to Agently</h2>
<p style="color:#64748b;text-align:center;margin:0 0 28px">Click below to sign in. This link expires in 15 minutes.</p>
<div style="text-align:center;margin:0 0 28px">
  <a href="${magicLinkUrl}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:800;font-size:13px;letter-spacing:.05em;text-transform:uppercase;display:inline-block">Sign In →</a>
</div>
<p style="color:#94a3b8;text-align:center;font-size:12px;margin:0">If you didn't request this, ignore this email.</p>
</div></body></html>`,
  });
}

async function sendPasswordResetEmail(toEmail, resetUrl, userName = "there") {
  const resend = getResend();
  const safeName = escapeHtml(userName || "there");
  const safeUrl = escapeHtml(resetUrl);
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: "Reset your Agently password",
    html: `<!DOCTYPE html><html><body style="margin:0;background:#f7f4eb;padding:32px 18px;font-family:Arial,sans-serif;color:#232f3e">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid rgba(35,47,62,.12);border-radius:22px;padding:32px;box-shadow:0 18px 48px rgba(35,47,62,.08)">
  <div style="margin-bottom:24px">
    <span style="display:inline-block;background:#ff5527;color:#fff;font-size:13px;font-weight:700;padding:9px 14px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase">Agently recovery</span>
  </div>
  <h1 style="margin:0 0 12px;color:#232f3e;font-size:28px;line-height:1.05;font-weight:600;letter-spacing:-.04em">Reset your password</h1>
  <p style="margin:0 0 22px;color:#334155;font-size:15px;line-height:1.55">Hi ${safeName}, we received a request to reset your Agently password. Use the secure button below to create a new password.</p>
  <div style="text-align:center;margin:28px 0">
    <a href="${safeUrl}" style="background:#232f3e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600;font-size:14px;display:inline-block">Create new password</a>
  </div>
  <p style="margin:0 0 12px;color:#64748b;font-size:13px;line-height:1.5">This secure recovery link expires in 30 minutes and can only be used once.</p>
  <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5">If you did not request this reset, you can safely ignore this email. Your existing password will continue to work.</p>
</div>
</body></html>`,
  });
}

async function sendTeamInviteEmail(
  toEmail,
  memberName,
  inviterName,
  orgName,
  role,
  magicLinkUrl,
) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  const loginUrl = magicLinkUrl || `${appUrl}/#/login`;
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `${inviterName} invited you to ${orgName} on Agently`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f8fafc">
<div style="background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.06)">
<div style="text-align:center;margin-bottom:28px">
  <span style="background:#232F3E;color:#fff;font-size:22px;font-weight:900;padding:10px 22px;border-radius:10px;letter-spacing:-.04em">Agently</span>
</div>
<h2 style="color:#0f172a;text-align:center;margin:0 0 8px;font-size:22px;font-weight:800">You've been invited!</h2>
<p style="color:#64748b;text-align:center;margin:0 0 24px;font-size:15px"><strong style="color:#0f172a">${inviterName}</strong> invited <strong style="color:#0f172a">${memberName}</strong> to join <strong style="color:#0f172a">${orgName}</strong> as a <strong style="color:#FF9900">${role}</strong>.</p>
<div style="background:#f8fafc;border-radius:12px;padding:16px 20px;margin-bottom:24px">
  <p style="margin:0;font-size:13px;color:#64748b"><strong style="color:#0f172a">Your access:</strong><br>
  ${role === "Admin" ? "✓ Manage voice agents, chatbots, leads, and team members" : "✓ View dashboard, call logs, and leads (read-only)"}</p>
</div>
<div style="text-align:center;margin:0 0 28px">
  <a href="${loginUrl}" style="background:#FF9900;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:800;font-size:13px;letter-spacing:.05em;text-transform:uppercase;display:inline-block">Accept Invitation →</a>
</div>
<p style="color:#94a3b8;text-align:center;font-size:12px;margin:0">This link expires in 7 days. If you didn't expect this invite, you can ignore it.</p>
</div></body></html>`,
  });
}

async function sendContactEmail(payload) {
  const resend = getResend();
  const to = contactRecipient();
  const inquiryType = payload.type === "sales" ? "Sales" : "Contact";
  const safeName = escapeHtml(payload.name || "Website visitor");
  const safeEmail = escapeHtml(payload.email || "");
  const safeSubject = escapeHtml(payload.subject || "New inquiry");
  const safeMessage = escapeHtml(payload.message || "").replace(/\n/g, "<br>");
  const safeCompany = escapeHtml(payload.companyName || "");
  const safeVolume = escapeHtml(payload.expectedVolume || "");

  await resend.emails.send({
    from: FROM(),
    to,
    reply_to: payload.email,
    subject: `[Agently ${inquiryType}] ${payload.subject || "New inquiry"} — ${payload.name || "Website visitor"}`,
    html: `<!DOCTYPE html><html><body style="margin:0;background:#f7f4eb;padding:32px 18px;font-family:Arial,sans-serif;color:#232f3e">
<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid rgba(35,47,62,.12);border-radius:22px;padding:28px;box-shadow:0 18px 48px rgba(35,47,62,.08)">
  <p style="margin:0 0 10px;color:#ff5527;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${inquiryType} inquiry</p>
  <h1 style="margin:0 0 20px;color:#232f3e;font-size:24px;line-height:1.1;font-weight:600">${safeSubject}</h1>
  <div style="background:#fbfaf4;border-radius:16px;padding:16px;margin-bottom:18px">
    <p style="margin:0 0 8px"><b>Name:</b> ${safeName}</p>
    <p style="margin:0"><b>Email:</b> ${safeEmail}</p>
    ${safeCompany ? `<p style="margin:8px 0 0"><b>Company:</b> ${safeCompany}</p>` : ""}
    ${safeVolume ? `<p style="margin:8px 0 0"><b>Volume:</b> ${safeVolume}</p>` : ""}
  </div>
  <p style="margin:0 0 8px;font-weight:700">Message</p>
  <p style="margin:0;color:#334155;line-height:1.55">${safeMessage}</p>
  <p style="margin:24px 0 0;color:#64748b;font-size:12px">Reply directly to this email to respond to ${safeName}.</p>
</div>
</body></html>`,
  });
}

async function sendUnreadNotificationsDigestEmail(
  toEmail,
  userName,
  orgName,
  unreadCount,
) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `You have ${unreadCount} unread Agently notifications`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f8fafc">
<div style="background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.06)">
<h2 style="color:#0f172a;margin:0 0 12px;font-size:22px;font-weight:800">You have unread notifications</h2>
<p style="color:#475569;font-size:15px;line-height:1.6">Hi ${userName},</p>
<p style="color:#475569;font-size:15px;line-height:1.6"><strong>${orgName}</strong> has ${unreadCount} unread notifications waiting in Agently.</p>
<div style="text-align:center;margin:28px 0">
  <a href="${appUrl}/#/notifications" style="background:#0f172a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:800;font-size:13px;letter-spacing:.05em;text-transform:uppercase;display:inline-block">Open Notifications</a>
</div>
<p style="color:#94a3b8;font-size:12px;margin:0">You receive this email when unread notifications reach your configured threshold.</p>
</div></body></html>`,
  });
}

async function sendOrganizationDeletionRequestEmail(
  toEmail,
  userName,
  orgName,
  scheduledDeletionAt,
) {
  const resend = getResend();
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `Organization deletion request received — ${orgName}`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f8fafc">
<div style="background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.06)">
<h2 style="color:#0f172a;margin:0 0 12px;font-size:22px;font-weight:800">Deletion request received</h2>
<p style="color:#475569;font-size:15px;line-height:1.6">Hi ${userName},</p>
<p style="color:#475569;font-size:15px;line-height:1.6">We received your request to delete <strong>${orgName}</strong>. Your workspace access has been disabled while the deletion is processed.</p>
<p style="color:#475569;font-size:15px;line-height:1.6">Your organization is scheduled for deletion within 30 days, no later than <strong>${new Date(scheduledDeletionAt).toLocaleDateString()}</strong>.</p>
<p style="color:#b91c1c;font-size:14px;line-height:1.6"><strong>Note:</strong> Paid and ongoing subscriptions are not refunded upon deletion.</p>
<p style="color:#94a3b8;font-size:12px;margin-top:24px">If this was a mistake, reply to this email immediately so the Agently team can review the request.</p>
</div></body></html>`,
  });
}

async function sendWelcomeEmail(toEmail, userName, companyName) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `Welcome to Agently, ${userName}!`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f8fafc">
<div style="background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.06)">
<div style="text-align:center;margin-bottom:28px">
  <span style="background:#232F3E;color:#fff;font-size:22px;font-weight:900;padding:10px 22px;border-radius:10px;letter-spacing:-.04em">Agently</span>
</div>
<h2 style="color:#0f172a;text-align:center;margin:0 0 8px;font-size:22px;font-weight:800">Welcome aboard, ${userName}! 🎉</h2>
<p style="color:#64748b;text-align:center;margin:0 0 24px;font-size:15px">Your AI receptionist for <strong style="color:#0f172a">${companyName}</strong> is ready to set up.</p>
<div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px">
  <p style="margin:0 0 12px;font-size:13px;color:#374151;font-weight:700">Get started in 3 steps:</p>
  <p style="margin:0 0 8px;font-size:13px;color:#64748b">✅ <strong>Step 1</strong> — Complete onboarding to configure your AI agent</p>
  <p style="margin:0 0 8px;font-size:13px;color:#64748b">📞 <strong>Step 2</strong> — Get a phone number from the Phone Numbers section</p>
  <p style="margin:0;font-size:13px;color:#64748b">🚀 <strong>Step 3</strong> — Test your agent with the in-app simulator</p>
</div>
<div style="text-align:center;margin:0 0 28px">
  <a href="${appUrl}" style="background:#FF9900;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:800;font-size:13px;letter-spacing:.05em;text-transform:uppercase;display:inline-block">Open Dashboard →</a>
</div>
<p style="color:#94a3b8;text-align:center;font-size:12px;margin:0">Questions? Reply to this email — we're here to help.</p>
</div></body></html>`,
  });
}

module.exports = {
  sendMagicLinkEmail,
  sendPasswordResetEmail,
  sendTeamInviteEmail,
  sendContactEmail,
  sendWelcomeEmail,
  sendOrganizationDeletionRequestEmail,
  sendUnreadNotificationsDigestEmail,
};
