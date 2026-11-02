// A path inside an app, as the server accepts it (MOBILE_DESIGN.md section 3):
// one leading slash, never `//` (another host) or a backslash (read as a slash
// by browsers), no control characters, at most 2000 characters.
export function normalizeAppPath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const p = path.trim();
  if (p.length < 1 || p.length > 2000) return null;
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  if (p.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  return p;
}

/** The App screen's slug for the server's Admin page. Not a valid app slug. */
export const ADMIN_SLUG = '_admin';
