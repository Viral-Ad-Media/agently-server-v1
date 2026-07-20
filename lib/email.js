"use strict";

let _resend = null;
let lastEmailUsageWarningAt = 0;
const { logEmailUsage } = require("./usage-ledger");

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

async function sendTrackedEmail(resend, emailOptions, usageContext = {}) {
  const result = await resend.emails.send(emailOptions);
  try {
    const providerMessageId =
      result?.data?.id ||
      result?.id ||
      result?.message_id ||
      result?.messageId ||
      null;
    await logEmailUsage({
      organizationId:
        usageContext.organizationId || usageContext.organization_id || null,
      userId: usageContext.userId || usageContext.user_id || null,
      emailType:
        usageContext.emailType || usageContext.email_type || "transactional",
      providerMessageId,
      to: Array.isArray(emailOptions.to)
        ? emailOptions.to.join(",")
        : emailOptions.to,
      subject: emailOptions.subject,
      billable: usageContext.billable !== false,
      metadata: {
        route: usageContext.route || null,
        resend_result: result || null,
        ...(usageContext.metadata || {}),
      },
    });
  } catch (err) {
    const now = Date.now();
    if (now - lastEmailUsageWarningAt >= 30000) {
      lastEmailUsageWarningAt = now;
      console.warn(
        "[usage-ledger] Resend email usage log skipped",
        err.message || String(err),
      );
    }
  }
  return result;
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

async function sendMagicLinkEmail(toEmail, magicLinkUrl, usageContext = {}) {
  const resend = getResend();
  await sendTrackedEmail(
    resend,
    {
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
    },
    { ...usageContext, emailType: "magic_link" },
  );
}

async function sendTeamInviteEmail(
  toEmail,
  memberName,
  inviterName,
  orgName,
  role,
  magicLinkUrl,
  usageContext = {},
) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  const loginUrl = magicLinkUrl || `${appUrl}/#/login`;
  await sendTrackedEmail(
    resend,
    {
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
    },
    { ...usageContext, emailType: "team_invite" },
  );
}

async function sendContactEmail(payload, usageContext = {}) {
  const resend = getResend();
  const to = process.env.RESEND_FROM_EMAIL || "hello@agently.ai";
  await sendTrackedEmail(
    resend,
    {
      from: FROM(),
      to,
      reply_to: payload.email,
      subject: `[${payload.type === "sales" ? "Sales" : "Contact"}] ${payload.subject || "New inquiry"} — ${payload.name}`,
      html: `<p><b>Name:</b> ${payload.name}</p>
<p><b>Email:</b> ${payload.email}</p>
${payload.companyName ? `<p><b>Company:</b> ${payload.companyName}</p>` : ""}
${payload.expectedVolume ? `<p><b>Volume:</b> ${payload.expectedVolume}</p>` : ""}
<p><b>Message:</b><br>${(payload.message || "").replace(/\n/g, "<br>")}</p>`,
    },
    {
      ...usageContext,
      emailType: payload.type === "sales" ? "sales_contact" : "contact_form",
    },
  );
}

async function sendUnreadNotificationsDigestEmail(
  toEmail,
  userName,
  orgName,
  unreadCount,
  usageContext = {},
) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  await sendTrackedEmail(
    resend,
    {
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
    },
    { ...usageContext, emailType: "notification_digest" },
  );
}

async function sendOrganizationDeletionRequestEmail(
  toEmail,
  userName,
  orgName,
  scheduledDeletionAt,
  usageContext = {},
) {
  const resend = getResend();
  await sendTrackedEmail(
    resend,
    {
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
    },
    { ...usageContext, emailType: "organization_deletion_request" },
  );
}

async function sendNumberRetentionWarningEmail({
  toEmails,
  organizationName,
  deadlineAt,
  minimumCreditUsd,
  numberLabels = [],
  usageContext = {},
}) {
  const resend = getResend();
  const appUrl = resolveFrontendUrl();
  const safeOrg = escapeHtml(organizationName || "your workspace");
  const deadline = new Date(deadlineAt);
  const safeDeadline = escapeHtml(
    Number.isNaN(deadline.getTime())
      ? "five days from this notice"
      : deadline.toLocaleString("en", {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: "UTC",
        }) + " UTC",
  );
  const minimum = Number(minimumCreditUsd || 1).toFixed(2);
  const labels = (numberLabels || []).filter(Boolean);
  const numberCount = Math.max(1, labels.length || 1);
  const numberWord = numberCount === 1 ? "number" : "numbers";
  const numberList = labels.length
    ? `<div style="margin:18px 0 0;padding:14px 16px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:13px;line-height:1.7">${labels.map((label) => `<div>${escapeHtml(label)}</div>`).join("")}</div>`
    : "";

  await sendTrackedEmail(
    resend,
    {
      from: FROM(),
      to: toEmails,
      subject: `Urgent: add credit within 5 days to keep your business ${numberWord}`,
      html: `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;padding:32px 18px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto"><tr><td>
<div style="overflow:hidden;border-radius:24px;background:#ffffff;border:1px solid #e2e8f0;box-shadow:0 24px 70px rgba(15,23,42,.12)">
  <div style="background:#0f172a;padding:28px 30px">
    <div style="display:inline-block;border-radius:999px;background:rgba(245,158,11,.16);padding:7px 12px;color:#f59e0b;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase">Action required</div>
    <h1 style="margin:18px 0 8px;color:#ffffff;font-size:30px;line-height:1.12;letter-spacing:-.04em">Keep your business ${numberWord} active</h1>
    <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.65">The usage credit for <strong style="color:#ffffff">${safeOrg}</strong> is below the required minimum, so billable services are currently paused.</p>
  </div>
  <div style="padding:28px 30px">
    <p style="margin:0;color:#475569;font-size:15px;line-height:1.7">Add at least <strong style="color:#0f172a">$${minimum}</strong> in usage credit by <strong style="color:#0f172a">${safeDeadline}</strong>.</p>
    <div style="margin:20px 0;padding:18px;border-radius:16px;background:#fff7ed;border:1px solid #fed7aa">
      <p style="margin:0;color:#9a3412;font-size:14px;line-height:1.65"><strong>If credit is not added before the deadline:</strong> your Agently services will remain stopped and your business ${numberWord} will be permanently released. Once released, ${numberCount === 1 ? "the number" : "those numbers"} cannot be recovered.</p>
    </div>
    ${numberList}
    <p style="margin:20px 0 0;color:#475569;font-size:14px;line-height:1.65">Adding the minimum credit before the deadline automatically cancels the scheduled release.</p>
    <div style="text-align:center;margin:26px 0 8px"><a href="${appUrl}/#/billing" style="display:inline-block;border-radius:12px;background:#f59e0b;color:#ffffff;text-decoration:none;padding:14px 28px;font-size:13px;font-weight:800">Add usage credit</a></div>
    <p style="margin:20px 0 0;color:#94a3b8;text-align:center;font-size:12px;line-height:1.5">This is an automated account-protection notice from Agently.</p>
  </div>
</div></td></tr></table></body></html>`,
    },
    { ...usageContext, emailType: "number_retention_warning", billable: false },
  );
}

async function sendNumberRetentionReleasedEmail({
  toEmails,
  organizationName,
  numberLabels = [],
  usageContext = {},
}) {
  const resend = getResend();
  const appUrl = resolveFrontendUrl();
  const safeOrg = escapeHtml(organizationName || "your workspace");
  const labels = (numberLabels || []).filter(Boolean);
  const numberCount = Math.max(1, labels.length || 1);
  const numberWord = numberCount === 1 ? "number" : "numbers";
  const numberList = labels.length
    ? `<div style="margin:18px 0 0;padding:14px 16px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:13px;line-height:1.7">${labels.map((label) => `<div>${escapeHtml(label)}</div>`).join("")}</div>`
    : "";

  await sendTrackedEmail(
    resend,
    {
      from: FROM(),
      to: toEmails,
      subject: `Your business ${numberWord} ${numberCount === 1 ? "has" : "have"} been permanently released`,
      html: `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;padding:32px 18px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto"><tr><td>
<div style="overflow:hidden;border-radius:24px;background:#ffffff;border:1px solid #e2e8f0;box-shadow:0 24px 70px rgba(15,23,42,.12)">
  <div style="background:#0f172a;padding:28px 30px">
    <div style="display:inline-block;border-radius:999px;background:rgba(239,68,68,.18);padding:7px 12px;color:#fca5a5;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase">Release completed</div>
    <h1 style="margin:18px 0 8px;color:#ffffff;font-size:30px;line-height:1.12;letter-spacing:-.04em">Your business ${numberWord} cannot be recovered</h1>
    <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.65">The five-day credit window for <strong style="color:#ffffff">${safeOrg}</strong> ended without the required account credit.</p>
  </div>
  <div style="padding:28px 30px">
    <p style="margin:0;color:#475569;font-size:15px;line-height:1.7">The business ${numberWord} linked to this workspace ${numberCount === 1 ? "was" : "were"} permanently released and can no longer be restored.</p>
    ${numberList}
    <div style="margin:20px 0;padding:18px;border-radius:16px;background:#fef2f2;border:1px solid #fecaca"><p style="margin:0;color:#991b1b;font-size:14px;line-height:1.65">You can add credit to reactivate eligible Agently services, but you will need to purchase and configure a new business number.</p></div>
    <div style="text-align:center;margin:26px 0 8px"><a href="${appUrl}/#/billing" style="display:inline-block;border-radius:12px;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 28px;font-size:13px;font-weight:800">Open billing</a></div>
  </div>
</div></td></tr></table></body></html>`,
    },
    {
      ...usageContext,
      emailType: "number_retention_released",
      billable: false,
    },
  );
}

async function sendWelcomeEmail(
  toEmail,
  userName,
  companyName,
  usageContext = {},
) {
  const resend = getResend();
  const appUrl = resolveFrontendUrl();
  const safeName = escapeHtml(userName || "there");
  const safeCompany = escapeHtml(companyName || "your workspace");
  const dashboardUrl = `${appUrl}/#/dashboard`;
  const onboardingUrl = `${appUrl}/#/dashboard`;

  await sendTrackedEmail(
    resend,
    {
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
    },
    { ...usageContext, emailType: "welcome" },
  );
}
module.exports = {
  sendMagicLinkEmail,
  sendTeamInviteEmail,
  sendContactEmail,
  sendWelcomeEmail,
  sendOrganizationDeletionRequestEmail,
  sendUnreadNotificationsDigestEmail,
  sendNumberRetentionWarningEmail,
  sendNumberRetentionReleasedEmail,
};
