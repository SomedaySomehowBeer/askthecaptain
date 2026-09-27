import assert from 'node:assert/strict';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createAttempts } from '../auth/attempt.ts';
import type { Transport } from '../api/client.ts';
import { createPkce } from '../auth/pkce.ts';
import { createAuthPlatform, PlatformCryptoFailed, rfc7636, type NativeBrowser, type NativeCrypto } from './auth-platform.ts';

const SHA256 = 'SHA-256' as const;
/** A fake expo-crypto over Node's crypto. Each digest is copied into an exact-size buffer, as expo-crypto's own
 *  fallback returns (a Node Buffer's .buffer is a shared pool). Records every call. */
function fakeCrypto(overrides: Partial<NativeCrypto<string>> = {}) {
	const calls = { random: [] as number[], digest: [] as string[] };
	const crypto: NativeCrypto<string> = {
		async getRandomBytesAsync(count) { calls.random.push(count); return new Uint8Array(nodeRandomBytes(count)); },
		async digest(algorithm, data) { calls.digest.push(algorithm); return Uint8Array.from(createHash('sha256').update(data).digest()).buffer; },
		...overrides
	};
	return { crypto, calls };
}
function fakeBrowser(result: { type: string; url?: string; [extra: string]: unknown } | Error = { type: 'cancel' }) {
	const calls = { open: [] as { url: string; redirect: string | null | undefined; options: unknown }[], dismissed: 0 };
	const browser: NativeBrowser = {
		async openAuthSessionAsync(url, redirect, options) { calls.open.push({ url, redirect, options }); if (result instanceof Error) throw result; return result as { type: string; url?: string }; },
		dismissAuthSession() { calls.dismissed += 1; }
	};
	return { browser, calls };
}
const platformFor = (os: string, crypto = fakeCrypto().crypto, browser = fakeBrowser().browser) => createAuthPlatform({ os, crypto, sha256: SHA256, browser });

test('native only: iOS and Android get a platform, web and anything else get none', () => {
	assert.ok(platformFor('ios')); assert.ok(platformFor('android'));
	for (const os of ['web', 'windows', 'macos', '']) assert.equal(platformFor(os), null, os);
});

test('random bytes come only from the asynchronous native generator, and wrong or all-zero output is refused', async () => {
	const { crypto, calls } = fakeCrypto();
	const bytes = await platformFor('ios', crypto)!.randomBytes(32);
	assert.equal(bytes.length, 32); assert.deepEqual(calls.random, [32]);
	for (const bad of [async () => new Uint8Array(31), async () => new Uint8Array(32), async () => [1, 2, 3] as unknown as Uint8Array]) {
		const platform = platformFor('android', fakeCrypto({ getRandomBytesAsync: bad }).crypto)!;
		await assert.rejects(platform.randomBytes(32), PlatformCryptoFailed);
	}
	await assert.rejects(platformFor('ios', fakeCrypto({ getRandomBytesAsync: async () => { throw new Error('SecRandomCopyBytes failed'); } }).crypto)!.randomBytes(32));
});

test('SHA-256 runs the RFC 7636 known-answer check first, through the injected crypto, with the SHA-256 algorithm', async () => {
	const { crypto, calls } = fakeCrypto();
	const platform = platformFor('ios', crypto)!;
	const data = new TextEncoder().encode('hello');
	assert.deepEqual(await platform.sha256(data), Uint8Array.from(createHash('sha256').update('hello').digest()));
	assert.deepEqual(calls.digest, [SHA256, SHA256], 'the check, then the real digest');
	await platform.sha256(data);
	assert.equal(calls.digest.length, 3, 'a passed check is not repeated');
	// The native digest receives a fresh copy of exactly the viewed bytes, backed by its own ArrayBuffer, even for a view
	// at an offset into a larger buffer.
	const seen: Uint8Array[] = [];
	const copying = platformFor('ios', fakeCrypto({ async digest(_a, bytes) { seen.push(bytes); return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer; } }).crypto)!;
	const whole = new TextEncoder().encode('xxhelloxx');
	const view = whole.subarray(2, 7);
	assert.deepEqual(await copying.sha256(view), Uint8Array.from(createHash('sha256').update('hello').digest()));
	const last = seen.at(-1)!;
	assert.notEqual(last.buffer, whole.buffer); assert.equal(last.byteOffset, 0); assert.equal(last.buffer.byteLength, 5);
	// The whole PKCE path through the adapter reproduces the RFC vector.
	const vector = await platform.sha256(new TextEncoder().encode(rfc7636.verifier));
	assert.equal(Buffer.from(vector).toString('base64url'), rfc7636.challenge);
});

test('a digest that fails the known-answer check, has the wrong length or is not an ArrayBuffer is refused, and the check reruns', async () => {
	let wrong = true;
	const { crypto, calls } = fakeCrypto({ async digest(_algorithm, data) { calls.digest.push('x'); return wrong ? new ArrayBuffer(32) : Uint8Array.from(createHash('sha256').update(data).digest()).buffer; } });
	const platform = platformFor('android', crypto)!;
	await assert.rejects(platform.sha256(new Uint8Array([1])), (error: unknown) => error instanceof PlatformCryptoFailed && /known-answer/.test(error.message));
	wrong = false;
	assert.equal((await platform.sha256(new Uint8Array([1]))).length, 32, 'a failed check is re-run, not remembered');
	for (const digest of [async () => new ArrayBuffer(20), async () => new Uint8Array(32) as unknown as ArrayBuffer]) {
		await assert.rejects(platformFor('ios', fakeCrypto({ digest }).crypto)!.sha256(new Uint8Array([1])), PlatformCryptoFailed);
	}
});

test('the attempt core turns a failing crypto adapter into cannot-finish, with no browser opened and nothing sent', async () => {
	const sent: unknown[] = [];
	const transport: Transport = { origin: 'https://api.example.test', request: async (...args) => { sent.push(args); return { kind: 'no-answer', reason: 'network' }; } };
	const { browser, calls } = fakeBrowser();
	const platform = platformFor('ios', fakeCrypto({ digest: async () => new ArrayBuffer(32) }).crypto, browser)!;
	assert.deepEqual(await createAttempts({ platform, transport }).start(), { kind: 'cannot-finish' });
	assert.equal(calls.open.length, 0); assert.equal(sent.length, 0);
	// And a working adapter produces well-formed PKCE values.
	const pkce = await createPkce(platformFor('android')!);
	assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('base64url'));
});

test('the auth session always asks for an ephemeral session with the exact prefix, and passes through only type and a success URL', async () => {
	const callback = 'app.askthecaptain.dev:/auth/callback?code=x&attempt=y';
	const success = fakeBrowser({ type: 'success', url: callback, error: 'ignored' });
	assert.deepEqual(await platformFor('ios', undefined, success.browser)!.openAuthSession('https://api.example.test/auth/google/start?x=1', 'app.askthecaptain.dev:/auth/callback'),
		{ type: 'success', url: callback });
	assert.deepEqual(success.calls.open, [{ url: 'https://api.example.test/auth/google/start?x=1', redirect: 'app.askthecaptain.dev:/auth/callback', options: { preferEphemeralSession: true } }]);
	for (const result of [{ type: 'cancel', error: 'The operation couldn’t be completed.' }, { type: 'dismiss' }, { type: 'opened' }, { type: 'locked' }, { type: 'success' }, { type: 'success', url: 7 }]) {
		const { browser } = fakeBrowser(result as { type: string });
		const answer = await platformFor('android', undefined, browser)!.openAuthSession('https://x.test', 'p');
		assert.deepEqual(answer, { type: result.type }, JSON.stringify(result));
	}
	await assert.rejects(platformFor('ios', undefined, fakeBrowser(new Error('Another web browser is already open')).browser)!.openAuthSession('https://x.test', 'p'));
});

test('dismiss passes through; an Android dismiss that throws is caught by the attempt core, which still closes', async () => {
	const { browser, calls } = fakeBrowser();
	platformFor('ios', undefined, browser)!.dismissAuthSession();
	assert.equal(calls.dismissed, 1);
	let finish!: (value: { type: string }) => void;
	const android: NativeBrowser = {
		openAuthSessionAsync: () => new Promise((resolve) => { finish = resolve; }),
		dismissAuthSession() { throw new Error("The method or property WebBrowser.dismissBrowser is not available on android"); }
	};
	const transport: Transport = { origin: 'https://api.example.test', request: async () => ({ kind: 'no-answer', reason: 'network' }) };
	const attempts = createAttempts({ platform: platformFor('android', undefined, android)!, transport });
	const outcome = attempts.start();
	for (let i = 0; i < 50 && attempts.state() !== 'awaiting-callback'; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(attempts.state(), 'awaiting-callback');
	assert.equal(attempts.cancel(), true, 'the throw does not escape cancel');
	assert.equal(attempts.state(), 'closing');
	finish({ type: 'dismiss' }); // the polyfill resolves when the app becomes active again
	assert.deepEqual(await outcome, { kind: 'cancelled' });
	assert.equal(attempts.state(), 'idle');
});
