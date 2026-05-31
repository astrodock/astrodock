class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

class SvAuth {
  constructor({ authUrl = 'http://localhost:3100', appId, appSecret }) {
    if (!appId) throw new Error('appId is required');
    if (!appSecret) throw new Error('appSecret is required');

    this.authUrl = authUrl.replace(/\/$/, '');
    this.appId = appId;
    this.appSecret = appSecret;
  }

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
    } catch (err) {
      throw new AuthError('Auth service unavailable', 503);
    }

    if (res.status === 401) throw new AuthError('Invalid credentials', 401);
    if (res.status === 403) throw new AuthError('No access to this app', 403);
    if (!res.ok) throw new AuthError('Auth service error', res.status);

    return res.json(); // { userId, email, name }
  }
}

module.exports = { SvAuth, AuthError };
