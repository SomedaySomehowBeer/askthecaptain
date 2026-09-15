import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { masterKey, newDataKey, open, seal } from './encryption.ts';

test('envelope encryption round trips; a different master cannot unwrap', () => {
	const master = masterKey(randomBytes(32).toString('base64'));
	const { key, wrapped } = newDataKey(master, 'org-a');
	assert.deepEqual(open(master, wrapped, 'org-a', 'data_key'), key);
	assert.throws(() => open(randomBytes(32), wrapped, 'org-a', 'data_key'));
	const encrypted = seal(key, Buffer.from('test-token'), 'org-a', 'access_token');
	assert.equal(open(key, encrypted, 'org-a', 'access_token').toString(), 'test-token');
	assert.throws(() => open(key, encrypted, 'org-b', 'access_token'));
	assert.throws(() => open(key, encrypted, 'org-a', 'refresh_token'));
	const tampered = Buffer.from(encrypted); tampered[29] = tampered[29]! ^ 1;
	assert.throws(() => open(key, tampered, 'org-a', 'access_token'));
	assert.notDeepEqual(seal(key, Buffer.from('test-token'), 'org-a', 'access_token'), encrypted);
	assert.throws(() => masterKey('invalid'));
});
