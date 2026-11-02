import { requireOptionalNativeModule } from 'expo';

type AstrodockPushNative = {
  publicKey(serverId: string): Promise<string>;
  deleteKey(serverId: string): Promise<void>;
};

// iOS only. On Android there is no native module: no key, so the server sends
// no encrypted payload and the phone shows the relay's generic text.
const native = requireOptionalNativeModule<AstrodockPushNative>('AstrodockPush');

/** The device's X25519 public key for a relay server id, base64. Null on Android. */
export async function publicKey(serverId: string): Promise<string | null> {
  if (!native) return null;
  return native.publicKey(serverId);
}

export async function deleteKey(serverId: string): Promise<void> {
  if (!native) return;
  await native.deleteKey(serverId);
}
