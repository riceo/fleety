import { config } from './config.js';

// Outbound mail via Resend's REST API. When RESEND_API_KEY is not set,
// senders fall back to handing the admin a shareable link instead.
export const emailConfigured = (): boolean => !!config.resendApiKey;

async function send(to: string, subject: string, html: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const shell = (title: string, body: string, cta: { href: string; label: string }) => `
<div style="background:#060a14;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#0d1424;border:1px solid #26314f;border-top:3px solid #e32636;padding:28px">
    <p style="margin:0 0 4px;color:#7e8cab;font-size:11px;letter-spacing:3px;text-transform:uppercase">Fleety</p>
    <h1 style="margin:0 0 16px;color:#eef2fb;font-size:22px">${title}</h1>
    <div style="color:#aab6cf;font-size:15px;line-height:1.5">${body}</div>
    <a href="${cta.href}" style="display:inline-block;margin-top:20px;background:#e32636;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:3px">${cta.label}</a>
    <p style="margin:20px 0 0;color:#56617c;font-size:12px">This link expires in 48 hours. If you weren't expecting it, ignore this email.</p>
  </div>
</div>`;

// Club names are admin-controlled and land in email HTML, so escape them.
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function sendInviteEmail(to: string, clubName: string, link: string): Promise<boolean> {
  const safe = esc(clubName);
  return send(
    to,
    `You've been added to ${clubName} on Fleety`,
    shell(
      `Welcome to ${safe}`,
      `<p>You've been given access to the ${safe} operations board — live fleet tracking, flight history and the clubhouse ticker.</p><p>Set your password to get started.</p>`,
      { href: link, label: 'Set your password' }
    )
  );
}

// Infra alert (metrics crossed a threshold). Best-effort to email + webhook.
export async function sendAlert(subject: string, lines: string[]): Promise<void> {
  const body = lines.map((l) => `• ${l}`).join('\n');
  await send(
    config.alertEmail,
    subject,
    shell(
      esc(subject),
      `<p>Fleety flagged the following on the ops box:</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>Check Platform → Health.</p>`,
      { href: `https://${config.baseDomain}/platform`, label: 'Open platform health' }
    )
  ).catch(() => {});
  if (config.alertWebhook) {
    // Slack/Discord-compatible: both accept a JSON body with a "text" field.
    await fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${subject}*\n${body}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}

// Operator ping when someone joins the landing-page waitlist.
export function sendWaitlistNotification(signupEmail: string, marketing: boolean): Promise<boolean> {
  return send(
    config.waitlistNotifyEmail,
    `Fleety waitlist: ${signupEmail}`,
    shell(
      'New waitlist signup',
      `<p><strong>${signupEmail.replace(/</g, '&lt;')}</strong> joined the Fleety waitlist.</p><p>Product updates opt-in: <strong>${marketing ? 'yes' : 'no'}</strong>.</p>`,
      { href: `https://${config.baseDomain}/platform`, label: 'Open platform admin' }
    )
  );
}

export function sendResetEmail(to: string, link: string): Promise<boolean> {
  return send(
    to,
    'Reset your Fleety password',
    shell(
      'Password reset',
      `<p>Someone (hopefully you) asked to reset the password for this account.</p>`,
      { href: link, label: 'Choose a new password' }
    )
  );
}
