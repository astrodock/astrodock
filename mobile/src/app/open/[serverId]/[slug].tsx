import * as Haptics from 'expo-haptics';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes';

import { Button, ErrorText, Icon, IconButton } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { appVersion, platform, SignInCancelled } from '@/lib/auth';
import { bridgeScript, parseBridgeMessage, type HapticStyle } from '@/lib/bridge';
import { ADMIN_SLUG, normalizeAppPath } from '@/lib/paths';
import { useServers } from '@/lib/servers';
import { type, useColors } from '@/lib/theme';
import { hostInDomain, isWebUrl, navigationDecision, parseUrl } from '@/lib/url';

type Params = { serverId: string; slug: string; path?: string; name?: string };

// The package types WebView as a plain function component without a ref; the
// native implementations forward one with these methods.
type WebViewHandle = { goBack(): void; reload(): void; injectJavaScript(script: string): void };
const AppWebView = WebView as unknown as React.ComponentType<
  React.ComponentProps<typeof WebView> & { ref?: React.Ref<WebViewHandle> }
>;

export default function AppScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId, slug, path, name } = useLocalSearchParams<Params>();
  const { ready, servers, client, signInAgain } = useServers();
  const server = servers.find((s) => s.id === serverId);

  const webRef = useRef<WebViewHandle>(null);
  const currentUrl = useRef('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [busy, setBusy] = useState(false);

  const title = name || (slug === ADMIN_SLUG ? 'Admin' : slug);
  const signedIn = !!server?.signedIn;

  const open = useCallback(async () => {
    setError(null);
    setUrl(null);
    const api = client(serverId);
    if (!api) return;
    try {
      if (slug === ADMIN_SLUG) {
        const { admin } = await api.apps();
        if (!admin?.url) throw new Error('Admin is not available to you on this server.');
        setUrl(admin.url);
      } else {
        const { url: ticketUrl } = await api.ticket(slug, normalizeAppPath(path));
        setUrl(ticketUrl);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // shown as signed out
      setError((err as Error).message);
    }
  }, [client, serverId, slug, path]);

  useEffect(() => {
    if (ready && signedIn) open();
  }, [ready, signedIn, open]);

  // Android's back button walks back inside the page first.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!canGoBack) return false;
        webRef.current?.goBack();
        return true;
      });
      return () => sub.remove();
    }, [canGoBack]),
  );

  const baseDomain = server?.baseDomain ?? '';
  const authHost = server ? parseUrl(server.authUrl)?.host ?? '' : '';

  const script = useMemo(
    () => bridgeScript({ baseDomain, platform: platform(), version: appVersion() }),
    [baseDomain],
  );

  const decide = useCallback(
    (target: string) => {
      const p = parseUrl(target);
      if (p && p.scheme === 'https' && p.host === authHost) return 'allow';
      return navigationDecision(target, baseDomain);
    },
    [authHost, baseDomain],
  );

  const onShouldStartLoad = useCallback(
    (req: ShouldStartLoadRequest) => {
      if (req.isTopFrame === false) return true;
      const decision = decide(req.url);
      if (decision === 'external') Linking.openURL(req.url).catch(() => {});
      return decision === 'allow';
    },
    [decide],
  );

  const onOpenWindow = useCallback(
    (e: WebViewOpenWindowEvent) => {
      const target = e.nativeEvent.targetUrl;
      const decision = decide(target);
      if (decision === 'allow') {
        webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`);
      } else if (decision === 'external') {
        Linking.openURL(target).catch(() => {});
      }
    },
    [decide],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const action = parseBridgeMessage(e.nativeEvent.url, e.nativeEvent.data, baseDomain);
      if (!action) return;
      switch (action.type) {
        case 'share':
          shareContent(action.url, action.text);
          break;
        case 'haptic':
          haptic(action.style);
          break;
        case 'openExternal':
          Linking.openURL(action.url).catch(() => {});
          break;
      }
    },
    [baseDomain],
  );

  const onNavigationStateChange = (nav: WebViewNavigation) => {
    currentUrl.current = nav.url;
    setCanGoBack(nav.canGoBack);
  };

  /** The page's address, unless it is still the single-use sign-in ticket. */
  const pageUrl = () => {
    const u = currentUrl.current;
    if (!isWebUrl(u)) return null;
    const p = parseUrl(u);
    if (p && p.host === authHost && /\/mobile\/open/.test(u)) return null;
    if (p && !hostInDomain(p.host, baseDomain) && p.host !== authHost) return null;
    return u;
  };

  const showMenu = () => {
    const openLabel = Platform.OS === 'ios' ? 'Open in Safari' : 'Open in Browser';
    const actions = [
      { label: 'Reload', run: () => webRef.current?.reload() },
      {
        label: openLabel,
        run: () => {
          const u = pageUrl();
          if (u) Linking.openURL(u).catch(() => {});
        },
      },
      {
        label: 'Share Link',
        run: () => {
          const u = pageUrl();
          if (u) shareContent(u, undefined);
        },
      },
    ];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions.map((a) => a.label), 'Cancel'], cancelButtonIndex: actions.length },
        (i) => actions[i]?.run(),
      );
    } else {
      Alert.alert(
        title,
        undefined,
        actions.map((a) => ({ text: a.label, onPress: a.run })),
        { cancelable: true },
      );
    }
  };

  const onSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInAgain(serverId);
    } catch (err) {
      if (!(err instanceof SignInCancelled)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A solid bar above the page rather than the system header, which on iOS 26
  // floats over the content and hides the top of every app. The page starts
  // below it, so no app has to make room for it.
  const header = (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
          // When the page can go back, the edge swipe goes to the page, not the stack.
          gestureEnabled: !canGoBack,
        }}
      />
      <View style={[styles.bar, { paddingTop: insets.top, backgroundColor: c.surface, borderBottomColor: c.separator }]}>
        <View style={styles.barRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to Apps"
            hitSlop={8}
            onPress={() => router.back()}
            style={({ pressed }) => [styles.barSide, { opacity: pressed ? 0.5 : 1 }]}>
            <Icon ios="chevron.left" android="arrow_back" size={18} color={c.tint} />
            <Text style={[type.body, { color: c.tint }]}>Apps</Text>
          </Pressable>
          <Text style={[type.bodyStrong, styles.barTitle, { color: c.text }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={[styles.barSide, styles.barRight]}>
            {url ? <IconButton ios="ellipsis.circle" android="more_vert" label="Menu" onPress={showMenu} /> : null}
          </View>
        </View>
      </View>
    </>
  );

  if (ready && !server) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {header}
        <View style={styles.center}>
        <Text style={[type.secondary, { color: c.secondary }]}>This server is no longer on this phone.</Text>
        </View>
      </View>
    );
  }

  if (ready && server && !server.signedIn) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {header}
        <View style={styles.center}>
        <Text style={[type.heading, { color: c.text }]}>Signed Out</Text>
        <Text style={[type.secondary, { color: c.secondary, textAlign: 'center' }]}>
          Sign in to {server.name} again to open this app.
        </Text>
        <ErrorText message={error} />
        <Button title="Sign In Again" busy={busy} onPress={onSignIn} style={{ alignSelf: 'stretch' }} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {header}
        <View style={styles.center}>
        <ErrorText message={error} />
        <Button title="Try Again" kind="plain" onPress={open} />
        </View>
      </View>
    );
  }

  if (!url) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {header}
        <View style={styles.center}>
        <ActivityIndicator />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      {header}
      <AppWebView
        ref={webRef}
        source={{ uri: url }}
        style={styles.fill}
        originWhitelist={['*']}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        geolocationEnabled
        javaScriptCanOpenWindowsAutomatically
        setSupportMultipleWindows
        injectedJavaScriptBeforeContentLoaded={script}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoad}
        onOpenWindow={onOpenWindow}
        onNavigationStateChange={onNavigationStateChange}
        onError={(e) => setError(e.nativeEvent.description || 'The page could not be loaded.')}
        startInLoadingState
        renderLoading={() => (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.background }]}>
            <ActivityIndicator />
          </View>
        )}
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
}

function shareContent(url: string | undefined, text: string | undefined) {
  if (Platform.OS === 'ios') {
    if (url) Share.share({ url, message: text }).catch(() => {});
    else if (text) Share.share({ message: text }).catch(() => {});
    return;
  }
  const message = [text, url].filter(Boolean).join('\n');
  if (message) Share.share({ message }).catch(() => {});
}

function haptic(style: HapticStyle) {
  const run = {
    light: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    medium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
    success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
    error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  }[style];
  run().catch(() => {});
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  barRow: { height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  barSide: { width: 96, flexDirection: 'row', alignItems: 'center', gap: 2 },
  barRight: { justifyContent: 'flex-end', paddingRight: 8 },
  barTitle: { flex: 1, textAlign: 'center' },
});
