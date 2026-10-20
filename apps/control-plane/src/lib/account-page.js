'use strict';

// The hosted account page an end user reaches at auth.<domain>/account.
//
// It was a static file with its own stylesheet and fonts from Google, which put
// a third party on a page that takes a password. It is rendered on the same
// shell as sign-in now, so the two read as one surface.
//
// What it offers depends on whether a platform session exists. With one, the
// address and the attached Google account are editable here. Without, it is the
// password form it has always been: what somebody who arrives holding only
// their password needs.

const { shell, icon, errorLine, passwordField, REVEAL_JS } = require('./auth-pages');

function accountPage() {
  return shell('Your account', `
<span class="tile">${icon('lock')}</span>
<div class="heading"><h1 id="title">Change your password</h1><p class="sub" id="who" hidden>Signed in as <b id="acctEmail"></b></p></div>
${errorLine()}
<div class="ok" id="ok" role="status" hidden><span></span></div>

<div id="signedIn" hidden>
  <div class="sec" id="googleSec">
    <h2>Sign in with Google</h2>
    <div class="state"><span class="dot" id="gDot"></span><span id="gState"></span></div>
    <p id="gHelp"></p>
    <a class="btn secondary" id="gLink" href="/account/google/link">Attach my Google account</a>
    <button class="secondary" type="button" id="gUnlink" hidden>Detach it</button>
  </div>
  <form class="sec" id="emailForm">
    <h2>Sign-in address</h2>
    <p>Changing it sends a link to the new address. Nothing changes until you follow it.</p>
    <div class="field"><label for="newEmail">New address</label><input type="email" id="newEmail" autocomplete="email"></div>
    <button class="secondary" type="submit" id="emailBtn">Send the confirmation link</button>
  </form>
  <div class="sec"><h2>Change password</h2></div>
</div>

<form id="form">
  <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="username" required></div>
  ${passwordField('currentPassword', 'Current password', { required: true })}
  ${passwordField('newPassword', 'New password', { autocomplete: 'new-password', required: true, minlength: 8, hint: 'At least 8 characters.' })}
  ${passwordField('confirmPassword', 'Confirm new password', { autocomplete: 'new-password', required: true, minlength: 8 })}
  <button type="submit" id="submitBtn">Change password</button>
</form>
<script>
const el = (id) => document.getElementById(id);
const say = (kind, text) => {
  el('err').hidden = kind !== 'error'; el('ok').hidden = kind !== 'success';
  el(kind === 'error' ? 'err' : 'ok').querySelector('span').textContent = text;
};
const quiet = () => { el('err').hidden = true; el('ok').hidden = true; };
${REVEAL_JS}

(async function load() {
  let me;
  try {
    const r = await fetch('/account/me');
    if (!r.ok) return;
    me = await r.json();
  } catch { return; }

  el('signedIn').hidden = false;
  el('who').hidden = false;
  el('title').textContent = 'Your account';
  el('acctEmail').textContent = me.email;
  el('email').value = me.email;
  el('email').readOnly = true;

  if (new URLSearchParams(location.search).get('linked')) {
    say('success', 'That Google account is attached. You can sign in with it from now on.');
    history.replaceState(null, '', location.pathname);
  }
  if (me.pendingEmail) say('success', 'Waiting for ' + me.pendingEmail + ' to confirm. Until then you sign in as ' + me.email + '.');

  if (!me.googleAvailable) {
    el('gState').textContent = 'Not set up on this server';
    el('gHelp').textContent = 'An administrator has to configure Google sign-in before this can be used.';
    el('gLink').hidden = true;
    return;
  }
  if (me.google.linked) {
    el('gDot').classList.add('on');
    el('gState').textContent = me.google.email ? 'Attached: ' + me.google.email : 'Attached';
    el('gHelp').textContent = me.hasPassword || me.passkeys
      ? 'You can sign in with either this or your password.'
      : 'This is currently the only way into your account.';
    el('gLink').hidden = true;
    el('gUnlink').hidden = false;
  } else {
    el('gState').textContent = 'Not attached';
    el('gHelp').textContent = 'It does not have to be the same address as above. Whichever Google account you pick becomes a way in.';
  }
})();

el('gUnlink').addEventListener('click', async (e) => {
  quiet(); e.target.disabled = true;
  try {
    const r = await fetch('/account/google/unlink', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    say('success', d.message);
    setTimeout(() => location.reload(), 900);
  } catch (ex) {
    say('error', ex.message || 'That did not work.');
    e.target.disabled = false;
  }
});

el('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault(); quiet();
  const value = el('newEmail').value.trim();
  if (!value) return say('error', 'Enter the address you want to use.');
  el('emailBtn').disabled = true;
  try {
    const r = await fetch('/account/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: value })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    say('success', d.message);
    el('newEmail').value = '';
  } catch (ex) {
    say('error', ex.message || 'That did not work.');
  }
  el('emailBtn').disabled = false;
});

el('form').addEventListener('submit', async (e) => {
  e.preventDefault(); quiet();
  const newPassword = el('newPassword').value;
  if (newPassword !== el('confirmPassword').value) return say('error', 'The new passwords are not the same.');
  const btn = el('submitBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/account/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: el('email').value, currentPassword: el('currentPassword').value, newPassword })
    });
    const data = await res.json();
    if (!res.ok) say('error', data.error);
    else {
      say('success', data.message);
      ['currentPassword', 'newPassword', 'confirmPassword'].forEach((id) => { el(id).value = ''; });
    }
  } catch {
    say('error', 'The server did not answer. Nothing was changed. Try again in a moment.');
  } finally {
    btn.disabled = false;
  }
});
</script>`);
}

module.exports = { accountPage };
