import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, readConfig } from './config.ts';

test('the API origin uses the transport rule: https, or loopback http only in development; a refused value is null', () => {
	assert.deepEqual(readConfig({ api: 'https://api.askthecaptain.app' }, false), { apiOrigin: 'https://api.askthecaptain.app' });
	assert.deepEqual(readConfig({ api: 'https://api.example.test/' }, false), { apiOrigin: 'https://api.example.test' });
	assert.deepEqual(readConfig({ api: 'http://localhost:8787' }, true), { apiOrigin: 'http://localhost:8787' });
	assert.deepEqual(readConfig({ api: 'http://localhost:8787' }, false), { apiOrigin: null });
	for (const bad of [undefined, null, '', 7, 'api.askthecaptain.app', 'http://api.example.test', 'https://Api.example.test',
		'https://api.example.test/v1', 'https://api.example.test?x=1', 'https://api.example.test#x', 'https://user:pw@api.example.test',
		'https://api.example.test:443', 'javascript:alert(1)', 'https://evil.test\\@api.example.test', ' https://api.example.test']) {
		assert.deepEqual(readConfig({ api: bad }, true), { apiOrigin: null }, String(bad));
	}
	assert.ok(Object.isFrozen(readConfig({ api: undefined }, false)));
});

test('a refused value is never repeated: the result holds only null, and nothing throws', () => {
	const result = readConfig({ api: 'https://user:canary-config-value@api.example.test/path' }, true);
	assert.ok(!JSON.stringify(result).includes('canary-config-value'));
});

test('outside Metro there is no development allowance: the bound configuration is the production reading of the value', () => {
	assert.deepEqual(config, readConfig({ api: process.env.EXPO_PUBLIC_API_URL }, false));
});
