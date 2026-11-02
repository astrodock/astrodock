import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { useColorScheme } from 'react-native';

import { notificationTarget } from '@/lib/notification-target';
import { ServersProvider, useServers } from '@/lib/servers';
import { useColors } from '@/lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Notifications that arrive while the app is open show as a banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export default function RootLayout() {
  const scheme = useColorScheme();
  const c = useColors();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: c.tint, background: c.background, card: c.surface, text: c.text, border: c.separator },
  };
  return (
    <ThemeProvider value={theme}>
      <ServersProvider>
        <StatusBar style="auto" />
        <NotificationTaps />
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Apps' }} />
          <Stack.Screen name="add-server" options={{ presentation: 'modal', title: 'Add Server' }} />
          <Stack.Screen name="open/[serverId]/[slug]" options={{ title: '' }} />
        </Stack>
      </ServersProvider>
    </ThemeProvider>
  );
}

/** A tap on a notification opens its app at its path, or the Inbox. */
function NotificationTaps() {
  const { ready, servers, client, bumpInbox } = useServers();
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (!ready || !response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = `${response.notification.request.identifier}:${response.notification.date}`;
    if (handled.current === id) return;
    handled.current = id;
    Notifications.clearLastNotificationResponse();

    const request = response.notification.request;
    const payload = (request.trigger as { payload?: unknown } | null)?.payload;
    const target = notificationTarget(request.content.data, payload);
    const server = servers.find((s) => s.signedIn && s.push?.serverId === target.relayServerId);
    bumpInbox();

    if (server && target.notificationId) {
      client(server.id)?.markRead(target.notificationId).catch(() => {});
    }
    if (server && target.app) {
      router.push({
        pathname: '/open/[serverId]/[slug]',
        params: {
          serverId: server.id,
          slug: target.app,
          ...(target.appName ? { name: target.appName } : {}),
          ...(target.path ? { path: target.path } : {}),
        },
      });
    } else {
      router.navigate('/inbox');
    }
  }, [ready, response, servers, client, router, bumpInbox]);

  return null;
}
