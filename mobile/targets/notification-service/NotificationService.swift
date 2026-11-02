import CryptoKit
import Security
import UserNotifications

// Replaces the relay's generic "New Notification" text with the real one.
//
// The payload carries `ad.s` (the relay server id) and `ad.x` (the envelope).
// The extension loads that server's private key from the Keychain group it
// shares with the app, decrypts (PushCrypto.swift), and rewrites the content.
// On any failure the generic text is shown unchanged.
//
// It also sets `userInfo.body` to { serverId, notificationId, app, appName, path } so a
// tap can open the right app. expo-notifications exposes `userInfo.body` to JS
// as `content.data`.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttempt = content

    if let ad = content.userInfo["ad"] as? [String: Any],
       let serverId = ad["s"] as? String,
       let x = ad["x"],
       let message = try? Self.decrypt(serverId: serverId, envelope: x) {
      if let appName = message.appName, !appName.isEmpty {
        content.title = appName
        content.subtitle = message.title
      } else {
        content.title = message.title
      }
      content.body = message.body
      content.threadIdentifier = "\(serverId):\(message.appSlug ?? "")"

      var target: [String: Any] = ["serverId": serverId, "notificationId": message.id]
      if let slug = message.appSlug { target["app"] = slug }
      if let appName = message.appName { target["appName"] = appName }
      if let path = message.path { target["path"] = path }
      var info = content.userInfo
      info["body"] = target
      content.userInfo = info
    }

    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let bestAttempt {
      contentHandler(bestAttempt)
    }
  }

  static func decrypt(serverId: String, envelope: Any) throws -> PushMessage {
    let key = try loadKey(serverId: serverId)
    return try PushCrypto.decrypt(PushEnvelope(envelope), privateKey: key)
  }

  struct NoKey: Error {}

  // Same item the app's astrodock-push module writes. No access group in the
  // query: the extension's only Keychain group is the shared one.
  static func loadKey(serverId: String) throws -> Curve25519.KeyAgreement.PrivateKey {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "ai.astrodock.push-key",
      kSecAttrAccount as String: serverId,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
      throw NoKey()
    }
    return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
  }
}
