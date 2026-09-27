/** Binds the injected adapters to the installed modules: expo-crypto and expo-web-browser (./auth-platform.ts) and
 *  expo-secure-store (./secure-storage.ts). Typecheck-only: it imports native modules, so node tests cover the adapters
 *  with fakes. `expo/fetch` is bound separately, and only, in ./fetch.ts.
 *
 *  Nothing here runs at import beyond building the adapter objects: no storage is opened, no browser shown and no
 *  request made until the account runner (a later increment wires it) calls these. */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { createAuthPlatform } from './auth-platform.ts';
import { openSecureStorage, type DeviceStorage } from './secure-storage.ts';

/** The attempt core's platform services on iOS and Android; null on web, where native sign-in is never offered. */
export const authPlatform = createAuthPlatform({ os: Platform.OS, crypto: Crypto, sha256: Crypto.CryptoDigestAlgorithm.SHA256, browser: WebBrowser });

/** The device's credential storage, or unavailable (web, or the module reports itself unavailable). */
export const openDeviceStorage = (): Promise<DeviceStorage> => openSecureStorage(Platform.OS, SecureStore);
