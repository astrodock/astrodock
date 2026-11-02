import { describe, expect, it } from '@jest/globals';
import { discoveryCandidates, parseDiscovery } from '../src/lib/discovery';

const wk = (host: string) => `https://${host}/.well-known/astrodock.json`;

describe('discoveryCandidates', () => {
  it('tries the domain, then auth.<domain>', () => {
    expect(discoveryCandidates('astrodock.ai')).toEqual([wk('astrodock.ai'), wk('auth.astrodock.ai')]);
  });

  it('tries an auth host only once', () => {
    expect(discoveryCandidates('auth.astrodock.ai')).toEqual([wk('auth.astrodock.ai')]);
  });

  it('replaces a leading admin. with auth.', () => {
    expect(discoveryCandidates('admin.astrodock.ai')).toEqual([wk('auth.astrodock.ai')]);
  });

  it('takes the host from a full URL and ignores the path', () => {
    expect(discoveryCandidates('https://admin.Example.com/apps?x=1')).toEqual([wk('auth.example.com')]);
    expect(discoveryCandidates('http://example.com/')).toEqual([wk('example.com'), wk('auth.example.com')]);
  });

  it('trims, lowercases and drops a trailing dot or slash', () => {
    expect(discoveryCandidates('  Example.COM./ ')).toEqual([wk('example.com'), wk('auth.example.com')]);
  });

  it('keeps an explicit port', () => {
    expect(discoveryCandidates('example.com:8443')).toEqual([wk('example.com:8443'), wk('auth.example.com:8443')]);
  });

  it('ignores user info in a full URL', () => {
    expect(discoveryCandidates('https://evil.test@example.com')).toEqual([wk('example.com'), wk('auth.example.com')]);
  });

  it('refuses things that are not domains', () => {
    expect(() => discoveryCandidates('')).toThrow();
    expect(() => discoveryCandidates('localhost')).toThrow();
    expect(() => discoveryCandidates('not a domain.com')).toThrow();
    expect(() => discoveryCandidates('ftp://example.com')).toThrow();
  });
});

describe('parseDiscovery', () => {
  const doc = {
    astrodock: 1,
    name: 'Acme',
    version: '0.0.31',
    baseDomain: 'Acme.dev',
    authUrl: 'https://auth.acme.dev/',
    mobile: { enabled: true },
    push: { relayUrl: 'https://push.astrodock.ai', serverId: 'srv_abc123' },
  };

  it('reads a discovery document', () => {
    expect(parseDiscovery(doc)).toEqual({
      name: 'Acme',
      version: '0.0.31',
      baseDomain: 'acme.dev',
      authUrl: 'https://auth.acme.dev',
      mobileEnabled: true,
      push: { relayUrl: 'https://push.astrodock.ai', serverId: 'srv_abc123' },
    });
  });

  it('treats push null as no relay and keeps mobile.enabled false', () => {
    const d = parseDiscovery({ ...doc, push: null, mobile: { enabled: false } });
    expect(d?.push).toBeNull();
    expect(d?.mobileEnabled).toBe(false);
  });

  it('refuses other documents and plain-http auth URLs', () => {
    expect(parseDiscovery({ ...doc, astrodock: 2 })).toBeNull();
    expect(parseDiscovery({ ...doc, authUrl: 'http://auth.acme.dev' })).toBeNull();
    expect(parseDiscovery(null)).toBeNull();
  });
});
