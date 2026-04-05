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

// Helper to escape HTML
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Shared email wrapper (brand colors, fonts, address) ─────────
function getEmailWrapper(content, title = "") {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap');
  body {
    font-family: 'Manrope', 'Segoe UI', Helvetica, Arial, sans-serif;
    background: #F3F4F6;
    margin: 0;
    padding: 40px 20px;
    color: #1F2937;
  }
  .container {
    max-width: 560px;
    margin: 0 auto;
    background: #FFFFFF;
    border-radius: 32px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.05);
    overflow: hidden;
  }
  .header {
    background: #232F3E;
    padding: 32px 24px;
    text-align: center;
  }
  .logo {
    font-family: 'Sora', 'Manrope', sans-serif;
    font-size: 28px;
    font-weight: 800;
    color: #FF9900;
    letter-spacing: -0.02em;
  }
  .tagline {
    color: #9CA3AF;
    margin-top: 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .content {
    padding: 32px 28px;
  }
  .footer {
    background: #F9FAFB;
    padding: 20px 28px;
    text-align: center;
    font-size: 12px;
    color: #6B7280;
    border-top: 1px solid #E5E7EB;
  }
  .button {
    background: #FF9900;
    color: #FFFFFF;
    text-decoration: none;
    padding: 12px 28px;
    border-radius: 40px;
    font-weight: 700;
    font-size: 14px;
    display: inline-block;
    margin: 16px 0;
  }
  h2 {
    font-family: 'Sora', 'Manrope', sans-serif;
    font-weight: 800;
    font-size: 24px;
    color: #232F3E;
    margin: 0 0 8px;
  }
  .highlight {
    color: #FF9900;
  }
  hr {
    border: none;
    border-top: 1px solid #E5E7EB;
    margin: 20px 0;
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">Agently</div>
    <div class="tagline">AI Receptionist for modern teams</div>
  </div>
  <div class="content">
    ${content}
  </div>
  <div class="footer">
    7001 South Hwy 6, Houston, Texas 77083<br>
    &copy; ${new Date().getFullYear()} Agently. All rights reserved.<br>
    <a href="{{unsubscribeLink}}" style="color: #6B7280; text-decoration: underline;">Unsubscribe</a>
  </div>
</div>
</body>
</html>`;
}

// ── Welcome email (sent after registration) ─────────────────────
async function sendWelcomeEmail(toEmail, userName, companyName) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  const unsubscribeLink = `${appUrl}/unsubscribe?email=${encodeURIComponent(toEmail)}`;

  const content = `
    <h2>Welcome aboard, ${escapeHtml(userName)}! 🎉</h2>
    <p style="font-size: 16px; line-height: 1.5; color: #4B5563;">You've successfully created your Agently workspace for <strong>${escapeHtml(companyName)}</strong>.</p>
    
    <div style="background: #F3F4F6; border-radius: 20px; padding: 20px; margin: 24px 0;">
      <p style="font-weight: 800; color: #232F3E; margin: 0 0 12px;">🚀 Next steps to get the most out of Agently:</p>
      <ul style="margin: 0; padding-left: 20px; color: #4B5563;">
        <li style="margin-bottom: 8px;">✅ Complete your agent onboarding – set up your voice and chat persona</li>
        <li style="margin-bottom: 8px;">✅ Import your website knowledge – our AI will learn your business</li>
        <li style="margin-bottom: 8px;">✅ Connect your phone number (Twilio) to start taking live calls</li>
        <li>✅ Embed the chat widget on your website – it's just an iframe</li>
      </ul>
    </div>
    
    <div style="background: #FEF3C7; border-left: 4px solid #FF9900; border-radius: 16px; padding: 16px 20px; margin: 24px 0;">
      <p style="font-weight: 700; margin: 0 0 8px; color: #92400E;">📧 Stay in the loop</p>
      <p style="margin: 0 0 12px; color: #B45309;">Get product updates, AI tips, and exclusive offers – once a week, no spam.</p>
      <a href="${appUrl}/subscribe?email=${encodeURIComponent(toEmail)}" class="button" style="background:#FF9900; color:#fff; padding:8px 20px; border-radius:40px; text-decoration:none; font-weight:600;">Subscribe to newsletter →</a>
    </div>
    
    <p style="color: #4B5563; font-size: 14px;">Need help? Reply to this email or visit our <a href="${appUrl}/help" style="color:#FF9900;">Help Center</a>.</p>
  `;

  const html = getEmailWrapper(content, "Welcome to Agently").replace(
    "{{unsubscribeLink}}",
    unsubscribeLink,
  );

  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `Welcome to Agently, ${userName}! Let's set up your AI receptionist.`,
    html,
  });
}

// ── Magic link email (updated to match brand) ───────────────────
async function sendMagicLinkEmail(toEmail, magicLinkUrl) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  const unsubscribeLink = `${appUrl}/unsubscribe?email=${encodeURIComponent(toEmail)}`;

  const content = `
    <h2>Sign in to Agently</h2>
    <p style="font-size: 16px; color: #4B5563;">Click the button below to sign in. This link expires in 15 minutes.</p>
    <div style="text-align: center;">
      <a href="${magicLinkUrl}" class="button" style="background:#FF9900; color:#fff; padding:12px 28px; border-radius:40px; text-decoration:none; font-weight:700; display:inline-block;">Sign In →</a>
    </div>
    <p style="font-size: 14px; color: #6B7280; text-align: center;">If you didn't request this, ignore this email.</p>
  `;
  const html = getEmailWrapper(content, "Sign In to Agently").replace(
    "{{unsubscribeLink}}",
    unsubscribeLink,
  );

  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: "Your Agently Sign-In Link",
    html,
  });
}

// ── Team invitation email (updated to match brand) ──────────────
async function sendTeamInviteEmail(toEmail, inviterName, orgName, role) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || "https://agently.vercel.app").replace(
    /\/$/,
    "",
  );
  const unsubscribeLink = `${appUrl}/unsubscribe?email=${encodeURIComponent(toEmail)}`;

  const content = `
    <h2>You're invited!</h2>
    <p style="font-size: 16px; color: #4B5563;"><strong>${inviterName}</strong> invited you to join <strong>${orgName}</strong> as a <strong>${role}</strong>.</p>
    <div style="text-align: center;">
      <a href="${appUrl}/#/login" class="button" style="background:#FF9900; color:#fff; padding:12px 28px; border-radius:40px; text-decoration:none; font-weight:700; display:inline-block;">Accept Invitation</a>
    </div>
    <p style="font-size: 14px; color: #6B7280;">If you don't have an account, you'll be asked to create one.</p>
  `;
  const html = getEmailWrapper(content, "Invitation to Agently").replace(
    "{{unsubscribeLink}}",
    unsubscribeLink,
  );

  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `You've been invited to ${orgName} on Agently`,
    html,
  });
}

// ── Contact / sales emails (unchanged – keep simple) ───────────
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

module.exports = {
  sendMagicLinkEmail,
  sendTeamInviteEmail,
  sendContactEmail,
  sendWelcomeEmail,
};
