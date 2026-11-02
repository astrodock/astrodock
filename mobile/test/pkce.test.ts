/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import { createHash } from 'crypto';

import { authorizeUrl, base64url, challengeFor, createVerifier, parseAuthRedirect } from '../src/lib/pkce';

const sha256 = async (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest());

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await challengeFor(verifier, sha256)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes a 43-character verifier from 32 random bytes', () => {
    const v = createVerifier((n) => new Uint8Array(n).fill(255));
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('encodes base64url without padding, as Node does', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 255);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('builds the authorize URL', () => {
    expect(authorizeUrl('https://auth.acme.dev/', 'CH', 'ST')).toBe(
      'https://auth.acme.dev/mobile/authorize?code_challenge=CH&code_challenge_method=S256&state=ST&redirect_uri=astrodock%3A%2F%2Fauth',
    );
  });

  it('reads the code back and checks state', () => {
    expect(parseAuthRedirect('astrodock://auth?code=amc_x&state=ST', 'ST')).toEqual({ code: 'amc_x' });
    expect(() => parseAuthRedirect('astrodock://auth?code=amc_x&state=OTHER', 'ST')).toThrow();
    expect(() => parseAuthRedirect('https://evil.test/?code=amc_x&state=ST', 'ST')).toThrow();
    expect(() => parseAuthRedirect('astrodock://auth?error=access_denied&state=ST', 'ST')).toThrow('access_denied');
  });
});
