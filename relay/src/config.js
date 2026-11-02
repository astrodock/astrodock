'use strict';

// Reads the relay's settings from the environment. Provider credentials that
// are missing or unreadable leave that platform switched off (503 on push)
// instead of stopping the relay, so one bad key does not take down the other
// platform.

const crypto = require('node:crypto');
const { normalizePem } = require('./jwt');

function loadApns(env, warn) {
  const { RELAY_APNS_KEY, RELAY_APNS_KEY_ID, RELAY_APNS_TEAM_ID, RELAY_APNS_TOPIC } = env;
  if (!RELAY_APNS_KEY && !RELAY_APNS_KEY_ID && !RELAY_APNS_TEAM_ID && !RELAY_APNS_TOPIC) return null;
  const missing = ['RELAY_APNS_KEY', 'RELAY_APNS_KEY_ID', 'RELAY_APNS_TEAM_ID', 'RELAY_APNS_TOPIC'].filter((k) => !env[k]);
  if (missing.length) {
    warn(`APNs disabled: ${missing.join(', ')} not set`);
    return null;
  }
  let key;
  try {
    key = crypto.createPrivateKey(normalizePem(RELAY_APNS_KEY));
  } catch {
    warn('APNs disabled: RELAY_APNS_KEY is not a readable .p8 key');
    return null;
  }
  return { key, keyId: RELAY_APNS_KEY_ID, teamId: RELAY_APNS_TEAM_ID, topic: RELAY_APNS_TOPIC, host: env.RELAY_APNS_HOST || null };
}

function loadFcm(env, warn) {
  if (!env.RELAY_FCM_SERVICE_ACCOUNT) return null;
  let account;
  try {
    account = JSON.parse(env.RELAY_FCM_SERVICE_ACCOUNT);
  } catch {
    warn('FCM disabled: RELAY_FCM_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
  const { client_email: clientEmail, private_key: privateKey, project_id: projectId } = account || {};
  if (!clientEmail || !privateKey || !projectId) {
    warn('FCM disabled: RELAY_FCM_SERVICE_ACCOUNT needs client_email, private_key and project_id');
    return null;
  }
  let key;
  try {
    key = crypto.createPrivateKey(normalizePem(privateKey));
  } catch {
    warn('FCM disabled: the service account private_key is not readable');
    return null;
  }
  return {
    key,
    clientEmail,
    projectId,
    tokenUrl: env.RELAY_FCM_TOKEN_URL || account.token_uri || 'https://oauth2.googleapis.com/token',
    sendUrl: env.RELAY_FCM_SEND_URL || `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`
  };
}

function loadConfig(env = process.env, warn = (msg) => console.warn(msg)) {
  const registration = (env.RELAY_REGISTRATION || 'code').toLowerCase();
  if (registration !== 'open' && registration !== 'code') {
    throw new Error('RELAY_REGISTRATION must be "open" or "code"');
  }
  return {
    port: Number(env.ASTRODOCK_PORT || env.PORT || 3000),
    databaseUrl: env.RELAY_DATABASE_URL || env.ASTRODOCK_DATABASE_URL || null,
    registration,
    registrationCode: env.RELAY_REGISTRATION_CODE || null,
    trustProxy: env.RELAY_TRUST_PROXY || null,
    apns: loadApns(env, warn),
    fcm: loadFcm(env, warn)
  };
}

module.exports = { loadConfig };
