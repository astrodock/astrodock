// Notification Service Extension: decrypts pushes from the relay.
// See NotificationService.swift and PushCrypto.swift.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'notification-service',
  name: 'NotificationService',
  bundleIdentifier: '.notification-service',
  deploymentTarget: '16.4',
  frameworks: ['UserNotifications'],
  entitlements: {
    // The shared group only. The app writes each server's push key here.
    'keychain-access-groups': [
      `$(AppIdentifierPrefix)${config.ios.bundleIdentifier}.shared`,
    ],
  },
});
