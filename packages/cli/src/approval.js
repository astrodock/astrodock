'use strict';

// Requests that need a person's approval.
//
// Some things a key asks for reach past its own app: creating an app, giving an
// app access to someone who already has an account, adding a domain. The
// platform answers those with 403 `approval_required` and a link. This waits for
// the person to approve it (with a passkey or authenticator code, in the
// browser), then repeats the identical request naming the approval.

const { openUrl } = require('./browser');

const POLL_MS = 3000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * client.request, plus waiting out an approval if one is asked for.
 * `wait: false` returns the 403 instead, for callers that should not block.
 */
async function requestWithApproval(client, method, path, body, { wait = true, log = console.error, browser = true } = {}) {
  const first = await client.request(method, path, body);
  if (first.status !== 403 || first.json?.code !== 'approval_required' || !wait) return first;

  const approval = first.json.approval;
  log(`\nThis needs your approval: ${approval.summary}.`);
  log(`Approve it here (passkey or authenticator code): ${approval.url}`);
  if (browser && openUrl(approval.url)) log('Opened it in your browser.');
  log('Waiting…');

  const deadline = new Date(approval.expiresAt).getTime();
  while (true) {
    if (Date.now() > deadline) throw new Error('The approval expired before anyone approved it.');
    await sleep(POLL_MS);
    const { status, json } = await client.request('GET', `/admin/approvals/${approval.id}`);
    if (status >= 400) throw new Error(json?.error || `could not check the approval (${status})`);
    const state = json.approval.status;
    if (state === 'approved') break;
    if (state === 'denied') throw new Error('The request was declined.');
    if (state === 'expired' || state === 'used') throw new Error(`The approval is ${state}.`);
  }
  log('Approved.');
  return client.request(method, path, body, { headers: { 'X-Astrodock-Approval': approval.id } });
}

module.exports = { requestWithApproval };
