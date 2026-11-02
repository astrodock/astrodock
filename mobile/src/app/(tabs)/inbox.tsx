import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, ErrorText, ScreenTitle } from '@/components/ui';
import type { InboxNotification } from '@/lib/api';
import { normalizeAppPath } from '@/lib/paths';
import { useServers } from '@/lib/servers';
import type { StoredServer } from '@/lib/storage';
import { type, useColors } from '@/lib/theme';

const PAGE = 50;

type Entry = InboxNotification & { serverId: string; serverName: string };
type ServerPage = { items: Entry[]; unread: number; more: boolean; error: string | null };

export default function InboxScreen() {
  const c = useColors();
  const router = useRouter();
  const { ready, servers, client, inboxVersion } = useServers();
  const [pages, setPages] = useState<Record<string, ServerPage>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadingMore = useRef(false);

  const signedIn = servers.filter((s) => s.signedIn);
  const key = signedIn.map((s) => s.id).join(',');

  const fetchPage = useCallback(
    async (server: StoredServer, before?: string): Promise<ServerPage | null> => {
      const api = client(server.id);
      if (!api) return null;
      try {
        const res = await api.notifications({ before, limit: PAGE });
        return {
          items: res.notifications.map((n) => ({ ...n, serverId: server.id, serverName: server.name })),
          unread: res.unread,
          more: res.notifications.length >= PAGE,
          error: null,
        };
      } catch (err) {
        return { items: [], unread: 0, more: false, error: `${server.name}: ${(err as Error).message}` };
      }
    },
    [client],
  );

  const loadAll = useCallback(async () => {
    const list = servers.filter((s) => key.split(',').includes(s.id));
    const results = await Promise.all(list.map(async (s) => [s.id, await fetchPage(s)] as const));
    const next: Record<string, ServerPage> = {};
    for (const [id, page] of results) if (page) next[id] = page;
    setPages(next);
    setLoading(false);
    const unread = Object.values(next).reduce((n, p) => n + p.unread, 0);
    Notifications.setBadgeCountAsync(unread).catch(() => {});
  }, [servers, key, fetchPage]);

  useEffect(() => {
    if (ready) loadAll();
  }, [ready, loadAll, inboxVersion]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (loadingMore.current) return;
    const due = signedIn.filter((s) => pages[s.id]?.more);
    if (!due.length) return;
    loadingMore.current = true;
    const results = await Promise.all(
      due.map(async (s) => {
        const items = pages[s.id].items;
        return [s.id, await fetchPage(s, items[items.length - 1]?.createdAt)] as const;
      }),
    );
    setPages((prev) => {
      const next = { ...prev };
      for (const [id, page] of results) {
        if (!page || !next[id]) continue;
        next[id] = { ...next[id], items: [...next[id].items, ...page.items], more: page.more, unread: page.unread };
      }
      return next;
    });
    loadingMore.current = false;
  };

  const markReadLocally = (entry: Entry) => {
    setPages((prev) => {
      const page = prev[entry.serverId];
      if (!page) return prev;
      return {
        ...prev,
        [entry.serverId]: {
          ...page,
          unread: Math.max(0, page.unread - 1),
          items: page.items.map((n) => (n.id === entry.id ? { ...n, readAt: new Date().toISOString() } : n)),
        },
      };
    });
  };

  const onPress = (entry: Entry) => {
    if (!entry.readAt) {
      markReadLocally(entry);
      client(entry.serverId)?.markRead(entry.id).catch(() => {});
    }
    if (entry.app) {
      const path = normalizeAppPath(entry.path);
      router.push({
        pathname: '/open/[serverId]/[slug]',
        params: { serverId: entry.serverId, slug: entry.app.slug, name: entry.app.name, ...(path ? { path } : {}) },
      });
    }
  };

  const markAllRead = async () => {
    await Promise.all(signedIn.map((s) => client(s.id)?.markAllRead().catch(() => {})));
    loadAll();
  };

  // Every server's notifications, newest first.
  const items = Object.values(pages)
    .flatMap((p) => p.items)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const errors = Object.values(pages)
    .map((p) => p.error)
    .filter(Boolean) as string[];
  const unread = Object.values(pages).reduce((n, p) => n + p.unread, 0);
  const multipleServers = signedIn.length > 1;

  const header = (
    <View>
      <ScreenTitle
        title="Inbox"
        action={unread > 0 ? <Button title="Mark All Read" kind="plain" onPress={markAllRead} /> : undefined}
      />
      {errors.length ? (
        <View style={styles.errors}>
          {errors.map((e) => (
            <ErrorText key={e} message={e} />
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={[styles.fill, { backgroundColor: c.background }]}>
      <FlatList
        data={items}
        keyExtractor={(n) => `${n.serverId}:${n.id}`}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={header}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: c.separator }]} />}
        ListEmptyComponent={
          loading && ready && signedIn.length ? (
            <ActivityIndicator style={{ marginTop: 32 }} />
          ) : (
            <View style={styles.empty}>
              <Text style={[type.heading, { color: c.text }]}>No Notifications</Text>
              <Text style={[type.secondary, { color: c.secondary, textAlign: 'center' }]}>
                {signedIn.length
                  ? 'Notifications from your apps will show here.'
                  : 'Sign in to a server to get notifications from its apps.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const isUnread = !item.readAt;
          const source = [item.app?.name ?? 'Platform', multipleServers ? item.serverName : null]
            .filter(Boolean)
            .join(' · ');
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${isUnread ? 'Unread. ' : ''}${source}. ${item.title}. ${item.body}`}
              onPress={() => onPress(item)}
              style={({ pressed }) => [
                styles.item,
                { backgroundColor: pressed ? c.separator : c.surface },
              ]}>
              <View style={[styles.dot, { backgroundColor: isUnread ? c.text : 'transparent' }]} />
              <View style={styles.itemText}>
                <View style={styles.itemTop}>
                  <Text style={[type.caption, { color: c.secondary, flex: 1 }]} numberOfLines={1}>
                    {source}
                  </Text>
                  <Text style={[type.caption, { color: c.secondary }]}>{when(item.createdAt)}</Text>
                </View>
                <Text style={[isUnread ? type.bodyStrong : type.body, { color: c.text }]} numberOfLines={2}>
                  {item.title}
                </Text>
                {item.body ? (
                  <Text style={[type.secondary, { color: c.secondary }]} numberOfLines={3}>
                    {item.body}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

function when(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const now = new Date();
  if (t.toDateString() === now.toDateString()) {
    return t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  errors: { paddingHorizontal: 20, paddingBottom: 8, gap: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 36 },
  item: { flexDirection: 'row', paddingVertical: 12, paddingRight: 20, paddingLeft: 14, gap: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  itemText: { flex: 1, gap: 2 },
  itemTop: { flexDirection: 'row', gap: 8 },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 32, paddingTop: 48 },
});
