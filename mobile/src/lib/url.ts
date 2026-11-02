// Strict URL helpers for origin checks.
//
// React Native's global URL is a set of regular expressions and can be fooled
// (`https://evil.test/x@astrodock.ai` reads as host `astrodock.ai`), so the
// checks that decide what a page may do use this parser instead. It follows the
// WHATWG rules that matter here: the authority ends at the first `/`, `\`, `?`
// or `#`; user info ends at the last `@` inside the authority.

export type ParsedUrl = {
  scheme: string;
  host: string;
  port: string;
};

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

export function parseUrl(input: string): ParsedUrl | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const m = SCHEME_RE.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { scheme, host: '', port: '' };
  }
  const rest = s.slice(m[0].length).replace(/^[/\\]+/, '');
  const end = rest.search(/[/\\?#]/);
  let authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  let host = authority;
  let port = '';
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    port = authority.slice(colon + 1);
    host = authority.slice(0, colon);
    if (!/^\d{0,5}$/.test(port)) return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host || !HOST_RE.test(host)) return null;
  return { scheme, host, port };
}

export function normalizeDomain(domain: string): string {
  return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

/** `host` is `domain` or a subdomain of it. */
export function hostInDomain(host: string, domain: string): boolean {
  const d = normalizeDomain(domain);
  if (!d || !host) return false;
  return host === d || host.endsWith(`.${d}`);
}

/** An https URL on the server's own hosts (`*.<baseDomain>`). */
export function isServerUrl(url: string, baseDomain: string): boolean {
  const p = parseUrl(url);
  return !!p && p.scheme === 'https' && hostInDomain(p.host, baseDomain);
}

export function isWebUrl(url: string): boolean {
  const p = parseUrl(url);
  return !!p && (p.scheme === 'http' || p.scheme === 'https') && !!p.host;
}

/** Query parameters of a URL, decoded. Later duplicates are ignored. */
export function queryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf('?');
  if (q === -1) return out;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (!(key in out)) out[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // A malformed escape: skip the pair.
    }
  }
  return out;
}

export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * What the App screen's WebView does with a top-frame navigation: load pages on
 * the server's own hosts, hand other web pages and other schemes (mailto:, tel:)
 * to the system, and refuse the rest.
 */
export function navigationDecision(url: string, baseDomain: string): NavigationDecision {
  const p = parseUrl(url);
  if (!p) return 'block';
  if (p.scheme === 'about' || p.scheme === 'blob' || p.scheme === 'data') return 'allow';
  if (p.scheme === 'http' || p.scheme === 'https') {
    return hostInDomain(p.host, baseDomain) ? 'allow' : 'external';
  }
  if (p.scheme === 'javascript' || p.scheme === 'file') return 'block';
  return 'external';
}
