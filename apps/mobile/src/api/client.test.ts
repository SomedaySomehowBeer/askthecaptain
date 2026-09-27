import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiOrigin, createApiClient, createTransport, type Fetch } from './client.ts';
import { apiOutcome, errorCode, exchangeOutcome } from './failure.ts';
import { apiPaths, organisationPath } from './paths.ts';

const origin = 'https://api.example.test';
const token = `sess_${'t'.repeat(43)}`;

type Call = { url: string; init: Parameters<Fetch>[1] };
type Reply = { status?: number; body?: string; redirected?: boolean; url?: string; headers?: Record<string, string>; throws?: boolean; hang?: boolean; bodyThrows?: boolean };
/** A fetch that records every call and answers as told. `read` counts body reads. */
function fakeFetch(reply: Reply | ((call: Call) => Reply)) {
	const calls: Call[] = []; const counts = { read: 0 };
	const fetch: Fetch = async (url, init) => {
		calls.push({ url, init });
		const r = typeof reply === 'function' ? reply({ url, init }) : reply;
		if (r.throws) throw new TypeError('Network request failed');
		if (r.hang) return new Promise(() => undefined);
		return {
			status: r.status ?? 200, redirected: r.redirected ?? false, url: r.url ?? url,
			headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
			text: async () => { counts.read += 1; if (r.bodyThrows) throw new Error('body lost'); return r.body ?? ''; }
		};
	};
	return { fetch, calls, counts };
}
const json = (value: unknown) => JSON.stringify(value);
const identity = <T>(value: unknown) => value as T;

test('the API origin: https, or loopback http in development only; canonical, with nothing after the host', () => {
	for (const [value, dev, expected] of [
		['https://api.example.test', false, 'https://api.example.test'], ['https://api.example.test/', false, 'https://api.example.test'],
		['https://api.example.test:8443', false, 'https://api.example.test:8443'], ['http://localhost:8787', true, 'http://localhost:8787'],
		['http://127.0.0.1:8787/', true, 'http://127.0.0.1:8787'], ['http://[::1]:8787', true, 'http://[::1]:8787']
	] as const) assert.equal(apiOrigin(value, dev), expected, value);
	for (const [value, dev] of [
		['http://api.example.test', true], ['http://localhost:8787', false], ['http://10.0.2.2:8787', true], ['HTTPS://api.example.test', false],
		['https://API.example.test', false], ['https://api.example.test/v1', false], ['https://api.example.test?x=1', false], ['https://api.example.test#x', false],
		['https://user:pass@api.example.test', false], ['https://api.example.test:443', false], ['http://localhost:80', true], ['https://api.example.test:0', false],
		['https://api.example.test:08443', false], ['https://api.example.test:70000', false], ['https://.example.test', false], ['https://api..test', false],
		['https://api.example.test.', false], ['//api.example.test', false], ['ftp://api.example.test', false], ['', false], [undefined, false], ['https://api.example.test ', false]
	] as const) assert.throws(() => apiOrigin(value, dev), (error: unknown) => error instanceof TypeError && (value === undefined || value === '' || !error.message.includes(value)), String(value));
});

test('every request goes to origin plus path, with redirect: error, the bearer only when given, and JSON only when there is a body', async () => {
	const { fetch, calls } = fakeFetch({ body: json({ ok: true }) });
	const transport = createTransport({ origin, fetch });
	await transport.request('GET', apiPaths.me, token);
	await transport.request('POST', apiPaths.nativeExchange, null, { a: 1 });
	await transport.request('POST', apiPaths.signOut, token);
	await transport.request('GET', organisationPath('3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'a/b'), token);
	assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
		['GET', `${origin}/v1/me`], ['POST', `${origin}/auth/native/exchange`], ['POST', `${origin}/auth/sign-out`],
		['GET', `${origin}/v1/organisations/3f2504e0-4f89-41d3-9a0c-0305e82c3301/a%2Fb`]
	]);
	for (const call of calls) assert.equal(call.init.redirect, 'error');
	assert.equal(calls[0]!.init.headers.authorization, `Bearer ${token}`); assert.equal(calls[0]!.init.body, undefined); assert.equal(calls[0]!.init.headers['content-type'], undefined);
	assert.equal(calls[1]!.init.headers.authorization, undefined); assert.equal(calls[1]!.init.body, '{"a":1}'); assert.equal(calls[1]!.init.headers['content-type'], 'application/json');
	assert.equal(calls[2]!.init.body, undefined);
});

test('a malformed token is never sent: the transport throws before fetch, the client answers unauthorised', async () => {
	const { fetch, calls } = fakeFetch({ body: json({}) });
	const transport = createTransport({ origin, fetch }); const client = createApiClient(transport);
	for (const bad of ['', 'sess_', `Bearer ${token}`, `${token}\r\nx-evil: 1`, `pks_${'t'.repeat(43)}`, `sess_${'t'.repeat(10)}`]) {
		await assert.rejects(transport.request('GET', apiPaths.me, bad), (error: unknown) => error instanceof TypeError && !error.message.includes(bad || '\u0000'));
		assert.deepEqual(await client.get(apiPaths.me, bad, identity), { ok: false, kind: 'unauthorised' });
	}
	assert.equal(calls.length, 0);
	await assert.rejects(client.post(apiPaths.nativeExchange, null, {}, identity), TypeError, 'the exchange is the attempt core’s alone');
	assert.equal(calls.length, 0);
});

test('a redirected, 3xx or foreign-URL response is no answer, and its body is never read', async () => {
	for (const reply of [{ redirected: true }, { url: 'https://evil.test/v1/me' }, { url: `${origin}/v1/me/` }, { url: '' }, { status: 302 }, { status: 307, headers: { location: 'https://evil.test' } }] as Reply[]) {
		const { fetch, counts } = fakeFetch({ body: json({ user: 'x' }), ...reply });
		assert.deepEqual(await createTransport({ origin, fetch }).request('GET', apiPaths.me, token), { kind: 'no-answer', reason: 'redirect' }, JSON.stringify(reply));
		assert.equal(counts.read, 0, JSON.stringify(reply));
	}
});

test('network failure and timeout are no answer; the timeout aborts the request, including a hung body read', async () => {
	assert.deepEqual(await createTransport({ origin, fetch: fakeFetch({ throws: true }).fetch }).request('GET', apiPaths.me, token), { kind: 'no-answer', reason: 'network' });
	const hung = fakeFetch({ hang: true });
	assert.deepEqual(await createTransport({ origin, fetch: hung.fetch, timeoutMs: 20 }).request('GET', apiPaths.me, token), { kind: 'no-answer', reason: 'timeout' });
	assert.equal(hung.calls[0]!.init.signal.aborted, true);
	const slowBody: Fetch = async (url) => ({ status: 200, redirected: false, url, headers: { get: () => null }, text: () => new Promise<string>(() => undefined) });
	assert.deepEqual(await createTransport({ origin, fetch: slowBody, timeoutMs: 20 }).request('GET', apiPaths.me, token), { kind: 'answered', status: 200, body: { readable: false } });
	assert.deepEqual(await createTransport({ origin, fetch: fakeFetch({ bodyThrows: true }).fetch }).request('GET', apiPaths.me, token), { kind: 'answered', status: 200, body: { readable: false } });
});

test('ApiOutcome: ok only for a 2xx that parses; confirmed 401; 429/5xx/no answer unavailable; other 4xx refused by code', () => {
	const answered = (status: number, value?: unknown, retryAfter?: number) => ({ kind: 'answered' as const, status, ...(retryAfter === undefined ? {} : { retryAfter }), body: value === undefined ? { readable: false as const } : { readable: true as const, value } });
	const strict = (value: unknown) => { if (typeof value !== 'object' || value === null || !('user' in value)) throw new TypeError('shape'); return value; };
	assert.deepEqual(apiOutcome(answered(200, { user: 1 }), strict), { ok: true, value: { user: 1 } });
	assert.deepEqual(apiOutcome(answered(200, { other: 1 }), strict), { ok: false, kind: 'unavailable', status: 200 });
	assert.deepEqual(apiOutcome(answered(200), strict), { ok: false, kind: 'unavailable', status: 200 });
	assert.deepEqual(apiOutcome(answered(401, { code: 'unauthorised' }), strict), { ok: false, kind: 'unauthorised' });
	assert.deepEqual(apiOutcome(answered(401), strict), { ok: false, kind: 'unauthorised' });
	assert.deepEqual(apiOutcome(answered(429, { code: 'rate_limited' }, 12), strict), { ok: false, kind: 'unavailable', status: 429, retryAfter: 12 });
	for (const status of [500, 502, 503, 504]) assert.deepEqual(apiOutcome(answered(status), strict), { ok: false, kind: 'unavailable', status });
	for (const status of [100, 199, 300, 600]) assert.deepEqual(apiOutcome(answered(status), strict), { ok: false, kind: 'unavailable', status });
	for (const reason of ['network', 'timeout', 'redirect'] as const) assert.deepEqual(apiOutcome({ kind: 'no-answer', reason }, strict), { ok: false, kind: 'unavailable', status: 0 });
	assert.deepEqual(apiOutcome(answered(403, { ok: false, code: 'forbidden', error: 'no' }), strict), { ok: false, kind: 'refused', status: 403, code: 'forbidden' });
	assert.deepEqual(apiOutcome(answered(404), strict), { ok: false, kind: 'refused', status: 404, code: 'unknown' });
	assert.deepEqual(apiOutcome(answered(400, { code: 'Not A Code' }), strict), { ok: false, kind: 'refused', status: 400, code: 'unknown' });
	assert.equal(errorCode({ readable: true, value: ['code'] }), null);
});

test('the client wires the transport to the mapping, and retry-after is read only as whole seconds', async () => {
	const client = createApiClient(createTransport({ origin, fetch: fakeFetch(({ url }) => url.endsWith('/v1/me') ? { status: 429, headers: { 'retry-after': ' 7 ' }, body: json({ code: 'rate_limited' }) } : { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2030 07:28:00 GMT' } }).fetch }));
	assert.deepEqual(await client.get(apiPaths.me, token, identity), { ok: false, kind: 'unavailable', status: 429, retryAfter: 7 });
	assert.deepEqual(await client.post(apiPaths.signOut, token, undefined, identity), { ok: false, kind: 'unavailable', status: 503 });
});

test('exchange mapping (root review): every status has an outcome, and only a strictly parsed 2xx signs in', () => {
	const answered = (status: number, value?: unknown) => ({ kind: 'answered' as const, status, body: value === undefined ? { readable: false as const } : { readable: true as const, value } });
	const parse = (value: unknown) => { if (typeof value !== 'object' || value === null || !('token' in value)) throw new TypeError('shape'); return value as never; };
	assert.equal(exchangeOutcome(answered(200, { token: 'x' }), parse).kind, 'signed-in');
	assert.deepEqual(exchangeOutcome(answered(200, { other: 1 }), parse), { kind: 'uncertain' });
	assert.deepEqual(exchangeOutcome(answered(200), parse), { kind: 'uncertain' });
	assert.deepEqual(exchangeOutcome(answered(401, { code: 'native_sign_in_disabled' }), parse), { kind: 'native-disabled' });
	for (const code of ['unauthorised', 'native_sign_in_unavailable', undefined]) assert.deepEqual(exchangeOutcome(answered(401, code && { code }), parse), { kind: 'cannot-finish' }, String(code));
	for (const status of [400, 403, 404, 409, 413, 422]) assert.deepEqual(exchangeOutcome(answered(status, { code: 'native_request_invalid' }), parse), { kind: 'cannot-finish' }, String(status));
	for (const status of [429, 500, 502, 503]) assert.deepEqual(exchangeOutcome(answered(status), parse), { kind: 'start-again', status });
	for (const status of [101, 304, 600]) assert.deepEqual(exchangeOutcome(answered(status), parse), { kind: 'uncertain' });
	for (const reason of ['network', 'timeout', 'redirect'] as const) assert.deepEqual(exchangeOutcome({ kind: 'no-answer', reason }, parse), { kind: 'uncertain' });
});
