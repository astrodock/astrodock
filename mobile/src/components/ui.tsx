import { Image } from 'expo-image';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { type, useColors } from '@/lib/theme';

export function Icon({
  ios,
  android,
  size = 20,
  color,
}: {
  ios: SymbolViewProps['name'] & string;
  android: string;
  size?: number;
  color: string;
}) {
  return (
    <SymbolView
      name={{ ios, android } as SymbolViewProps['name']}
      size={size}
      tintColor={color}
      fallback={<View style={{ width: size, height: size }} />}
    />
  );
}

/** The tab screens' compact title row, with an optional action on the right. */
export function ScreenTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.titleRow}>
      <Text style={[type.title, { color: c.text }]} accessibilityRole="header">
        {title}
      </Text>
      {action}
    </View>
  );
}

export function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  const c = useColors();
  return (
    <View style={styles.sectionTitle}>
      <Text style={[type.heading, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      {detail ? (
        <Text style={[type.caption, { color: c.secondary }]} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  kind?: 'filled' | 'plain' | 'destructive';
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

export function Button({ title, onPress, kind = 'filled', busy, disabled, style }: ButtonProps) {
  const c = useColors();
  const filled = kind === 'filled';
  const color = kind === 'destructive' ? c.danger : filled ? c.onTint : c.tint;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        filled ? { backgroundColor: c.tint } : null,
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={color} /> : <Text style={[type.bodyStrong, { color }]}>{title}</Text>}
    </Pressable>
  );
}

/** A header action: an icon with a label for screen readers. */
export function IconButton({
  ios,
  android,
  label,
  onPress,
}: {
  ios: SymbolViewProps['name'] & string;
  android: string;
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.5 : 1 }]}>
      <Icon ios={ios} android={android} size={22} color={c.tint} />
    </Pressable>
  );
}

export function Group({ children }: { children: React.ReactNode }) {
  const c = useColors();
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.group, { backgroundColor: c.surface }]}>
      {items.map((child, i) => (
        <View key={i}>
          {i > 0 ? <View style={[styles.separator, { backgroundColor: c.separator }]} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

export function Row({
  title,
  detail,
  onPress,
  tone = 'normal',
  chevron,
  leading,
  trailing,
}: {
  title: string;
  detail?: string;
  onPress?: () => void;
  tone?: 'normal' | 'action' | 'destructive';
  chevron?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const c = useColors();
  const titleColor = tone === 'action' ? c.tint : tone === 'destructive' ? c.danger : c.text;
  const body = (
    <View style={styles.row}>
      {leading}
      <View style={styles.rowText}>
        <Text style={[type.body, { color: titleColor }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={[type.secondary, { color: c.secondary }]} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon ios="chevron.right" android="chevron_right" size={14} color={c.secondary} /> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ backgroundColor: pressed ? c.separator : 'transparent' })}>
      {body}
    </Pressable>
  );
}

export function ErrorText({ message }: { message: string | null | undefined }) {
  const c = useColors();
  if (!message) return null;
  return (
    <Text style={[type.secondary, { color: c.danger }]} accessibilityRole="alert">
      {message}
    </Text>
  );
}

/**
 * An app's icon: the first of `sources` that loads, else its initial. An app
 * with no icon file answers with its index page, which fails to decode and
 * moves on to the next.
 */
export function AppTile({ name, sources = [], size = 44 }: { name: string; sources?: string[]; size?: number }) {
  const c = useColors();
  const radius = Math.round(size * 0.22);
  const key = sources.join('|');
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => setIndex(0), [key]);
  const uri = sources[index];
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: c.tile }}
        contentFit="cover"
        onError={() => setIndex((i) => i + 1)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  const initial = (name.trim()[0] || '?').toUpperCase();
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: radius, backgroundColor: c.tile }]}>
      <Text style={{ fontSize: size * 0.45, fontWeight: '600', color: c.text }}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  sectionTitle: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8, gap: 2 },
  button: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: { padding: 4 },
  group: { marginHorizontal: 16, borderRadius: 12, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 48 },
  rowText: { flex: 1, gap: 2 },
  tile: { alignItems: 'center', justifyContent: 'center' },
});
