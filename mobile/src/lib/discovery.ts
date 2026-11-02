// Discovery (MOBILE_DESIGN.md section 1): what the person types, the addresses
// to try, and the shape of the answer.

import { normalizeDomain, parseUrl } from './url';

export type Discovery = {
  name: string;
  version: string;
  baseDomain: string;
  authUrl: string;
  mobileEnabled: boolean;
  push: { relayUrl: string; serverId: string } | null;
};

const HOSTPORT_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;

/**
 * The discovery URLs to try, in order, for `astrodock.ai`, `auth.astrodock.ai`,
 * `admin.astrodock.ai` or a full URL. Throws a message for the person when the
 * input is not a host name.
 */
export function discoveryCandidates(input: string): string[] {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter your server’s address.');
  let hostport: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const p = parseUrl(raw);
    if (!p || (p.scheme !== 'https' && p.scheme !== 'http')) {
      throw new Error('That is not a web address.');
    }
    hostport = p.port ? `${p.host}:${p.port}` : p.host;
  } else {
    hostport = raw.split(/[/?#\\]/)[0].toLowerCase().replace(/\.$/, '');
  }
  if (!HOSTPORT_RE.test(hostport)) {
    throw new Error('Enter a domain like astrodock.example.com.');
  }
  if (hostport.startsWith('admin.')) hostport = `auth.${hostport.slice('admin.'.length)}`;
  const urls = [`https://${hostport}/.well-known/astrodock.json`];
  if (!hostport.startsWith('auth.')) urls.push(`https://auth.${hostport}/.well-known/astrodock.json`);
  return urls;
}

/** Checks a discovery document. Null if it is not one. */
export function parseDiscovery(json: unknown): Discovery | null {
  if (!json || typeof json !== 'object') return null;
  const d = json as Record<string, unknown>;
  if (d.astrodock !== 1) return null;
  const authUrl = typeof d.authUrl === 'string' ? d.authUrl.replace(/\/+$/, '') : '';
  const auth = parseUrl(authUrl);
  if (!auth || auth.scheme !== 'https') return null;
  const baseDomain = normalizeDomain(typeof d.baseDomain === 'string' ? d.baseDomain : '');
  if (!baseDomain) return null;
  const mobile = d.mobile as Record<string, unknown> | null | undefined;
  const push = d.push as Record<string, unknown> | null | undefined;
  const relay =
    push &&
    typeof push.relayUrl === 'string' &&
    typeof push.serverId === 'string' &&
    parseUrl(push.relayUrl)?.scheme === 'https' &&
    /^srv_[A-Za-z0-9_-]+$/.test(push.serverId)
      ? { relayUrl: push.relayUrl.replace(/\/+$/, ''), serverId: push.serverId }
      : null;
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Astrodock',
    version: typeof d.version === 'string' ? d.version : '',
    baseDomain,
    authUrl,
    mobileEnabled: !mobile || mobile.enabled !== false,
    push: relay,
  };
}
