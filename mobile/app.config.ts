import type { ConfigContext, ExpoConfig } from 'expo/config';

// A fork changes the bundle id here (or with APP_BUNDLE_ID) and everything that
// derives from it follows: the Android package, the shared Keychain group that
// holds the push keys, and the Notification Service Extension's bundle id.
const BUNDLE_ID = process.env.APP_BUNDLE_ID || 'ai.astrodock.mobile';

// The build profile, set per profile in eas.json. A local `npx expo run:ios`
// has no APP_VARIANT and counts as a development build.
const VARIANT = process.env.APP_VARIANT || 'development';
const PUSH_ENVIRONMENT = VARIANT === 'development' ? 'sandbox' : 'production';

// Keychain group shared by the app and the Notification Service Extension.
// The app writes each server's push key here; the extension reads it.
const SHARED_KEYCHAIN_GROUP = `${BUNDLE_ID}.shared`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Astrodock',
  slug: 'astrodock',
  scheme: 'astrodock',
  version: '0.1.0',
  orientation: 'default',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    // Set APPLE_TEAM_ID locally or as an EAS environment variable. It is the
    // publisher's and stays out of the repository.
    ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: 'Apps you open in Astrodock can use the camera to take photos and videos.',
      NSPhotoLibraryUsageDescription: 'Apps you open in Astrodock can attach photos and videos from your library.',
      NSMicrophoneUsageDescription: 'Apps you open in Astrodock can use the microphone to record audio.',
      NSLocationWhenInUseUsageDescription: 'Apps you open in Astrodock can use your location while you use them.',
      // Read at run time by the astrodock-push module to store keys in the shared group.
      AstrodockKeychainGroup: `$(AppIdentifierPrefix)${SHARED_KEYCHAIN_GROUP}`,
    },
    entitlements: {
      'aps-environment': PUSH_ENVIRONMENT === 'sandbox' ? 'development' : 'production',
      // The app's own group comes first so items stored without a group
      // (expo-secure-store's device tokens) stay private to the app.
      'keychain-access-groups': [
        `$(AppIdentifierPrefix)${BUNDLE_ID}`,
        `$(AppIdentifierPrefix)${SHARED_KEYCHAIN_GROUP}`,
      ],
    },
  },
  android: {
    package: BUNDLE_ID,
    permissions: [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
    ],
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/images/icon.png',
        imageWidth: 96,
        backgroundColor: '#FFFFFF',
        dark: { image: './assets/images/icon.png', backgroundColor: '#000000' },
      },
    ],
    // No biometrics: drop the Face ID usage string the plugin adds by default.
    ['expo-secure-store', { faceIDPermission: false }],
    'expo-web-browser',
    [
      'expo-notifications',
      { mode: PUSH_ENVIRONMENT === 'sandbox' ? 'development' : 'production' },
    ],
    '@bacons/apple-targets',
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    ...config.extra,
    appVariant: VARIANT,
    pushEnvironment: PUSH_ENVIRONMENT,
    sharedKeychainGroup: SHARED_KEYCHAIN_GROUP,
  },
});
