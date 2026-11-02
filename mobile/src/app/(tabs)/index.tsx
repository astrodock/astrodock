import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppTile, Button, ErrorText, Icon, IconButton, Row, ScreenTitle, SectionTitle } from '@/components/ui';
import type { AppsResponse, MobileApp } from '@/lib/api';
import { SignInCancelled } from '@/lib/auth';
import { ADMIN_SLUG } from '@/lib/paths';
import { useServers } from '@/lib/servers';
import type { StoredServer } from '@/lib/storage';
import { type, useColors } from '@/lib/theme';

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

  return (
    <SafeAreaView edges={['top']} style={[styles.fill, { backgroundColor: c.background }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item, i) => `${item.server.id}:${item.kind}:${item.kind === 'app' ? item.app.slug : i}`}
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={<ScreenTitle title="Apps" action={addButton} />}
        ListFooterComponent={<View style={{ height: 32 }} />}
        renderSectionHeader={({ section }) => (
          <SectionTitle
            title={section.server.name}
            detail={section.server.user?.email ?? hostOf(section.server.authUrl)}
          />
        )}
        renderItem={({ item, index, section }) => {
          const first = index === 0;
          const last = index === section.data.length - 1;
          return (
            <View
              style={[
                styles.cell,
                { backgroundColor: c.surface },
                first && styles.cellFirst,
                last && styles.cellLast,
              ]}>
              {!first ? <View style={[styles.separator, { backgroundColor: c.separator }]} /> : null}
              {renderItem(item)}
            </View>
          );
        }}
      />
    </SafeAreaView>
  );

  function renderItem(item: Item) {
    switch (item.kind) {
      case 'app':
        return (
          <Row
            title={item.app.name}
            detail={item.app.description || undefined}
            leading={<AppTile name={item.app.name} logoUrl={item.app.logoUrl} />}
            chevron
            onPress={() =>
              router.push({
                pathname: '/open/[serverId]/[slug]',
                params: { serverId: item.server.id, slug: item.app.slug, name: item.app.name },
              })
            }
          />
        );
      case 'admin':
        return (
          <Row
            title="Admin"
            detail="Manage this server"
            leading={
              <View style={[styles.adminTile, { backgroundColor: c.tile }]}>
                <Icon ios="slider.horizontal.3" android="tune" size={20} color={c.text} />
              </View>
            }
            chevron
            onPress={() =>
              router.push({
                pathname: '/open/[serverId]/[slug]',
                params: { serverId: item.server.id, slug: ADMIN_SLUG, name: 'Admin' },
              })
            }
          />
        );
      case 'signedOut':
        return (
          <View style={styles.message}>
            <Text style={[type.secondary, { color: c.secondary }]}>You are signed out of this server.</Text>
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
    }
  }
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  cell: { marginHorizontal: 16 },
  cellFirst: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  cellLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
  message: { padding: 16, gap: 10 },
  adminTile: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
