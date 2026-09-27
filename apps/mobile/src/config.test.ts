import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, readConfig, webLink, webPaths } from './config.ts';

test('both origins use the transport rule: https, or loopback http only in development; a refused value is null', () => {
	assert.deepEqual(readConfig({ api: 'https://api.askthecaptain.app', app: 'https://app.askthecaptain.app' }, false),
		{ apiOrigin: 'https://api.askthecaptain.app', webOrigin: 'https://app.askthecaptain.app' });
	assert.deepEqual(readConfig({ api: 'https://api.example.test/', app: 'https://app.example.test:8443' }, false),
		{ apiOrigin: 'https://api.example.test', webOrigin: 'https://app.example.test:8443' });
	assert.deepEqual(readConfig({ api: 'http://localhost:8787', app: 'http://127.0.0.1:3000' }, true),
		{ apiOrigin: 'http://localhost:8787', webOrigin: 'http://127.0.0.1:3000' });
	assert.deepEqual(readConfig({ api: 'http://localhost:8787', app: 'http://127.0.0.1:3000' }, false), { apiOrigin: null, webOrigin: null });
	for (const bad of [undefined, null, '', 7, 'app.askthecaptain.app', 'http://app.example.test', 'https://App.example.test',
		'https://app.example.test/settings', 'https://app.example.test?x=1', 'https://app.example.test#x', 'https://user:pw@app.example.test',
		'https://app.example.test:443', 'javascript:alert(1)', 'https://evil.test\\@app.example.test', ' https://app.example.test']) {
		assert.deepEqual(readConfig({ api: bad, app: bad }, true), { apiOrigin: null, webOrigin: null }, String(bad));
	}
	assert.deepEqual(readConfig({ api: 'https://api.example.test', app: 'nope' }, false), { apiOrigin: 'https://api.example.test', webOrigin: null }, 'each is judged on its own');
	assert.ok(Object.isFrozen(readConfig({ api: undefined, app: undefined }, false)));
});

test('a refused value is never repeated: the result holds only null, and nothing throws', () => {
	const secretish = 'https://user:canary-config-value@app.example.test/path';
	const result = readConfig({ api: secretish, app: secretish }, true);
	assert.ok(!JSON.stringify(result).includes('canary-config-value'));
});

test('website links: the validated origin plus an allow-listed path only; hidden when the origin was refused', () => {
	assert.deepEqual([...webPaths], ['/', '/settings', '/work', '/work?owner=all', '/resources/inventory']);
	assert.equal(webLink('https://app.askthecaptain.app', '/resources/inventory'), 'https://app.askthecaptain.app/resources/inventory');
	assert.equal(webLink(null, '/resources/inventory'), null);
	for (const path of ['/resources', '/resources/inventory/', '/resources/inventory?x=1', '/resources/equipment'])
		assert.equal(webLink('https://app.askthecaptain.app', path as never), null, path);
	assert.equal(webLink('https://app.askthecaptain.app', '/'), 'https://app.askthecaptain.app/');
	assert.equal(webLink('https://app.askthecaptain.app', '/settings'), 'https://app.askthecaptain.app/settings');
	assert.equal(webLink(null, '/settings'), null);
	assert.equal(webLink('https://app.askthecaptain.app', '/work'), 'https://app.askthecaptain.app/work');
	assert.equal(webLink(null, '/work'), null);
	assert.equal(webLink('https://app.askthecaptain.app', '/work?owner=all'), 'https://app.askthecaptain.app/work?owner=all');
	assert.equal(webLink('https://app.askthecaptain.app', '/work?owner=other' as never), null);
	for (const path of ['/settings/passkeys', '//evil.test', 'https://evil.test', '/settings?x=1', '', '/auth/callback'])
		assert.equal(webLink('https://app.askthecaptain.app', path as never), null, path);
});

test('outside Metro there is no development allowance: the bound configuration is the production reading of the two values', () => {
	assert.deepEqual(config, readConfig({ api: process.env.EXPO_PUBLIC_API_URL, app: process.env.EXPO_PUBLIC_APP_URL }, false));
});
