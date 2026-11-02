import CryptoKit
import Foundation

// Checks targets/notification-service/PushCrypto.swift against the control
// plane's reference vector (test/push-vector.json, copied from
// apps/control-plane/test/fixtures/push-vector.json). Run with
// `npm run test:push-vector`.

@main
struct PushCryptoTest {
  static var failures = 0

  static func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
  }

  static func main() throws {
    let path = CommandLine.arguments.dropFirst().first ?? "test/push-vector.json"
    let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
    let b64 = { (k: String) in Data(base64Encoded: vector[k] as! String)! }

    let device = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: b64("devicePrivateKey"))
    check(device.publicKey.rawRepresentation == b64("devicePublicKey"), "device public key matches the private key")

    let envelope = vector["envelope"] as! [String: Any]
    let plaintext = try PushCrypto.open(PushEnvelope(envelope), privateKey: device)
    check(plaintext == b64("plaintextBase64"), "envelope decrypts to the vector's plaintext bytes")
    check(String(data: plaintext, encoding: .utf8) == (vector["plaintext"] as! String), "plaintext matches as text")

    let message = try PushCrypto.decrypt(PushEnvelope(envelope), privateKey: device)
    check(message.id == "5f0c2a3e-8b1d-4c7a-9e2f-1a2b3c4d5e6f", "id")
    check(message.title == "Task Due", "title")
    check(message.body == "Call the bank. Café at 3 — bring the forms ✓", "body (non-ASCII)")
    check(message.appSlug == "assistant" && message.appName == "Assistant", "app slug and name")
    check(message.path == "/tasks/12", "path")

    // The FCM form carries the envelope as a JSON string.
    let asString = String(data: try JSONSerialization.data(withJSONObject: envelope), encoding: .utf8)!
    check((try? PushCrypto.decrypt(PushEnvelope(asString), privateKey: device))?.id == message.id, "envelope as a JSON string")

    // A changed byte, the wrong key or another version must not decrypt.
    var tampered = envelope
    var c = Data(base64Encoded: envelope["c"] as! String)!
    c[0] ^= 1
    tampered["c"] = c.base64EncodedString()
    check((try? PushCrypto.open(PushEnvelope(tampered), privateKey: device)) == nil, "tampered ciphertext is refused")
    check((try? PushCrypto.open(PushEnvelope(envelope), privateKey: .init())) == nil, "another key is refused")
    var v2 = envelope
    v2["v"] = 2
    check((try? PushEnvelope(v2)) == nil, "unknown version is refused")

    if failures > 0 {
      print("\(failures) check(s) failed")
      exit(1)
    }
    print("push vector: all checks passed")
  }
}
