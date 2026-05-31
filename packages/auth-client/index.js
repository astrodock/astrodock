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
    const authUrl = opts.authUrl || process.env.ASTRODOCK_AUTH_URL || 'http://localhost:3100';
    const appId = opts.appId || process.env.ASTRODOCK_APP_ID;
    const appSecret = opts.appSecret || process.env.ASTRODOCK_APP_SECRET;

    if (!appId) throw new Error('appId is required (set ASTRODOCK_APP_ID or pass appId)');
    if (!appSecret) throw new Error('appSecret is required (set ASTRODOCK_APP_SECRET or pass appSecret)');

    this.authUrl = authUrl.replace(/\/$/, '');
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * Verify end-user credentials.
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
