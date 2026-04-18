'use strict';

let _resend = null;

function getResend() {
  if (_resend) return _resend;
  const { Resend } = require('resend');
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured.');
  _resend = new Resend(key);
  return _resend;
}

const FROM = () =>
  `${process.env.RESEND_FROM_NAME || 'Agently'} <${process.env.RESEND_FROM_EMAIL || 'hello@agently.ai'}>`;

async function sendMagicLinkEmail(toEmail, magicLinkUrl) {
  const resend = getResend();
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: 'Your Agently Sign-In Link',
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

async function sendTeamInviteEmail(toEmail, memberName, inviterName, orgName, role, magicLinkUrl) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || 'https://agently.vercel.app').replace(/\/$/, '');
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
  ${role === 'Admin' ? '✓ Manage voice agents, chatbots, leads, and team members' : '✓ View dashboard, call logs, and leads (read-only)'}</p>
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
  const to = process.env.RESEND_FROM_EMAIL || 'hello@agently.ai';
  await resend.emails.send({
    from: FROM(),
    to,
    reply_to: payload.email,
    subject: `[${payload.type === 'sales' ? 'Sales' : 'Contact'}] ${payload.subject || 'New inquiry'} — ${payload.name}`,
    html: `<p><b>Name:</b> ${payload.name}</p>
<p><b>Email:</b> ${payload.email}</p>
${payload.companyName ? `<p><b>Company:</b> ${payload.companyName}</p>` : ''}
${payload.expectedVolume ? `<p><b>Volume:</b> ${payload.expectedVolume}</p>` : ''}
<p><b>Message:</b><br>${(payload.message || '').replace(/\n/g,'<br>')}</p>`,
  });
}



async function sendWelcomeEmail(toEmail, userName, companyName) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || 'https://agently.vercel.app').replace(/\/$/, '');
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

module.exports = { sendMagicLinkEmail, sendTeamInviteEmail, sendContactEmail, sendWelcomeEmail };
