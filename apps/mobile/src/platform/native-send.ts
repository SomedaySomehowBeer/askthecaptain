/** The native request function for the API transport (docs/plans/expo-mobile-platform-account-2026-09.md, "Platform
 *  contract"). Pure: the underlying fetch is injected, so node tests can prove the forced options; src/platform/fetch.ts
 *  binds it to `expo/fetch`, the only place that module is imported.
 *
 *  Two options are forced after the caller's own, so no caller can loosen them:
 *  - `redirect: 'error'`. React Native's global `fetch` ignores this option. `expo/fetch` honours it natively, by source
 *    reading (expo 57.0.25: iOS `ios/Fetch/NativeResponse.swift` declines the redirect and fails the request; Android
 *    `android/.../fetch/NativeRequest.kt` builds OkHttp with `followRedirects(false)`). That is source evidence only:
 *    the device redirect check, including an encoded organisation path, still decides whether it is claimed.
 *  - `credentials: 'omit'`. `expo/fetch` defaults to `'include'`, which sends and stores cookies. The API authenticates
 *    by bearer only, so no cookie is ever sent or kept.
 *
 *  Every destination still comes from the fixed-origin transport (src/api/client.ts); this function adds no URL of its
 *  own. */
import type { Send } from '../api/client.ts';

type SendInit = Parameters<Send>[1];
/** The part of `expo/fetch` this uses. */
export type UnderlyingFetch = (url: string, init: SendInit & { redirect: 'error'; credentials: 'omit' }) => ReturnType<Send>;

export function createNativeSend(underlying: UnderlyingFetch): Send {
	return (url, init) => underlying(url, { ...init, redirect: 'error', credentials: 'omit' });
}
