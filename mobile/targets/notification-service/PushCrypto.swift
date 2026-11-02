import CryptoKit
import Foundation

// Decryption of an Astrodock push envelope (MOBILE_DESIGN.md section 6).
//
//   shared = X25519(device private key, ephemeral public key)
//   key    = HKDF-SHA256(shared, salt = ephemeral public key, info = "astrodock-push-v1"), 32 bytes
//   AES-256-GCM, 12-byte nonce, no additional data; c = ciphertext || 16-byte tag
//
// Compiled into the Notification Service Extension and into the macOS test in
// test/PushCryptoTest.swift. Foundation and CryptoKit only.

enum PushCryptoError: Error {
  case badEnvelope
  case unsupportedVersion
  case badPlaintext
}

struct PushEnvelope {
  let ephemeralPublicKey: Data
  let nonce: Data
  let ciphertext: Data

  /// From the APNs payload (`ad.x`, a dictionary) or the FCM data field (a JSON string).
  init(_ value: Any) throws {
    var dict = value as? [String: Any]
    if dict == nil, let text = value as? String, let data = text.data(using: .utf8) {
      dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    guard let dict else { throw PushCryptoError.badEnvelope }
    let version = (dict["v"] as? NSNumber)?.intValue
    guard version == 1 else { throw PushCryptoError.unsupportedVersion }
    guard
      let e = (dict["e"] as? String).flatMap({ Data(base64Encoded: $0) }), e.count == 32,
      let n = (dict["n"] as? String).flatMap({ Data(base64Encoded: $0) }), n.count == 12,
      let c = (dict["c"] as? String).flatMap({ Data(base64Encoded: $0) }), c.count >= 16
    else { throw PushCryptoError.badEnvelope }
    ephemeralPublicKey = e
    nonce = n
    ciphertext = c
  }
}

struct PushMessage {
  let id: String
  let title: String
  let body: String
  let appSlug: String?
  let appName: String?
  let path: String?

  init(json: Data) throws {
    guard let dict = try JSONSerialization.jsonObject(with: json) as? [String: Any] else {
      throw PushCryptoError.badPlaintext
    }
    let rawId = dict["id"]
    if let s = rawId as? String {
      id = s
    } else if let n = rawId as? NSNumber {
      id = n.stringValue
    } else {
      throw PushCryptoError.badPlaintext
    }
    title = dict["t"] as? String ?? ""
    body = dict["b"] as? String ?? ""
    appSlug = dict["a"] as? String
    appName = dict["an"] as? String
    path = dict["p"] as? String
  }
}

enum PushCrypto {
  static let info = Data("astrodock-push-v1".utf8)

  /// The plaintext bytes (UTF-8 JSON).
  static func open(_ envelope: PushEnvelope, privateKey: Curve25519.KeyAgreement.PrivateKey) throws -> Data {
    let ephemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: envelope.ephemeralPublicKey)
    let shared = try privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
    let key = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: envelope.ephemeralPublicKey,
      sharedInfo: info,
      outputByteCount: 32
    )
    let box = try AES.GCM.SealedBox(combined: envelope.nonce + envelope.ciphertext)
    return try AES.GCM.open(box, using: key)
  }

  static func decrypt(_ envelope: PushEnvelope, privateKey: Curve25519.KeyAgreement.PrivateKey) throws -> PushMessage {
    try PushMessage(json: open(envelope, privateKey: privateKey))
  }
}
