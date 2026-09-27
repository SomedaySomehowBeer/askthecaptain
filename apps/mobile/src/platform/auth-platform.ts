/** The attempt core's platform services (`AuthPlatform`, src/auth/contracts.ts) over injected `expo-crypto` and
 *  `expo-web-browser` (docs/plans/expo-mobile-platform-account-2026-09.md, "Platform contract"). Pure: the modules are
 *  parameters, so node tests use fakes; src/platform/expo.ts binds the installed modules.
 *
 *  Installed SDK facts this relies on (expo-crypto 57.0.3, expo-web-browser 57.0.3, read from source):
 *  - `getRandomBytesAsync` fills bytes from the native secure generator (iOS SecRandomCopyBytes, Android SecureRandom)
 *    and has no fallback. The synchronous `getRandomBytes` returns Math.random bytes in development builds, so it is
 *    never used (the boundary guard refuses it).
 *  - `digest(SHA-256, bytes)` resolves a 32-byte ArrayBuffer.
 *  - iOS runs ASWebAuthenticationSession: `success` with the callback URL, `cancel` on any error including the person
 *    cancelling, `dismiss` after `dismissAuthSession`; a second open or a failed start throws.
 *  - Android has no native auth session. A JavaScript polyfill opens a Custom Tab and races the callback, received as
 *    an ordinary deep link, against the app becoming active again (`dismiss`). `preferEphemeralSession` does not apply
 *    there, a second open throws, and `dismissAuthSession` throws because Android has no `dismissBrowser`; the attempt
 *    core catches that throw. Device gates cover both platforms' real behaviour.
 *
 *  Native only: on any other platform (web) there is no AuthPlatform, so native sign-in is never offered. */
import type { AuthPlatform } from '../auth/contracts.ts';
import { base64url } from '../auth/pkce.ts';

/** The part of `expo-crypto` used. `A` is the module's digest-algorithm type; the caller passes its SHA-256 value.
 *  `digest` takes a `BufferSource` backed by an ordinary ArrayBuffer (not a SharedArrayBuffer), so the adapter always
 *  passes a fresh copy of that kind. */
export type NativeCrypto<A> = {
	getRandomBytesAsync(byteCount: number): Promise<Uint8Array>;
	digest(algorithm: A, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
};
/** The part of `expo-web-browser` used. */
export type NativeBrowser = {
	openAuthSessionAsync(url: string, redirectUrl?: string | null, options?: { preferEphemeralSession?: boolean }): Promise<{ type: string; url?: string }>;
	dismissAuthSession(): void;
};

/** RFC 7636 appendix B: this verifier's S256 challenge. */
export const rfc7636 = { verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' } as const;

/** Thrown when the platform's crypto gives a wrong or unusable answer. The attempt core treats any crypto failure as
 *  `cannot-finish` before anything is opened or sent. The message names no value. */
export class PlatformCryptoFailed extends Error {
	constructor(what: string) { super(`platform crypto: ${what}`); this.name = 'PlatformCryptoFailed'; }
}

export function createAuthPlatform<A>(deps: { os: string; crypto: NativeCrypto<A>; sha256: A; browser: NativeBrowser }): AuthPlatform | null {
	if (deps.os !== 'ios' && deps.os !== 'android') return null;
	const { crypto, sha256: algorithm, browser } = deps;

	const digest = async (data: Uint8Array): Promise<Uint8Array> => {
		// A copy into a new ArrayBuffer: exactly the bytes of `data`, whatever buffer (or view offset) it came from.
		const copy = new Uint8Array(data.byteLength);
		copy.set(data);
		const result = await crypto.digest(algorithm, copy);
		if (!(result instanceof ArrayBuffer) || result.byteLength !== 32) throw new PlatformCryptoFailed('SHA-256 did not return 32 bytes');
		return new Uint8Array(result);
	};
	/** The known-answer check, run before the first digest is used; a passing result is kept, a failure is re-checked
	 *  next time (it may have been a transient native error). */
	let checked: Promise<void> | null = null;
	const knownAnswer = (): Promise<void> => {
		checked ??= digest(new TextEncoder().encode(rfc7636.verifier)).then((bytes) => {
			if (base64url(bytes) !== rfc7636.challenge) throw new PlatformCryptoFailed('SHA-256 failed the RFC 7636 known-answer check');
		});
		checked.catch(() => { checked = null; });
		return checked;
	};

	return {
		async randomBytes(length) {
			const bytes = await crypto.getRandomBytesAsync(length);
			if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new PlatformCryptoFailed('random bytes had the wrong length');
			// All zero is what a broken native generator (or an unfilled buffer) returns; for 32 real bytes it has
			// probability 2^-256.
			if (bytes.every((byte) => byte === 0)) throw new PlatformCryptoFailed('random bytes were all zero');
			return bytes;
		},
		async sha256(data) {
			await knownAnswer();
			return digest(data);
		},
		async openAuthSession(url, redirectPrefix) {
			const result = await browser.openAuthSessionAsync(url, redirectPrefix, { preferEphemeralSession: true });
			// Only `type` and a success URL pass through; anything else the platform adds (an iOS error description) is
			// dropped. Every type other than success is a cancellation in the attempt core.
			return result.type === 'success' && typeof result.url === 'string' ? { type: 'success', url: result.url } : { type: String(result.type) };
		},
		dismissAuthSession() {
			browser.dismissAuthSession();
		}
	};
}
