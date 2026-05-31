// Derive an app's public host from its subdomain.
//
// The admin UI is served at admin.<domain>; the apex domain is not part of the
// API contract, so we infer it from the current hostname by stripping a leading
// "admin." label. In local dev (localhost / IPs) we just show the bare subdomain.
export function appHost(subdomain) {
  if (!subdomain) return '';
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const isLocal =
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isLocal) return subdomain;
  const apex = host.replace(/^admin\./, '');
  return `${subdomain}.${apex}`;
}

export function appUrl(subdomain) {
  const host = appHost(subdomain);
  if (!host) return '#';
  // Local dev: no resolvable host, keep it non-navigating but informative.
  if (!host.includes('.')) return `#${host}`;
  return `https://${host}`;
}
