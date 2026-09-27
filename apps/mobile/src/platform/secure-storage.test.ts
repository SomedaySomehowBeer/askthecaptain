import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StorageUnwritable } from '../account/contracts.ts';
import { createCredentialStore } from '../account/store.ts';
import { DeleteNotConfirmed, openSecureStorage, type SecureStoreModule } from './secure-storage.ts';

const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 5; // any number: the adapter passes the module's own constant through
type Call = { op: 'get' | 'set' | 'delete' | 'available'; key?: string; value?: string; options?: unknown };

/** A fake expo-secure-store over a Map, recording every call and its options. `silentDelete` models iOS ignoring a
 *  failed SecItemDelete; `lockedAfterDelete` models the device locking between the delete and the read-back. */
function fakeStore(behaviour: { available?: boolean | Error; silentDelete?: boolean; lockedAfterDelete?: boolean; deleteThrows?: boolean } = {}) {
	const data = new Map<string, string>(); const calls: Call[] = []; let locked = false;
	const store: SecureStoreModule = {
		WHEN_UNLOCKED_THIS_DEVICE_ONLY,
		async isAvailableAsync() { calls.push({ op: 'available' }); if (behaviour.available instanceof Error) throw behaviour.available; return behaviour.available ?? true; },
		async getItemAsync(key, options) { calls.push({ op: 'get', key, options }); if (locked) throw new Error('errSecInteractionNotAllowed'); return data.get(key) ?? null; },
		async setItemAsync(key, value, options) { calls.push({ op: 'set', key, value, options }); data.set(key, value); },
		async deleteItemAsync(key, options) {
			calls.push({ op: 'delete', key, options });
			if (behaviour.deleteThrows) throw new Error('Could not delete the item from SecureStore');
			if (!behaviour.silentDelete) data.delete(key);
			if (behaviour.lockedAfterDelete) locked = true;
		}
	};
	return { store, data, calls };
}
const token = `sess_${'t'.repeat(43)}`;
const session = { token, expiresAt: '2030-10-01T08:30:00.000Z', userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };

test('storage is native only: web and other platforms are refused before the module is touched', async () => {
	for (const os of ['web', 'windows', 'macos', '']) {
		const { store, calls } = fakeStore();
		assert.deepEqual(await openSecureStorage(os, store), { available: false }, os);
		assert.deepEqual(calls, [], `${os}: no call at all`);
	}
});

test('a module that reports itself unavailable, fails that check, or lacks the accessibility constant is refused', async () => {
	assert.deepEqual(await openSecureStorage('ios', fakeStore({ available: false }).store), { available: false });
	assert.deepEqual(await openSecureStorage('android', fakeStore({ available: new Error('native module missing') }).store), { available: false });
	const { store, calls } = fakeStore();
	assert.deepEqual(await openSecureStorage('ios', { ...store, WHEN_UNLOCKED_THIS_DEVICE_ONLY: undefined as unknown as number }), { available: false });
	assert.deepEqual(calls, [], 'refused before the availability check');
	const opened = await openSecureStorage('android', fakeStore().store);
	assert.equal(opened.available, true);
});

test('every call passes the same options: WHEN_UNLOCKED_THIS_DEVICE_ONLY, the default service, no authentication prompt', async () => {
	const { store, calls } = fakeStore();
	const opened = await openSecureStorage('ios', store);
	assert.ok(opened.available);
	await opened.storage.setItem('session', 'v'); await opened.storage.getItem('session'); await opened.storage.deleteItem('session');
	await opened.storage.setItem(`org.${session.userId}`, 'o');
	const withOptions = calls.filter((c) => c.op !== 'available');
	assert.deepEqual(withOptions.map((c) => c.op), ['set', 'get', 'delete', 'get', 'set']);
	for (const call of withOptions) assert.deepEqual(call.options, { keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
	assert.ok(withOptions.every((c) => c.options === withOptions[0]!.options), 'one frozen options object for every call');
	assert.ok(Object.isFrozen(withOptions[0]!.options));
});

test('strings pass through exactly, and null means no usable value was returned', async () => {
	const { store, data } = fakeStore();
	const opened = await openSecureStorage('android', store);
	assert.ok(opened.available);
	assert.equal(await opened.storage.getItem('session'), null);
	await opened.storage.setItem('session', ' exactly as written \n');
	assert.equal(data.get('session'), ' exactly as written \n');
	assert.equal(await opened.storage.getItem('session'), ' exactly as written \n');
});

test('a delete is confirmed by reading back: a silent iOS failure or a lock before the read-back is not a deletion', async () => {
	const confirmed = fakeStore();
	const ok = await openSecureStorage('ios', confirmed.store); assert.ok(ok.available);
	confirmed.data.set('session', 'v');
	await ok.storage.deleteItem('session');
	assert.equal(confirmed.data.has('session'), false);
	assert.deepEqual(confirmed.calls.filter((c) => c.op !== 'available').map((c) => c.op), ['delete', 'get']);

	const silent = fakeStore({ silentDelete: true });
	const s = await openSecureStorage('ios', silent.store); assert.ok(s.available);
	silent.data.set('session', 'v');
	await assert.rejects(s.storage.deleteItem('session'), DeleteNotConfirmed);

	const locked = fakeStore({ lockedAfterDelete: true });
	const l = await openSecureStorage('ios', locked.store); assert.ok(l.available);
	locked.data.set('session', 'v');
	await assert.rejects(l.storage.deleteItem('session'), /errSecInteractionNotAllowed/);

	const failing = fakeStore({ deleteThrows: true });
	const f = await openSecureStorage('android', failing.store); assert.ok(f.available);
	await assert.rejects(f.storage.deleteItem('session'));
	assert.deepEqual(failing.calls.filter((c) => c.op !== 'available').map((c) => c.op), ['delete'], 'no read-back after a delete that threw');
});

test('with the credential store: an unconfirmed delete is reported as StorageUnwritable, never as deleted', async () => {
	const failures: { silentDelete?: boolean; lockedAfterDelete?: boolean; deleteThrows?: boolean }[] = [{ silentDelete: true }, { lockedAfterDelete: true }, { deleteThrows: true }];
	for (const behaviour of failures) {
		const { store, data } = fakeStore(behaviour);
		const opened = await openSecureStorage('ios', store); assert.ok(opened.available);
		const credentials = createCredentialStore(opened.storage, () => ({ account: 1, organisation: 1 }));
		assert.equal(await credentials.install(session, { account: 1, organisation: 1 }), 'written');
		await assert.rejects(credentials.removeIf(token), StorageUnwritable, JSON.stringify(behaviour));
		if (!behaviour.deleteThrows && behaviour.silentDelete) assert.ok(data.has('session'), 'the copy really remains');
	}
	const { store, data } = fakeStore();
	const opened = await openSecureStorage('android', store); assert.ok(opened.available);
	const credentials = createCredentialStore(opened.storage, () => ({ account: 1, organisation: 1 }));
	await credentials.install(session, { account: 1, organisation: 1 });
	assert.equal(await credentials.removeIf(token), 'deleted');
	assert.equal(data.has('session'), false);
});
