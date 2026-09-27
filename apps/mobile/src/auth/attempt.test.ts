import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Answer, Transport } from '../api/client.ts';
import { apiPaths } from '../api/paths.ts';
import { createAttempts, startUrl } from './attempt.ts';
import { callbackUrl } from './callback.ts';
import { createCleanup } from './cleanup.ts';
import { AttemptActive, type AttemptOutcome, type AuthPlatform } from './contracts.ts';
import { isStoredSession } from '../account/session.ts';
import { parseSignedIn } from './exchange.ts';

const origin = 'https://api.example.test';
const token = `sess_${'T'.repeat(43)}`;
const expiresAt = '2030-02-01T00:00:00.000Z';
const user = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'nat@example.test', name: 'Nat' };
const signedInBody = { token, expiresAt, user, returnTo: '/work' };
const code = `nh_${'C'.repeat(43)}`;
const s256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; !check(); i++) { assert.ok(i < 100, 'never reached'); await settle(); } }

type Opened = { url: string; prefix: string; resolve: (result: { type: string; url?: string }) => void; reject: (error: unknown) => void };
function fakePlatform(overrides: Partial<AuthPlatform> = {}) {
	const opened: Opened[] = []; const counts = { dismissed: 0 };
	const platform: AuthPlatform = {
		randomBytes: async (length) => new Uint8Array(randomBytes(length)),
		sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
		openAuthSession: (url, prefix) => new Promise((resolve, reject) => { opened.push({ url, prefix, resolve: resolve as Opened['resolve'], reject }); }),
		dismissAuthSession: () => { counts.dismissed += 1; },
		...overrides
	};
	return { platform, opened, counts };
}
type Sent = { method: string; path: string; token: string | null; body: unknown };
function fakeTransport(answer: (sent: Sent) => Answer | Promise<Answer>) {
	const sent: Sent[] = [];
	const transport: Transport = { origin, request: async (method, path, t, body) => { const call = { method, path, token: t, body }; sent.push(call); return answer(call); } };
	return { transport, sent };
}
const answered = (status: number, value?: unknown): Answer => ({ kind: 'answered', status, body: value === undefined ? { readable: false } : { readable: true, value } });
/** The attempt value and challenge the core put in the start URL. */
const startOf = (opened: Opened) => { const q = new URL(opened.url).searchParams; return { attempt: q.get('attempt')!, challenge: q.get('code_challenge')!, returnTo: q.get('return_to') }; };
const callbackFor = (opened: Opened, c = code) => `${callbackUrl}?code=${c}&attempt=${startOf(opened).attempt}`;

test('the start URL: origin, fixed path, the native parameters, and return_to only for an unchanged app path', () => {
	const pkce = { challenge: 'c'.repeat(43), attempt: 'a'.repeat(43) };
	const base = `${origin}/auth/google/start?client=native&code_challenge=${pkce.challenge}&code_challenge_method=S256&attempt=${pkce.attempt}`;
	assert.equal(startUrl(origin, pkce), base);
	assert.equal(startUrl(origin, pkce, '/work/views'), `${base}&return_to=%2Fwork%2Fviews`);
	assert.equal(startUrl(origin, pkce, '/chat?filter=unread&x=1'), `${base}&return_to=%2Fchat%3Ffilter%3Dunread%26x%3D1`);
	for (const refused of ['', '//evil.test', '/\\evil.test', 'https://evil.test/work', 'app.askthecaptain.dev:/work', '/auth/callback', '/unknown', '/link-not-allowed', `/${'a'.repeat(2048)}`])
		assert.equal(startUrl(origin, pkce, refused), base, refused.slice(0, 40));
});

test('a full attempt: one browser session with this attempt’s challenge, then one exchange with the matching verifier', async () => {
	const { platform, opened } = fakePlatform(); const { transport, sent } = fakeTransport(() => answered(200, signedInBody));
	const attempts = createAttempts({ platform, transport });
	assert.equal(attempts.state(), 'idle');
	const outcome = attempts.start('/work');
	assert.equal(attempts.state(), 'opening');
	await until(() => opened.length === 1);
	assert.equal(attempts.state(), 'awaiting-callback');
	assert.equal(opened[0]!.prefix, 'app.askthecaptain.dev:/auth/callback');
	const start = startOf(opened[0]!); assert.equal(start.returnTo, '/work');
	opened[0]!.resolve({ type: 'success', url: callbackFor(opened[0]!) });
	assert.deepEqual(await outcome, { kind: 'signed-in', session: signedInBody });
	assert.equal(sent.length, 1);
	const body = sent[0]!.body as { code: string; verifier: string; attempt: string };
	assert.deepEqual([sent[0]!.method, sent[0]!.path, sent[0]!.token], ['POST', apiPaths.nativeExchange, null]);
	assert.deepEqual(Object.keys(body).sort(), ['attempt', 'code', 'verifier']);
	assert.equal(body.code, code); assert.equal(body.attempt, start.attempt); assert.equal(s256(body.verifier), start.challenge);
	assert.equal(attempts.state(), 'idle');
	// The next attempt uses fresh values.
	const next = attempts.start(); await until(() => opened.length === 2);
	assert.notEqual(startOf(opened[1]!).attempt, start.attempt); assert.notEqual(startOf(opened[1]!).challenge, start.challenge);
	opened[1]!.resolve({ type: 'cancel' }); await next;
});

test('one attempt at a time: start is refused while opening, awaiting the callback and exchanging', async () => {
	let answer!: (a: Answer) => void;
	const { platform, opened } = fakePlatform(); const { transport, sent } = fakeTransport(() => new Promise<Answer>((resolve) => { answer = resolve; }));
	const attempts = createAttempts({ platform, transport });
	const first = attempts.start();
	await assert.rejects(attempts.start(), AttemptActive, 'opening');
	await until(() => opened.length === 1);
	await assert.rejects(attempts.start(), AttemptActive, 'awaiting-callback');
	opened[0]!.resolve({ type: 'success', url: callbackFor(opened[0]!) });
	await until(() => sent.length === 1);
	assert.equal(attempts.state(), 'exchanging');
	await assert.rejects(attempts.start(), AttemptActive, 'exchanging');
	assert.equal(attempts.cancel(), false, 'no cancel once the exchange is sent');
	answer(answered(503));
	assert.deepEqual(await first, { kind: 'start-again', status: 503 });
	assert.equal(opened.length, 1); assert.equal(sent.length, 1);
});

/** Crypto whose first random-bytes call completes only when the test says so. */
function heldCrypto() {
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	const counts = { calls: 0 };
	const bytes = async (length: 32) => { counts.calls += 1; if (counts.calls === 1) await gate; return new Uint8Array(randomBytes(length)); };
	return { randomBytes: bytes, release: () => release(), counts };
}
/** Tracks whether a promise has settled, without awaiting it. */
function watch<T>(promise: Promise<T>) {
	const state: { done: boolean; value?: T; error?: unknown } = { done: false };
	promise.then((value) => { state.done = true; state.value = value; }, (error: unknown) => { state.done = true; state.error = error; });
	return state;
}

test('cancel while the crypto is still running: closing until it settles, no second start meanwhile, and the browser never opens', async () => {
	const crypto = heldCrypto();
	const { platform, opened, counts } = fakePlatform({ randomBytes: crypto.randomBytes });
	const { transport, sent } = fakeTransport(() => answered(200, signedInBody));
	const attempts = createAttempts({ platform, transport });
	const first = watch(attempts.start());
	await until(() => crypto.counts.calls === 1);
	assert.equal(attempts.state(), 'opening');
	assert.equal(attempts.cancel(), true); assert.equal(counts.dismissed, 1);
	assert.equal(attempts.state(), 'closing');
	assert.equal(attempts.cancel(), false, 'nothing more to cancel');
	await assert.rejects(attempts.start(), AttemptActive, 'refused while the old platform call is unsettled');
	await settle(); await settle();
	assert.equal(first.done, false); assert.equal(attempts.state(), 'closing');
	crypto.release();
	await until(() => first.done);
	assert.deepEqual(first.value, { kind: 'cancelled' });
	assert.equal(attempts.state(), 'idle');
	assert.equal(opened.length, 0, 'a cancelled opening never opens the browser'); assert.equal(sent.length, 0);
	// Now a new attempt starts normally.
	const second = attempts.start(); await until(() => opened.length === 1);
	assert.equal(attempts.state(), 'awaiting-callback');
	opened[0]!.resolve({ type: 'dismiss' }); assert.deepEqual(await second, { kind: 'cancelled' });
});

test('cancel while the browser is open: closing until the browser call returns, no overlapping browser, the late callback is not delivered', async () => {
	for (const late of [{ type: 'dismiss' }, 'success', 'reject'] as const) {
		const { platform, opened, counts } = fakePlatform(); const { transport, sent } = fakeTransport(() => answered(200, signedInBody));
		const attempts = createAttempts({ platform, transport });
		const first = watch(attempts.start()); await until(() => opened.length === 1);
		assert.equal(attempts.cancel(), true); assert.equal(counts.dismissed, 1);
		assert.equal(attempts.state(), 'closing');
		await assert.rejects(attempts.start(), AttemptActive);
		await settle();
		assert.equal(opened.length, 1, 'no second browser while the first is still open');
		if (late === 'success') opened[0]!.resolve({ type: 'success', url: callbackFor(opened[0]!) });
		else if (late === 'reject') opened[0]!.reject(new Error('already closed'));
		else opened[0]!.resolve(late);
		await until(() => first.done);
		assert.deepEqual(first.value, { kind: 'cancelled' }, JSON.stringify(late));
		assert.equal(attempts.state(), 'idle'); assert.equal(sent.length, 0, 'the late callback was not exchanged');
		const second = attempts.start(); await until(() => opened.length === 2);
		opened[1]!.resolve({ type: 'cancel' }); assert.deepEqual(await second, { kind: 'cancelled' });
	}
});

test('a browser call that never settles after cancel leaves the state honestly closing, and start stays refused', async () => {
	const { platform, opened } = fakePlatform(); const { transport } = fakeTransport(() => answered(200, signedInBody));
	const attempts = createAttempts({ platform, transport });
	const first = watch(attempts.start()); await until(() => opened.length === 1);
	attempts.cancel();
	for (let i = 0; i < 20; i++) await settle();
	assert.equal(attempts.state(), 'closing'); assert.equal(first.done, false);
	await assert.rejects(attempts.start(), AttemptActive);
	assert.equal(opened.length, 1);
});

test('every browser result other than success, and a browser that fails to open, is cancelled with nothing sent', async () => {
	const { transport, sent } = fakeTransport(() => answered(200, signedInBody));
	for (const result of [{ type: 'cancel' }, { type: 'dismiss' }, { type: 'locked' }, { type: 'opened' }, { type: 'something-new' }, { type: 'success' }, { type: 'success', url: 42 }] as { type: string; url?: string }[]) {
		const { platform, opened } = fakePlatform(); const attempts = createAttempts({ platform, transport });
		const outcome = attempts.start(); await until(() => opened.length === 1);
		opened[0]!.resolve(result);
		assert.deepEqual(await outcome, { kind: 'cancelled' }, JSON.stringify(result)); assert.equal(attempts.state(), 'idle');
	}
	const { platform, opened } = fakePlatform(); const attempts = createAttempts({ platform, transport });
	const outcome = attempts.start(); await until(() => opened.length === 1);
	opened[0]!.reject(new Error('Another web browser is already open'));
	assert.deepEqual(await outcome, { kind: 'cancelled' });
	assert.equal(sent.length, 0);
});

test('a callback that is not this attempt’s exact callback is callback-invalid, with nothing sent', async () => {
	const { transport, sent } = fakeTransport(() => answered(200, signedInBody));
	for (const make of [
		(o: Opened) => `${callbackUrl}?code=${code}&attempt=${'x'.repeat(43)}`, (o: Opened) => `${callbackFor(o)}#x`, (o: Opened) => callbackFor(o).replace(':/', '://'),
		(o: Opened) => `${callbackFor(o)}&extra=1`, (o: Opened) => callbackFor(o, 'nh_short'), (o: Opened) => `https://app.askthecaptain.dev/auth/callback?code=${code}&attempt=${startOf(o).attempt}`
	]) {
		const { platform, opened } = fakePlatform(); const attempts = createAttempts({ platform, transport });
		const outcome = attempts.start(); await until(() => opened.length === 1);
		opened[0]!.resolve({ type: 'success', url: make(opened[0]!) });
		assert.deepEqual(await outcome, { kind: 'callback-invalid' });
	}
	assert.equal(sent.length, 0);
});

test('the exchange through the core: each answer maps as reviewed, and the exchange is sent exactly once for every outcome', async () => {
	const cases: [Answer | 'throw', AttemptOutcome][] = [
		[answered(200, signedInBody), { kind: 'signed-in', session: signedInBody }],
		[answered(200, { ...signedInBody, extra: 1 }), { kind: 'uncertain' }],
		[answered(200, { ...signedInBody, token: 'pks_x' }), { kind: 'uncertain' }],
		[answered(200), { kind: 'uncertain' }],
		[answered(401, { ok: false, code: 'native_sign_in_disabled', error: 'off' }), { kind: 'native-disabled' }],
		[answered(401, { ok: false, code: 'unauthorised', error: 'this account now needs its passkey; start sign-in again' }), { kind: 'cannot-finish' }],
		[answered(400, { ok: false, code: 'native_request_invalid' }), { kind: 'cannot-finish' }],
		[answered(404, { ok: false, code: 'not_found' }), { kind: 'cannot-finish' }],
		[answered(429, { ok: false, code: 'rate_limited' }), { kind: 'start-again', status: 429 }],
		[answered(500, { ok: false, code: 'internal' }), { kind: 'start-again', status: 500 }],
		[answered(502), { kind: 'start-again', status: 502 }],
		[{ kind: 'no-answer', reason: 'network' }, { kind: 'uncertain' }],
		[{ kind: 'no-answer', reason: 'timeout' }, { kind: 'uncertain' }],
		[{ kind: 'no-answer', reason: 'redirect' }, { kind: 'uncertain' }],
		['throw', { kind: 'uncertain' }]
	];
	for (const [answer, expected] of cases) {
		const { platform, opened } = fakePlatform();
		const { transport, sent } = fakeTransport(() => { if (answer === 'throw') throw new Error('boom'); return answer; });
		const attempts = createAttempts({ platform, transport });
		const outcome = attempts.start(); await until(() => opened.length === 1);
		opened[0]!.resolve({ type: 'success', url: callbackFor(opened[0]!) });
		assert.deepEqual(await outcome, expected, JSON.stringify(answer));
		await settle();
		assert.equal(sent.length, 1, `sent once: ${JSON.stringify(answer)}`); assert.equal(attempts.state(), 'idle');
	}
});

test('the platform’s crypto failing is cannot-finish, before any browser or request', async () => {
	const { transport, sent } = fakeTransport(() => answered(200, signedInBody));
	for (const overrides of [{ randomBytes: async () => { throw new Error('no entropy'); } }, { sha256: async () => new Uint8Array(3) }] as Partial<AuthPlatform>[]) {
		const { platform, opened } = fakePlatform(overrides); const attempts = createAttempts({ platform, transport });
		assert.deepEqual(await attempts.start(), { kind: 'cannot-finish' }); assert.equal(opened.length, 0); assert.equal(attempts.state(), 'idle');
	}
	assert.equal(sent.length, 0);
});

test('the success body is parsed strictly', () => {
	assert.deepEqual(parseSignedIn(signedInBody), signedInBody);
	const bad: unknown[] = [null, [], 'x', { ...signedInBody, extra: 1 }, { token, expiresAt, user }, { ...signedInBody, token: `sess_${'x'.repeat(10)}` },
		{ ...signedInBody, token: `${token}x` }, { ...signedInBody, expiresAt: '2030-02-01' }, { ...signedInBody, expiresAt: 'soon' },
		{ ...signedInBody, expiresAt: '2030-02-01T00:00:00Z' }, { ...signedInBody, expiresAt: '2030-02-30T00:00:00.000Z' }, { ...signedInBody, expiresAt: '2030-02-01T00:00:00.000+00:00' }, { ...signedInBody, user: { ...user, id: user.id.toUpperCase() } },
		{ ...signedInBody, user: { ...user, extra: 1 } }, { ...signedInBody, user: { id: user.id, email: user.email } }, { ...signedInBody, user: { ...user, email: '' } },
		{ ...signedInBody, returnTo: 7 }, { ...signedInBody, returnTo: 'x'.repeat(2049) }];
	for (const value of bad) assert.throws(() => parseSignedIn(value), (error: unknown) => error instanceof TypeError && !error.message.includes(token), JSON.stringify(value)?.slice(0, 80));
});

test('cleanup: a confirmed revoke or 401 drops the token; otherwise three sends over the schedule, then pending until the person retries', async () => {
	for (const status of [200, 401]) {
		const { transport, sent } = fakeTransport(() => answered(status, { ok: true }));
		const cleanup = createCleanup({ transport, sleep: async () => undefined });
		assert.equal(await cleanup.begin(token, expiresAt), 'revoked');
		assert.deepEqual(sent, [{ method: 'POST', path: apiPaths.signOut, token, body: undefined }]);
		assert.equal(cleanup.state(), 'none'); assert.equal(cleanup.expiresAt(), null);
	}
	const answers: Answer[] = [answered(503), answered(429), { kind: 'no-answer', reason: 'network' }, answered(403, { code: 'forbidden' }), answered(502), answered(200, { ok: true })];
	const { transport, sent } = fakeTransport(() => answers.shift()!);
	const slept: number[] = [];
	const cleanup = createCleanup({ transport, sleep: async (ms) => { slept.push(ms); } });
	const attempts = createAttempts({ platform: fakePlatform().platform, transport, cleanup });
	const running = cleanup.begin(token, expiresAt);
	// Checked before anything awaits, while the first send is still in flight.
	assert.equal(attempts.state(), 'cleaning-up');
	const refused = attempts.start(); const extra = attempts.retryCleanup();
	await assert.rejects(refused, AttemptActive);
	assert.equal(await extra, 'still-pending', 'no extra send while running');
	assert.equal(await running, 'still-pending');
	assert.deepEqual(slept, [10_000, 20_000]); assert.equal(sent.length, 3);
	assert.equal(attempts.state(), 'cleanup-pending'); assert.equal(attempts.pendingCleanupExpiresAt(), expiresAt);
	await assert.rejects(attempts.start(), AttemptActive);
	assert.equal(attempts.cancel(), false);
	await assert.rejects(cleanup.begin(`sess_${'U'.repeat(43)}`, expiresAt), 'only one token is ever held');
	assert.equal(await attempts.retryCleanup(), 'still-pending'); assert.equal(sent.length, 4, 'exactly one more send');
	assert.equal(await attempts.retryCleanup(), 'still-pending'); assert.equal(sent.length, 5);
	assert.equal(await attempts.retryCleanup(), 'revoked'); assert.equal(sent.length, 6);
	assert.ok(sent.every((s) => s.token === token && s.path === apiPaths.signOut));
	assert.equal(attempts.state(), 'idle'); assert.equal(attempts.pendingCleanupExpiresAt(), null);
	assert.equal(await attempts.retryCleanup(), 'revoked'); assert.equal(sent.length, 6, 'nothing held, nothing sent');
});

/** A fake clock that the fake timer advances. */
function fakeTime() {
	const time = { now: 1_000_000, slept: [] as number[] };
	return { time, now: () => time.now, sleep: async (ms: number) => { time.slept.push(ms); time.now += ms; } };
}
const busy = (status: number, retryAfter?: number): Answer => ({ ...answered(status), ...(retryAfter === undefined ? {} : { retryAfter }) } as Answer);

test('cleanup waits out a retry-after within the schedule, and a transport that throws is just another failure', async () => {
	const answers: (Answer | 'throw')[] = [busy(429, 25), 'throw', busy(503)];
	const { transport, sent } = fakeTransport(() => { const next = answers.shift()!; if (next === 'throw') throw new Error('boom'); return next; });
	const { time, now, sleep } = fakeTime();
	const cleanup = createCleanup({ transport, sleep, now });
	assert.equal(await cleanup.begin(token, expiresAt), 'still-pending');
	assert.deepEqual(time.slept, [25_000, 20_000], 'the second send waits the 25 seconds asked for, not the scheduled 10');
	assert.equal(sent.length, 3);
});

test('a retry-after beyond the schedule is never cut short: the cleanup goes pending, and an explicit retry sends nothing until that time', async () => {
	const answers: Answer[] = [busy(503, 120), busy(429, 60), answered(200, { ok: true })];
	const { transport, sent } = fakeTransport(() => answers.shift()!);
	const { time, now, sleep } = fakeTime();
	const cleanup = createCleanup({ transport, sleep, now });
	const attempts = createAttempts({ platform: fakePlatform().platform, transport, cleanup });
	const started = time.now;
	const at = (ms: number) => new Date(ms).toISOString();
	assert.equal(attempts.pendingCleanupRetryAt(), null, 'nothing held yet');
	assert.equal(await cleanup.begin(token, expiresAt), 'still-pending');
	assert.equal(sent.length, 1, 'no send before the 120 seconds the server asked for');
	assert.deepEqual(time.slept, []);
	assert.equal(attempts.state(), 'cleanup-pending');
	assert.equal(attempts.pendingCleanupRetryAt(), at(started + 120_000), 'the pending state names when a retry may send');
	time.now = started + 119_999;
	assert.equal(await attempts.retryCleanup(), 'still-pending'); assert.equal(sent.length, 1, 'an explicit retry is held back too');
	time.now = started + 120_000;
	assert.equal(attempts.pendingCleanupRetryAt(), null, 'a retry may send now');
	assert.equal(await attempts.retryCleanup(), 'still-pending'); assert.equal(sent.length, 2, 'one send once the time has come');
	// That answer asked for 60 more seconds, counted from when it arrived.
	assert.equal(attempts.pendingCleanupRetryAt(), at(started + 180_000));
	time.now += 59_000;
	assert.equal(await attempts.retryCleanup(), 'still-pending'); assert.equal(sent.length, 2);
	time.now += 1_000;
	assert.equal(await attempts.retryCleanup(), 'revoked'); assert.equal(sent.length, 3);
	assert.equal(attempts.state(), 'idle');
	assert.equal(attempts.pendingCleanupRetryAt(), null, 'cleared on completion'); assert.equal(attempts.pendingCleanupExpiresAt(), null);
});

test('the device clock passing the session’s expiry is not revocation: the token stays held until the server confirms', async () => {
	const answers: Answer[] = [busy(503), busy(503), busy(503), busy(503), answered(401, { code: 'unauthorised' })];
	const { transport, sent } = fakeTransport(() => answers.shift()!);
	const { time, now, sleep } = fakeTime();
	const cleanup = createCleanup({ transport, sleep, now });
	assert.equal(await cleanup.begin(token, expiresAt), 'still-pending');
	time.now = Date.parse(expiresAt) + 86_400_000; // the phone's clock says the session expired a day ago
	assert.equal(cleanup.state(), 'pending'); assert.equal(cleanup.expiresAt(), expiresAt);
	assert.equal(await cleanup.retry(), 'still-pending', 'still held: only the server can confirm');
	assert.equal(await cleanup.retry(), 'revoked', 'a confirmed 401 ends it');
	assert.equal(sent.length, 5); assert.ok(sent.every((s) => s.token === token));
});

test('drift guard: every session the exchange accepts is one the credential store can save, and nothing more', () => {
	const tokens = [token, `sess_${'a'.repeat(42)}`, `sess_${'a'.repeat(44)}`, `sess_${'a'.repeat(42)}=`, `pks_${'a'.repeat(43)}`, `sess_${'A-_9'.repeat(10)}abc`];
	const instants = [expiresAt, '2030-02-01T00:00:00Z', '2030-02-30T00:00:00.000Z', '2030-02-01T00:00:00.000+00:00', '2030-02-01T24:00:00.000Z', '2001-01-01T00:00:00.000Z', '2030-02-01T00:00:00.0000Z'];
	const ids = [user.id, user.id.toUpperCase(), `{${user.id}}`];
	for (const t of tokens) for (const e of instants) for (const id of ids) {
		let parsed: ReturnType<typeof parseSignedIn> | null = null;
		try { parsed = parseSignedIn({ ...signedInBody, token: t, expiresAt: e, user: { ...user, id } }); } catch { /* refused */ }
		const storable = isStoredSession({ token: t, expiresAt: e, userId: id });
		assert.equal(parsed !== null, storable, `${t.slice(0, 8)}… ${e} ${id.slice(0, 4)}`);
		if (parsed) assert.ok(isStoredSession({ token: parsed.token, expiresAt: parsed.expiresAt, userId: parsed.user.id }));
	}
});

test('a retry-after that is due is not waited for twice, and a timer that fires early never sends early', async () => {
	// The answer's retry-after (5 s) is shorter than the next scheduled delay (10 s): the schedule applies.
	const quick = fakeTransport((() => { const a = [busy(503, 5), answered(200, { ok: true })]; return () => a.shift()!; })());
	const one = fakeTime();
	assert.equal(await createCleanup({ transport: quick.transport, sleep: one.sleep, now: one.now }).begin(token, expiresAt), 'revoked');
	assert.deepEqual(one.time.slept, [10_000]);
	// A timer that returns before the named time: nothing is sent early; the cleanup goes pending.
	const early = fakeTransport(() => busy(503, 20));
	const time = { now: 0 };
	const cleanup = createCleanup({ transport: early.transport, now: () => time.now, sleep: async (ms) => { time.now += ms - 1; } });
	assert.equal(await cleanup.begin(token, expiresAt), 'still-pending');
	assert.equal(early.sent.length, 1);
});

test('no secret leaks: outcomes, states, errors and cleanup wording never carry the code, verifier, attempt or a held token', async () => {
	const seen: string[] = []; const secrets: string[] = [];
	const record = (value: unknown) => seen.push(JSON.stringify(value) ?? '');
	for (const answer of [answered(401, { code: 'native_sign_in_disabled' }), answered(400), answered(503), { kind: 'no-answer', reason: 'network' } as Answer, answered(200, signedInBody)]) {
		const { platform, opened } = fakePlatform(); const { transport, sent } = fakeTransport(() => answer);
		const attempts = createAttempts({ platform, transport });
		const outcome = attempts.start(); await until(() => opened.length === 1);
		record(attempts.state());
		opened[0]!.resolve({ type: 'success', url: callbackFor(opened[0]!) });
		const result = await outcome;
		const body = sent[0]!.body as { code: string; verifier: string; attempt: string };
		secrets.push(body.code, body.verifier, body.attempt);
		record(result.kind === 'signed-in' ? { ...result, session: { ...result.session, token: undefined } } : result);
		record(attempts.state()); record(attempts.pendingCleanupExpiresAt());
	}
	record(String(new AttemptActive())); record(new AttemptActive().message);
	const { transport } = fakeTransport(() => answered(503));
	const cleanup = createCleanup({ transport, sleep: async () => undefined });
	const attempts = createAttempts({ platform: fakePlatform().platform, transport, cleanup });
	await cleanup.begin(token, expiresAt);
	record(attempts.state()); record(attempts.pendingCleanupExpiresAt()); record(cleanup.state()); record(cleanup.expiresAt()); record(await attempts.retryCleanup());
	try { await attempts.start(); } catch (error) { record(String(error)); record((error as Error).stack?.split('\n')[0]); }
	secrets.push(token);
	const all = seen.join('\n');
	for (const secret of secrets) assert.ok(!all.includes(secret), 'a secret appeared in an outcome, state, error or wording');
});
