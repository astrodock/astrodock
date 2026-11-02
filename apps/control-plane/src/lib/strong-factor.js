'use strict';

// The proof an approval asks for: a passkey or an authenticator code, every
// time, regardless of how recently the person signed in.
//
// Step-up re-auth (lib/sessions) accepts any factor and then trusts the session
// for fifteen minutes. That is the wrong shape for approving an agent. An agent
// with control of the browser can click Approve inside that window, and a
// password is something an agent can be told. A passkey needs a person's touch
// on this origin. An authenticator code comes from the person's phone. Passkey
// is offered first and recommended: a code can still be read out to whoever
// asks for it, and a passkey cannot.

const factors = require('./auth-factors');
const passkeys = require('./passkeys');

const handleFor = (user) => `strong:${user.id}`;

/** Which of the two this account holds. */
async function availableFor(user) {
  const f = await factors.factorsFor(user.id);
  return { passkey: f.passkeys > 0, totp: !!f.totp };
}

async function passkeyOptions(user) {
  return passkeys.beginAuthentication({ user, handle: handleFor(user) });
}

/**
 * True only when `proof` is a passkey assertion or a TOTP code for this user.
 * A password or recovery code is refused: neither proves a person is here.
 */
async function verify(user, proof = {}) {
  const { passkeyResponse, totp } = proof || {};
  if (passkeyResponse) {
    const who = await passkeys.finishAuthentication({ handle: handleFor(user), response: passkeyResponse })
      .catch(() => null);
    return !!who && who.id === user.id;
  }
  if (totp) return factors.checkTotp(user, String(totp).trim());
  return false;
}

module.exports = { availableFor, passkeyOptions, verify };
