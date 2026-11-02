// The server registry and device tokens, in expo-secure-store (the iOS Keychain,
// Android Keystore). Tokens are stored apart from the list, one item each.

import * as SecureStore from 'expo-secure-store';

import type { User } from './api';

export type StoredServer = {
  /** Local id, used in routes and storage keys. */
  id: string;
  /** The server's identity (MOBILE_DESIGN.md section 1). */
  authUrl: string;
  name: string;
  baseDomain: string;
  version: string;
  push: { relayUrl: string; serverId: string } | null;
  user: User | null;
  signedIn: boolean;
  /** The relay subscription handle, once push is set up. */
  pushHandle: string | null;
  addedAt: string;
};

const LIST_KEY = 'astrodock.servers.v1';
const tokenKey = (id: string) => `astrodock.token.${id}`;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadServers(): Promise<StoredServer[]> {
  const raw = await SecureStore.getItemAsync(LIST_KEY, OPTIONS);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as StoredServer[]) : [];
  } catch {
    return [];
  }
}

export async function saveServers(list: StoredServer[]): Promise<void> {
  await SecureStore.setItemAsync(LIST_KEY, JSON.stringify(list), OPTIONS);
}

export function getToken(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(id), OPTIONS);
}

export function setToken(id: string, token: string): Promise<void> {
  return SecureStore.setItemAsync(tokenKey(id), token, OPTIONS);
}

export function deleteToken(id: string): Promise<void> {
  return SecureStore.deleteItemAsync(tokenKey(id), OPTIONS);
}
