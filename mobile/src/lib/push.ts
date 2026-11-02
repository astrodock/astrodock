// Push setup after sign-in (MOBILE_DESIGN.md section 8, Push on iOS):
// permission, the raw device token, a relay subscription, then the server.

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import * as AstrodockPush from '../../modules/astrodock-push';
import { relaySubscribe, relayUnsubscribe, type PushEnvironment, type ServerClient } from './api';
import type { StoredServer } from './storage';

/**
 * sandbox for development builds, production for preview, TestFlight and App
 * Store builds. Set by app.config.ts from APP_VARIANT, which each EAS build
 * profile sets in eas.json.
 */
export function pushEnvironment(): PushEnvironment {
  return Constants.expoConfig?.extra?.pushEnvironment === 'production' ? 'production' : 'sandbox';
}

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export async function permissionState(): Promise<PermissionState> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted) return 'granted';
  return p.canAskAgain ? 'undetermined' : 'denied';
}

export async function requestPermission(): Promise<PermissionState> {
  const current = await permissionState();
  if (current !== 'undetermined') return current;
  const p = await Notifications.requestPermissionsAsync();
  return p.granted ? 'granted' : 'denied';
}

let channelReady = false;
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android' || channelReady) return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Notifications',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  channelReady = true;
}

/**
 * Subscribes this device with the server's relay and tells the server.
 * Returns the relay handle, or null when the server has no relay or
 * notifications are not allowed. `ask` shows the permission prompt if it has
 * not been answered yet.
 */
export async function registerPush(
  server: StoredServer,
  client: ServerClient,
  { ask }: { ask: boolean },
): Promise<string | null> {
  if (!server.push) return null;
  const state = ask ? await requestPermission() : await permissionState();
  if (state !== 'granted') return null;
  await ensureAndroidChannel();

  const token = await Notifications.getDevicePushTokenAsync();
  const environment = pushEnvironment();
  const publicKey = await AstrodockPush.publicKey(server.push.serverId);
  const { handle } = await relaySubscribe(server.push.relayUrl, {
    serverId: server.push.serverId,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    environment,
    token: String(token.data),
  });
  await client.putPush({ handle, environment, ...(publicKey ? { publicKey } : {}) });
  return handle;
}

/** Drops the relay subscription and the server's push key. Never throws. */
export async function unregisterPush(server: StoredServer): Promise<void> {
  if (!server.push) return;
  if (server.pushHandle) {
    await relayUnsubscribe(server.push.relayUrl, server.pushHandle).catch(() => {});
  }
  await AstrodockPush.deleteKey(server.push.serverId).catch(() => {});
}
