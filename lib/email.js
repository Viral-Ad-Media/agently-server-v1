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

async function sendTeamInviteEmail(toEmail, inviterName, orgName, role) {
  const resend = getResend();
  const appUrl = (process.env.APP_URL || 'https://agently.vercel.app').replace(/\/$/, '');
  await resend.emails.send({
    from: FROM(),
    to: toEmail,
    subject: `You've been invited to ${orgName} on Agently`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px">
<h2>You're invited!</h2>
<p><strong>${inviterName}</strong> invited you to join <strong>${orgName}</strong> as a <strong>${role}</strong>.</p>
<a href="${appUrl}/#/login" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:800;margin-top:16px">Accept Invitation</a>
<p style="color:#94a3b8;font-size:12px;margin-top:24px">If you don't have an account you'll be asked to create one.</p>
</body></html>`,
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

module.exports = { sendMagicLinkEmail, sendTeamInviteEmail, sendContactEmail };
