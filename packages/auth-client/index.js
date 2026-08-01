'use strict';

/**
 * @astrodock/auth-client
 *
 * Tiny server-side client for the Astrodock platform auth service. An app calls
 * `verify(email, password)` to check an end-user's credentials against the control
 * plane's `/verify` endpoint, then mints its OWN session (e.g. a JWT signed with
 * ASTRODOCK_APP_JWT_SECRET). The platform never issues app sessions — it only
 * answers "are these credentials valid for this app?".
 *
 * Reads its config from the platform-injected environment by default:
 *   ASTRODOCK_AUTH_URL, ASTRODOCK_APP_ID, ASTRODOCK_APP_SECRET
 *
 * TWO WAYS TO SIGN SOMEONE IN
 *
 *   HOSTED (recommended) — send the browser to `authorizeUrl()`, and exchange the
 *   code it comes back with via `exchange()`. Your app never touches the user's
 *   password, so it cannot leak one; the platform can offer passkeys and two-factor
 *   on your behalf; and one platform session signs the user into every app they
 *   have access to.
 *
 *   VERIFY (legacy) — your app collects the password and calls `verify()`. Still
 *   supported and still works. Be aware of what it means: your server handles that
 *   user's platform password in plaintext, and if the person is also an operator,
 *   that same password opens the dashboard. It also cannot support a second factor,
 *   because there is nowhere in this flow to ask for one.
 */

class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

class AstrodockAuth {
  /**
   * @param {object} [opts]
   * @param {string} [opts.authUrl]   Defaults to process.env.ASTRODOCK_AUTH_URL
   * @param {string} [opts.appId]     Defaults to process.env.ASTRODOCK_APP_ID
   * @param {string} [opts.appSecret] Defaults to process.env.ASTRODOCK_APP_SECRET
   */
  constructor(opts = {}) {
    // Two URLs, deliberately, because two different things reach them.
    //
    // The token exchange is server-to-server and uses the INTERNAL address, so it
    // never leaves the box. The authorize URL is followed by the USER'S BROWSER
    // and must therefore be public — this used to use the internal one for both,
    // which meant every app redirected its users to http://api:3100, a name only
    // resolvable inside the Docker network. Sign-in simply did not work.
    const authUrl = opts.authUrl || process.env.ASTRODOCK_AUTH_URL || 'http://localhost:3100';
    const authorizeUrl = opts.authorizeUrl || process.env.ASTRODOCK_AUTHORIZE_URL || null;
    const appId = opts.appId || process.env.ASTRODOCK_APP_ID;
    const appSecret = opts.appSecret || process.env.ASTRODOCK_APP_SECRET;

    if (!appId) throw new Error('appId is required (set ASTRODOCK_APP_ID or pass appId)');
    if (!appSecret) throw new Error('appSecret is required (set ASTRODOCK_APP_SECRET or pass appSecret)');

    this.authUrl = authUrl.replace(/\/$/, '');
    this.authorizeEndpoint = (authorizeUrl || `${this.authUrl}/authorize`).replace(/\/$/, '');
    this.logoutEndpoint = process.env.ASTRODOCK_LOGOUT_URL
      || this.authorizeEndpoint.replace(/\/authorize$/, '/logout');
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * Where to send the browser to sign in.
   *
   * `redirectUri` must EXACTLY match one registered for this app — the platform
   * refuses anything else, which is what stops a stolen code being delivered
   * somewhere it shouldn't.
   *
   * `state` is echoed back untouched. Generate it per attempt, store it in your
   * own session, and compare on return: that is what stops a forged callback.
   */
  authorizeUrl({ redirectUri, state, nonce } = {}) {
    if (!redirectUri) throw new Error('redirectUri is required');
    const p = new URLSearchParams({ app_id: this.appId, redirect_uri: redirectUri });
    if (state) p.set('state', state);
    if (nonce) p.set('nonce', nonce);
    return `${this.authorizeEndpoint}?${p}`;
  }

  /**
   * Where to send the browser to end the PLATFORM session.
   *
   * This does NOT sign the user out of any app, including yours — cookies are
   * scoped to the host that set them, and each app sets its own on its own
   * subdomain. What it does is stop Astrodock silently re-authenticating them,
   * so the next app asks for a password again.
   *
   * For "sign out everywhere": clear your own session cookie first, then send
   * them here. Anything already signed in elsewhere stays signed in until that
   * app's own session expires.
   */
  logoutUrl({ redirectUri } = {}) {
    return redirectUri
      ? `${this.logoutEndpoint}?redirect_uri=${encodeURIComponent(redirectUri)}`
      : this.logoutEndpoint;
  }

  /**
   * Exchange the code from the callback for the user's identity.
   *
   * Server-side only — it sends your app secret. Single-use, and valid for about a
   * minute, so exchange it as soon as the callback arrives.
   *
   * @returns {Promise<{userId: string, email: string, name: string}>}
   */
  async exchange(code, { redirectUri } = {}) {
    let res;
    try {
      res = await fetch(`${this.authUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, app_id: this.appId, app_secret: this.appSecret, redirect_uri: redirectUri })
      });
    } catch (err) {
      throw new AuthError(`Auth service unavailable: ${err.message}`, 503);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(data.error || 'Could not complete sign-in', res.status);
    return data;
  }

  /**
   * Verify end-user credentials. LEGACY — see the note at the top of this file.
   * @returns {Promise<{userId: string, email: string, name: string}>}
   * @throws {AuthError} 401 invalid credentials, 403 no access, 503 unavailable
   */
  async verify(email, password, { clientIp } = {}) {
    let res;
    try {
      res = await fetch(`${this.authUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          appId: this.appId,
          appSecret: this.appSecret,
          clientIp: clientIp || undefined
        })
      });
    } catch {
      throw new AuthError('Auth service unavailable', 503);
    }

    if (res.status === 401) throw new AuthError('Invalid credentials', 401);
    if (res.status === 403) throw new AuthError('No access to this app', 403);
    if (!res.ok) throw new AuthError('Auth service error', res.status);

    return res.json(); // { userId, email, name }
  }
}

// Backwards/clarity alias
module.exports = { AstrodockAuth, AuthError };
