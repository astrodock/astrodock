// The servers this phone is signed in to, and what can be done with them.
// Every screen reads the list and gets API clients from here.

import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, discover, rediscover, ServerClient } from './api';
import { signIn as browserSignIn } from './auth';
import type { Discovery } from './discovery';
import { registerPush, unregisterPush } from './push';
import { deleteToken, getToken, loadServers, saveServers, setToken, type StoredServer } from './storage';

type ServersValue = {
  ready: boolean;
  servers: StoredServer[];
  /** Bumped when a notification arrives, so the Inbox reloads. */
  inboxVersion: number;
  bumpInbox: () => void;
  client: (id: string) => ServerClient | null;
  /** Discovery, sign-in and push setup for a typed address. */
  addServer: (input: string) => Promise<StoredServer>;
  signInAgain: (id: string) => Promise<void>;
  signOut: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Sets up push for every signed-in server. `ask` may show the prompt. */
  registerPushAll: (ask: boolean) => Promise<void>;
};

const ServersContext = createContext<ServersValue | null>(null);

export function useServers(): ServersValue {
  const value = useContext(ServersContext);
  if (!value) throw new Error('useServers outside ServersProvider');
  return value;
}

export function ServersProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [servers, setServers] = useState<StoredServer[]>([]);
  const [inboxVersion, setInboxVersion] = useState(0);
  const listRef = useRef<StoredServer[]>([]);
  const tokens = useRef(new Map<string, string>());

  const commit = useCallback(async (update: (list: StoredServer[]) => StoredServer[]) => {
    const next = update(listRef.current);
    listRef.current = next;
    setServers(next);
    await saveServers(next);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<StoredServer>) =>
      commit((list) => list.map((s) => (s.id === id ? { ...s, ...changes } : s))),
    [commit],
  );

  const markSignedOut = useCallback(
    (id: string) => {
      tokens.current.delete(id);
      deleteToken(id).catch(() => {});
      patch(id, { signedIn: false, pushHandle: null }).catch(() => {});
    },
    [patch],
  );

  const makeClient = useCallback(
    (server: StoredServer, token: string) => new ServerClient(server.authUrl, token, () => markSignedOut(server.id)),
    [markSignedOut],
  );

  const client = useCallback(
    (id: string) => {
      const server = listRef.current.find((s) => s.id === id);
      const token = tokens.current.get(id);
      if (!server || !server.signedIn || !token) return null;
      return makeClient(server, token);
    },
    [makeClient],
  );

  const setupPush = useCallback(
    async (server: StoredServer, ask: boolean) => {
      const token = tokens.current.get(server.id);
      if (!token || !server.push) return;
      try {
        const handle = await registerPush(server, makeClient(server, token), { ask });
        if (handle && handle !== server.pushHandle) await patch(server.id, { pushHandle: handle });
      } catch (err) {
        if (__DEV__) console.warn('[push] setup failed:', err instanceof Error ? err.message : err);
      }
    },
    [makeClient, patch],
  );

  // Load the registry and tokens, then refresh push quietly (device tokens can change).
  useEffect(() => {
    let canceled = false;
    (async () => {
      const list = await loadServers().catch(() => [] as StoredServer[]);
      for (const s of list) {
        const t = s.signedIn ? await getToken(s.id).catch(() => null) : null;
        if (t) tokens.current.set(s.id, t);
        else s.signedIn = false;
      }
      if (canceled) return;
      listRef.current = list;
      setServers(list);
      setReady(true);
      for (const s of list) if (s.signedIn) setupPush(s, false);
    })();
    return () => {
      canceled = true;
    };
  }, [setupPush]);

  const completeSignIn = useCallback(
    async (existing: StoredServer | null, doc: Discovery) => {
      const result = await browserSignIn(doc.authUrl);
      const base = {
        authUrl: doc.authUrl,
        name: doc.name,
        baseDomain: doc.baseDomain,
        version: doc.version,
        push: doc.push,
        user: result.user,
        signedIn: true,
      };
      let server: StoredServer;
      if (existing) {
        server = { ...existing, ...base, pushHandle: null };
        await setToken(server.id, result.deviceToken);
        tokens.current.set(server.id, result.deviceToken);
        await commit((list) => list.map((s) => (s.id === server.id ? server : s)));
      } else {
        server = { id: Crypto.randomUUID(), ...base, pushHandle: null, addedAt: new Date().toISOString() };
        await setToken(server.id, result.deviceToken);
        tokens.current.set(server.id, result.deviceToken);
        await commit((list) => [...list, server]);
      }
      setupPush(server, true);
      return server;
    },
    [commit, setupPush],
  );

  const addServer = useCallback(
    async (input: string) => {
      const doc = await discover(input);
      if (!doc.mobileEnabled) throw new Error('This server has the mobile app turned off.');
      const existing = listRef.current.find((s) => s.authUrl === doc.authUrl) ?? null;
      if (existing?.signedIn) throw new Error('This server is already added.');
      return completeSignIn(existing, doc);
    },
    [completeSignIn],
  );

  const signInAgain = useCallback(
    async (id: string) => {
      const server = listRef.current.find((s) => s.id === id);
      if (!server) return;
      const doc = await rediscover(server.authUrl);
      if (doc && !doc.mobileEnabled) throw new Error('This server has the mobile app turned off.');
      await completeSignIn(server, doc ?? {
        name: server.name,
        version: server.version,
        baseDomain: server.baseDomain,
        authUrl: server.authUrl,
        mobileEnabled: true,
        push: server.push,
      });
    },
    [completeSignIn],
  );

  const signOut = useCallback(
    async (id: string) => {
      const server = listRef.current.find((s) => s.id === id);
      if (!server) return;
      const c = client(id);
      if (c) {
        // Revoking the device also clears its push fields on the server.
        await c.deleteDevice().catch((err) => {
          if (!(err instanceof ApiError)) throw err;
        });
      }
      await unregisterPush(server);
      tokens.current.delete(id);
      await deleteToken(id).catch(() => {});
      await patch(id, { signedIn: false, pushHandle: null });
    },
    [client, patch],
  );

  const remove = useCallback(
    async (id: string) => {
      const server = listRef.current.find((s) => s.id === id);
      if (!server) return;
      if (server.signedIn) await signOut(id).catch(() => {});
      else await unregisterPush(server);
      await commit((list) => list.filter((s) => s.id !== id));
    },
    [commit, signOut],
  );

  const registerPushAll = useCallback(
    async (ask: boolean) => {
      for (const s of listRef.current) if (s.signedIn) await setupPush(s, ask);
    },
    [setupPush],
  );

  const bumpInbox = useCallback(() => setInboxVersion((v) => v + 1), []);

  // A notification that arrives while the app is open: reload the Inbox.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => bumpInbox());
    return () => sub.remove();
  }, [bumpInbox]);

  const value = useMemo<ServersValue>(
    () => ({
      ready,
      servers,
      inboxVersion,
      bumpInbox,
      client,
      addServer,
      signInAgain,
      signOut,
      remove,
      registerPushAll,
    }),
    [ready, servers, inboxVersion, bumpInbox, client, addServer, signInAgain, signOut, remove, registerPushAll],
  );

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}
