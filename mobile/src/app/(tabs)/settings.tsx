import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ErrorText, Group, Row, ScreenTitle, SectionTitle } from '@/components/ui';
import { appVersion, SignInCancelled } from '@/lib/auth';
import { permissionState, requestPermission, type PermissionState } from '@/lib/push';
import { useServers } from '@/lib/servers';
import type { StoredServer } from '@/lib/storage';
import { type, useColors } from '@/lib/theme';

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: 'Allowed',
  denied: 'Not Allowed',
  undetermined: 'Not Set',
};

export default function SettingsScreen() {
  const c = useColors();
  const router = useRouter();
  const { servers, signOut, signInAgain, remove, registerPushAll } = useServers();
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshPermission = useCallback(() => {
    permissionState()
      .then(setPermission)
      .catch(() => setPermission(null));
  }, []);

  // Read it on focus and when coming back from the system Settings app.
  useFocusEffect(
    useCallback(() => {
      refreshPermission();
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'active') refreshPermission();
      });
      return () => sub.remove();
    }, [refreshPermission]),
  );

  const run = async (id: string, task: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await task();
    } catch (err) {
      if (!(err instanceof SignInCancelled)) setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const confirmSignOut = (s: StoredServer) =>
    Alert.alert(`Sign Out of ${s.name}?`, 'This phone stops getting its notifications.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => run(s.id, () => signOut(s.id)) },
    ]);

  const confirmRemove = (s: StoredServer) =>
    Alert.alert(`Remove ${s.name}?`, 'This signs out and removes the server from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => run(s.id, () => remove(s.id)) },
    ]);

  const allowNotifications = async () => {
    const state = await requestPermission();
    setPermission(state);
    if (state === 'granted') await registerPushAll(false);
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.fill, { backgroundColor: c.background }]}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 32 }}>
        <ScreenTitle title="Settings" />

        <SectionTitle title="Servers" />
        {error ? (
          <View style={styles.note}>
            <ErrorText message={error} />
          </View>
        ) : null}
        {servers.map((s) => (
          <View key={s.id} style={styles.groupGap}>
            <Group>
              <Row
                title={s.name}
                detail={
                  s.signedIn
                    ? `${s.user?.email ?? 'Signed in'} · ${hostOf(s.authUrl)}`
                    : `Signed out · ${hostOf(s.authUrl)}`
                }
              />
              {s.signedIn ? (
                <Row title="Sign Out" tone="action" onPress={() => confirmSignOut(s)} />
              ) : (
                <Row
                  title={busy === s.id ? 'Signing In…' : 'Sign In Again'}
                  tone="action"
                  onPress={() => run(s.id, () => signInAgain(s.id))}
                />
              )}
              <Row title="Remove" tone="destructive" onPress={() => confirmRemove(s)} />
            </Group>
          </View>
        ))}
        <Group>
          <Row title="Add Server" tone="action" onPress={() => router.push('/add-server')} />
        </Group>

        <SectionTitle title="Notifications" />
        <Group>
          <Row title="Notifications" trailing={<Text style={[type.secondary, { color: c.secondary }]}>{permission ? PERMISSION_LABEL[permission] : ''}</Text>} />
          {permission === 'undetermined' ? (
            <Row title="Allow Notifications" tone="action" onPress={allowNotifications} />
          ) : null}
          {permission === 'denied' ? (
            <Row title="Open System Settings" tone="action" onPress={() => Linking.openSettings()} />
          ) : null}
        </Group>

        <SectionTitle title="Devices" />
        <View style={styles.note}>
          <Text style={[type.secondary, { color: c.secondary }]}>
            Each server lists this phone on your account page, under Devices. You can revoke it there from any
            browser, for example if this phone is lost.
          </Text>
        </View>

        <SectionTitle title="About" />
        <Group>
          <Row title="Version" trailing={<Text style={[type.secondary, { color: c.secondary }]}>{appVersion()}</Text>} />
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  groupGap: { marginBottom: 12 },
  note: { paddingHorizontal: 20 },
});
