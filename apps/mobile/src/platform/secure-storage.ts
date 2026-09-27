/** `SessionStorage` (src/account/contracts.ts) over an injected `expo-secure-store` (docs/plans/expo-mobile-foundation-
 *  2026-09.md §4; docs/plans/expo-mobile-platform-account-2026-09.md, "Platform contract"). Pure: the module and the
 *  platform name are parameters, so node tests use fakes; src/platform/expo.ts binds the installed module. Only the
 *  credential store (src/account/store.ts) calls the storage this returns, one operation at a time, and it replaces
 *  every error with StorageUnreadable or StorageUnwritable, so no platform message travels further.
 *
 *  Installed SDK facts this relies on (expo-secure-store 57.0.4, read from source):
 *  - Keys must match /^[\w.-]+$/; `session` and `org.{uuid}` do.
 *  - iOS: `keychainAccessible` defaults to WHEN_UNLOCKED. An overwrite of an existing item updates only its data and
 *    keeps its first accessibility, so every write passes WHEN_UNLOCKED_THIS_DEVICE_ONLY from the very first build that
 *    writes a credential. That is sufficient only because no earlier build wrote one (an invariant, not a check).
 *  - iOS: a failed delete is silent (every SecItemDelete status is ignored), so a delete is confirmed by reading back.
 *    A read on a locked device throws.
 *  - Android: a read of an entry it cannot decrypt returns null (and usually deletes it). So `null` means "no usable
 *    saved sign-in was returned", never proof that no bytes remain.
 *  - Web: the native module is empty. Storage there is refused before any call; native sign-in is never offered.
 *  - Keychain items survive app uninstall on iOS; the account runner checks any found session with /v1/me.
 *
 *  Every call passes the same options object: the default keychain service, no `requireAuthentication`, and
 *  WHEN_UNLOCKED_THIS_DEVICE_ONLY. */
import type { SessionStorage, StorageKey } from '../account/contracts.ts';

type Options = { readonly keychainAccessible: number };
/** The part of `expo-secure-store` used. */
export type SecureStoreModule = {
	readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
	isAvailableAsync(): Promise<boolean>;
	getItemAsync(key: string, options?: Options): Promise<string | null>;
	setItemAsync(key: string, value: string, options?: Options): Promise<void>;
	deleteItemAsync(key: string, options?: Options): Promise<void>;
};

export type DeviceStorage = { readonly available: true; readonly storage: SessionStorage } | { readonly available: false };

/** Thrown by `deleteItem` when the read-back still finds a value: the delete did not take effect. The message names no
 *  key or value; the credential store reports it as StorageUnwritable ("a copy may remain"). */
export class DeleteNotConfirmed extends Error {
	constructor() { super('secure storage: the value was still there after deleting it'); this.name = 'DeleteNotConfirmed'; }
}

/** The device's credential storage, or `available: false` on web, on an unknown platform, or when the module reports
 *  itself unavailable (including when that check fails). Nothing is read or written here. */
export async function openSecureStorage(os: string, store: SecureStoreModule): Promise<DeviceStorage> {
	if (os !== 'ios' && os !== 'android') return { available: false };
	const accessible = store.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
	if (typeof accessible !== 'number') return { available: false };
	let available = false;
	try { available = (await store.isAvailableAsync()) === true; } catch { available = false; }
	if (!available) return { available: false };

	const options: Options = Object.freeze({ keychainAccessible: accessible });
	const storage: SessionStorage = {
		getItem: (key: StorageKey) => store.getItemAsync(key, options),
		setItem: (key: StorageKey, value: string) => store.setItemAsync(key, value, options),
		async deleteItem(key: StorageKey) {
			await store.deleteItemAsync(key, options);
			// A read-back that throws (the device locked in between) also leaves the delete unconfirmed: the error
			// propagates, and the store reports that a copy may remain.
			if ((await store.getItemAsync(key, options)) !== null) throw new DeleteNotConfirmed();
		}
	};
	return { available: true, storage: Object.freeze(storage) };
}
