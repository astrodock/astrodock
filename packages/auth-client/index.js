'use strict';

/**
 * @toolstead/auth-client
 *
 * Tiny server-side client for the Toolstead platform auth service. An app calls
 * `verify(email, password)` to check an end-user's credentials against the control
 * plane's `/verify` endpoint, then mints its OWN session (e.g. a JWT signed with
 * TOOLSTEAD_APP_JWT_SECRET). The platform never issues app sessions — it only
 * answers "are these credentials valid for this app?".
 *
 * Reads its config from the platform-injected environment by default:
 *   TOOLSTEAD_AUTH_URL, TOOLSTEAD_APP_ID, TOOLSTEAD_APP_SECRET
 */

class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

class ToolsteadAuth {
  /**
   * @param {object} [opts]
   * @param {string} [opts.authUrl]   Defaults to process.env.TOOLSTEAD_AUTH_URL
   * @param {string} [opts.appId]     Defaults to process.env.TOOLSTEAD_APP_ID
   * @param {string} [opts.appSecret] Defaults to process.env.TOOLSTEAD_APP_SECRET
   */
  constructor(opts = {}) {
    const authUrl = opts.authUrl || process.env.TOOLSTEAD_AUTH_URL || 'http://localhost:3100';
    const appId = opts.appId || process.env.TOOLSTEAD_APP_ID;
    const appSecret = opts.appSecret || process.env.TOOLSTEAD_APP_SECRET;

    if (!appId) throw new Error('appId is required (set TOOLSTEAD_APP_ID or pass appId)');
    if (!appSecret) throw new Error('appSecret is required (set TOOLSTEAD_APP_SECRET or pass appSecret)');

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
module.exports = { ToolsteadAuth, AuthError };
