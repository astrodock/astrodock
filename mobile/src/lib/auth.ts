// Mobile sign-in (MOBILE_DESIGN.md section 2): PKCE through the system browser
// sheet, then the code for a device token.

import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { exchangeCode, type TokenResponse } from './api';
import { authorizeUrl, base64url, challengeFor, createVerifier, parseAuthRedirect, REDIRECT_URI } from './pkce';

export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in was canceled.');
  }
}

export function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

export function platform(): 'ios' | 'android' {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>));

export async function signIn(authUrl: string): Promise<TokenResponse> {
  const verifier = createVerifier((n) => Crypto.getRandomBytes(n));
  const challenge = await challengeFor(verifier, sha256);
  const state = base64url(Crypto.getRandomBytes(16));

  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl(authUrl, challenge, state), REDIRECT_URI);
  if (result.type !== 'success') throw new SignInCancelled();
  const { code } = parseAuthRedirect(result.url, state);

  return exchangeCode(authUrl, {
    code,
    code_verifier: verifier,
    device: {
      name: Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone'),
      platform: platform(),
      appVersion: appVersion(),
    },
  });
}
