// `window.astrodock`, the small bridge pages on the server's own hosts get
// (MOBILE_DESIGN.md section 8). The page side is a script injected before
// content loads; it defines the bridge only on https pages under the base
// domain. The native side checks the sending page's URL again and ignores
// anything else.

import { isServerUrl, isWebUrl, normalizeDomain } from './url';

export const HAPTIC_STYLES = ['light', 'medium', 'success', 'warning', 'error'] as const;
export type HapticStyle = (typeof HAPTIC_STYLES)[number];

export type BridgeAction =
  | { type: 'share'; url?: string; text?: string }
  | { type: 'haptic'; style: HapticStyle }
  | { type: 'openExternal'; url: string };

export function bridgeScript(opts: { baseDomain: string; platform: string; version: string }): string {
  const base = JSON.stringify(normalizeDomain(opts.baseDomain));
  const platform = JSON.stringify(opts.platform);
  const version = JSON.stringify(opts.version);
  return `(function () {
  try {
    var base = ${base};
    var host = String(location.hostname || '').toLowerCase();
    if (location.protocol !== 'https:') return;
    if (!(host === base || host.slice(-(base.length + 1)) === '.' + base)) return;
    if (window.astrodock || !window.ReactNativeWebView) return;
    var post = function (type, payload) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ astrodock: 1, type: type, payload: payload }));
    };
    Object.defineProperty(window, 'astrodock', {
      value: Object.freeze({
        platform: ${platform},
        version: ${version},
        share: function (o) { o = o || {}; post('share', { url: o.url, text: o.text }); },
        haptic: function (style) { post('haptic', style); },
        openExternal: function (url) { post('openExternal', String(url)); }
      }),
      writable: false,
      configurable: false
    });
  } catch (e) {}
})();
true;`;
}

const MAX_TEXT = 2000;
const MAX_URL = 4000;

/**
 * The action a WebView message asks for, or null to ignore it. `sourceUrl` is
 * `event.nativeEvent.url`, the page that sent it.
 */
export function parseBridgeMessage(sourceUrl: string, data: string, baseDomain: string): BridgeAction | null {
  if (!isServerUrl(sourceUrl, baseDomain)) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const { astrodock, type, payload } = msg as { astrodock?: unknown; type?: unknown; payload?: unknown };
  if (astrodock !== 1) return null;

  switch (type) {
    case 'share': {
      const p = (payload && typeof payload === 'object' ? payload : {}) as { url?: unknown; text?: unknown };
      const url = typeof p.url === 'string' && p.url.length <= MAX_URL && isWebUrl(p.url) ? p.url : undefined;
      const text = typeof p.text === 'string' && p.text.trim() ? p.text.slice(0, MAX_TEXT) : undefined;
      if (!url && !text) return null;
      return { type: 'share', ...(url ? { url } : {}), ...(text ? { text } : {}) };
    }
    case 'haptic':
      return typeof payload === 'string' && (HAPTIC_STYLES as readonly string[]).includes(payload)
        ? { type: 'haptic', style: payload as HapticStyle }
        : null;
    case 'openExternal':
      return typeof payload === 'string' && payload.length <= MAX_URL && isWebUrl(payload)
        ? { type: 'openExternal', url: payload }
        : null;
    default:
      return null;
  }
}
