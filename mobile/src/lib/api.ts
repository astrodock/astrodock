// Typed clients for an Astrodock server's /mobile/* routes and for the push
// relay. Shapes follow MOBILE_DESIGN.md sections 1 to 7.

import { discoveryCandidates, parseDiscovery, type Discovery } from './discovery';

export type User = { id: string; email: string; name: string };

export type MobileApp = {
  slug: string;
  name: string;
  description: string;
  url: string;
  logoUrl: string;
  brandColor: string;
  authMode: string;
};

export type AppsResponse = {
  user: User;
  apps: MobileApp[];
  admin?: { url: string } | null;
};

export type InboxNotification = {
  id: string;
  app: { slug: string; name: string } | null;
  title: string;
  body: string;
  path: string | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationsResponse = { notifications: InboxNotification[]; unread: number };

export type Device = {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  appVersion: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type TokenResponse = { deviceId: string; deviceToken: string; user: User };

export type PushEnvironment = 'sandbox' | 'production';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 15000;

async function requestJson<T>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
        ? (json as { error: string }).error
        : `The server answered ${res.status}.`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

// ── discovery and sign-in ────────────────────────────────────────────────────

/** Tries each discovery address in turn. Throws a message for the person. */
export async function discover(input: string): Promise<Discovery> {
  const urls = discoveryCandidates(input);
  for (const url of urls) {
    try {
      const doc = parseDiscovery(await requestJson<unknown>(url));
      if (doc) return doc;
    } catch {
      // Try the next address.
    }
  }
  throw new Error('No Astrodock server answered at that address.');
}

export async function rediscover(authUrl: string): Promise<Discovery | null> {
  try {
    return parseDiscovery(await requestJson<unknown>(`${authUrl}/.well-known/astrodock.json`));
  } catch {
    return null;
  }
}

export function exchangeCode(
  authUrl: string,
  body: {
    code: string;
    code_verifier: string;
    device: { name: string; platform: 'ios' | 'android'; appVersion: string };
  },
): Promise<TokenResponse> {
  return requestJson<TokenResponse>(`${authUrl}/mobile/token`, { method: 'POST', body });
}

// ── a signed-in server ───────────────────────────────────────────────────────

export class ServerClient {
  constructor(
    private authUrl: string,
    private token: string,
    private onUnauthorized: () => void,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await requestJson<T>(`${this.authUrl}${path}`, {
        method,
        body,
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.onUnauthorized();
      throw err;
    }
  }

  apps() {
    return this.call<AppsResponse>('GET', '/mobile/apps');
  }

  ticket(app: string, path?: string | null) {
    return this.call<{ url: string }>('POST', '/mobile/ticket', path ? { app, path } : { app });
  }

  notifications(opts: { before?: string; limit?: number } = {}) {
    const q = [`limit=${opts.limit ?? 50}`];
    if (opts.before) q.push(`before=${encodeURIComponent(opts.before)}`);
    return this.call<NotificationsResponse>('GET', `/mobile/notifications?${q.join('&')}`);
  }

  markRead(id: string) {
    return this.call<unknown>('POST', `/mobile/notifications/${encodeURIComponent(id)}/read`);
  }

  markAllRead() {
    return this.call<unknown>('POST', '/mobile/notifications/read-all');
  }

  device() {
    return this.call<Device>('GET', '/mobile/device');
  }

  deleteDevice() {
    return this.call<unknown>('DELETE', '/mobile/device');
  }

  putPush(body: { handle: string; publicKey?: string; environment: PushEnvironment }) {
    return this.call<unknown>('PUT', '/mobile/push', body);
  }

  deletePush() {
    return this.call<unknown>('DELETE', '/mobile/push');
  }
}

// ── the push relay ───────────────────────────────────────────────────────────

export function relaySubscribe(
  relayUrl: string,
  body: { serverId: string; platform: 'ios' | 'android'; environment: PushEnvironment; token: string },
): Promise<{ handle: string }> {
  return requestJson<{ handle: string }>(`${relayUrl}/v1/subscriptions`, { method: 'POST', body });
}

export async function relayUnsubscribe(relayUrl: string, handle: string): Promise<void> {
  await requestJson<unknown>(`${relayUrl}/v1/subscriptions/${encodeURIComponent(handle)}`, { method: 'DELETE' });
}
