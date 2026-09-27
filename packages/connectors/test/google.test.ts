import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleConnector } from '../src/google.ts';

test('revocation posts only the token to Google’s revocation endpoint, with a timeout', async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const google = new GoogleConnector('client', 'secret', 'https://api.test/connections/google/callback', async (url, init) => {
		calls.push({ url: String(url), init: init! }); return new Response(null, { status: 200 });
	});
	await google.revoke('refresh');
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, 'https://oauth2.googleapis.com/revoke');
	assert.equal(calls[0]!.init.method, 'POST');
	assert.deepEqual([...new URLSearchParams(calls[0]!.init.body as URLSearchParams)], [['token', 'refresh']]);
	assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

test('a refused or unreachable revocation fails without exposing provider bodies, tokens or network errors', async () => {
	const clean = (error: unknown) => error instanceof Error && error.message === 'google_failed' && !/sensitive|secret-token/.test(JSON.stringify(error) + String(error));
	const refused = new GoogleConnector('c', 's', 'https://api.test/cb', async () => Response.json({ error: 'invalid_token', error_description: 'sensitive' }, { status: 400 }));
	await assert.rejects(refused.revoke('secret-token'), clean);
	const unreachable = new GoogleConnector('c', 's', 'https://api.test/cb', async () => { throw new Error('sensitive secret-token'); });
	await assert.rejects(unreachable.revoke('secret-token'), clean);
});
