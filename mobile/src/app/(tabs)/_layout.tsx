import { NativeTabs } from 'expo-router/native-tabs';

import { useColors } from '@/lib/theme';

export default function TabsLayout() {
  const c = useColors();
  return (
    <NativeTabs tintColor={c.tint}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Apps</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.grid.2x2" md="apps" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="tray" md="inbox" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
