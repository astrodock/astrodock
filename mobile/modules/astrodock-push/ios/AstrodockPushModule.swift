import CryptoKit
import ExpoModulesCore
import Foundation
import Security

// One Curve25519 key pair per Astrodock server (keyed by the relay's server id,
// `srv_...`). The private key is stored in the Keychain group shared with the
// Notification Service Extension, which reads it to decrypt pushes. It never
// leaves the Keychain except into this process and the extension.
//
// Keychain item, kept in step with targets/notification-service/NotificationService.swift:
//   class      kSecClassGenericPassword
//   service    "ai.astrodock.push-key"
//   account    the relay server id
//   group      Info.plist AstrodockKeychainGroup ($(AppIdentifierPrefix)<bundle id>.shared)
//   value      the 32-byte raw private key
public class AstrodockPushModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AstrodockPush")

    // Returns the base64 public key, creating the key pair on first use.
    AsyncFunction("publicKey") { (serverId: String) -> String in
      let key = try PushKeyStore.loadOrCreate(serverId: serverId)
      return key.publicKey.rawRepresentation.base64EncodedString()
    }

    AsyncFunction("deleteKey") { (serverId: String) in
      try PushKeyStore.delete(serverId: serverId)
    }
  }
}

enum PushKeyStore {
  static let service = "ai.astrodock.push-key"

  struct KeychainError: Error, CustomStringConvertible {
    let status: OSStatus
    let action: String
    var description: String { "Keychain \(action) failed (\(status))" }
  }

  static var accessGroup: String? {
    let value = Bundle.main.object(forInfoDictionaryKey: "AstrodockKeychainGroup") as? String
    guard let value, !value.isEmpty, !value.hasPrefix("$(") else { return nil }
    return value
  }

  static func baseQuery(serverId: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: serverId,
    ]
    if let group = accessGroup {
      query[kSecAttrAccessGroup as String] = group
    }
    return query
  }

  static func load(serverId: String) throws -> Curve25519.KeyAgreement.PrivateKey? {
    var query = baseQuery(serverId: serverId)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else {
      throw KeychainError(status: status, action: "read")
    }
    return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
  }

  static func loadOrCreate(serverId: String) throws -> Curve25519.KeyAgreement.PrivateKey {
    if let existing = try load(serverId: serverId) { return existing }
    let key = Curve25519.KeyAgreement.PrivateKey()
    var query = baseQuery(serverId: serverId)
    query[kSecValueData as String] = key.rawRepresentation
    // The extension runs while the phone is locked, after the first unlock.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem, let existing = try load(serverId: serverId) {
      return existing
    }
    guard status == errSecSuccess else { throw KeychainError(status: status, action: "write") }
    return key
  }

  static func delete(serverId: String) throws {
    let status = SecItemDelete(baseQuery(serverId: serverId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(status: status, action: "delete")
    }
  }
}
