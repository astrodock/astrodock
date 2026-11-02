import { describe, expect, it } from '@jest/globals';
import { bridgeScript, parseBridgeMessage } from '../src/lib/bridge';
import { isServerUrl, navigationDecision, parseUrl } from '../src/lib/url';

const msg = (type: string, payload: unknown) => JSON.stringify({ astrodock: 1, type, payload });

describe('bridge origin check', () => {
  const base = 'acme.dev';

  it('accepts messages from https pages on the base domain and its subdomains', () => {
    expect(parseBridgeMessage('https://acme.dev/', msg('haptic', 'light'), base)).toEqual({ type: 'haptic', style: 'light' });
    expect(parseBridgeMessage('https://tasks.acme.dev/x', msg('haptic', 'error'), base)).toEqual({ type: 'haptic', style: 'error' });
  });

  it('ignores every other origin', () => {
    const m = msg('openExternal', 'https://example.com');
    expect(parseBridgeMessage('https://evil.test/', m, base)).toBeNull();
    expect(parseBridgeMessage('https://acme.dev.evil.test/', m, base)).toBeNull();
    expect(parseBridgeMessage('https://notacme.dev/', m, base)).toBeNull();
    expect(parseBridgeMessage('http://tasks.acme.dev/', m, base)).toBeNull();
    expect(parseBridgeMessage('https://evil.test/x@acme.dev/', m, base)).toBeNull();
    expect(parseBridgeMessage('https://evil.test\\@acme.dev/', m, base)).toBeNull();
    expect(parseBridgeMessage('about:blank', m, base)).toBeNull();
    expect(parseBridgeMessage('', m, base)).toBeNull();
  });

  it('checks each action', () => {
    const page = 'https://tasks.acme.dev/';
    expect(parseBridgeMessage(page, msg('share', { url: 'https://tasks.acme.dev/1', text: 'Hi' }), base)).toEqual({
      type: 'share',
      url: 'https://tasks.acme.dev/1',
      text: 'Hi',
    });
    expect(parseBridgeMessage(page, msg('share', { url: 'javascript:alert(1)' }), base)).toBeNull();
    expect(parseBridgeMessage(page, msg('openExternal', 'https://example.com/a'), base)).toEqual({
      type: 'openExternal',
      url: 'https://example.com/a',
    });
    expect(parseBridgeMessage(page, msg('openExternal', 'tel:123'), base)).toBeNull();
    expect(parseBridgeMessage(page, msg('haptic', 'heavy'), base)).toBeNull();
    expect(parseBridgeMessage(page, msg('nope', {}), base)).toBeNull();
    expect(parseBridgeMessage(page, 'not json', base)).toBeNull();
    expect(parseBridgeMessage(page, JSON.stringify({ type: 'haptic', payload: 'light' }), base)).toBeNull();
  });

  it('embeds values safely in the injected script', () => {
    const s = bridgeScript({ baseDomain: 'acme.dev', platform: 'ios', version: '1.0"; alert(1); "' });
    expect(s).toContain('var base = "acme.dev"');
    expect(s).toContain('version: "1.0\\"; alert(1); \\""');
  });
});

describe('URL parsing', () => {
  it('reads the real host', () => {
    expect(parseUrl('https://user:pw@Tasks.Acme.dev:8443/a?b#c')).toEqual({ scheme: 'https', host: 'tasks.acme.dev', port: '8443' });
    expect(parseUrl('https://evil.test/x@acme.dev/')?.host).toBe('evil.test');
    expect(parseUrl('https://evil.test\\@acme.dev/')?.host).toBe('evil.test');
    expect(isServerUrl('https://acme.dev.', 'acme.dev')).toBe(true);
  });

  it('decides where links open', () => {
    expect(navigationDecision('https://tasks.acme.dev/x', 'acme.dev')).toBe('allow');
    expect(navigationDecision('https://example.com/', 'acme.dev')).toBe('external');
    expect(navigationDecision('mailto:a@b.c', 'acme.dev')).toBe('external');
    expect(navigationDecision('about:blank', 'acme.dev')).toBe('allow');
    expect(navigationDecision('javascript:alert(1)', 'acme.dev')).toBe('block');
    expect(navigationDecision('file:///etc/passwd', 'acme.dev')).toBe('block');
  });
});
