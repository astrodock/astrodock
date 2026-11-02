// Where a tapped notification leads. On iOS the Notification Service Extension
// sets `userInfo.body` (expo-notifications' `content.data`) to
// { serverId, notificationId, app, appName, path }. When it could not decrypt, and on
// Android, only the relay's `ad.s` / `s` (the relay server id) is there, and the
// tap opens the Inbox.

import { normalizeAppPath } from './paths';

export type NotificationTarget = {
  relayServerId: string | null;
  notificationId: string | null;
  app: string | null;
  appName: string | null;
  path: string | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function notificationTarget(data: unknown, payload: unknown): NotificationTarget {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const ad = (p.ad && typeof p.ad === 'object' ? p.ad : {}) as Record<string, unknown>;
  const app = str(d.app);
  return {
    relayServerId: str(d.serverId) ?? str(ad.s) ?? str(d.s),
    notificationId: str(d.notificationId),
    app: app && /^[a-z0-9][a-z0-9-]*$/i.test(app) ? app : null,
    appName: str(d.appName),
    path: normalizeAppPath(d.path),
  };
}
