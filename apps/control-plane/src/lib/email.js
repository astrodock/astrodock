'use strict';

const https = require('https');
const config = require('../config');

// Optional transactional email via Resend. If no API key is configured, this is
// a no-op (logged once) — email alerts are a nice-to-have, never required to boot.
function sendEmail({ to, subject, html }) {
  const apiKey = config.email.resendApiKey;
  if (!apiKey) {
    console.warn('[email] TOOLSTEAD_RESEND_API_KEY not set — skipping email:', subject);
    return Promise.resolve();
  }
  if (!to) return Promise.resolve();

  const payload = JSON.stringify({
    from: config.email.from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else { console.error(`[email] Resend error ${res.statusCode}: ${body}`); reject(new Error(`Resend ${res.statusCode}`)); }
      });
    });
    req.on('error', (err) => { console.error('[email] request failed:', err.message); reject(err); });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendEmail };
