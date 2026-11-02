import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppTile, Button, ErrorText, Icon, IconButton, ScreenTitle, SectionTitle } from '@/components/ui';
import type { AppsResponse, MobileApp } from '@/lib/api';
import { SignInCancelled } from '@/lib/auth';
import { ADMIN_SLUG } from '@/lib/paths';
import { useServers } from '@/lib/servers';
import type { StoredServer } from '@/lib/storage';
import { type, useColors } from '@/lib/theme';

const COLUMNS = 3;
const PAD = 20;
const GAP = 12;
const ICON = 64;

type Load = { status: 'loading' } | { status: 'ok'; data: AppsResponse } | { status: 'error'; message: string };

type Item =
  | { kind: 'app'; server: StoredServer; app: MobileApp }
  | { kind: 'admin'; server: StoredServer; url: string }
  | { kind: 'signedOut'; server: StoredServer }
  | { kind: 'loading'; server: StoredServer }
  | { kind: 'error'; server: StoredServer; message: string }
  | { kind: 'empty'; server: StoredServer };

export default function AppsScreen() {
  const c = useColors();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { ready, servers, client, signInAgain } = useServers();
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<Record<string, string>>({});

  const signedInKey = servers
    .filter((s) => s.signedIn)
    .map((s) => s.id)
    .join(',');

  const loadAll = useCallback(async () => {
    const ids = signedInKey ? signedInKey.split(',') : [];
    await Promise.all(
      ids.map(async (id) => {
        const api = client(id);
        if (!api) return;
        setLoads((l) => (l[id]?.status === 'ok' ? l : { ...l, [id]: { status: 'loading' } }));
        try {
          const data = await api.apps();
          setLoads((l) => ({ ...l, [id]: { status: 'ok', data } }));
        } catch (err) {
          setLoads((l) => ({ ...l, [id]: { status: 'error', message: (err as Error).message } }));
        }
      }),
    );
  }, [signedInKey, client]);

  useEffect(() => {
    if (ready) loadAll();
  }, [ready, loadAll]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const onSignIn = async (id: string) => {
    setSigningIn(id);
    setSignInError((e) => ({ ...e, [id]: '' }));
    try {
      await signInAgain(id);
    } catch (err) {
      if (!(err instanceof SignInCancelled)) {
        setSignInError((e) => ({ ...e, [id]: (err as Error).message }));
      }
    } finally {
      setSigningIn(null);
    }
  };

  const sections = servers.map((server) => {
    const load = loads[server.id];
    let data: Item[];
    if (!server.signedIn) data = [{ kind: 'signedOut', server }];
    else if (!load || load.status === 'loading') data = [{ kind: 'loading', server }];
    else if (load.status === 'error') data = [{ kind: 'error', server, message: load.message }];
    else {
      data = load.data.apps.map((app) => ({ kind: 'app' as const, server, app }));
      if (!data.length) data.push({ kind: 'empty', server });
      if (load.data.admin?.url) data.push({ kind: 'admin', server, url: load.data.admin.url });
    }
    return { server, data };
  });

  const addButton = (
    <IconButton ios="plus" android="add" label="Add Server" onPress={() => router.push('/add-server')} />
  );

  if (ready && servers.length === 0) {
    return (
      <SafeAreaView edges={['top']} style={[styles.fill, { backgroundColor: c.background }]}>
        <ScreenTitle title="Apps" />
        <View style={styles.empty}>
          <Text style={[type.heading, { color: c.text }]}>Add Your First Server</Text>
          <Text style={[type.secondary, { color: c.secondary, textAlign: 'center' }]}>
            Sign in to an Astrodock server to see the apps you can use.
          </Text>
          <Button title="Add Server" onPress={() => router.push('/add-server')} style={{ alignSelf: 'stretch' }} />
        </View>
      </SafeAreaView>
    );
  }

  // Three across. The tile is a third of the row less the gaps; the icon sits
  // centered in it with the name underneath.
  const tileWidth = Math.floor((width - PAD * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  // One server needs no heading: the grid is just the apps.
  const showHeadings = sections.length > 1;

  return (
    <SafeAreaView edges={['top']} style={[styles.fill, { backgroundColor: c.background }]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <ScreenTitle title="Apps" action={addButton} />
        {sections.map(({ server, data }) => {
          const tiles = data.filter((i) => i.kind === 'app' || i.kind === 'admin');
          const messages = data.filter((i) => i.kind !== 'app' && i.kind !== 'admin');
          return (
            <View key={server.id} style={styles.section}>
              {showHeadings ? (
                <SectionTitle title={server.name} detail={server.user?.email ?? hostOf(server.authUrl)} />
              ) : null}
              {messages.map((item, i) => (
                <View key={i} style={[styles.messageBox, { backgroundColor: c.surface }]}>
                  {renderMessage(item)}
                </View>
              ))}
              {tiles.length ? (
                <View style={styles.grid}>
                  {tiles.map((item) => (
                    <View key={item.kind === 'app' ? item.app.slug : 'admin'} style={{ width: tileWidth }}>
                      {renderTile(item)}
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );

  function renderTile(item: Item) {
    if (item.kind === 'app') {
      return (
        <Tile
          label={item.app.name}
          icon={<AppTile name={item.app.name} sources={iconSources(item.app)} size={ICON} />}
          onPress={() =>
            router.push({
              pathname: '/open/[serverId]/[slug]',
              params: { serverId: item.server.id, slug: item.app.slug, name: item.app.name },
            })
          }
        />
      );
    }
    if (item.kind === 'admin') {
      return (
        <Tile
          label="Admin"
          icon={
            <View style={[styles.adminTile, { backgroundColor: c.tile }]}>
              <Icon ios="slider.horizontal.3" android="tune" size={28} color={c.text} />
            </View>
          }
          onPress={() =>
            router.push({
              pathname: '/open/[serverId]/[slug]',
              params: { serverId: item.server.id, slug: ADMIN_SLUG, name: 'Admin' },
            })
          }
        />
      );
    }
    return null;
  }

  function renderMessage(item: Item) {
    switch (item.kind) {
      case 'signedOut':
        return (
          <View style={styles.message}>
            <Text style={[type.secondary, { color: c.secondary }]}>You are signed out of {item.server.name}.</Text>
            <ErrorText message={signInError[item.server.id]} />
            <Button
              title="Sign In Again"
              busy={signingIn === item.server.id}
              onPress={() => onSignIn(item.server.id)}
            />
          </View>
        );
      case 'loading':
        return (
          <View style={styles.message}>
            <ActivityIndicator />
          </View>
        );
      case 'error':
        return (
          <View style={styles.message}>
            <ErrorText message={item.message} />
            <Button title="Try Again" kind="plain" onPress={loadAll} />
          </View>
        );
      case 'empty':
        return (
          <View style={styles.message}>
            <Text style={[type.secondary, { color: c.secondary }]}>No apps are shared with you on this server yet.</Text>
          </View>
        );
      default:
        return null;
    }
  }
}

/** One icon in the grid: the icon, and the name under it. */
function Tile({ label, icon, onPress }: { label: string; icon: React.ReactNode; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.6 : 1 }]}>
      {icon}
      <Text style={[type.caption, styles.tileLabel, { color: c.text }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

// The logo set in the app's settings, then the icon most web apps ship for
// iOS home screens. Static files are served without sign-in.
function iconSources(app: MobileApp): string[] {
  const out: string[] = [];
  if (app.logoUrl) out.push(app.logoUrl);
  if (app.url) out.push(`${app.url.replace(/\/+$/, '')}/apple-touch-icon.png`);
  return out;
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  section: { gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, columnGap: GAP, rowGap: 20, paddingTop: 4 },
  tile: { alignItems: 'center', gap: 6 },
  tileLabel: { textAlign: 'center' },
  messageBox: { marginHorizontal: 16, borderRadius: 12 },
  message: { padding: 16, gap: 10 },
  adminTile: { width: ICON, height: ICON, borderRadius: Math.round(ICON * 0.22), alignItems: 'center', justifyContent: 'center' },
});
