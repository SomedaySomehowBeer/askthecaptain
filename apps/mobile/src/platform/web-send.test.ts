import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransport } from '../api/client.ts';
import { apiPaths } from '../api/paths.ts';
import { createWebSend, type UnderlyingWebFetch } from './web-send.ts';

const origin = 'https://captain.example.test';

function recording() {
	const calls: { url: string; init: Parameters<UnderlyingWebFetch>[1] }[] = [];
	const underlying: UnderlyingWebFetch = async (url, init) => {
		calls.push({ url, init });
		return { status: 200, redirected: false, url, headers: { get: () => null }, body: null };
	};
	return { underlying, calls };
}

test('cookies are included, the web client header is set and redirects refused; a caller cannot loosen any of them', async () => {
	const { underlying, calls } = recording();
	const send = createWebSend(underlying);
	const signal = new AbortController().signal;
	await send(`${origin}/v1/me`, { method: 'GET', headers: { accept: 'application/json', 'x-captain-client': 'native', 'X-Captain-Client': 'other' }, redirect: 'follow' as 'error', credentials: 'omit', signal } as Parameters<typeof send>[1]);
	await send(`${origin}/auth/sign-out`, { method: 'POST', headers: { accept: 'application/json' }, body: '{}', redirect: 'error', signal });
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'include');
		assert.equal(call.init.headers['x-captain-client'], 'web');
	}
	assert.equal(calls[1]!.url, `${origin}/auth/sign-out`);
	assert.equal(calls[1]!.init.method, 'POST'); assert.equal(calls[1]!.init.body, '{}'); assert.equal(calls[1]!.init.signal, signal);
	assert.deepEqual(calls[1]!.init.headers, { accept: 'application/json', 'x-captain-client': 'web' });
});

test('never a bearer: an authorization header is dropped whatever its spelling, and nothing else is', async () => {
	const { underlying, calls } = recording();
	const send = createWebSend(underlying);
	const signal = new AbortController().signal;
	await send(`${origin}/v1/me`, { method: 'GET', headers: { Authorization: 'Bearer sess_x', authorization: 'Bearer sess_y', accept: 'application/json' }, redirect: 'error', signal });
	assert.deepEqual(calls[0]!.init.headers, { accept: 'application/json', 'x-captain-client': 'web' });
	assert.ok(!JSON.stringify(calls).includes('sess_'));
});

test('through the fixed-origin transport with no token: every request carries the cookie options and the header', async () => {
	const { underlying, calls } = recording();
	const transport = createTransport({ origin, send: createWebSend(underlying) });
	await transport.request('GET', apiPaths.me, null);
	await transport.request('POST', apiPaths.passkeyOptions, null, {});
	assert.deepEqual(calls.map((c) => [c.url, c.init.credentials, c.init.headers['x-captain-client'], 'authorization' in c.init.headers]), [
		[`${origin}/v1/me`, 'include', 'web', false], [`${origin}/auth/passkey/options`, 'include', 'web', false]
	]);
});

test('a refused redirect (the browser throws for redirect: error) is no answer, never a response', async () => {
	const refusing: UnderlyingWebFetch = async () => { throw new TypeError('Failed to fetch'); };
	const transport = createTransport({ origin, send: createWebSend(refusing) });
	assert.deepEqual(await transport.request('GET', apiPaths.me, null), { kind: 'no-answer', reason: 'network' });
});
