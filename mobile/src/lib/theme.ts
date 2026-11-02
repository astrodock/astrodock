import { useColorScheme } from 'react-native';

// Plain neutral surfaces. Indigo marks what can be tapped; red marks errors.
const light = {
  background: '#F2F2F7',
  surface: '#FFFFFF',
  text: '#111114',
  secondary: '#6C6C72',
  separator: '#D8D8DE',
  tile: '#E4E4EA',
  tint: '#4F46E5',
  onTint: '#FFFFFF',
  danger: '#D92D20',
};

const dark: typeof light = {
  background: '#000000',
  surface: '#1C1C1E',
  text: '#F4F4F6',
  secondary: '#9C9CA3',
  separator: '#38383C',
  tile: '#2C2C30',
  tint: '#8B87F5',
  onTint: '#0B0B12',
  danger: '#FF6B5E',
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

// System font. Clear steps between headings and body text.
export const type = {
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: 0.2 },
  heading: { fontSize: 20, fontWeight: '600' as const },
  section: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.4 },
  body: { fontSize: 17, fontWeight: '400' as const },
  bodyStrong: { fontSize: 17, fontWeight: '600' as const },
  secondary: { fontSize: 15, fontWeight: '400' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
};
