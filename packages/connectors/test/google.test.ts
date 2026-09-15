import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleConnector, googleScopes } from '../src/google.ts';

test('Google OAuth requests offline consent, incremental scopes and PKCE; typed profile verifies Gmail', async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetcher: typeof fetch = async (url, init) => {
		calls.push({ url: String(url), init: init! });
		return Response.json(String(url).includes('/profile') ? { emailAddress: 'Owner@Example.com' }
			: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer', scope: googleScopes.join(' ') });
	};
	const google = new GoogleConnector('client', 'secret', 'https://api.test/connections/google/callback', fetcher);
	const url = new URL(google.authorizationUrl({ state: 'state', codeChallenge: 'challenge' }));
	for (const [key, value] of Object.entries({ access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: 'state', code_challenge: 'challenge', code_challenge_method: 'S256', scope: googleScopes.join(' ') }))
		assert.equal(url.searchParams.get(key), value);
	assert.equal((await google.exchange({ code: 'code', codeVerifier: 'verifier' })).refreshToken, 'refresh');
	assert.equal(new URLSearchParams(calls[0]!.init.body as URLSearchParams).get('code_verifier'), 'verifier');
	assert.equal((await google.profile('access')).emailAddress, 'owner@example.com');
	assert.deepEqual(calls[1]!.init.headers, { authorization: 'Bearer access' });
	await google.refresh('refresh');
	assert.equal(new URLSearchParams(calls[2]!.init.body as URLSearchParams).get('grant_type'), 'refresh_token');
	await google.revoke('refresh'); assert.equal(calls[3]!.url, 'https://oauth2.googleapis.com/revoke');
	assert.equal(new URLSearchParams(calls[3]!.init.body as URLSearchParams).get('token'), 'refresh');
});
test('invalid responses and revoked grants fail without exposing provider bodies or network secrets', async () => {
	for (const data of [{ access_token: 'sensitive' }, { error: 'invalid_grant', error_description: 'sensitive' }]) {
		const google = new GoogleConnector('c', 's', 'https://api.test/cb', async () => Response.json(data, { status: 'error' in data ? 400 : 200 }));
		await assert.rejects(google.refresh('refresh'), { message: 'error' in data ? 'grant_revoked' : 'google_failed' });
	}
	const google = new GoogleConnector('c', 's', 'https://api.test/cb', async () => { throw new Error('sensitive'); });
	await assert.rejects(google.profile('access'), { message: 'google_failed' });
});
