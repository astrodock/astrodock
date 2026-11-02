// PKCE (RFC 7636, S256) and the mobile sign-in URLs. Pure: the random bytes and
// SHA-256 come in as functions so this runs under Jest.

import { queryParams } from './url';

export const REDIRECT_URI = 'astrodock://auth';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

/** 32 random bytes, base64url: a 43-character verifier. */
export function createVerifier(randomBytes: (n: number) => Uint8Array): string {
  return base64url(randomBytes(32));
}

export async function challengeFor(
  verifier: string,
  sha256: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  return base64url(await sha256(asciiBytes(verifier)));
}

export function authorizeUrl(authUrl: string, challenge: string, state: string): string {
  const q = [
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
    ['redirect_uri', REDIRECT_URI],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${authUrl.replace(/\/+$/, '')}/mobile/authorize?${q}`;
}

/** The code from `astrodock://auth?code=...&state=...`, after checking state. */
export function parseAuthRedirect(url: string, expectedState: string): { code: string } {
  if (!url.toLowerCase().startsWith(`${REDIRECT_URI}?`) && url.toLowerCase() !== REDIRECT_URI) {
    throw new Error('Sign-in returned to an unexpected address.');
  }
  const params = queryParams(url);
  if (params.error) {
    throw new Error(params.error_description || params.error);
  }
  if (params.state !== expectedState) {
    throw new Error('Sign-in did not match this request. Try again.');
  }
  if (!params.code) throw new Error('Sign-in did not return a code. Try again.');
  return { code: params.code };
}
