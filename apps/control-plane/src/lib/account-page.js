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
  return shell('Your Account', `
<span class="tile">${icon('lock')}</span>
<div class="heading"><h1 id="title">Change Your Password</h1><p class="sub" id="who" hidden>Signed in as <b id="acctEmail"></b></p></div>
${errorLine()}
<div class="ok" id="ok" role="status" hidden><span></span></div>

<div id="signedIn" hidden>
  <div class="sec" id="googleSec">
    <h2>Sign In with Google</h2>
    <div class="state"><span class="dot" id="gDot"></span><span id="gState"></span></div>
    <p id="gHelp"></p>
    <a class="btn secondary" id="gLink" href="/account/google/link">Attach My Google Account</a>
    <button class="secondary" type="button" id="gUnlink" hidden>Detach It</button>
  </div>
  <form class="sec" id="emailForm">
    <h2>Sign-In Address</h2>
    <p>Changing it sends a link to the new address. Nothing changes until you follow it.</p>
    <div class="field"><label for="newEmail">New Address</label><input type="email" id="newEmail" autocomplete="email"></div>
    <div id="emailPwField" hidden>${passwordField('emailPassword', 'Current Password')}</div>
    <div class="field" id="emailCodeField" hidden><label for="emailCode">Authenticator Code</label><input id="emailCode" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>
    <button class="secondary" type="submit" id="emailBtn">Send the Confirmation Link</button>
  </form>
  <div class="sec"><h2>Change Password</h2></div>
</div>

<form id="form">
  <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="username" required></div>
  ${passwordField('currentPassword', 'Current Password', { required: true })}
  ${passwordField('newPassword', 'New Password', { autocomplete: 'new-password', required: true, minlength: 8, hint: 'At least 8 characters.' })}
  ${passwordField('confirmPassword', 'Confirm New Password', { autocomplete: 'new-password', required: true, minlength: 8 })}
  <div class="field" id="codeField" hidden><label for="code">Authenticator Code</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><p class="hint">This account has two-step sign-in.</p></div>
  <button type="submit" id="submitBtn">Change Password</button>
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
  el('title').textContent = 'Your Account';
  el('acctEmail').textContent = me.email;
  el('email').value = me.email;
  el('email').readOnly = true;
  // Changing the address asks for proof it is you, with whichever factor you have.
  el('emailPwField').hidden = !me.hasPassword;
  el('emailCodeField').hidden = me.hasPassword || !me.hasTotp;

  if (new URLSearchParams(location.search).get('linked')) {
    say('success', 'That Google account is attached. You can sign in with it from now on.');
    history.replaceState(null, '', location.pathname);
  }
  if (me.pendingEmail) say('success', 'Waiting for ' + me.pendingEmail + ' to confirm. Until then you sign in as ' + me.email + '.');

  if (!me.googleAvailable) {
    el('gState').textContent = 'Not Set Up on This Server';
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
    el('gState').textContent = 'Not Attached';
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
      body: JSON.stringify({ email: value, currentPassword: el('emailPassword').value, totp: el('emailCode').value.trim() })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    say('success', d.message);
    el('newEmail').value = ''; el('emailPassword').value = ''; el('emailCode').value = '';
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
      body: JSON.stringify({ email: el('email').value, currentPassword: el('currentPassword').value, newPassword, totp: el('code').value.trim() })
    });
    const data = await res.json();
    if (!res.ok) {
      // The server asks for the code only once the password is right.
      if (data.code === 'totp_required') { el('codeField').hidden = false; el('code').focus(); }
      say('error', data.error);
    } else {
      say('success', data.message);
      ['currentPassword', 'newPassword', 'confirmPassword', 'code'].forEach((id) => { el(id).value = ''; });
      el('codeField').hidden = true;
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
