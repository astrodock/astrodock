import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, ErrorText } from '@/components/ui';
import { SignInCancelled } from '@/lib/auth';
import { useServers } from '@/lib/servers';
import { type, useColors } from '@/lib/theme';

export default function AddServerScreen() {
  const c = useColors();
  const router = useRouter();
  const { addServer } = useServers();
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await addServer(domain);
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (err) {
      if (!(err instanceof SignInCancelled)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.fill, { backgroundColor: c.background }]}>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable accessibilityRole="button" hitSlop={10} onPress={() => router.back()}>
              <Text style={[type.body, { color: c.tint }]}>Cancel</Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.body}>
        <Text style={[type.secondary, { color: c.secondary }]}>
          Enter the domain of your Astrodock server. You will sign in on the next screen.
        </Text>
        <View style={styles.field}>
          <Text style={[type.section, { color: c.secondary }]}>Domain</Text>
          <TextInput
            value={domain}
            onChangeText={setDomain}
            placeholder="astrodock.example.com"
            placeholderTextColor={c.secondary}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            autoFocus
            editable={!busy}
            onSubmitEditing={() => domain.trim() && onContinue()}
            style={[
              type.body,
              styles.input,
              { color: c.text, backgroundColor: c.surface, borderColor: error ? c.danger : c.separator },
            ]}
            accessibilityLabel="Domain"
          />
        </View>
        <ErrorText message={error} />
        <Button title="Continue" busy={busy} disabled={!domain.trim()} onPress={onContinue} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 20, gap: 16 },
  field: { gap: 6 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
});
