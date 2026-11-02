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

function show(log, { url, userCode, browser }) {
  log('');
  log(`Open this page to continue: ${url}`);
  if (userCode) log(`Check that it shows this code: ${userCode}`);
  if (browser && openUrl(url)) log('Opened it in your browser.');
  log('Waiting for approval…');
}

async function cmdLogin(flags, { cwd = process.cwd(), log = console.log } = {}) {
  if (tracked(cwd)) {
    throw new Error(`${CRED_FILE} is tracked by git. Run: git rm --cached ${CRED_FILE}, and add it to .gitignore.`);
  }
  const browser = !flags['no-browser'];
  const { verifier, challenge } = pkce();
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
    const { status, json } = await post(`${instanceUrl}/cli/login/start`, { codeChallenge: challenge, client, manifest });
    if (status >= 400) throw new Error(json?.error || `Could not start sign-in (${status}).`);
    show(log, { url: json.verificationUriComplete.startsWith('/') ? `${instanceUrl}${json.verificationUriComplete}` : json.verificationUriComplete, userCode: json.userCode, browser });
    approved = await pollInstance(instanceUrl, json.deviceCode, verifier, json.interval, log);
  } else {
    const cloudUrl = checkUrl(String(flags.cloud || process.env.ASTRODOCK_CLOUD_URL || DEFAULT_CLOUD_URL), 'The Astrodock cloud URL');
    const { status, json } = await post(`${cloudUrl}/api/cli/start`, { codeChallenge: challenge, client, manifest });
    if (status >= 400) throw new Error(json?.error || `Could not start sign-in (${status}).`);
    show(log, { url: json.verificationUriComplete, userCode: json.userCode, browser });
    const handed = await pollCloud(cloudUrl, json.deviceCode, json.interval, log);
    instanceUrl = checkUrl(handed.instanceUrl, 'The instance URL');
    approved = await pollInstance(instanceUrl, handed.deviceCode, verifier, handed.interval, log);
  }

  // The address this sign-in actually went through, which is known to work from
  // here. The instance's own idea of its address can differ behind a proxy.
  const file = writeCredentials(cwd, instanceUrl, approved.token);
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

module.exports = { cmdLogin, pkce, gitRemote, ensureIgnored, writeCredentials, DEFAULT_CLOUD_URL };
