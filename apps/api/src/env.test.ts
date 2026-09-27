import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readEnv } from './env.ts';

const required = { DATABASE_URL: 'postgres://captain@localhost/captain', APP_URL: 'https://app.test', API_URL: 'https://api.test' };
/** Settings the retired mail, calendar and embedding code once read (#133). Staging may still hold some as secrets. */
const retired = { MAIL_SYNC_DISABLED: 'yes', CALENDAR_SYNC_DISABLED: 'yes', INDEX_DISABLED: 'yes', GMAIL_PUBSUB_TOPIC: 'not a topic',
	GMAIL_PUSH_AUDIENCE: 'not a url', EMBED_URL: 'not a url', EMBED_TOKEN: 'short' };

test('retired settings left in the environment, even malformed ones, neither block startup nor reach the configuration', () => {
	const env = readEnv({ ...required, ...retired });
	for (const key of Object.keys(retired)) assert.ok(!Object.keys(env).includes(key), key);
	assert.equal(env.DATABASE_URL, required.DATABASE_URL);
	assert.equal(env.WORKFLOWS_DISABLED, '0'); assert.equal(env.SERIES_DISABLED, '0'); assert.equal(env.PORT, 8080);
});

test('required settings and the retained checks still refuse an incomplete or invalid configuration', () => {
	for (const key of Object.keys(required)) {
		const { [key as keyof typeof required]: _, ...rest } = required;
		assert.throws(() => readEnv(rest), new RegExp(`configuration is incomplete: .*${key}`), key);
	}
	assert.throws(() => readEnv({ ...required, SHOPIFY_CLIENT_ID: 'id' }), /SHOPIFY_CLIENT_ID/);
	assert.equal(readEnv({ ...required, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }).SHOPIFY_CLIENT_ID, 'id');
	assert.throws(() => readEnv({ ...required, WORKFLOWS_DISABLED: 'yes' }), /WORKFLOWS_DISABLED/);
	assert.throws(() => readEnv({ ...required, APP_URL: 'not a url' }), /APP_URL/);
});

test('mobile sign-in is off unless NATIVE_SIGN_IN is exactly 1', () => {
	assert.equal(readEnv(required).NATIVE_SIGN_IN, '0');
	assert.equal(readEnv({ ...required, NATIVE_SIGN_IN: '0' }).NATIVE_SIGN_IN, '0');
	assert.equal(readEnv({ ...required, NATIVE_SIGN_IN: '1' }).NATIVE_SIGN_IN, '1');
	for (const value of ['yes', 'true', 'on', '']) assert.throws(() => readEnv({ ...required, NATIVE_SIGN_IN: value }), /NATIVE_SIGN_IN/, value);
});
