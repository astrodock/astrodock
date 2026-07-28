'use strict';

// Transactional email. Two providers — Resend (one API key) and SMTP (everything
// else). Configuration lives in email-config; this module only sends.
//
// Email is not on any critical path: nothing signs in by email link and no
// password reset goes through here, so a platform with no provider configured is
// a supported state, not a broken one. It just means alerts have nowhere to go.

const https = require('https');
const emailConfig = require('./email-config');

let warnedNoProvider = false;

function sendViaResend({ apiKey, from, to, subject, html }) {
  const payload = JSON.stringify({ from, to, subject, html });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        // Resend puts a human-readable reason in the body; surfacing it beats
        // showing an operator "Resend 422" and letting them guess.
        let detail = body;
        try { detail = JSON.parse(body).message || body; } catch { /* keep raw */ }
        reject(new Error(`Resend rejected it (${res.statusCode}): ${String(detail).slice(0, 200)}`));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Resend timed out after 15s')); });
    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

async function sendViaSmtp({ smtp, from, to, subject, html }) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
  try {
    return await transport.sendMail({ from, to, subject, html });
  } finally {
    transport.close();
  }
}

async function sendEmail({ to, subject, html }) {
  if (!to) return null;
  const cfg = await emailConfig.resolve();

  if (!emailConfig.isUsable(cfg)) {
    if (!warnedNoProvider) {
      console.warn('[email] no email provider configured — skipping alerts. Set one up under Settings → Email.');
      warnedNoProvider = true;
    }
    return null;
  }
  warnedNoProvider = false;

  const recipients = Array.isArray(to) ? to : [to];
  if (cfg.provider === 'smtp') {
    return sendViaSmtp({ smtp: cfg.smtp, from: cfg.from, to: recipients.join(', '), subject, html });
  }
  return sendViaResend({ apiKey: cfg.resendApiKey, from: cfg.from, to: recipients, subject, html });
}

// Used by the "Send test" button and the setup wizard. Reports the failure
// rather than swallowing it, which is the entire point of a test.
async function sendTestEmail(to) {
  const cfg = await emailConfig.resolve();
  if (!emailConfig.isUsable(cfg)) throw new Error('No email provider is set up yet.');
  if (!to) throw new Error('Enter an address to send the test to.');
  await sendEmail({
    to,
    subject: '[Astrodock] Test message',
    html: '<h2 style="color:#0e9e6e">Email is working</h2>'
      + `<p style="color:#475569">Sent from your Astrodock instance via <b>${cfg.provider}</b>. `
      + 'If you can read this, alerts will reach you.</p>'
  });
  return { sent: true, provider: cfg.provider, to };
}

module.exports = { sendEmail, sendTestEmail };
