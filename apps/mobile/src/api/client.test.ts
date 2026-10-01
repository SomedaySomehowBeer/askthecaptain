import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { apiOrigin, createApiClient, createTransport, maxResponseBytes, type Answer, type BodyReader, type Send } from './client.ts';
import { apiOutcome, errorCode, exchangeOutcome } from './failure.ts';
import { apiPaths, organisationPath } from './paths.ts';

const origin = 'https://api.example.test';
const token = `sess_${'t'.repeat(43)}`;

// "No unhandled rejection or uncaught exception" below relies on Node's test runner, which fails on either, including
// asynchronous activity after a test. The file adds no process hooks (the boundary guard forbids `process`). Each test
// ends with `settle`, so late promise jobs and rejection tracking run while that test is still the one reported.
/** Lets pending promise jobs and rejection tracking run. */
const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
afterEach(settle);

type ReadResult = { done: boolean; value?: unknown };
/** One scripted `read()`: a chunk, the end, a rejection, or a promise the test settles itself. */
type Step = { chunk: unknown } | { done: true } | { reject: unknown } | { wait: Promise<ReadResult> };
type StreamOptions = { cancel?: 'resolve' | 'reject' | 'throw' | 'hang'; releaseThrows?: boolean };
const never = <T>() => new Promise<T>(() => undefined);
function deferred<T>() {
	let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
	return { promise, resolve, reject };
}

/** A body stream whose reads follow `steps` (then report the end). It ignores cancel and abort, as a hostile or
 *  polyfilled stream may. `closed` throws if read, so any test that reaches the end also proves it is never read. */
function fakeStream(steps: readonly Step[], events: string[], options: StreamOptions = {}) {
	const log = { reads: 0, releases: 0, cancels: [] as unknown[] };
	let next = 0;
	const reader: BodyReader & { readonly closed: never } = {
		read() {
			log.reads += 1;
			const step = steps[next++];
			if (step === undefined || 'done' in step) return Promise.resolve({ done: true, value: undefined });
			if ('chunk' in step) return Promise.resolve({ done: false, value: step.chunk });
			if ('reject' in step) return Promise.reject(step.reject);
			return step.wait;
		},
		cancel(reason) {
			log.cancels.push(reason); events.push(`cancel:${String(reason)}`);
			if (options.cancel === 'throw') throw new TypeError('cancel failed');
			if (options.cancel === 'reject') return Promise.reject(new TypeError('cancel failed'));
			if (options.cancel === 'hang') return never();
			return Promise.resolve();
		},
		releaseLock() { log.releases += 1; if (options.releaseThrows) throw new TypeError('a read is pending'); },
		get closed(): never { throw new Error('closed must never be read'); }
	};
	return { stream: { getReader: () => reader }, log };
}

type Call = { url: string; init: Parameters<Send>[1] };
type Reply = {
	status?: number; redirected?: boolean; url?: string; headers?: Record<string, string>; throws?: boolean; hang?: boolean;
	/** The body as one chunk of these UTF-8 bytes, then the end. */
	text?: string;
	/** Or exactly these reads. */
	steps?: readonly Step[];
	nullBody?: boolean; bodyGetterThrows?: boolean; getReaderThrows?: boolean; stream?: StreamOptions;
};
/** A `send` that records every call and answers as told. `bodyGets` counts touches of the `body` getter; `events`
 *  records stream cancels and the request's abort, in order. */
function fakeSend(reply: Reply | ((call: Call) => Reply)) {
	const calls: Call[] = []; const counts = { bodyGets: 0 }; const events: string[] = [];
	const streams: ReturnType<typeof fakeStream>['log'][] = [];
	const send: Send = async (url, init) => {
		calls.push({ url, init });
		init.signal.addEventListener('abort', () => { events.push('abort'); });
		const r = typeof reply === 'function' ? reply({ url, init }) : reply;
		if (r.throws) throw new TypeError('Network request failed');
		if (r.hang) return never();
		const { stream, log } = fakeStream(r.steps ?? [{ chunk: bytes(r.text ?? '') }, { done: true }], events, r.stream);
		streams.push(log);
		return {
			status: r.status ?? 200, redirected: r.redirected ?? false, url: r.url ?? url,
			headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
			get body() {
				counts.bodyGets += 1;
				if (r.bodyGetterThrows) throw new TypeError('body lost');
				if (r.nullBody) return null;
				return r.getReaderThrows ? { getReader: (): BodyReader => { throw new TypeError('locked'); } } : stream;
			}
		};
	};
	return { send, calls, counts, events, streams };
}
const json = (value: unknown) => JSON.stringify(value);
const identity = <T>(value: unknown) => value as T;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
/** A valid JSON string of exactly `size` UTF-8 bytes. */
const padded = (size: number) => `"${'a'.repeat(size - 2)}"`;
/** `all` as 64 KiB chunks, then the end. */
function chunked(all: Uint8Array, size = 65_536): Step[] {
	const steps: Step[] = [];
	for (let i = 0; i < all.length; i += size) steps.push({ chunk: all.subarray(i, i + size) });
	return [...steps, { done: true }];
}
const request = (send: Send, timeoutMs?: number) => createTransport({ origin, send, ...(timeoutMs === undefined ? {} : { timeoutMs }) }).request('GET', apiPaths.me, token);
const unreadableAt = (status: number, retryAfter?: number): Answer =>
	({ kind: 'answered', status, ...(retryAfter === undefined ? {} : { retryAfter }), body: { readable: false } });

/** Replaces the global TextDecoder with one that records every `decode` input, until `restore`. */
function spyDecoder() {
	const Original = globalThis.TextDecoder; const inputs: unknown[] = [];
	class Spy extends Original {
		override decode(...args: Parameters<InstanceType<typeof Original>['decode']>): string { inputs.push(args[0]); return super.decode(...args); }
	}
	globalThis.TextDecoder = Spy as typeof globalThis.TextDecoder;
	return { inputs, restore: () => { globalThis.TextDecoder = Original; } };
}
/** Wraps JSON.parse to count calls whose text is `fixture` (the runner's own parsing is not counted), until `restore`. */
function spyParse(fixture: string) {
	const original = JSON.parse; const seen = { count: 0 };
	JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (text === fixture) seen.count += 1; return original(text, reviver); }) as typeof JSON.parse;
	return { seen, restore: () => { JSON.parse = original; } };
}
/** Replaces AbortController with one whose `abort()` aborts a real inner controller (so listeners still see it) and
 *  then throws, as a rethrowing polyfill might. A throwing listener on a real Node AbortSignal can't stand in for this:
 *  Node reports the listener's error asynchronously and `abort()` itself never throws. */
function throwingAbort() {
	const Original = globalThis.AbortController; const aborts = { count: 0 };
	class Throwing {
		readonly inner = new Original();
		get signal() { return this.inner.signal; }
		abort(reason?: unknown) { aborts.count += 1; this.inner.abort(reason); throw new Error('abort failed'); }
	}
	globalThis.AbortController = Throwing as unknown as typeof globalThis.AbortController;
	return { aborts, restore: () => { globalThis.AbortController = Original; } };
}

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
	const { send, calls } = fakeSend({ text: json({ ok: true }) });
	const transport = createTransport({ origin, send });
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

test('a malformed token is never sent: the transport throws before sending, the client answers unauthorised', async () => {
	const { send, calls } = fakeSend({ text: json({}) });
	const transport = createTransport({ origin, send }); const client = createApiClient(transport);
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
		const { send, counts, calls, events } = fakeSend({ text: json({ user: 'x' }), ...reply, bodyGetterThrows: true });
		assert.deepEqual(await createTransport({ origin, send }).request('GET', apiPaths.me, token), { kind: 'no-answer', reason: 'redirect' }, JSON.stringify(reply));
		assert.equal(counts.bodyGets, 0, JSON.stringify(reply));
		// Refused without touching the body, and aborted, so native buffering or download stops.
		assert.equal(calls[0]!.init.signal.aborted, true, JSON.stringify(reply));
		assert.deepEqual(events, ['abort'], JSON.stringify(reply));
	}
});

test('network failure and timeout are no answer; the timeout aborts the request, including a hung body read', async () => {
	assert.deepEqual(await request(fakeSend({ throws: true }).send), { kind: 'no-answer', reason: 'network' });
	const hung = fakeSend({ hang: true });
	assert.deepEqual(await request(hung.send, 20), { kind: 'no-answer', reason: 'timeout' });
	assert.equal(hung.calls[0]!.init.signal.aborted, true);
	const slowBody = fakeSend({ steps: [{ wait: never() }] });
	assert.deepEqual(await request(slowBody.send, 20), unreadableAt(200));
	assert.equal(slowBody.calls[0]!.init.signal.aborted, true);
	assert.deepEqual(await request(fakeSend({ steps: [{ reject: new Error('body lost') }] }).send), unreadableAt(200));
	// A stream error after some data: unreadable, nothing thrown out of request, no partial JSON.
	assert.deepEqual(await request(fakeSend({ steps: [{ chunk: bytes('{"a":') }, { reject: new Error('reset') }] }).send), unreadableAt(200));
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
	const client = createApiClient(createTransport({ origin, send:fakeSend(({ url }) => url.endsWith('/v1/me') ? { status: 429, headers: { 'retry-after': ' 7 ' }, text: json({ code: 'rate_limited' }) } : { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2030 07:28:00 GMT' } }).send }));
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

// The response byte budget (docs/plans/expo-mobile-response-byte-budget-2026-09.md §3).

test('budget: an ordinary multi-chunk body parses; the end is handled before its undefined value; the lock is released once; nothing is cancelled or aborted', async () => {
	const text = json({ user: { name: 'Ada é € 🍺' }, list: [1, 2, 3] }); const all = bytes(text);
	// Including a zero-byte chunk, which counts nothing and adds nothing.
	const f = fakeSend({ steps: [{ chunk: all.subarray(0, 5) }, { chunk: new Uint8Array(0) }, { chunk: all.subarray(5, 23) }, { chunk: all.subarray(23) }, { done: true }] });
	assert.deepEqual(await request(f.send), { kind: 'answered', status: 200, body: { readable: true, value: JSON.parse(text) } });
	assert.equal(f.streams[0]!.reads, 5);
	assert.equal(f.streams[0]!.releases, 1);
	assert.deepEqual(f.events, [], 'a successful completion calls neither cancel nor abort');
	assert.equal(f.calls[0]!.init.signal.aborted, false);
	// A releaseLock that throws changes nothing.
	const throwing = fakeSend({ text, stream: { releaseThrows: true } });
	assert.deepEqual(await request(throwing.send), { kind: 'answered', status: 200, body: { readable: true, value: JSON.parse(text) } });
});

test('budget: exactly maxResponseBytes parses; one byte more is unreadable, cancelled then aborted, and the crossing chunk is never decoded or followed', async () => {
	const atLimit = fakeSend({ steps: chunked(bytes(padded(maxResponseBytes))) });
	const value = await request(atLimit.send);
	assert.equal(value.kind === 'answered' && value.body.readable && typeof value.body.value === 'string' ? value.body.value.length : -1, maxResponseBytes - 2);
	assert.deepEqual(atLimit.events, []);

	const over = chunked(bytes(padded(maxResponseBytes + 1)));
	const crossing = over.length - 2; // the last chunk (one byte) crosses; the end follows it
	const steps: Step[] = [...over.slice(0, crossing + 1), { chunk: bytes('more') }, { done: true }];
	const decoder = spyDecoder();
	try {
		const f = fakeSend({ steps });
		assert.deepEqual(await request(f.send), unreadableAt(200));
		assert.deepEqual(f.events, ['cancel:budget', 'abort']);
		assert.equal(f.streams[0]!.reads, crossing + 1, 'later chunks are never requested');
		assert.equal(f.streams[0]!.releases, 0);
		const crossingChunk = (steps[crossing] as { chunk: unknown }).chunk;
		assert.ok(!decoder.inputs.includes(crossingChunk), 'the crossing chunk is never decoded');
		assert.equal(decoder.inputs.length, crossing);
	} finally { decoder.restore(); }
});

test('budget: one chunk larger than the limit is refused without being decoded', async () => {
	const decoder = spyDecoder();
	try {
		const f = fakeSend({ steps: [{ chunk: bytes(padded(maxResponseBytes + 10)) }, { done: true }] });
		assert.deepEqual(await request(f.send), unreadableAt(200));
		assert.deepEqual(decoder.inputs, []);
		assert.deepEqual(f.events, ['cancel:budget', 'abort']);
	} finally { decoder.restore(); }
});

test('budget: 2-, 3- and 4-byte characters split at every byte across chunks decode exactly', async () => {
	for (const text of [json('é'), json('x€y'), json('🍺'), json('a🍺é€b')]) {
		const all = bytes(text);
		for (let cut = 1; cut < all.length; cut += 1) {
			const f = fakeSend({ steps: [{ chunk: all.subarray(0, cut) }, { chunk: all.subarray(cut) }, { done: true }] });
			assert.deepEqual(await request(f.send), { kind: 'answered', status: 200, body: { readable: true, value: JSON.parse(text) } }, `${text} at ${cut}`);
		}
	}
});

test('budget: a chunk that is not a Uint8Array is unreadable and never coerced', async () => {
	for (const chunk of ['{}', new ArrayBuffer(2), [123, 125], null, 7]) {
		const f = fakeSend({ steps: [{ chunk }, { done: true }] });
		assert.deepEqual(await request(f.send), unreadableAt(200), String(chunk));
		assert.deepEqual(f.events, ['cancel:unreadable', 'abort'], String(chunk));
	}
});

test('budget: content-length over the limit refuses before the body is touched, by length first; anything else changes nothing', async () => {
	for (const declared of [String(maxResponseBytes + 1), '0000001048577', '9'.repeat(400)]) {
		const f = fakeSend({ headers: { 'content-length': declared }, bodyGetterThrows: true });
		assert.deepEqual(await request(f.send), unreadableAt(200), declared.slice(0, 20));
		assert.equal(f.counts.bodyGets, 0, 'the body getter is never touched');
		assert.deepEqual(f.events, ['abort']);
	}
	for (const declared of ['12abc', '-5', '1e9', ' 2000000', '2000000 ', '', '10', String(maxResponseBytes), '0001048576']) {
		const f = fakeSend({ headers: { 'content-length': declared }, text: json({ ok: true }) });
		assert.deepEqual(await request(f.send), { kind: 'answered', status: 200, body: { readable: true, value: { ok: true } } }, declared);
	}
	// Declared small but actually large: the count still decides.
	const lying = fakeSend({ headers: { 'content-length': '10' }, steps: chunked(bytes(padded(maxResponseBytes + 1))) });
	assert.deepEqual(await request(lying.send), unreadableAt(200));
	assert.deepEqual(lying.events, ['cancel:budget', 'abort']);
});

test('budget: invalid UTF-8 is unreadable (an intended change from text()); a BOM is removed; empty and null bodies are unreadable', async () => {
	const quote = 0x22;
	for (const [name, steps] of [
		['lone continuation byte', [{ chunk: new Uint8Array([quote, 0x80, quote]) }, { done: true }]],
		['overlong form', [{ chunk: new Uint8Array([quote, 0xc0, 0xaf, quote]) }, { done: true }]],
		['surrogate half', [{ chunk: new Uint8Array([quote, 0xed, 0xa0, 0x80, quote]) }, { done: true }]],
		['invalid sequence split across chunks', [{ chunk: new Uint8Array([quote, 0xe2, 0x82]) }, { chunk: new Uint8Array([0x41, quote]) }, { done: true }]],
		['incomplete sequence at the end', [{ chunk: new Uint8Array([quote, 0xe2, 0x82]) }, { done: true }]]
	] as const satisfies readonly (readonly [string, readonly Step[]])[]) assert.deepEqual(await request(fakeSend({ steps }).send), unreadableAt(200), name);
	const bom = fakeSend({ steps: [{ chunk: new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"a":1}')]) }, { done: true }] });
	assert.deepEqual(await request(bom.send), { kind: 'answered', status: 200, body: { readable: true, value: { a: 1 } } });
	assert.deepEqual(await request(fakeSend({ text: '' }).send), unreadableAt(200));
	assert.deepEqual(await request(fakeSend({ steps: [{ done: true }] }).send), unreadableAt(200));
	assert.deepEqual(await request(fakeSend({ nullBody: true }).send), unreadableAt(200));
	// Through the mappings: a 2xx read is unavailable, and an exchange 200 is uncertain.
	const invalid: Reply = { steps: [{ chunk: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }, { done: true }] };
	assert.deepEqual(apiOutcome(await request(fakeSend(invalid).send), identity), { ok: false, kind: 'unavailable', status: 200 });
	const exchange = await createTransport({ origin, send: fakeSend(invalid).send }).request('POST', apiPaths.nativeExchange, null, { code: 'x' });
	assert.deepEqual(exchangeOutcome(exchange, (v) => v as never), { kind: 'uncertain' });
});

test('budget: a first read that never settles ends at the timer, aborted; a later settlement or rejection is harmless', async () => {
	for (const settleLater of ['resolve', 'reject'] as const) {
		const late = deferred<ReadResult>();
		const f = fakeSend({ steps: [{ wait: late.promise }] });
		assert.deepEqual(await request(f.send, 20), unreadableAt(200));
		assert.equal(f.calls[0]!.init.signal.aborted, true);
		assert.deepEqual(f.events, ['cancel:timeout', 'abort']);
		if (settleLater === 'resolve') late.resolve({ done: false, value: bytes('{}') }); else late.reject(new Error('aborted'));
		await settle();
		assert.equal(f.streams[0]!.reads, 1);
		assert.equal(f.streams[0]!.releases, 0);
	}
});

test('budget: a cancel that throws or rejects, on the budget and timeout paths, changes nothing, and the abort still runs once after it', async () => {
	for (const cancel of ['throw', 'reject'] as const) {
		const budget = fakeSend({ steps: chunked(bytes(padded(maxResponseBytes + 1))), stream: { cancel } });
		assert.deepEqual(await request(budget.send), unreadableAt(200), cancel);
		assert.deepEqual(budget.events, ['cancel:budget', 'abort'], cancel);
		const timeout = fakeSend({ steps: [{ wait: never() }], stream: { cancel } });
		assert.deepEqual(await request(timeout.send, 20), unreadableAt(200), cancel);
		assert.deepEqual(timeout.events, ['cancel:timeout', 'abort'], cancel);
	}
	// The timeout path does not await cleanup: a cancel that never settles doesn't hold the request.
	const hanging = fakeSend({ steps: [{ wait: never() }], stream: { cancel: 'hang' } });
	assert.deepEqual(await request(hanging.send, 20), unreadableAt(200));
});

test('budget: one timer covers headers and body; a body stalled after late headers ends at that same timer', async () => {
	const original = globalThis.setTimeout; const delays: unknown[] = [];
	type Timer = (handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => ReturnType<typeof setTimeout>;
	globalThis.setTimeout = ((handler, ms, ...rest) => { delays.push(ms); return (original as unknown as Timer)(handler, ms, ...rest); }) as Timer as unknown as typeof setTimeout;
	try {
		const { stream } = fakeStream([{ wait: never() }], []);
		const lateHeaders: Send = (url) => new Promise((resolve) => {
			(original as unknown as Timer)(() => resolve({ status: 200, redirected: false, url, headers: { get: () => null }, body: stream }), 15);
		});
		assert.deepEqual(await request(lateHeaders, 37), unreadableAt(200));
		assert.deepEqual(delays, [37], 'exactly one timer, for the whole request');
	} finally { globalThis.setTimeout = original; }
});

test('budget (stop state): after a timeout or a budget stop, a late read does no decode, no further read and no parse', async () => {
	// Timeout, then the pending read resolves with a whole valid body, and the end is available after it.
	{
		const fixture = json({ late: true }); const late = deferred<ReadResult>();
		const decoder = spyDecoder(); const parse = spyParse(fixture);
		try {
			const f = fakeSend({ steps: [{ wait: late.promise }, { done: true }] });
			assert.deepEqual(await request(f.send, 20), unreadableAt(200));
			late.resolve({ done: false, value: bytes(fixture) });
			await settle();
			assert.equal(f.streams[0]!.reads, 1);
			assert.deepEqual(decoder.inputs, []);
			assert.equal(parse.seen.count, 0);
		} finally { decoder.restore(); parse.restore(); }
	}
	// Timeout, then the pending read rejects: nothing more happens, and cleanup ran once.
	{
		const late = deferred<ReadResult>();
		const f = fakeSend({ steps: [{ wait: late.promise }] });
		assert.deepEqual(await request(f.send, 20), unreadableAt(200));
		late.reject(new Error('aborted'));
		await settle();
		assert.equal(f.streams[0]!.cancels.length, 1);
		assert.deepEqual(f.events, ['cancel:timeout', 'abort']);
	}
	// Timeout during a mid-body read: the chunks already counted were decoded; the late chunk and the end are not.
	{
		const fixture = '{"a":"bc"}'; const late = deferred<ReadResult>();
		const decoder = spyDecoder(); const parse = spyParse(fixture);
		try {
			const f = fakeSend({ steps: [{ chunk: bytes('{"a"') }, { chunk: bytes(':"b') }, { wait: late.promise }, { done: true }] });
			assert.deepEqual(await request(f.send, 20), unreadableAt(200));
			late.resolve({ done: false, value: bytes('c"}') });
			await settle();
			assert.equal(f.streams[0]!.reads, 3);
			assert.equal(decoder.inputs.length, 2);
			assert.equal(parse.seen.count, 0);
		} finally { decoder.restore(); parse.restore(); }
	}
	// A budget stop with more data and the end still available: no further read, no parse.
	{
		const fixture = padded(maxResponseBytes + 1); const steps = chunked(bytes(fixture));
		const decoder = spyDecoder(); const parse = spyParse(fixture);
		try {
			const f = fakeSend({ steps: [...steps.slice(0, -1), { chunk: bytes('x') }, { done: true }] });
			assert.deepEqual(await request(f.send), unreadableAt(200));
			await settle();
			assert.equal(f.streams[0]!.reads, steps.length - 1);
			assert.equal(decoder.inputs.length, steps.length - 2);
			assert.equal(parse.seen.count, 0);
		} finally { decoder.restore(); parse.restore(); }
	}
});

test('budget: an abort that throws synchronously never changes the outcome or leaves the request unsettled', async () => {
	const fake = throwingAbort();
	try {
		// Before headers: the timer settles the request before it aborts.
		assert.deepEqual(await request(fakeSend({ hang: true }).send, 20), { kind: 'no-answer', reason: 'timeout' });
		// After headers, with a stalled body: the status and retry-after are kept.
		const stalled = fakeSend({ status: 429, headers: { 'retry-after': '20' }, steps: [{ wait: never() }] });
		assert.deepEqual(await request(stalled.send, 20), unreadableAt(429, 20));
		assert.deepEqual(stalled.events, ['cancel:timeout', 'abort']);
		// The budget path: the cancel was still attempted before the abort.
		const budget = fakeSend({ steps: chunked(bytes(padded(maxResponseBytes + 1))) });
		assert.deepEqual(await request(budget.send), unreadableAt(200));
		assert.deepEqual(budget.events, ['cancel:budget', 'abort']);
		// The early content-length refusal: the body is still never touched.
		const refused = fakeSend({ headers: { 'content-length': String(maxResponseBytes + 1) }, bodyGetterThrows: true });
		assert.deepEqual(await request(refused.send), unreadableAt(200));
		assert.equal(refused.counts.bodyGets, 0);
		assert.equal(fake.aborts.count, 4);
	} finally { fake.restore(); }
});

test('budget: the timer settles the request before it aborts, so a send that rejects inside its abort listener still reports a timeout', async () => {
	const rejectsOnAbort: Send = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('aborted')); }); });
	assert.deepEqual(await request(rejectsOnAbort, 20), { kind: 'no-answer', reason: 'timeout' });
});

test('budget: a 429 keeps its retry-after when its body times out, is oversized or is not valid UTF-8', async () => {
	const headers = { 'retry-after': '20' };
	for (const [name, reply, timeoutMs] of [
		['times out', { status: 429, headers, steps: [{ wait: never<ReadResult>() }] }, 20],
		['oversized', { status: 429, headers, steps: chunked(bytes(padded(maxResponseBytes + 1))) }, undefined],
		['declared oversized', { status: 429, headers: { ...headers, 'content-length': String(maxResponseBytes + 1) } }, undefined],
		['invalid UTF-8', { status: 429, headers, steps: [{ chunk: new Uint8Array([0x22, 0xff, 0x22]) }, { done: true }] }, undefined]
	] as const satisfies readonly (readonly [string, Reply, number | undefined])[]) {
		const answer = await request(fakeSend(reply).send, timeoutMs);
		assert.deepEqual(answer, unreadableAt(429, 20), name);
		assert.deepEqual(apiOutcome(answer, identity), { ok: false, kind: 'unavailable', status: 429, retryAfter: 20 }, name);
	}
});

test('budget: an oversized body keeps every existing mapping; it is never ok and never a client bug', async () => {
	const oversized = (status: number, headers: Record<string, string> = {}) => fakeSend({ status, headers, steps: chunked(bytes(padded(maxResponseBytes + 1))) }).send;
	assert.deepEqual(apiOutcome(await request(oversized(200)), identity), { ok: false, kind: 'unavailable', status: 200 });
	assert.deepEqual(apiOutcome(await request(oversized(401)), identity), { ok: false, kind: 'unauthorised' });
	assert.deepEqual(apiOutcome(await request(oversized(403)), identity), { ok: false, kind: 'refused', status: 403, code: 'unknown' });
	assert.deepEqual(apiOutcome(await request(oversized(429, { 'retry-after': '20' })), identity), { ok: false, kind: 'unavailable', status: 429, retryAfter: 20 });
	const exchange = await createTransport({ origin, send: oversized(200) }).request('POST', apiPaths.nativeExchange, null, { code: 'x' });
	assert.deepEqual(exchangeOutcome(exchange, (v) => v as never), { kind: 'uncertain' });
});

test('budget: a body getter or getReader that throws after headers is an unreadable body with the status and retry-after, never no answer', async () => {
	for (const fault of ['bodyGetterThrows', 'getReaderThrows'] as const) {
		const faulty: Reply = fault === 'bodyGetterThrows' ? { bodyGetterThrows: true } : { getReaderThrows: true };
		const at = (status: number, headers: Record<string, string> = {}) => request(fakeSend({ ...faulty, status, headers }).send);
		for (const [status, answer] of [[200, unreadableAt(200)], [401, unreadableAt(401)], [403, unreadableAt(403)]] as const) assert.deepEqual(await at(status), answer, `${fault} ${status}`);
		const busy = await at(429, { 'retry-after': '20' });
		assert.deepEqual(busy, unreadableAt(429, 20), fault);
		assert.deepEqual(apiOutcome(await at(200), identity), { ok: false, kind: 'unavailable', status: 200 }, fault);
		assert.deepEqual(apiOutcome(await at(401), identity), { ok: false, kind: 'unauthorised' }, fault);
		assert.deepEqual(apiOutcome(await at(403), identity), { ok: false, kind: 'refused', status: 403, code: 'unknown' }, fault);
		assert.deepEqual(apiOutcome(busy, identity), { ok: false, kind: 'unavailable', status: 429, retryAfter: 20 }, fault);
	}
});

test('passkey DELETE uses the bounded transport once, without a body, and rejects redirects', async () => {
 const f = fakeSend({ text: json({ ok: true }) }); const client = createApiClient(createTransport({ origin, send: f.send }));
 const path = '/v1/me/passkeys/00000000-0000-4000-8000-000000000005' as const;
 assert.deepEqual(await client.delete(path, null, value => value), { ok: true, value: { ok: true } });
 assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.method, 'DELETE'); assert.equal(f.calls[0]!.init.body, undefined); assert.equal(f.calls[0]!.init.redirect, 'error');
 const redirected = fakeSend({ status: 302 });
 assert.deepEqual(await createApiClient(createTransport({ origin, send: redirected.send })).delete(path, null, value => value), { ok: false, kind: 'unavailable', status: 0 });
});

test('membership PATCH sends the role body once through the bounded transport', async () => {
 const f = fakeSend({ text: json({ ok: true }) }); const client = createApiClient(createTransport({ origin, send: f.send }));
 const path = organisationPath('00000000-0000-4000-8000-000000000003', 'members', '00000000-0000-4000-8000-000000000002');
 assert.deepEqual(await client.patch(path, null, { role: 'admin' }, value => value), { ok: true, value: { ok: true } });
 assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.method, 'PATCH'); assert.equal(f.calls[0]!.init.body, '{"role":"admin"}'); assert.equal(f.calls[0]!.init.redirect, 'error'); assert.equal(f.calls[0]!.init.headers.authorization, undefined);
});

test('push DELETE sends its endpoint body once, without bearer and with redirect refusal', async () => {
 const f = fakeSend({ text: json({ ok: true }) }); const client = createApiClient(createTransport({ origin, send: f.send }));
 const path = organisationPath('00000000-0000-4000-8000-000000000003', 'push', 'subscriptions');
 await client.delete(path, null, value => value, { endpoint: 'https://push.example.test/synthetic' });
 assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.body, '{"endpoint":"https://push.example.test/synthetic"}'); assert.equal(f.calls[0]!.init.headers.authorization, undefined); assert.equal(f.calls[0]!.init.redirect, 'error');
});
