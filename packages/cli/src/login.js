'use strict';

// `astrodock login`: get a key for this repo without anyone copying one.
//
// Two ways in, one command:
//   • With an instance URL (--url, or ASTRODOCK_URL already set): sign in to
//     that instance directly.
//   • With neither: start at the hosted service, where the person signs up or
//     signs in, and pays if they are new. The service then hands the sign-in to
//     their instance.
//
// Either way the browser opens a page where a person approves the key with a
// passkey or authenticator code, and the CLI collects it. The CLI keeps a PKCE
// verifier and only ever sends its hash, so the hosted service, which relays
// the sign-in to the instance, can never collect the key itself.
//
// The key is written to .env.astrodock (0600), which is added to .gitignore.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CRED_FILE, loadCredentials } = require('./credentials');
const { openUrl } = require('./browser');

// The hosted service. Overridable for testing and for anyone running their own.
const DEFAULT_CLOUD_URL = 'https://cloud.astrodock.ai';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

// The key comes back sealed to a key pair made here for this sign-in, so it is
// readable only by this process, whoever relays the sign-in. The platform's
// copy of this scheme is apps/control-plane/src/lib/sealed.js: the two must
// stay byte-for-byte the same.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('base64url');
  return { publicKey: raw, privateKey };
}

function openSealed(sealedKey, privateKey, salt) {
  const epk = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(sealedKey.epk, 'base64url')]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey: epk });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(String(salt)), Buffer.from('astrodock-cli-login'), 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealedKey.iv, 'base64url'));
  d.setAuthTag(Buffer.from(sealedKey.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(sealedKey.ct, 'base64url')), d.final()]).toString('utf8');
}

// What the approval page has to show. Computed here from this sign-in's own
// challenge and key, never taken from a server.
function checkCode(challenge, publicKey) {
  const h = crypto.createHash('sha256').update(`astrodock-check:${challenge}:${publicKey || ''}`).digest();
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

function checkUrl(url, label) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${label} is not a valid URL: ${url}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use https (got ${u.protocol}//${u.host})`);
  }
  return url.replace(/\/$/, '');
}

// A remote URL can carry a credential (https://user:token@host/...). It is shown
// to the person approving, so strip that before it leaves this machine.
function gitRemote(cwd) {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
      const u = new URL(raw);
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      return raw.replace(/^[^@\s]+@/, '');
    }
  } catch {
    return '';
  }
}

function clientInfo(cwd) {
  return {
    hostname: os.hostname(),
    folder: path.basename(cwd),
    gitRemote: gitRemote(cwd),
    platform: process.platform,
    cliVersion: require('../package.json').version
  };
}

function readManifestLoose(cwd) {
  const p = path.join(cwd, 'app.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Cannot reach ${new URL(url).origin}: ${err.message}`);
  }
  let json = null;
  const text = await res.text();
  if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
  return { status: res.status, json };
}

function inGitRepo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function tracked(cwd) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', CRED_FILE], { cwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Make sure git will never pick the key file up. */
function ensureIgnored(cwd) {
  if (!inGitRepo(cwd)) return false;
  const gi = path.join(cwd, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.includes(CRED_FILE) || lines.includes(`/${CRED_FILE}`)) return false;
  fs.writeFileSync(gi, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${CRED_FILE}\n`);
  return true;
}

function writeCredentials(cwd, url, token) {
  const file = path.join(cwd, CRED_FILE);
  // Replaced, not edited: it holds these two lines and nothing else.
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `ASTRODOCK_URL=${url}\nASTRODOCK_TOKEN=${token}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

// A server that is still starting, or a certificate still being issued, is a
// reason to keep waiting rather than to give up. Polling stops at the
// sign-in's own expiry instead.
const GIVE_UP_MS = 20 * 60 * 1000;

async function patientPost(url, body, state, log) {
  try {
    const out = await post(url, body);
    state.unreachable = false;
    return out;
  } catch (err) {
    if (Date.now() - state.started > GIVE_UP_MS) throw err;
    if (!state.unreachable && log) log(`Waiting for ${new URL(url).host} to answer…`);
    state.unreachable = true;
    return { status: 0, json: { status: 'pending' } };
  }
}

/** Poll an instance until the sign-in is approved, declined or expired. */
async function pollInstance(instanceUrl, deviceCode, verifier, interval, log) {
  let wait = Math.max(Number(interval) || 3, 2) * 1000;
  const state = { started: Date.now() };
  while (true) {
    await sleep(wait);
    const { status, json } = await patientPost(`${instanceUrl}/cli/login/poll`, { deviceCode, codeVerifier: verifier }, state, log);
    if (status === 429 || json?.code === 'slow_down') { wait += 2000; continue; }
    if (json?.status === 'pending') continue;
    if (json?.status === 'approved') return json;
    if (json?.status === 'denied') throw new Error('The sign-in was declined.');
    if (json?.status === 'expired') throw new Error('The sign-in expired. Run astrodock login again.');
    if (json?.status === 'consumed') throw new Error('This sign-in was already used. Run astrodock login again.');
    throw new Error(json?.error || `Sign-in failed (${status}).`);
  }
}

/** Poll the hosted service until it hands the sign-in to an instance. */
async function pollCloud(cloudUrl, deviceCode, interval, log) {
  let wait = Math.max(Number(interval) || 3, 2) * 1000;
  let said = false;
  const state = { started: Date.now() };
  while (true) {
    await sleep(wait);
    const { status, json } = await patientPost(`${cloudUrl}/api/cli/poll`, { deviceCode }, state, log);
    if (status === 429 || json?.code === 'slow_down') { wait += 2000; continue; }
    if (json?.status === 'pending') continue;
    if (json?.status === 'provisioning') {
      if (!said) { log('Setting up your Astrodock…'); said = true; }
      continue;
    }
    if (json?.status === 'instance') return json;
    if (json?.status === 'denied') throw new Error('The sign-in was declined.');
    if (json?.status === 'expired') throw new Error('The sign-in expired. Run astrodock login again.');
    throw new Error(json?.error || `Sign-in failed (${status}).`);
  }
}

function show(log, { url, check, browser }) {
  log('');
  log(`Open this page to continue: ${url}`);
  log(`Approve only if the page shows this check code: ${check}`);
  if (browser && openUrl(url)) log('Opened it in your browser.');
  log('Waiting for approval…');
}

async function cmdLogin(flags, { cwd = process.cwd(), log = console.log } = {}) {
  if (tracked(cwd)) {
    throw new Error(`${CRED_FILE} is tracked by git. Run: git rm --cached ${CRED_FILE}, and add it to .gitignore.`);
  }
  const browser = !flags['no-browser'];
  const { verifier, challenge } = pkce();
  const keys = keyPair();
  const check = checkCode(challenge, keys.publicKey);
  const client = clientInfo(cwd);
  const manifest = readManifestLoose(cwd);

  // Where to start: an instance we were told about, or the hosted service.
  let existing = {};
  try { existing = loadCredentials(cwd); } catch { existing = {}; }
  const instanceGiven = flags.url || existing.ASTRODOCK_URL;

  let instanceUrl;
  let approved;
  if (instanceGiven) {
    instanceUrl = checkUrl(String(instanceGiven), 'The Astrodock URL');
    const { status, json } = await post(`${instanceUrl}/cli/login/start`, { codeChallenge: challenge, clientPublicKey: keys.publicKey, client, manifest });
    if (status >= 400) throw new Error(json?.error || `Could not start sign-in (${status}).`);
    show(log, { url: json.verificationUriComplete.startsWith('/') ? `${instanceUrl}${json.verificationUriComplete}` : json.verificationUriComplete, check, browser });
    approved = await pollInstance(instanceUrl, json.deviceCode, verifier, json.interval, log);
  } else {
    const cloudUrl = checkUrl(String(flags.cloud || process.env.ASTRODOCK_CLOUD_URL || DEFAULT_CLOUD_URL), 'The Astrodock cloud URL');
    const { status, json } = await post(`${cloudUrl}/api/cli/start`, { codeChallenge: challenge, clientPublicKey: keys.publicKey, client, manifest });
    if (status >= 400) throw new Error(json?.error || `Could not start sign-in (${status}).`);
    show(log, { url: json.verificationUriComplete, check, browser });
    const handed = await pollCloud(cloudUrl, json.deviceCode, json.interval, log);
    instanceUrl = checkUrl(handed.instanceUrl, 'The instance URL');
    approved = await pollInstance(instanceUrl, handed.deviceCode, verifier, handed.interval, log);
  }

  if (!approved.sealed) throw new Error('The platform sent the key unsealed. Update it before signing in.');
  let opened;
  try { opened = JSON.parse(openSealed(approved.sealed, keys.privateKey, challenge)); }
  catch { throw new Error('The key could not be opened, so it was not meant for this sign-in. Run astrodock login again.'); }
  const token = opened.token;
  if (!/^tk_[A-Za-z0-9_-]+$/.test(String(token))) throw new Error('What came back is not an access key.');

  // Given an address, keep it: it is the one known to work from here, and the
  // instance's own idea of its address can differ behind a proxy. Through the
  // hosted service, use the address sealed with the key, not the relay's word.
  const savedUrl = instanceGiven || !opened.url ? instanceUrl : checkUrl(opened.url, 'The instance URL');
  const file = writeCredentials(cwd, savedUrl, token);
  const ignored = ensureIgnored(cwd);

  log('');
  log(approved.kind === 'app'
    ? `Signed in. This key works for "${approved.app}" only.`
    : 'Signed in. This key works for every app on your account.');
  log(`Saved to ${path.relative(cwd, file) || CRED_FILE}${ignored ? ' (and added to .gitignore)' : ''}.`);
  if (approved.expiresAt) log(`It expires ${String(approved.expiresAt).slice(0, 10)}. Run astrodock login again to get a new one.`);
  if (process.env.ASTRODOCK_TOKEN || process.env.ASTRODOCK_URL) {
    log(`Note: ASTRODOCK_URL or ASTRODOCK_TOKEN is set in your environment, and it takes precedence over ${CRED_FILE}.`);
  }
  log('');
  log(manifest ? 'Next: astrodock apply, then astrodock deploy:watch --local' : 'Next: add an app.json, then astrodock apply and astrodock deploy:watch --local');
  return approved;
}

module.exports = { cmdLogin, pkce, keyPair, openSealed, checkCode, gitRemote, ensureIgnored, writeCredentials, DEFAULT_CLOUD_URL };
