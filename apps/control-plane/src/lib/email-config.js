'use strict';

// Where email delivery is configured.
//
// It used to live only in ASTRODOCK_RESEND_API_KEY, which meant the one thing an
// operator most wants to change after install — where alerts come from and how
// they are sent — required editing a file on the box and restarting the stack.
// It now lives in platform_settings like every other operational setting, with
// the credential encrypted at rest, and env stays as the seed value so existing
// installs keep working untouched.
//
// Two providers, deliberately:
//   resend — paste one API key, nothing else to know. Good first-run default.
//   smtp   — speaks to everything else: SES, Postmark, Mailgun, Fastmail, Gmail,
//            a corporate relay, a box in a cupboard. One protocol, every vendor.

const { eq, inArray } = require('drizzle-orm');
const { db, schema } = require('../db');
const config = require('../config');
const { encryptSecret, decryptSecret } = require('./crypto');

const KEYS = {
  provider: 'email.provider',
  from: 'email.from',
  resendApiKey: 'email.resend_api_key',
  smtpHost: 'email.smtp_host',
  smtpPort: 'email.smtp_port',
  smtpSecure: 'email.smtp_secure',
  smtpUser: 'email.smtp_user',
  smtpPassword: 'email.smtp_password'
};
const SECRET_KEYS = new Set([KEYS.resendApiKey, KEYS.smtpPassword]);
const PROVIDERS = ['none', 'resend', 'smtp'];

async function readRows() {
  const wanted = Object.values(KEYS);
  try {
    const rows = await db.select().from(schema.platformSettings)
      .where(inArray(schema.platformSettings.key, wanted));
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch (err) {
    console.error('[email-config] load failed:', err.message);
    return new Map();
  }
}

// The resolved config, secrets included. Server-side only — never hand this to a
// route response; use describe() for that.
async function resolve() {
  const rows = await readRows();
  const get = (k) => rows.get(k);
  const secret = (k) => { const v = get(k); return v == null ? null : decryptSecret(v); };

  // An install that only ever set the env var has no rows, so infer the provider
  // from what env carries rather than reporting "not set up" at someone who has
  // been receiving alerts for weeks.
  let provider = get(KEYS.provider);
  if (!provider) provider = config.email.resendApiKey ? 'resend' : 'none';

  return {
    provider,
    from: get(KEYS.from) || config.email.from,
    resendApiKey: secret(KEYS.resendApiKey) || config.email.resendApiKey || '',
    smtp: {
      host: get(KEYS.smtpHost) || '',
      port: Number(get(KEYS.smtpPort)) || 587,
      // Implicit TLS on 465; everything else negotiates STARTTLS after connecting.
      secure: get(KEYS.smtpSecure) != null ? get(KEYS.smtpSecure) === true || get(KEYS.smtpSecure) === 'true'
        : Number(get(KEYS.smtpPort)) === 465,
      user: get(KEYS.smtpUser) || '',
      password: secret(KEYS.smtpPassword) || ''
    }
  };
}

// True when the resolved provider has everything it needs to actually send.
function isUsable(cfg) {
  if (cfg.provider === 'resend') return !!cfg.resendApiKey;
  if (cfg.provider === 'smtp') return !!cfg.smtp.host;
  return false;
}

// The safe view for the dashboard: whether a credential exists, never its value.
async function describe() {
  const cfg = await resolve();
  return {
    provider: cfg.provider,
    from: cfg.from,
    usable: isUsable(cfg),
    resend: { keySet: !!cfg.resendApiKey },
    smtp: {
      host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
      user: cfg.smtp.user, passwordSet: !!cfg.smtp.password
    },
    // Tells the UI it is looking at an install that predates in-app setup, so it
    // can say where the value came from rather than showing a blank box.
    fromEnv: !!config.email.resendApiKey
  };
}

async function put(key, value, actor) {
  const stored = SECRET_KEYS.has(key) ? encryptSecret(String(value)) : value;
  const row = { key, value: stored, updatedBy: actor || '', updatedAt: new Date() };
  await db.insert(schema.platformSettings).values(row)
    .onConflictDoUpdate({ target: schema.platformSettings.key, set: row });
}

async function clear(key) {
  await db.delete(schema.platformSettings).where(eq(schema.platformSettings.key, key));
}

// Save a partial update. Blank secrets mean "leave what is stored alone" — the
// UI never receives the current value, so it cannot echo it back, and treating
// an empty field as a deletion would wipe the key every time someone edited the
// port number next to it.
async function update(patch, actor) {
  if (patch.provider != null) {
    if (!PROVIDERS.includes(patch.provider)) throw new Error(`provider must be one of: ${PROVIDERS.join(', ')}`);
    await put(KEYS.provider, patch.provider, actor);
  }
  if (patch.from != null) {
    const from = String(patch.from).trim();
    if (from && !/.+@.+\..+/.test(from)) throw new Error('The “from” address does not look like an email address.');
    await put(KEYS.from, from, actor);
  }

  if (patch.resendApiKey) await put(KEYS.resendApiKey, String(patch.resendApiKey).trim(), actor);

  const smtp = patch.smtp || {};
  if (smtp.host != null) await put(KEYS.smtpHost, String(smtp.host).trim(), actor);
  if (smtp.port != null) {
    const port = parseInt(smtp.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('SMTP port must be between 1 and 65535.');
    await put(KEYS.smtpPort, port, actor);
  }
  if (smtp.secure != null) await put(KEYS.smtpSecure, !!smtp.secure, actor);
  if (smtp.user != null) await put(KEYS.smtpUser, String(smtp.user).trim(), actor);
  if (smtp.password) await put(KEYS.smtpPassword, String(smtp.password), actor);

  // Explicit removal, distinct from "left blank".
  if (patch.clearResendKey) await clear(KEYS.resendApiKey);
  if (patch.clearSmtpPassword) await clear(KEYS.smtpPassword);

  return describe();
}

module.exports = { resolve, describe, update, isUsable, KEYS, PROVIDERS };
