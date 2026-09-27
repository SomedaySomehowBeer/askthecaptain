import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransport } from '../api/client.ts';
import { apiPaths } from '../api/paths.ts';
import { createNativeSend, type UnderlyingFetch } from './native-send.ts';

const origin = 'https://api.example.test';
const token = `sess_${'t'.repeat(43)}`;

/** An underlying fetch that records what it was given and answers 200 at the requested URL, with no body. */
function recording() {
	const calls: { url: string; init: Parameters<UnderlyingFetch>[1] }[] = [];
	const underlying: UnderlyingFetch = async (url, init) => {
		calls.push({ url, init });
		return { status: 200, redirected: false, url, headers: { get: () => null }, body: null };
	};
	return { underlying, calls };
}

test('redirect: error and credentials: omit are always sent, and a caller cannot loosen them', async () => {
	const { underlying, calls } = recording();
	const send = createNativeSend(underlying);
	const signal = new AbortController().signal;
	// A caller that tries to follow redirects and include cookies (the casts stand for any future caller).
	await send(`${origin}/v1/me`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'follow' as 'error', credentials: 'include', signal } as Parameters<typeof send>[1]);
	await send(`${origin}/auth/sign-out`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}', redirect: 'error', signal });
	assert.equal(calls.length, 2);
	for (const call of calls) { assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit'); }
	// Everything else passes through unchanged: URL, method, headers, body and the abort signal.
	assert.equal(calls[1]!.url, `${origin}/auth/sign-out`);
	assert.equal(calls[1]!.init.method, 'POST'); assert.equal(calls[1]!.init.body, '{}');
	assert.deepEqual(calls[1]!.init.headers, { authorization: `Bearer ${token}` });
	assert.equal(calls[1]!.init.signal, signal);
});

test('through the fixed-origin transport: every request reaches the underlying fetch with both forced options', async () => {
	const { underlying, calls } = recording();
	const transport = createTransport({ origin, send: createNativeSend(underlying) });
	await transport.request('GET', apiPaths.me, token);
	await transport.request('POST', apiPaths.nativeExchange, null, { code: 'x' });
	assert.deepEqual(calls.map((c) => [c.url, c.init.redirect, c.init.credentials]), [
		[`${origin}/v1/me`, 'error', 'omit'], [`${origin}/auth/native/exchange`, 'error', 'omit']
	]);
});

test('a refused redirect from the native layer (it throws) is no answer, never a response', async () => {
	// expo/fetch rejects with "Redirect is not allowed when redirect mode is 'error'" (FetchRedirectException).
	const refusing: UnderlyingFetch = async () => { throw new Error("Redirect is not allowed when redirect mode is 'error'"); };
	const transport = createTransport({ origin, send: createNativeSend(refusing) });
	assert.deepEqual(await transport.request('GET', apiPaths.me, token), { kind: 'no-answer', reason: 'network' });
});
