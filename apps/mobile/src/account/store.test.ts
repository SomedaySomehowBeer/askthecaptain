import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	StorageUnreadable, StorageUnwritable,
	type Generation, type SessionStorage, type StorageKey, type StoredSession
} from './contracts.ts';
import { createCredentialStore } from './store.ts';

const userA = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const userB = '9b2d6c1e-0a4f-4c3b-8e7d-5f6a7b8c9d0e';
const orgA = 'c0ffee00-1234-4abc-9def-0123456789ab';
const orgB = 'd00dfeed-5678-4def-8abc-ba9876543210';
const token = (letter: string) => `sess_${letter.repeat(43)}`;
const session = (letter: string, userId = userA): StoredSession => ({ token: token(letter), expiresAt: '2030-10-01T08:30:00.000Z', userId });
const stored = (value: StoredSession) => JSON.stringify(value);
/** What a platform error might say. None of it may escape the store. */
const platformDetail = `Keychain item ${token('p')} failed: errSecInteractionNotAllowed`;

/** Lets every pending promise callback run. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

type Call = { kind: 'get' | 'set' | 'delete'; key: StorageKey; value?: string; resolve(value?: string | null): void; reject(error: Error): void };

/** Device storage whose calls complete only when the test says so, one at a time, in the order they were made. It
 *  records the most calls ever outstanding at once, which must stay at one. */
class Device implements SessionStorage {
	readonly data = new Map<string, string>();
	readonly log: string[] = [];
	#pending: Call[] = [];
	mostAtOnce = 0;
	getItem(key: StorageKey) { return this.#call('get', key) as Promise<string | null>; }
	setItem(key: StorageKey, value: string) { return this.#call('set', key, value) as Promise<void>; }
	deleteItem(key: StorageKey) { return this.#call('delete', key) as Promise<void>; }
	get waiting() { return this.#pending.map((call) => `${call.kind} ${call.key}`); }
	#call(kind: Call['kind'], key: StorageKey, value?: string) {
		return new Promise<unknown>((resolve, reject) => {
			this.#pending.push({ kind, key, value, resolve, reject });
			this.log.push(`${kind} ${key}`);
			this.mostAtOnce = Math.max(this.mostAtOnce, this.#pending.length);
		});
	}
	async #next(expected: string) {
		await drain();
		const call = this.#pending.shift();
		assert.ok(call, `expected a storage call: ${expected}`);
		assert.equal(`${call.kind} ${call.key}`, expected);
		return call;
	}
	/** Completes the oldest call, which must be `expected`, and applies it. */
	async complete(expected: string) {
		const call = await this.#next(expected);
		if (call.kind === 'get') call.resolve(this.data.get(call.key) ?? null);
		else { if (call.kind === 'set') this.data.set(call.key, call.value!); else this.data.delete(call.key); call.resolve(); }
		await drain();
	}
	/** Fails the oldest call, which must be `expected`, changing nothing. */
	async fail(expected: string, error: unknown = new Error(platformDetail)) {
		(await this.#next(expected)).reject(error as Error);
		await drain();
	}
	/** Completes calls as they arrive until none are left. */
	async run() {
		for (;;) { await drain(); const next = this.waiting[0]; if (!next) return; await this.complete(next); }
	}
}

function setup() {
	const device = new Device();
	let generation: Generation = { account: 1, organisation: 1 };
	const store = createCredentialStore(device, () => generation);
	return {
		device, store,
		generation: () => generation,
		advance(part: keyof Generation) { generation = { ...generation, [part]: generation[part] + 1 }; }
	};
}

/** Tracks whether a promise has settled, without awaiting it. */
function watch<T>(promise: Promise<T>) {
	const state: { done: boolean; value?: T; error?: unknown } = { done: false };
	promise.then((value) => { state.done = true; state.value = value; }, (error: unknown) => { state.done = true; state.error = error; });
	return state;
}

const assertFixed = (error: unknown, kind: typeof StorageUnreadable | typeof StorageUnwritable) => {
	assert.ok(error instanceof kind);
	assert.equal((error as Error).cause, undefined);
	for (const text of [(error as Error).message, String((error as Error).stack), JSON.stringify(error)])
		assert.ok(!text.includes('sess_') && !text.includes('Keychain') && !text.includes(userA), text);
};

test('reads what was installed, and null when nothing is stored', async () => {
	const { device, store, generation } = setup();
	const first = store.read(); await device.complete('get session'); assert.equal(await first, null);
	const install = store.install(session('a'), generation()); await device.complete('set session');
	assert.equal(await install, 'written');
	assert.deepEqual(JSON.parse(device.data.get('session')!), session('a'));
	const again = store.read(); await device.complete('get session'); assert.deepEqual(await again, session('a'));
});

test('operations run strictly one at a time, first in, first out, each starting only when the one before has finished', async () => {
	const { device, store, generation } = setup();
	device.data.set('session', stored(session('a')));
	const results = [
		watch(store.read()), watch(store.install(session('b'), generation())), watch(store.removeIf(token('a'))),
		watch(store.setOrg(userA, orgA, generation())), watch(store.readOrg(userA)), watch(store.forgetOrgIf(userA, orgB))
	];
	await drain();
	assert.deepEqual(device.waiting, ['get session'], 'only the first operation has touched storage');
	await device.complete('get session'); assert.ok(results[0]!.done); assert.ok(!results[1]!.done);
	assert.deepEqual(device.waiting, ['set session']);
	await device.complete('set session');
	await device.complete('get session'); // removeIf(a) compares: b is stored now
	await device.complete(`set org.${userA}`);
	await device.complete(`get org.${userA}`);
	await device.complete(`get org.${userA}`); // forgetOrgIf(orgB) compares: orgA is stored
	assert.deepEqual(results.map((r) => r.value), [session('a'), 'written', 'newer-kept', 'written', orgA, 'other-kept']);
	assert.equal(device.mostAtOnce, 1);
	assert.deepEqual(device.log, ['get session', 'set session', 'get session', `set org.${userA}`, `get org.${userA}`, `get org.${userA}`]);
});

test('install checks the account generation when it runs, not when it was queued: a stale sign-in writes nothing', async () => {
	const { device, store, generation, advance } = setup();
	const before = store.read();
	const install = watch(store.install(session('a'), generation()));
	advance('account'); // signed out (or another sign-in began) while the install waited
	await device.complete('get session'); await before; await drain();
	assert.equal(install.value, 'stale');
	assert.deepEqual(device.waiting, []);
	assert.equal(device.data.has('session'), false);
});

test('an organisation change alone never makes a valid sign-in stale', async () => {
	const { device, store, generation, advance } = setup();
	const install = store.install(session('a'), generation());
	advance('organisation');
	await device.complete('set session');
	assert.equal(await install, 'written');
});

test('setOrg is stale after either an account or an organisation change, and then writes nothing', async () => {
	for (const part of ['account', 'organisation'] as const) {
		const { device, store, generation, advance } = setup();
		const choice = store.setOrg(userA, orgA, generation());
		advance(part);
		await drain();
		assert.equal(await choice, 'stale', part);
		assert.deepEqual(device.log, [], part);
	}
	const { device, store, generation } = setup();
	const choice = store.setOrg(userA, orgA, generation()); await device.complete(`set org.${userA}`);
	assert.equal(await choice, 'written');
	assert.equal(device.data.get(`org.${userA}`), orgA);
});

test('a slow removal for an old session never erases a newer one', async () => {
	const { device, store, generation } = setup();
	device.data.set('session', stored(session('a')));
	// The old session's removal is queued after the newer install: the comparison keeps the newer session.
	const install = store.install(session('b'), generation());
	const removal = store.removeIf(token('a'));
	await device.run();
	assert.equal(await install, 'written');
	assert.equal(await removal, 'newer-kept');
	assert.deepEqual(JSON.parse(device.data.get('session')!), session('b'));
	assert.ok(!device.log.includes('delete session'));
});

test('removeIf deletes the matching session, and answers absent when nothing is stored', async () => {
	const { device, store } = setup();
	device.data.set('session', stored(session('a')));
	const removal = store.removeIf(token('a'));
	await device.complete('get session'); await device.complete('delete session');
	assert.equal(await removal, 'deleted');
	assert.equal(device.data.has('session'), false);
	const again = store.removeIf(token('a')); await device.complete('get session');
	assert.equal(await again, 'absent');
});

test('a removal that cannot read or cannot delete throws, so the copy is never reported gone', async () => {
	const { device, store } = setup();
	device.data.set('session', stored(session('a')));
	const unread = watch(store.removeIf(token('a')));
	await device.fail('get session');
	assertFixed(unread.error, StorageUnreadable);
	const undeleted = watch(store.removeIf(token('a')));
	await device.complete('get session'); await device.fail('delete session');
	assertFixed(undeleted.error, StorageUnwritable);
	assert.ok(device.data.has('session'), 'the copy remains');
});

test('an unreadable stored value fails closed: never parsed, compared as absent, repaired or deleted, until a new save replaces it', async () => {
	for (const raw of ['{', '{"token":"sess_x"}', stored({ ...session('a'), userId: userA.toUpperCase() }), stored({ ...session('a'), expiresAt: '2030-10-01T08:30:00Z' }), JSON.stringify({ ...session('a'), note: 1 })]) {
		const { device, store, generation } = setup();
		device.data.set('session', raw);
		const read = watch(store.read()); await device.complete('get session');
		assertFixed(read.error, StorageUnreadable);
		const removal = watch(store.removeIf(token('a'))); await device.complete('get session');
		assertFixed(removal.error, StorageUnreadable);
		assert.equal(device.data.get('session'), raw, 'left exactly as it was');
		assert.ok(!device.log.includes('delete session'));
		const install = store.install(session('b'), generation()); await device.complete('set session');
		assert.equal(await install, 'written');
		const after = store.read(); await device.complete('get session');
		assert.deepEqual(await after, session('b'));
	}
	// A non-string from the platform is unreadable too.
	const { device, store } = setup();
	const read = watch(store.read());
	await drain(); device.data.set('session', 42 as unknown as string);
	await device.complete('get session');
	assertFixed(read.error, StorageUnreadable);
});

test('organisation choices: read, compare-and-delete, keep another choice, and fail closed when unreadable', async () => {
	const { device, store } = setup();
	const none = store.readOrg(userA); await device.complete(`get org.${userA}`); assert.equal(await none, null);
	device.data.set(`org.${userA}`, orgA); device.data.set(`org.${userB}`, orgB);
	const other = store.forgetOrgIf(userA, orgB); await device.complete(`get org.${userA}`);
	assert.equal(await other, 'other-kept');
	const forget = store.forgetOrgIf(userA, orgA);
	await device.complete(`get org.${userA}`); await device.complete(`delete org.${userA}`);
	assert.equal(await forget, 'deleted');
	assert.equal(device.data.get(`org.${userB}`), orgB, 'another person\'s choice is a different key');
	const absent = store.forgetOrgIf(userA, orgA); await device.complete(`get org.${userA}`);
	assert.equal(await absent, 'absent');
	device.data.set(`org.${userA}`, orgA.toUpperCase());
	const unreadable = watch(store.readOrg(userA)); await device.complete(`get org.${userA}`);
	assertFixed(unreadable.error, StorageUnreadable);
	const unforgotten = watch(store.forgetOrgIf(userA, orgA)); await device.complete(`get org.${userA}`);
	assertFixed(unforgotten.error, StorageUnreadable);
	assert.equal(device.data.get(`org.${userA}`), orgA.toUpperCase());
	device.data.set(`org.${userA}`, orgA);
	const failed = watch(store.forgetOrgIf(userA, orgA));
	await device.complete(`get org.${userA}`); await device.fail(`delete org.${userA}`);
	assertFixed(failed.error, StorageUnwritable);
	assert.equal(device.data.get(`org.${userA}`), orgA);
});

test('a failure rejects only its own operation; the ones queued behind it still run', async () => {
	const { device, store, generation } = setup();
	const failedWrite = watch(store.install(session('a'), generation()));
	const failedRead = watch(store.readOrg(userA));
	const next = watch(store.install(session('b'), generation()));
	await device.fail('set session', 'not even an Error');
	await device.fail(`get org.${userA}`);
	await device.complete('set session');
	assertFixed(failedWrite.error, StorageUnwritable);
	assertFixed(failedRead.error, StorageUnreadable);
	assert.equal(next.value, 'written');
	assert.deepEqual(JSON.parse(device.data.get('session')!), session('b'));
});

test('a storage call that throws synchronously is contained like any other failure', async () => {
	const device: SessionStorage = {
		getItem() { throw new Error(platformDetail); }, setItem() { throw new Error(platformDetail); }, deleteItem() { throw new Error(platformDetail); }
	};
	const store = createCredentialStore(device, () => ({ account: 1, organisation: 1 }));
	await assert.rejects(store.read(), (error) => { assertFixed(error, StorageUnreadable); return true; });
	await assert.rejects(store.install(session('a'), { account: 1, organisation: 1 }), (error) => { assertFixed(error, StorageUnwritable); return true; });
	assert.equal(await store.settled(0), 'settled');
});

test('settled waits for exactly the operations queued before the call', async () => {
	const { device, store, generation } = setup();
	assert.equal(await store.settled(0), 'settled', 'nothing queued');
	const early = store.install(session('a'), generation());
	const done = watch(store.settled(60_000));
	const late = watch(store.read());
	await drain(); assert.ok(!done.done);
	await device.complete('set session'); await early; await drain();
	assert.equal(done.value, 'settled', 'the later read is not waited for');
	assert.ok(!late.done);
	await device.complete('get session');
	assert.deepEqual(late.value, session('a'));
	// A failed operation counts as finished.
	const failing = watch(store.read()); const afterFailure = watch(store.settled(60_000));
	await device.fail('get session'); await drain();
	assertFixed(failing.error, StorageUnreadable);
	assert.equal(afterFailure.value, 'settled');
});

test('a hung operation times settled out without cancelling it or letting anything overtake it', async () => {
	const { device, store, generation } = setup();
	const hung = watch(store.install(session('a'), generation()));
	assert.equal(await store.settled(5), 'timed-out');
	assert.ok(!hung.done, 'the write is still running');
	const behind = watch(store.install(session('b'), generation()));
	await drain();
	assert.deepEqual(device.waiting, ['set session'], 'nothing overtakes the hung write');
	await device.complete('set session'); await device.complete('set session');
	assert.equal(hung.value, 'written'); assert.equal(behind.value, 'written');
	assert.deepEqual(JSON.parse(device.data.get('session')!), session('b'));
	assert.equal(await store.settled(0), 'settled');
});

test('invalid arguments are refused before anything is queued, without repeating the value', async () => {
	const { device, store, generation } = setup();
	const secretLike = `${token('z')}!`;
	const refusals: [string, () => Promise<unknown>][] = [
		['install token', () => store.install({ ...session('a'), token: secretLike }, generation())],
		['install extra field', () => store.install({ ...session('a'), note: 'x' } as StoredSession, generation())],
		['install generation', () => store.install(session('a'), { account: Number.NaN, organisation: 1 })],
		['removeIf', () => store.removeIf(secretLike)],
		['readOrg', () => store.readOrg(userA.toUpperCase())],
		['setOrg user', () => store.setOrg('..', orgA, generation())],
		['setOrg organisation', () => store.setOrg(userA, `${orgA}/x`, generation())],
		['setOrg generation', () => store.setOrg(userA, orgA, { account: 1 } as Generation)],
		['forgetOrgIf', () => store.forgetOrgIf(userA, '')]
	];
	for (const [label, run] of refusals)
		await assert.rejects(run(), (error: unknown) => {
			assert.ok(error instanceof TypeError, label);
			assert.ok(!error.message.includes('sess_') && !error.message.includes(userA.toUpperCase()), label);
			return true;
		}, label);
	for (const timeout of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])
		await assert.rejects(store.settled(timeout), RangeError, String(timeout));
	await drain();
	assert.deepEqual(device.log, []);
	assert.equal(await store.settled(0), 'settled');
});
