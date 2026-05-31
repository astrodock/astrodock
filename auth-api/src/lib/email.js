const https = require('https');

const FROM = 'SV Platform <noreply@seniorverse.dev>';

function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set, skipping email');
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    from: FROM,
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
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          console.error(`[email] Resend API error ${res.statusCode}: ${body}`);
          reject(new Error(`Resend API error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', (err) => {
      console.error('[email] Request failed:', err.message);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendEmail };
