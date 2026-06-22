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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function resolveFrontendUrl() {
  const raw =
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://agently.vercel.app";
  return String(raw)
    .split(",")[0]
    .trim()
    .replace(/^https\/\//i, "https://")
    .replace(/^http\/\//i, "http://")
    .replace(/\/$/, "");
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
  const to = process.env.RESEND_FROM_EMAIL || "hello@agently.ai";
  await resend.emails.send({
    from: FROM(),
    to,
    reply_to: payload.email,
    subject: `[${payload.type === "sales" ? "Sales" : "Contact"}] ${payload.subject || "New inquiry"} — ${payload.name}`,
    html: `<p><b>Name:</b> ${payload.name}</p>
<p><b>Email:</b> ${payload.email}</p>
${payload.companyName ? `<p><b>Company:</b> ${payload.companyName}</p>` : ""}
${payload.expectedVolume ? `<p><b>Volume:</b> ${payload.expectedVolume}</p>` : ""}
<p><b>Message:</b><br>${(payload.message || "").replace(/\n/g, "<br>")}</p>`,
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
  const appUrl = resolveFrontendUrl();
  const safeName = escapeHtml(userName || "there");
  const safeCompany = escapeHtml(companyName || "your workspace");
  const dashboardUrl = `${appUrl}/#/dashboard`;
  const onboardingUrl = `${appUrl}/#/dashboard`;

  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `Welcome to Agently — your agent workspace is ready`,
    html: `<!DOCTYPE html>
<html>
  <body style="margin:0;background:#f7f4eb;padding:32px 18px;font-family:Avantt,Avenir Next,Inter,Segoe UI,Arial,sans-serif;color:#232f3e;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;">
      <tr>
        <td style="padding:0;">
          <div style="background:#fbfaf4;border:1px solid rgba(35,47,62,.12);border-radius:28px;overflow:hidden;box-shadow:0 24px 70px rgba(35,47,62,.12);">
            <div style="background:#232f3e;padding:26px 28px 30px;position:relative;">
              <div style="display:inline-block;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:8px 14px;color:#fff;font-size:13px;font-weight:500;letter-spacing:-.01em;">
                <span style="display:inline-block;width:9px;height:9px;background:#ff5527;border-radius:999px;margin-right:8px;"></span>Agently
              </div>
              <h1 style="margin:24px 0 10px;color:#fff;font-size:40px;line-height:40px;font-weight:500;letter-spacing:-.055em;">
                Welcome aboard, ${safeName}.
              </h1>
              <p style="margin:0;color:rgba(255,255,255,.76);font-size:16px;line-height:22px;font-weight:400;max-width:460px;">
                Your ${safeCompany} control room is open. Next, finish onboarding so Agently can answer, qualify, recover, and hand off conversations with the right context.
              </p>
            </div>
            <div style="padding:28px;">
              <div style="display:block;background:#fff;border:1px solid rgba(35,47,62,.1);border-radius:22px;padding:18px;margin-bottom:20px;">
                <p style="margin:0 0 12px;color:#232f3e;font-size:15px;line-height:21px;font-weight:500;">Your setup path</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:10px 0;border-top:1px solid rgba(35,47,62,.08);font-size:14px;line-height:20px;color:#425266;"><strong style="color:#232f3e;">1.</strong> Add your workspace details and website.</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-top:1px solid rgba(35,47,62,.08);font-size:14px;line-height:20px;color:#425266;"><strong style="color:#232f3e;">2.</strong> Review the Knowledge Base answers Agently prepares.</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-top:1px solid rgba(35,47,62,.08);font-size:14px;line-height:20px;color:#425266;"><strong style="color:#232f3e;">3.</strong> Launch your first voice agent and test the experience.</td>
                  </tr>
                </table>
              </div>
              <div style="text-align:center;margin:24px 0 20px;">
                <a href="${onboardingUrl}" style="display:inline-block;background:#ff5527;color:#fff;text-decoration:none;border-radius:999px;padding:15px 28px;font-size:14px;line-height:18px;font-weight:500;box-shadow:0 12px 26px rgba(255,85,39,.22);">Continue setup</a>
              </div>
              <p style="margin:0;text-align:center;color:#6b7280;font-size:12px;line-height:18px;">
                You can also open your workspace here: <a href="${dashboardUrl}" style="color:#232f3e;text-decoration:underline;">Agently dashboard</a>.
              </p>
            </div>
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  });
}
module.exports = {
  sendMagicLinkEmail,
  sendTeamInviteEmail,
  sendContactEmail,
  sendWelcomeEmail,
  sendOrganizationDeletionRequestEmail,
  sendUnreadNotificationsDigestEmail,
};
