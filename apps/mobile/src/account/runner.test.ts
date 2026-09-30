import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cleanup } from '../auth/cleanup.ts';
import type { ApiClient, ApiOutcome, AttemptOutcome, Attempts, AttemptState } from '../auth/contracts.ts';
import { createClampedClock } from './clock.ts';
import { createApiClient, createTransport, maxResponseBytes } from '../api/client.ts';
import { myWorkPath } from '../api/paths.ts';
import { beginRead, finishRead, initialWorkList } from '../work/my-work-list.ts';
import { parseMyWorkPage } from '../work/my-work.ts';
import type { CredentialStore, Generation, ReadScope, StoredSession } from './contracts.ts';
import { idleRevocation, type PersonScope } from './revocation.ts';
import { createAccountRunner, type AccountRunner, type Timers } from './runner.ts';

const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const orgA = 'c0ffee00-1234-4abc-9def-0123456789ab';
const orgB = 'd00dfeed-5678-4def-8abc-ba9876543210';
const token = (letter: string) => `sess_${letter.repeat(43)}`;
const stored = (letter: string): StoredSession => ({ token: token(letter), expiresAt: '2030-10-01T08:30:00.000Z', userId });
const meBody = (...organisations: string[]) => ({
	user: { id: userId, email: 'owner@example.test', name: 'Owner' }, passkeyVerified: true,
	memberships: organisations.map((organisationId) => ({ organisationId, organisationName: 'Org', role: 'owner', status: 'active' }))
});
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

type Call = { name: string; args: unknown[]; resolve(value: unknown): void; reject(error: unknown): void };
/** Records calls; each completes only when the test says so. */
class Calls {
	readonly all: Call[] = [];
	#open: Call[] = [];
	make<T>(name: string, args: unknown[]): Promise<T> {
		return new Promise<T>((resolve, reject) => { const call = { name, args, resolve: resolve as (v: unknown) => void, reject }; this.all.push(call); this.#open.push(call); });
	}
	names() { return this.all.map((c) => c.name); }
	/** The oldest unanswered call with this name. */
	take(name: string): Call {
		const index = this.#open.findIndex((c) => c.name === name);
		assert.ok(index >= 0, `expected a pending ${name}; open: ${this.#open.map((c) => c.name).join(', ')}`);
		return this.#open.splice(index, 1)[0]!;
	}
	async answer(name: string, value: unknown) { await drain(); this.take(name).resolve(value); await drain(); }
	async fail(name: string, error: unknown = new Error(`platform detail ${token('p')}`)) { await drain(); this.take(name).reject(error); await drain(); }
}

/** `client`: a real client to use instead of the recording fake (the byte-budget regression below).
 *  `slowAfterMs`: the runner's injected slow delay for "Sign out everywhere else". */
function harness(options: { storage?: boolean; client?: ApiClient; slowAfterMs?: number } = {}) {
	const calls = new Calls();
	let generation: (() => Generation) | null = null;
	const store: CredentialStore = {
		read: () => calls.make('read', []),
		install: (session, g) => calls.make('install', [session, g]),
		removeIf: (t) => calls.make('removeIf', [t]),
		readOrg: (u) => calls.make('readOrg', [u]),
		setOrg: (u, o, g) => calls.make('setOrg', [u, o, g]),
		forgetOrgIf: (u, o) => calls.make('forgetOrgIf', [u, o]),
		settled: () => Promise.resolve('settled')
	};
	const attemptState = { value: 'idle' as AttemptState, cancel: true };
	const attempts: Attempts = {
		state: () => attemptState.value,
		start: (returnTo) => { attemptState.value = 'awaiting-callback'; return calls.make<AttemptOutcome>('start', [returnTo]).finally(() => { attemptState.value = 'idle'; }); },
		cancel: () => { if (!attemptState.cancel) return false; attemptState.value = 'closing'; return true; },
		retryCleanup: async () => 'revoked', pendingCleanupExpiresAt: () => null, pendingCleanupRetryAfterMs: () => null
	};
	/** `getThrows` / `postThrows`: the next `get` / `post` throws synchronously (a broken client), without recording a
	 *  call. `postRaw`: the next `post` resolves with exactly what the test answers, not mapped to a client outcome (a
	 *  broken client resolving something unusable). */
	const flags = { getThrows: false, postThrows: false, postRaw: false };
	const client: ApiClient = {
		get: <T>(path: unknown, t: string | null, parse: (value: unknown) => T) => {
			if (flags.getThrows) { flags.getThrows = false; throw new Error(`client detail ${token('q')}`); }
			return calls.make<ApiOutcome<unknown>>('get', [path, t]).then((answer) => answer.ok ? { ok: true as const, value: parse(answer.value) } : answer as ApiOutcome<T>);
		},
		// As the real client: a 2xx body the parser refuses is `unavailable` with its status, never a rejection.
		post: <T>(path: unknown, t: string | null, body: unknown, parse: (value: unknown) => T) => {
			if (flags.postThrows) { flags.postThrows = false; throw new Error(`client detail ${token('q')}`); }
			if (flags.postRaw) { flags.postRaw = false; return calls.make<ApiOutcome<T>>('post', [path, t, body]); }
			return calls.make<ApiOutcome<unknown>>('post', [path, t, body]).then((answer): ApiOutcome<T> => {
				if (!answer.ok) return answer as ApiOutcome<T>;
				try { return { ok: true, value: parse(answer.value) }; } catch { return { ok: false, kind: 'unavailable', status: 200 }; }
			});
		}
	};
	const cleanupState = { value: 'none' as 'none' | 'running' | 'pending', retryAfterMs: null as number | null };
	const cleanup: Cleanup = {
		state: () => cleanupState.value,
		begin: (t, e) => { cleanupState.value = 'running'; return calls.make<'revoked' | 'still-pending'>('begin', [t, e]).then((r) => { cleanupState.value = r === 'revoked' ? 'none' : 'pending'; return r; }); },
		retry: () => { cleanupState.value = 'running'; return calls.make<'revoked' | 'still-pending'>('retry', []).then((r) => { cleanupState.value = r === 'revoked' ? 'none' : 'pending'; return r; }); },
		expiresAt: () => null, retryAfterMs: () => cleanupState.retryAfterMs
	};
	/** `throwNext`: the next `set` throws (a broken timer), setting nothing. */
	const timers = { fired: new Map<number, () => void>(), delays: new Map<number, number>(), next: 0, throwNext: false };
	const fakeTimers: Timers = {
		set: (ms, run) => {
			if (timers.throwNext) { timers.throwNext = false; throw new Error('timer detail'); }
			const id = ++timers.next; timers.fired.set(id, run); timers.delays.set(id, ms); return id;
		},
		clear: (id) => { timers.fired.delete(id as number); }
	};
	// `clock.now` is the raw monotonic reading the test controls; the runner clamps it. The wall clock is fixed at the
	// epoch, so a wait of N ms reads "about" new Date(N).
	const clock = { now: 0 };
	const snapshots: unknown[] = [];
	const runner = createAccountRunner({
		createStore: options.storage === false ? null : (current) => { generation = current; return store; },
		attempts, client: options.client ?? client, cleanup, timers: fakeTimers, clock: createClampedClock(() => clock.now), wallNow: () => 0,
		...(options.slowAfterMs === undefined ? {} : { slowAfterMs: options.slowAfterMs })
	});
	runner.subscribe((s) => snapshots.push(s));
	return { calls, runner, attemptState, cleanupState, timers, clock, snapshots, flags, generation: () => generation!() };
}
const account = (runner: AccountRunner) => runner.snapshot().account;
/** Nothing a screen can see ever holds a token. */
const tokenFree = (snapshots: unknown[]) => { const text = JSON.stringify(snapshots); assert.ok(!text.includes('sess_'), 'a token reached a snapshot'); };

async function signedInWithStoredSession(organisations: string[], storedChoice: string | null, options: Parameters<typeof harness>[0] = {}) {
	const t = harness(options);
	t.runner.start();
	await t.calls.answer('read', stored('a'));
	const me = t.calls.take('get');
	assert.deepEqual(me.args, ['/v1/me', token('a')]);
	me.resolve({ ok: true, value: meBody(...organisations) }); await drain();
	if (organisations.length > 0) await t.calls.answer('readOrg', storedChoice);
	return t;
}

test('launch: a saved session is checked with /v1/me before anything is shown as signed in', async () => {
	const t = harness();
	t.runner.start();
	assert.equal(account(t.runner).kind, 'starting');
	await t.calls.answer('read', stored('a'));
	assert.equal(account(t.runner).kind, 'checking');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	const loading = account(t.runner);
	assert.ok(loading.kind === 'signed-in' && !loading.ready, 'no organisation yet, so not ready');
	await t.calls.answer('readOrg', orgB);
	const ready = account(t.runner);
	assert.ok(ready.kind === 'signed-in' && ready.ready && ready.org.kind === 'chosen' && ready.org.membership.organisationId === orgB);
	tokenFree(t.snapshots);
});

test('launch: /v1/me unavailable is unverified with Retry-After pacing; Sign out releases the saved session', async () => {
	const t = harness();
	t.runner.start();
	await t.calls.answer('read', stored('a'));
	await t.calls.answer('get', { ok: false, kind: 'unavailable', status: 429, retryAfter: 30 });
	const unverified = account(t.runner);
	assert.deepEqual(unverified, { kind: 'unverified', retrying: false, wait: { until: 30_000, about: new Date(30_000).toISOString() } });
	t.clock.now = 29_999; t.runner.send({ type: 'retry' }); await drain();
	assert.equal(t.calls.names().filter((n) => n === 'get').length, 1, 'no early Try again');
	t.clock.now = 30_000; t.runner.send({ type: 'retry' }); await drain();
	assert.equal(t.calls.names().filter((n) => n === 'get').length, 2);
	await t.calls.answer('get', { ok: false, kind: 'unavailable', status: 0 });
	t.runner.send({ type: 'sign-out' }); await drain();
	assert.deepEqual(t.calls.take('removeIf').args, [token('a')]);
	assert.deepEqual(t.calls.take('begin').args, [token('a'), '2030-10-01T08:30:00.000Z']);
	tokenFree(t.snapshots);
});

test('storage unavailable: native sign-in is never offered and nothing is read', async () => {
	const t = harness({ storage: false });
	t.runner.start(); await drain();
	assert.equal(account(t.runner).kind, 'storage-unavailable');
	assert.equal(t.runner.snapshot().signInOffered, false);
	t.runner.send({ type: 'sign-in' }); await drain();
	assert.deepEqual(t.calls.names(), []);
});

test('unreadable storage: Try reading again reads again; a failed read never becomes "nothing stored"', async () => {
	const t = harness();
	t.runner.start();
	await t.calls.fail('read');
	assert.equal(account(t.runner).kind, 'storage-unreadable');
	t.runner.send({ type: 'retry' }); await drain();
	await t.calls.answer('read', null);
	assert.deepEqual(account(t.runner), { kind: 'signed-out', notice: null, gate: 'idle' });
});

test('sign-in: gate, attempt, save, verify, then the destination; the save uses the advanced account generation', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', null);
	t.runner.send({ type: 'sign-in', returnTo: '/equipment' }); await drain();
	const start = t.calls.take('start');
	assert.deepEqual(start.args, ['/equipment']);
	start.resolve({ kind: 'signed-in', session: { token: token('b'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/equipment' } });
	await drain();
	const install = t.calls.take('install');
	assert.deepEqual(install.args[0], stored('b'));
	assert.deepEqual(install.args[1], t.generation());
	assert.equal((install.args[1] as Generation).account, 1);
	assert.deepEqual(account(t.runner), { kind: 'signing-in', phase: 'saving', slow: false });
	install.resolve('written'); await drain();
	assert.equal(account(t.runner).kind, 'checking');
	await t.calls.answer('get', { ok: true, value: meBody(orgA) });
	const between = account(t.runner);
	assert.ok(between.kind === 'signed-in' && !between.ready && between.destination === null, 'no destination while the choice is read');
	await t.calls.answer('readOrg', null);
	const setOrg = t.calls.take('setOrg');
	assert.deepEqual(setOrg.args.slice(0, 2), [userId, orgA], 'the only membership is chosen and remembered');
	const ready = account(t.runner);
	assert.ok(ready.kind === 'signed-in' && ready.ready && ready.destination === '/equipment');
	tokenFree(t.snapshots);
});

test('a failed save that may have written is compare-deleted and revoked; sign-in waits until both have results', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', null);
	t.runner.send({ type: 'sign-in' }); await drain();
	t.calls.take('start').resolve({ kind: 'signed-in', session: { token: token('b'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/' } });
	await drain();
	await t.calls.fail('install');
	assert.deepEqual(t.calls.take('removeIf').args, [token('b')]);
	const begin = t.calls.take('begin');
	assert.deepEqual(begin.args[0], token('b'));
	// The save had in fact written: the compare-delete finds and deletes it.
	t.calls.all.filter((c) => c.name === 'removeIf')[0]!.resolve('deleted');
	t.cleanupState.retryAfterMs = 10_000;
	begin.resolve('still-pending'); await drain();
	const pending = account(t.runner);
	assert.ok(pending.kind === 'releasing' && pending.reason === 'save-failed' && pending.local === 'deleted' && pending.server === 'pending');
	assert.deepEqual(pending.wait, { until: 10_000, about: new Date(10_000).toISOString() });
	assert.equal(t.runner.snapshot().signInOffered, false);
	const starts = t.calls.names().filter((n) => n === 'start').length;
	t.runner.send({ type: 'sign-in' }); await drain();
	assert.equal(t.calls.names().filter((n) => n === 'start').length, starts, 'no sign-in while the handle is held');
	t.clock.now = 9_999; t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(t.calls.names().filter((n) => n === 'retry'), [], "no Try again before the cleanup's server wait");
	t.clock.now = 10_000; t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(t.calls.names().filter((n) => n === 'removeIf').length, 1, 'the local copy is already deleted: no second removal');
	await t.calls.answer('retry', 'revoked');
	assert.deepEqual(account(t.runner), { kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'save-failed', local: 'deleted', server: 'ended' } });
	// Released: the gate opens again.
	t.runner.send({ type: 'sign-in' }); await drain();
	assert.equal(t.calls.names().filter((n) => n === 'start').length, starts + 1);
	tokenFree(t.snapshots);
});

test('sign-out: a copy that may remain with revocation pending warns about closing the app; Try again retries both', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	t.runner.send({ type: 'sign-out' }); await drain();
	await t.calls.fail('removeIf');
	await t.calls.answer('begin', 'still-pending');
	const warned = account(t.runner);
	assert.ok(warned.kind === 'releasing' && warned.closeAppWarning && warned.local === 'copy-may-remain' && warned.server === 'pending');
	assert.deepEqual(t.calls.names().filter((n) => n === 'forgetOrgIf'), [], 'the per-person organisation choice is kept');
	t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(t.calls.take('removeIf').args, [token('a')], 'the local compare-delete is retried');
	t.calls.take('retry').resolve('revoked'); await drain();
	assert.equal(account(t.runner).kind, 'releasing', 'still waiting for the local result');
	t.calls.all.filter((c) => c.name === 'removeIf')[1]!.resolve('absent'); await drain();
	assert.deepEqual(account(t.runner), { kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'sign-out', local: 'no-usable-copy', server: 'ended' } });
	tokenFree(t.snapshots);
});

test('a 401 from /v1/me ends the session: compare-delete only, no revocation', async () => {
	const t = harness();
	t.runner.start();
	await t.calls.answer('read', stored('a'));
	await t.calls.answer('get', { ok: false, kind: 'unauthorised' });
	await t.calls.answer('removeIf', 'deleted');
	assert.deepEqual(t.calls.names().filter((n) => n === 'begin'), []);
	assert.deepEqual(account(t.runner), { kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'session-ended', local: 'deleted', server: 'not-needed' } });
});

test('a malformed /v1/me answer is unavailable, never a sign-out', async () => {
	const t = harness();
	t.runner.start();
	await t.calls.answer('read', stored('a'));
	await t.calls.answer('get', { ok: true, value: { user: { id: userId }, memberships: [] } });
	assert.equal(account(t.runner).kind, 'unverified');
	assert.deepEqual(t.calls.names().filter((n) => n === 'removeIf'), []);
});

test('the gate refuses while a cleanup is held or the attempt core is busy, and says busy', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', null);
	t.cleanupState.value = 'pending';
	t.runner.send({ type: 'sign-in' }); await drain();
	assert.deepEqual(account(t.runner), { kind: 'signed-out', notice: null, gate: 'busy' });
	t.cleanupState.value = 'none'; t.attemptState.value = 'closing';
	t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(account(t.runner), { kind: 'signed-out', notice: null, gate: 'busy' });
	t.attemptState.value = 'idle';
	t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(t.calls.names().filter((n) => n === 'start').length, 1);
});

test('cancel: closing until the browser call settles, slow wording after ten seconds, then a neutral cancelled notice', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', null);
	t.runner.send({ type: 'sign-in' }); await drain();
	t.runner.send({ type: 'cancel' }); await drain();
	assert.deepEqual(account(t.runner), { kind: 'signing-in', phase: 'closing', slow: false });
	const [id, fire] = [...t.timers.fired.entries()].pop()!;
	fire(); t.timers.fired.delete(id);
	assert.deepEqual(account(t.runner), { kind: 'signing-in', phase: 'closing', slow: true });
	await t.calls.answer('start', { kind: 'cancelled' });
	assert.deepEqual(account(t.runner), { kind: 'signed-out', notice: { kind: 'sign-in', outcome: 'cancelled' }, gate: 'idle' });
});

test('a revocation refused because the cleanup slot holds another session is a fault; the handle is kept and only a Try again with the slot free begins it', async () => {
	const t = await signedInWithStoredSession([orgA], null);
	await drain(); t.calls.take('setOrg').resolve('written'); await drain();
	t.cleanupState.value = 'pending'; // the one slot holds a token this runner did not give it
	t.runner.send({ type: 'sign-out' }); await drain();
	await t.calls.answer('removeIf', 'deleted');
	assert.deepEqual(t.calls.names().filter((n) => n === 'begin' || n === 'retry'), [], 'nothing began and nothing was retried');
	const refused = t.runner.snapshot();
	assert.ok(refused.fault && refused.account.kind === 'releasing' && refused.account.server === 'refused' && refused.account.canRetry);
	assert.equal(refused.signInOffered, false);
	t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(t.calls.names().filter((n) => n === 'begin' || n === 'retry'), [], "the other session's retry is never used for this one");
	const still = account(t.runner);
	assert.ok(still.kind === 'releasing' && still.server === 'refused');
	t.cleanupState.value = 'none';
	t.runner.send({ type: 'retry' }); await drain();
	assert.deepEqual(t.calls.take('begin').args, [token('a'), '2030-10-01T08:30:00.000Z']);
	t.calls.all.filter((c) => c.name === 'begin')[0]!.resolve('revoked'); await drain();
	assert.deepEqual(account(t.runner), { kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'sign-out', local: 'deleted', server: 'ended' } });
	tokenFree(t.snapshots);
});

// ---------------------------------------------------------------------------------------------------------------
// Organisation-scoped reads (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1–§3.2).

const identity = (value: unknown) => value;
const stockPath = (scope: ReadScope) => `/v1/organisations/${scope.organisationId}/stock` as never;
/** The scope the snapshot shows now (what a screen would pass as `expected`). */
const shown = (runner: AccountRunner): ReadScope => {
	const view = account(runner);
	assert.ok(view.kind === 'signed-in' && view.scope !== null, 'expected a ready scope');
	return view.scope;
};
const getCount = (t: ReturnType<typeof harness>) => t.calls.all.filter((c) => c.name === 'get').length;
const meSends = (t: ReturnType<typeof harness>) => t.calls.all.filter((c) => c.name === 'get' && c.args[0] === '/v1/me').length;
/** No outcome, snapshot or call argument other than the transport's own ever carries a token to a screen. */
const outcomesTokenFree = (...outcomes: unknown[]) => assert.ok(!JSON.stringify(outcomes).includes('sess_'), 'a token reached an outcome');

test('scoped reads: nothing is sent before ready; the path is built from the runner\'s own scope; a 403 only refreshes membership, 30 s after the launch check', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', stored('a'));
	const guessed: ReadScope = { epoch: 'a0.o0', userId, organisationId: orgA };
	assert.deepEqual(await t.runner.organisationRead(guessed, stockPath, identity), { kind: 'superseded' }, 'checking: superseded');
	assert.equal(getCount(t), 1, 'only the launch /v1/me was sent');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	assert.deepEqual(await t.runner.organisationRead(guessed, stockPath, identity), { kind: 'superseded' }, 'verified but no organisation chosen yet: superseded');
	await t.calls.answer('readOrg', orgA);
	const scope = shown(t.runner);
	assert.equal(scope.organisationId, orgA); assert.equal(scope.userId, userId);
	const given: ReadScope[] = [];
	t.clock.now = 30_000; // the refusal spacing is measured from the launch check (§3.2)
	const read = t.runner.organisationRead({ ...scope }, (current) => { given.push(current); return stockPath(current); }, identity);
	const sent = t.calls.take('get');
	assert.deepEqual(sent.args, [`/v1/organisations/${orgA}/stock`, token('a')], 'sent synchronously, before any await');
	assert.deepEqual(given, [scope], 'the path function is given the runner\'s current scope');
	sent.resolve({ ok: false, kind: 'refused', status: 403, code: 'forbidden' });
	const refused = await read;
	assert.deepEqual(refused, { kind: 'refused', status: 403 });
	const refresh = t.calls.take('get');
	assert.deepEqual(refresh.args, ['/v1/me', token('a')], 'only a fresh membership list is asked for');
	const chosen = account(t.runner);
	assert.ok(chosen.kind === 'signed-in' && chosen.org.kind === 'chosen' && chosen.org.membership.organisationId === orgA, 'nothing removed on the refusal');
	refresh.resolve({ ok: true, value: meBody(orgA, orgB) }); await drain();
	outcomesTokenFree(refused); tokenFree(t.snapshots);
});

test('scoped reads: a 403 within 30 s of the launch check refreshes nothing; a 400 never refreshes; each read is sent once', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const scope = shown(t.runner);
	t.clock.now = 29_999;
	const early = t.runner.organisationRead(scope, stockPath, identity);
	t.calls.take('get').resolve({ ok: false, kind: 'refused', status: 404, code: 'not_found' });
	assert.deepEqual(await early, { kind: 'refused', status: 404 });
	await drain();
	assert.equal(meSends(t), 1, 'inside the spacing: no /v1/me, and nothing recorded to retry');
	t.clock.now = 60_000;
	const bad = t.runner.organisationRead(scope, stockPath, identity);
	t.calls.take('get').resolve({ ok: false, kind: 'refused', status: 400, code: 'invalid_request' });
	assert.deepEqual(await bad, { kind: 'refused', status: 400 });
	await drain();
	assert.equal(meSends(t), 1, 'a 400 is a client problem, never an access check');
	assert.equal(getCount(t), 3, 'the launch check and exactly one send per read');
});

test('scoped reads: an expected scope that is not the current one sends nothing (a screen rendered before a change)', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const before = shown(t.runner);
	t.runner.send({ type: 'choose-organisation', organisationId: orgB }); await drain();
	const now = shown(t.runner);
	assert.notEqual(now.epoch, before.epoch);
	const sends = getCount(t);
	assert.deepEqual(await t.runner.organisationRead(before, stockPath, identity), { kind: 'superseded' }, 'the old epoch');
	assert.deepEqual(await t.runner.organisationRead({ ...now, organisationId: orgA }, stockPath, identity), { kind: 'superseded' }, 'the current epoch with another organisation');
	assert.deepEqual(await t.runner.organisationRead({ ...now, userId: '0190c0de-0000-7000-8000-000000000099' }, stockPath, identity), { kind: 'superseded' }, 'the current epoch with another user');
	assert.deepEqual(await t.runner.organisationRead({ ...now, epoch: `${now.epoch}x` }, stockPath, identity), { kind: 'superseded' }, 'another epoch for the same IDs');
	assert.equal(getCount(t), sends, 'none of them sent anything');
	const current = t.runner.organisationRead(now, stockPath, identity);
	assert.deepEqual(t.calls.take('get').args, [`/v1/organisations/${orgB}/stock`, token('a')], 'the current scope is read');
	t.calls.all.at(-1)!.resolve({ ok: true, value: { items: [] } });
	assert.deepEqual(await current, { kind: 'ok', value: { items: [] } });
});

test('scoped reads: an answer that arrives after a switch, or after A → B → A, is superseded, never applied to the new scope', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const a1 = shown(t.runner);
	const late = t.runner.organisationRead(a1, stockPath, identity);
	const lateCall = t.calls.take('get');
	t.runner.send({ type: 'choose-organisation', organisationId: orgB }); await drain();
	lateCall.resolve({ ok: true, value: { items: ['from A'] } });
	assert.deepEqual(await late, { kind: 'superseded' }, 'a switch during the flight');
	// A → B → A: the organisation is A again, but it is a new epoch, so the first A read's answer is not current.
	const aba = t.runner.organisationRead(shown(t.runner), stockPath, identity);
	const abaCall = t.calls.take('get');
	t.runner.send({ type: 'choose-organisation', organisationId: orgA }); await drain();
	const a2 = shown(t.runner);
	assert.equal(a2.organisationId, orgA); assert.notEqual(a2.epoch, a1.epoch);
	abaCall.resolve({ ok: true, value: { items: ['from B'] } });
	assert.deepEqual(await aba, { kind: 'superseded' });
	const oldA = t.runner.organisationRead(a1, stockPath, identity);
	assert.deepEqual(await oldA, { kind: 'superseded' }, 'the first A scope is never current again');
});

test('scoped reads: a membership refresh that keeps the organisation keeps the epoch, so a read in flight still applies', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const scope = shown(t.runner);
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	const me = t.calls.take('get');
	assert.deepEqual(me.args, ['/v1/me', token('a')]);
	const read = t.runner.organisationRead(scope, stockPath, identity);
	const readCall = t.calls.take('get');
	me.resolve({ ok: true, value: meBody(orgA, orgB, 'feedface-9999-4aaa-8bbb-cccccccccccc') }); await drain();
	assert.equal(shown(t.runner).epoch, scope.epoch, 'new membership list, same organisation: same epoch');
	readCall.resolve({ ok: true, value: { items: ['kept'] } });
	assert.deepEqual(await read, { kind: 'ok', value: { items: ['kept'] } });
});

test('scoped reads: a 401 ends the current session and is superseded; a late 401 from an old session\'s read changes nothing', async () => {
	// The current session: a 401 releases it (compare-delete, no revocation), and the read is superseded.
	const t = await signedInWithStoredSession([orgA], null);
	await drain(); t.calls.take('setOrg').resolve('written'); await drain();
	const current = t.runner.organisationRead(shown(t.runner), stockPath, identity);
	t.calls.take('get').resolve({ ok: false, kind: 'unauthorised' });
	assert.deepEqual(await current, { kind: 'superseded' }, 'the account dispatch runs first, so a 401 is superseded');
	const releasing = account(t.runner);
	assert.ok(releasing.kind === 'releasing' && releasing.reason === 'session-ended' && releasing.server === 'not-needed');
	assert.deepEqual(t.calls.take('removeIf').args, [token('a')]);

	// An old session's read that answers 401 after a sign-out and a new sign-in.
	const u = await signedInWithStoredSession([orgA, orgB], orgA);
	const old = u.runner.organisationRead(shown(u.runner), stockPath, identity);
	const oldCall = u.calls.take('get');
	u.runner.send({ type: 'sign-out' }); await drain();
	await u.calls.answer('removeIf', 'deleted'); await u.calls.answer('begin', 'revoked');
	assert.equal(account(u.runner).kind, 'signed-out');
	u.runner.send({ type: 'sign-in' }); await drain();
	u.calls.take('start').resolve({ kind: 'signed-in', session: { token: token('b'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/' } });
	await drain();
	await u.calls.answer('install', 'written');
	const me = u.calls.take('get');
	assert.deepEqual(me.args, ['/v1/me', token('b')]);
	me.resolve({ ok: true, value: meBody(orgA, orgB) }); await drain();
	await u.calls.answer('readOrg', orgA);
	const fresh = shown(u.runner);
	const removals = u.calls.names().filter((n) => n === 'removeIf').length;
	oldCall.resolve({ ok: false, kind: 'unauthorised' });
	assert.deepEqual(await old, { kind: 'superseded' });
	await drain();
	assert.deepEqual(shown(u.runner), fresh, 'the new session is untouched');
	assert.equal(u.calls.names().filter((n) => n === 'removeIf').length, removals, 'nothing of the new session is removed');
	tokenFree(u.snapshots);
});

test('scoped reads: a path function that throws is a client bug, and nothing is sent', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const scope = shown(t.runner);
	const sends = getCount(t);
	assert.deepEqual(await t.runner.organisationRead(scope, () => { throw new TypeError('bad path'); }, identity), { kind: 'client-bug' });
	// The real builder refusing an offset past the page cap (a hook bug) is the same.
	assert.deepEqual(await t.runner.organisationRead(scope, (current) => myWorkPath(current, 500), identity), { kind: 'client-bug' });
	assert.equal(getCount(t), sends, 'nothing sent');
	const valid = t.runner.organisationRead(scope, (current) => myWorkPath(current, 0), identity);
	assert.deepEqual(t.calls.take('get').args, [`/v1/organisations/${orgA}/tasks?ownerId=${userId}&status=open&offset=0&limit=50`, token('a')]);
	t.calls.all.at(-1)!.resolve({ ok: true, value: { tasks: [], nextOffset: null } });
	assert.deepEqual(await valid, { kind: 'ok', value: { tasks: [], nextOffset: null } });
});

test('scoped reads never reject: a client that rejects or throws is a client bug, with no account effect; after a switch it is superseded', async () => {
	// #198 §3.1: any unexpected throw resolves as `client-bug`. The real client and transport resolve every network and
	// server condition, so a rejection can only be a programming error, never "unavailable".
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const scope = shown(t.runner);
	const before = t.runner.snapshot();
	t.clock.now = 60_000; // outside the refusal spacing, so a wrongly dispatched refusal would be visible as a /v1/me
	const rejected = t.runner.organisationRead(scope, stockPath, identity);
	await t.calls.fail('get');
	assert.deepEqual(await rejected, { kind: 'client-bug' });
	assert.equal(t.runner.snapshot(), before, 'no account effect at all: same snapshot object');
	assert.equal(meSends(t), 1, 'no /v1/me');
	// A client whose `get` throws synchronously: the same, and the returned promise still resolves.
	t.flags.getThrows = true;
	const thrown = t.runner.organisationRead(scope, stockPath, identity);
	assert.ok(thrown instanceof Promise);
	assert.deepEqual(await thrown, { kind: 'client-bug' });
	assert.equal(t.runner.snapshot(), before);
	// A rejection that arrives after a switch is dropped like any late answer.
	const late = t.runner.organisationRead(scope, stockPath, identity);
	const lateCall = t.calls.take('get');
	t.runner.send({ type: 'choose-organisation', organisationId: orgB }); await drain();
	lateCall.reject(new Error(`client detail ${token('r')}`));
	assert.deepEqual(await late, { kind: 'superseded' });
	outcomesTokenFree(await rejected, await thrown, await late);
	tokenFree(t.snapshots);
});

test('scoped reads: a read\'s Retry-After is its own wait, separate from the account\'s /v1/me wait, in both directions', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const scope = shown(t.runner);
	t.clock.now = 10_000;
	const busy = t.runner.organisationRead(scope, stockPath, identity);
	t.calls.take('get').resolve({ ok: false, kind: 'unavailable', status: 429, retryAfter: 20 });
	assert.deepEqual(await busy, { kind: 'unavailable', wait: { until: 30_000, about: new Date(20_000).toISOString() } }, 'measured on the shared clamped clock when the answer arrived');
	const noWait = t.runner.organisationRead(scope, stockPath, identity);
	t.calls.take('get').resolve({ ok: false, kind: 'unavailable', status: 0 });
	assert.deepEqual(await noWait, { kind: 'unavailable', wait: null });
	// The read's wait does not hold the account: a foreground refresh 30 s after the launch check is sent at once.
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meSends(t), 2, 'the business wait did not become an account wait');
	// And the account's wait does not hold reads: a 429 on /v1/me, then a read is still sent.
	await t.calls.answer('get', { ok: false, kind: 'unavailable', status: 429, retryAfter: 600 });
	const during = t.runner.organisationRead(shown(t.runner), stockPath, identity);
	const call = t.calls.take('get');
	assert.deepEqual(call.args, [`/v1/organisations/${orgA}/stock`, token('a')], 'sent despite the account wait');
	call.resolve({ ok: true, value: { items: [] } });
	assert.deepEqual(await during, { kind: 'ok', value: { items: [] } });
	t.clock.now = 60_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meSends(t), 2, 'the account wait still holds /v1/me');
});

test('start reads the saved sign-in once', async () => {
	const t = harness();
	t.runner.start(); t.runner.start(); await drain();
	assert.deepEqual(t.calls.names(), ['read']);
});

test('a stored organisation choice that is no longer a membership is forgotten and the chooser is shown', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], 'feedface-9999-4aaa-8bbb-cccccccccccc');
	assert.deepEqual(t.calls.take('forgetOrgIf').args, [userId, 'feedface-9999-4aaa-8bbb-cccccccccccc']);
	const chooser = account(t.runner);
	assert.ok(chooser.kind === 'signed-in' && chooser.org.kind === 'choose' && !chooser.ready);
	assert.deepEqual(chooser.orgNotice, { kind: 'lost-unnamed' }, 'only the stored ID was known: nothing is named');
	t.runner.send({ type: 'choose-organisation', organisationId: orgA }); await drain();
	assert.equal((account(t.runner) as { orgNotice: unknown }).orgNotice, null, "the person's own choice clears the notice");
	const setOrg = t.calls.take('setOrg');
	assert.deepEqual(setOrg.args.slice(0, 2), [userId, orgA]);
	assert.deepEqual(setOrg.args[2], t.generation(), 'saved under the current generation');
	// Not remembered: the choice still stands for this session, and the person is told.
	setOrg.reject(new Error('x')); await drain();
	const ready = account(t.runner);
	assert.ok(ready.kind === 'signed-in' && ready.ready && ready.notice?.kind === 'organisation-not-remembered');
});

// ---------------------------------------------------------------------------------------------------------------
// Snapshot identity (composition plan §3).

test('snapshot: the same object until the machine changes; an ignored event neither allocates nor notifies', async () => {
	const t = harness();
	const first = t.runner.snapshot();
	assert.equal(t.runner.snapshot(), first, 'no event: same object');
	t.runner.start(); await t.calls.answer('read', null);
	const signedOut = t.runner.snapshot();
	assert.notEqual(signedOut, first, 'a changing event gives a new object');
	assert.equal(t.runner.snapshot(), signedOut);
	const notified = t.snapshots.length;
	t.runner.send({ type: 'refresh' }); t.runner.send({ type: 'cancel' }); t.runner.send({ type: 'destination-used' }); await drain();
	assert.equal(t.runner.snapshot(), signedOut, 'ignored events: same object');
	assert.equal(t.snapshots.length, notified, 'ignored events: no listener notified');
	tokenFree(t.snapshots);
});

// ---------------------------------------------------------------------------------------------------------------
// /v1/me pacing (composition plan §3).

const meCount = (t: ReturnType<typeof harness>) => t.calls.all.filter((c) => c.name === 'get' && c.args[0] === '/v1/me').length;

test('pacing: the launch check counts as a load start; a foreground refresh waits 30 s after it, exactly at the boundary', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	assert.equal(meCount(t), 1);
	t.clock.now = 29_999; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 1, 'within 30 s of the launch check: nothing sent');
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 2, 'at exactly 30 s: sent');
	const refreshing = account(t.runner);
	assert.ok(refreshing.kind === 'signed-in' && refreshing.refreshing && refreshing.ready, 'the page stays while checking');
});

test('pacing: a burst of 20 foreground transitions sends one load, coalesced with the one in flight', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	t.clock.now = 60_000;
	for (let i = 0; i < 20; i += 1) t.runner.send({ type: 'refresh' });
	await drain();
	assert.equal(meCount(t), 2);
});

test('pacing: a server wait from a refresh blocks every trigger until exactly its end; success clears it', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	await t.calls.answer('get', { ok: false, kind: 'unavailable', status: 429, retryAfter: 60 });
	const kept = account(t.runner);
	assert.ok(kept.kind === 'signed-in' && kept.ready && !kept.refreshing, 'unavailable keeps the state');
	// A refusal from an organisation read is subject to the server wait too (the account wait does not stop the read).
	const read = t.runner.organisationRead(shown(t.runner), stockPath, identity); await drain();
	t.clock.now = 89_999;
	t.calls.take('get').resolve({ ok: false, kind: 'refused', status: 403, code: 'forbidden' });
	assert.deepEqual(await read, { kind: 'refused', status: 403 }); await drain();
	t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 2, 'nothing before the server wait, from a refusal or a refresh');
	t.clock.now = 90_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 3, 'at exactly the server wait: sent');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	t.clock.now = 120_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 4, 'a successful answer cleared the wait; only the 30 s spacing applies');
});

test('pacing: a clock reading that goes backwards is clamped, so a wait never ends early', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	t.clock.now = 50_000; t.runner.send({ type: 'refresh' }); await drain();
	t.clock.now = 10_000; // the source went backwards when the answer arrived
	await t.calls.answer('get', { ok: false, kind: 'unavailable', status: 503, retryAfter: 60 });
	t.clock.now = 80_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 2, 'the wait runs from the clamped 50 s, to 110 s, not from the backward reading');
	t.clock.now = 110_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meCount(t), 3);
});

test('pacing: a wait survives sign-out; the next session\'s first check shows unverified with it, never a silent check', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', stored('a'));
	await t.calls.answer('get', { ok: false, kind: 'unavailable', status: 429, retryAfter: 100 });
	t.runner.send({ type: 'sign-out' }); await drain();
	await t.calls.answer('removeIf', 'deleted'); await t.calls.answer('begin', 'revoked');
	assert.equal(account(t.runner).kind, 'signed-out');
	t.clock.now = 5_000;
	t.runner.send({ type: 'sign-in' }); await drain();
	t.calls.take('start').resolve({ kind: 'signed-in', session: { token: token('b'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/' } });
	await drain();
	await t.calls.answer('install', 'written');
	assert.deepEqual(account(t.runner), { kind: 'unverified', retrying: false, wait: { until: 100_000, about: new Date(100_000).toISOString() } });
	assert.equal(meCount(t), 1, 'nothing sent for the new session before the wait');
	t.clock.now = 100_000; t.runner.send({ type: 'retry' }); await drain();
	assert.equal(meCount(t), 2);
	tokenFree(t.snapshots);
});

test('pacing: a full restart (a new runner) starts with no wait', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', stored('a'));
	assert.equal(account(t.runner).kind, 'checking', 'a fresh process checks at once');
});

test('refresh: loss of the chosen organisation names it, forgets the stored choice and makes the tabs not ready', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	await t.calls.answer('get', { ok: true, value: meBody(orgB) });
	assert.deepEqual(t.calls.take('forgetOrgIf').args, [userId, orgA]);
	const lost = account(t.runner);
	assert.ok(lost.kind === 'signed-in');
	assert.deepEqual(lost.orgNotice, { kind: 'lost', name: 'Org' });
	// The only remaining membership is chosen automatically; the notice stays so the loss is still reported.
	assert.ok(lost.ready && lost.org.kind === 'chosen' && lost.org.membership.organisationId === orgB);
});

test('refresh: a 401 releases the session', async () => {
	const t = await signedInWithStoredSession([orgA], null);
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	await t.calls.answer('get', { ok: false, kind: 'unauthorised' });
	const releasing = account(t.runner);
	assert.ok(releasing.kind === 'releasing' && releasing.reason === 'session-ended' && releasing.server === 'not-needed');
});

// ---------------------------------------------------------------------------------------------------------------
// Byte budget through a scoped read (docs/plans/expo-mobile-response-byte-budget-2026-09.md §2.3 and §3 "Scoped read").
// The real transport and client, with a fake `send` whose body is a byte stream.

type FakeStream = { reads: number; cancels: unknown[] };
/** A response whose body yields `chunks`, then done; records reads and cancels. */
function streamed(url: string, status: number, chunks: readonly Uint8Array[], headers: Record<string, string> = {}, record?: FakeStream) {
	let next = 0;
	return {
		status, redirected: false, url, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
		body: {
			getReader: () => ({
				read: async () => {
					if (record) record.reads += 1;
					return next < chunks.length ? { done: false, value: chunks[next++] } : { done: true, value: undefined };
				},
				cancel: async (reason?: unknown) => { record?.cancels.push(reason); },
				releaseLock: () => undefined
			})
		}
	};
}
const jsonChunk = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** More than `maxResponseBytes` in 64 KiB chunks, with no content-length: only the byte count can refuse it. */
const oversizedChunks = () => {
	const chunk = new Uint8Array(65_536).fill(0x20);
	const first = chunk.slice();
	// A valid task page followed by legal JSON whitespace: absent the budget this would be usable data.
	first.set(jsonChunk(taskBody('00000000-0000-4000-8000-000000000001')));
	return Array.from({ length: Math.floor(maxResponseBytes / chunk.byteLength) + 2 }, (_, index) => index === 0 ? first : chunk);
};
const taskBody = (id: string) => ({ tasks: [{ id, title: 'Kept task', ownerId: userId, status: 'open', due: null, tags: [] }], nextOffset: null });

/** A ready runner (organisation A) over the real client; `tasks` answers each organisation read in order. */
async function readyOverRealTransport(tasks: ((url: string) => ReturnType<typeof streamed>)[]) {
	const signals: AbortSignal[] = [];
	const origin = 'https://api.example.test';
	const send = (async (url: string, init: { signal: AbortSignal }) => {
		signals.push(init.signal);
		if (url === `${origin}/v1/me`) return streamed(url, 200, [jsonChunk(meBody(orgA, orgB))]);
		const answer = tasks.shift();
		assert.ok(answer, 'no unexpected organisation read');
		return answer(url);
	}) as unknown as Parameters<typeof createTransport>[0]['send'];
	const t = harness({ client: createApiClient(createTransport({ origin, send })) });
	t.runner.start();
	await t.calls.answer('read', stored('a'));
	await drain();
	await t.calls.answer('readOrg', orgA);
	return { t, signals };
}

test('byte budget: an oversized scoped read is unavailable, never a client bug; the list keeps its rows; the account is untouched', async () => {
	const record: FakeStream = { reads: 0, cancels: [] };
	const chunks = oversizedChunks();
	const kept = '00000000-0000-4000-8000-000000000001';
	const { t, signals } = await readyOverRealTransport([
		(url) => streamed(url, 200, [jsonChunk(taskBody(kept))]),
		(url) => streamed(url, 200, chunks, {}, record)
	]);
	const scope = shown(t.runner);
	const readPage = (offset: number) => t.runner.organisationRead(scope, (current) => myWorkPath(current, offset), (value) => parseMyWorkPage(value, { scope, offset }));

	// A first page loads through the real transport and parser.
	const first = beginRead(initialWorkList, 'first', 0)!;
	const loaded = finishRead(first.state, first.seq, await readPage(0));
	assert.deepEqual(loaded.rows.map((row) => row.id), [kept]);

	// Refresh: the answer is a 200 whose body crosses the budget.
	const refresh = beginRead(loaded, 'refresh', 0)!;
	const outcome = await readPage(0);
	assert.deepEqual(outcome, { kind: 'unavailable', wait: null }, 'unavailable, not client-bug');
	const after = finishRead(refresh.state, refresh.seq, outcome);
	assert.deepEqual(after.rows.map((row) => row.id), [kept], 'the list keeps its rows');
	assert.deepEqual(after.problem, { op: 'refresh', kind: 'unavailable', wait: null }, '"Couldn\'t refresh", never an empty list');

	// The transport stopped at the crossing chunk: no further read, the stream cancelled, the request aborted.
	const crossing = Math.floor(maxResponseBytes / 65_536) + 1;
	assert.equal(record.reads, crossing, 'no read after the chunk that crossed the budget');
	assert.deepEqual(record.cancels, ['budget']);
	assert.equal(signals.at(-1)!.aborted, true);

	// The account is unaffected: still ready, same scope, no session effect.
	const view = account(t.runner);
	assert.ok(view.kind === 'signed-in' && view.ready && view.scope?.epoch === scope.epoch);
	tokenFree(t.snapshots);
});

// ---------------------------------------------------------------------------------------------------------------
// Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §4, §5a.3-4; C1-C4).

/** The person scope the snapshot shows now (what the screen captures when the confirmation opens). */
const personShown = (runner: AccountRunner): PersonScope => {
	const view = account(runner);
	assert.ok(view.kind === 'signed-in', 'expected a signed-in person');
	return view.person;
};
const postCount = (t: ReturnType<typeof harness>) => t.calls.all.filter((c) => c.name === 'post').length;
/** The newest timer the runner has set since `before` (its id and fire function). */
const newestTimer = (t: ReturnType<typeof harness>, before: number) => {
	assert.ok(t.timers.next > before, 'expected a timer');
	const id = t.timers.next;
	return { id, fire: t.timers.fired.get(id)!, delay: t.timers.delays.get(id) };
};
const waitAt = (ms: number) => ({ until: ms, about: new Date(ms).toISOString() });
/** Signs out (the local copy deleted, the session revoked) and back in as the same person with organisation A. */
async function signOutAndBackIn(t: ReturnType<typeof harness>) {
	t.runner.send({ type: 'sign-out' }); await drain();
	await t.calls.answer('removeIf', 'deleted');
	await t.calls.answer('begin', 'revoked');
	t.runner.send({ type: 'sign-in' }); await drain();
	t.calls.take('start').resolve({ kind: 'signed-in', session: { token: token('b'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/' } });
	await drain();
	await t.calls.answer('install', 'written');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	await t.calls.answer('readOrg', orgA);
}

test('revocation: one request for the current person, a count as the result, one notification per change, no /v1/me refresh', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const expected = personShown(t.runner);
	assert.equal(expected.userId, userId); assert.deepEqual(Object.keys(expected).sort(), ['epoch', 'userId'], 'token-free: an epoch and the person only');
	assert.equal(t.runner.revocationView(), idleRevocation);
	const accountBefore = t.runner.snapshot(); const notified = t.snapshots.length; const meBefore = meSends(t);
	const outcome = t.runner.revokeOthers(expected);
	assert.equal(t.snapshots.length, notified + 1, 'sending: one notification');
	assert.deepEqual(t.runner.revocationView(), { inFlight: true, slow: false, wait: null, last: null });
	const post = t.calls.take('post');
	assert.deepEqual(post.args, ['/v1/me/sessions/revoke-others', token('a'), {}], 'the fixed path, the current credential, no input');
	post.resolve({ ok: true, value: { ended: 2 } });
	assert.deepEqual(await outcome, { kind: 'ok', ended: 2 });
	assert.equal(t.snapshots.length, notified + 2, 'settling: one notification');
	const settled = t.runner.revocationView();
	assert.deepEqual(settled, { inFlight: false, slow: false, wait: null, last: { kind: 'ok', ended: 2 } });
	assert.equal(t.runner.revocationView(), settled, 'the same object until it changes');
	assert.equal(t.runner.snapshot(), accountBefore, 'the account snapshot is untouched');
	assert.ok(t.snapshots.slice(notified).every((s) => s === accountBefore), 'listeners get the unchanged account snapshot');
	assert.equal(meSends(t), meBefore, 'no /v1/me refresh follows');
	outcomesTokenFree(await outcome, settled, t.snapshots);
});

test('revocation C4: a new send clears the last result in the same change; a refused press changes nothing and notifies nobody', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const expected = personShown(t.runner);
	const first = t.runner.revokeOthers(expected);
	await t.calls.answer('post', { ok: true, value: { ended: 2 } }); await first;
	const notified = t.snapshots.length;
	const second = t.runner.revokeOthers(expected);
	assert.equal(t.snapshots.length, notified + 1, 'one change, one notification');
	assert.deepEqual(t.runner.revocationView(), { inFlight: true, slow: false, wait: null, last: null }, 'never the old count beside a new request');
	const inFlight = t.runner.revocationView();
	assert.deepEqual(await t.runner.revokeOthers(expected), { kind: 'in-flight' }, 'a duplicate press');
	assert.equal(postCount(t), 2, 'exactly one request per press that was admitted');
	assert.equal(t.snapshots.length, notified + 1, 'a refused press notifies nobody');
	assert.equal(t.runner.revocationView(), inFlight);
	await t.calls.answer('post', { ok: true, value: { ended: 0 } });
	assert.deepEqual(await second, { kind: 'ok', ended: 0 });
	assert.deepEqual(t.runner.revocationView().last, { kind: 'ok', ended: 0 });
});

test('revocation: a 429 keeps its status and its own wait (C2); the wait cannot be bypassed, even after the screen remounts; /v1/me pacing is untouched', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const expected = personShown(t.runner);
	const accountBefore = t.runner.snapshot();
	const first = t.runner.revokeOthers(expected);
	await t.calls.answer('post', { ok: false, kind: 'unavailable', status: 429, retryAfter: 20 });
	const limited = await first;
	assert.deepEqual(limited, { kind: 'unknown', status: 429, wait: waitAt(20_000), seconds: 20 });
	// A remounted screen reads the runner's view: the wait and the result are still there.
	const view = t.runner.revocationView();
	assert.deepEqual(view, { inFlight: false, slow: false, wait: waitAt(20_000), last: limited });
	assert.equal(t.runner.snapshot(), accountBefore, 'this wait is not the account\'s /v1/me wait');
	t.clock.now = 19_999;
	const notified = t.snapshots.length;
	assert.deepEqual(await t.runner.revokeOthers(expected), { kind: 'waiting', wait: waitAt(20_000) });
	assert.equal(postCount(t), 1, 'nothing sent before the wait');
	assert.equal(t.snapshots.length, notified); assert.equal(t.runner.revocationView(), view, 'the last result is kept');
	t.clock.now = 20_000;
	const next = t.runner.revokeOthers(expected);
	assert.equal(postCount(t), 2, 'at exactly the wait, the press sends');
	assert.deepEqual(t.runner.revocationView(), { inFlight: true, slow: false, wait: null, last: null });
	await t.calls.answer('post', { ok: false, kind: 'unavailable', status: 503 });
	assert.deepEqual(await next, { kind: 'unknown', status: 503, wait: null, seconds: null });
	assert.deepEqual(t.runner.revocationView().wait, null);
	// The account's /v1/me pacing never saw the revocation's wait: a refresh at 30 s after launch is sent as usual.
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	assert.equal(meSends(t), 2, 'the /v1/me refresh follows its own pacing only');
});

test('revocation: other 4xx are refusals with no organisation effect; malformed and oversized answers are unknown; a broken client is a client bug', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const expected = personShown(t.runner);
	const accountBefore = t.runner.snapshot(); const meBefore = meSends(t);
	for (const status of [403, 404, 409]) {
		const outcome = t.runner.revokeOthers(expected);
		await t.calls.answer('post', { ok: false, kind: 'refused', status, code: 'x' });
		assert.deepEqual(await outcome, { kind: 'refused', status });
		assert.deepEqual(t.runner.revocationView().last, { kind: 'refused', status });
	}
	await drain();
	assert.equal(t.runner.snapshot(), accountBefore, 'no organisation refusal, no membership refresh: this route is not organisation-scoped');
	assert.equal(meSends(t), meBefore);
	for (const value of [{ ended: -1 }, { ended: 1.5 }, { ended: 2 ** 53 }, { ended: '2' }, {}, { ended: 1, extra: true }, null, [1]]) {
		const outcome = t.runner.revokeOthers(expected);
		await t.calls.answer('post', { ok: true, value });
		assert.deepEqual(await outcome, { kind: 'unknown', status: 200, wait: null, seconds: null }, JSON.stringify(value));
	}
	const rejected = t.runner.revokeOthers(expected);
	await t.calls.fail('post');
	assert.deepEqual(await rejected, { kind: 'client-bug' });
	assert.deepEqual(t.runner.revocationView(), { inFlight: false, slow: false, wait: null, last: { kind: 'unknown', status: 0, wait: null, seconds: null } }, 'shown as unknown: a request may have left');
	t.flags.postThrows = true;
	assert.deepEqual(await t.runner.revokeOthers(expected), { kind: 'client-bug' }, 'a client that throws before sending');
	assert.equal(t.runner.revocationView().inFlight, false, 'never left in flight');
	outcomesTokenFree(await rejected, t.runner.revocationView(), t.snapshots);
});

test('revocation: a client that resolves something unusable, or a timer that throws, never leaves the view in flight; an old request\'s failure has no effect', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const expected = personShown(t.runner);

	// The client resolves `undefined` (not an outcome): the answer's mapping throws, and the request is failed.
	const before = t.timers.next;
	t.flags.postRaw = true;
	const unusable = t.runner.revokeOthers(expected);
	const slow = newestTimer(t, before);
	await t.calls.answer('post', undefined);
	assert.deepEqual(await unusable, { kind: 'client-bug' });
	assert.deepEqual(t.runner.revocationView(), { inFlight: false, slow: false, wait: null, last: { kind: 'unknown', status: 0, wait: null, seconds: null } },
		'shown as unknown, not in flight');
	assert.ok(!t.timers.fired.has(slow.id), 'its slow timer was cleared');
	const next = t.runner.revokeOthers(expected);
	assert.equal(postCount(t), 2, 'the next press sends: nothing was stuck');
	await t.calls.answer('post', { ok: true, value: { ended: 0 } });
	assert.deepEqual(await next, { kind: 'ok', ended: 0 });

	// The timer throws before anything is sent: the request is failed at once, and nothing is sent.
	t.timers.throwNext = true;
	assert.deepEqual(await t.runner.revokeOthers(expected), { kind: 'client-bug' });
	assert.equal(postCount(t), 2, 'nothing sent');
	assert.deepEqual(t.runner.revocationView(), { inFlight: false, slow: false, wait: null, last: { kind: 'unknown', status: 0, wait: null, seconds: null } });
	const after = t.runner.revokeOthers(expected);
	assert.equal(postCount(t), 3, 'and the next press sends');
	await t.calls.answer('post', { ok: true, value: { ended: 1 } });
	assert.deepEqual(await after, { kind: 'ok', ended: 1 });

	// An unusable answer for a request that is no longer current (the person signed out meanwhile): stale, no effect.
	t.flags.postRaw = true;
	const old = t.runner.revokeOthers(expected);
	t.runner.send({ type: 'sign-out' }); await drain();
	const notified = t.snapshots.length; const accountNow = t.runner.snapshot();
	t.calls.take('post').resolve(undefined);
	assert.deepEqual(await old, { kind: 'stale' });
	assert.equal(t.snapshots.length, notified, 'no notification'); assert.equal(t.runner.snapshot(), accountNow);
	assert.equal(t.runner.revocationView(), idleRevocation);
	outcomesTokenFree(await unusable, await old, t.snapshots);
});

test('revocation: a 401 on the current handle ends the session through the existing event', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const outcome = t.runner.revokeOthers(personShown(t.runner));
	await t.calls.answer('post', { ok: false, kind: 'unauthorised' });
	assert.deepEqual(await outcome, { kind: 'stale' });
	const releasing = account(t.runner);
	assert.ok(releasing.kind === 'releasing' && releasing.reason === 'session-ended' && releasing.server === 'not-needed');
	assert.deepEqual(t.calls.take('removeIf').args, [token('a')]);
	assert.equal(t.runner.revocationView(), idleRevocation);
});

test('revocation C1: sign out and back in as the same person: the old control is stale, and the old answer changes nothing and notifies nobody', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const old = personShown(t.runner);
	const timersBefore = t.timers.next;
	const pending = t.runner.revokeOthers(old);
	const slow = newestTimer(t, timersBefore);
	await signOutAndBackIn(t);
	const renewed = personShown(t.runner);
	assert.equal(renewed.userId, old.userId); assert.notEqual(renewed.epoch, old.epoch, 'ABA: a new epoch for the same person');
	assert.ok(!t.timers.fired.has(slow.id), 'the old request\'s slow timer was cleared with the scope');
	assert.equal(t.runner.revocationView(), idleRevocation, 'the old state is gone');
	const accountNow = t.runner.snapshot(); const notified = t.snapshots.length;
	t.calls.take('post').resolve({ ok: true, value: { ended: 3 } });
	assert.deepEqual(await pending, { kind: 'stale' });
	slow.fire(); await drain();
	assert.equal(t.snapshots.length, notified, 'no notification for a late answer or a late tick');
	assert.equal(t.runner.snapshot(), accountNow);
	assert.equal(t.runner.revocationView(), idleRevocation, 'no result, no slow flag under the new scope');
	assert.deepEqual(await t.runner.revokeOthers(old), { kind: 'stale' }, 'a control confirmed for the old sign-in sends nothing');
	assert.equal(postCount(t), 1);
});

test('revocation C1: a 429 or a 401 that arrives after the account changed records nothing and dispatches nothing', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const first = t.runner.revokeOthers(personShown(t.runner));
	t.runner.send({ type: 'sign-out' }); await drain();
	let notified = t.snapshots.length; let accountNow = t.runner.snapshot();
	t.calls.take('post').resolve({ ok: false, kind: 'unavailable', status: 429, retryAfter: 60 });
	assert.deepEqual(await first, { kind: 'stale' });
	assert.equal(t.snapshots.length, notified); assert.equal(t.runner.snapshot(), accountNow);
	assert.equal(t.runner.revocationView(), idleRevocation, 'no wait recorded');
	await t.calls.answer('removeIf', 'deleted'); await t.calls.answer('begin', 'revoked');

	// A second person's run: signed in again, a request out, then the session ends another way; its 401 comes late.
	await signOutAndBackInFromSignedOut(t);
	const second = t.runner.revokeOthers(personShown(t.runner));
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	await t.calls.answer('get', { ok: false, kind: 'unauthorised' });
	await t.calls.answer('removeIf', 'deleted');
	const removals = t.calls.all.filter((c) => c.name === 'removeIf').length;
	notified = t.snapshots.length; accountNow = t.runner.snapshot();
	t.calls.take('post').resolve({ ok: false, kind: 'unauthorised' });
	assert.deepEqual(await second, { kind: 'stale' });
	await drain();
	assert.equal(t.calls.all.filter((c) => c.name === 'removeIf').length, removals, 'the old handle\'s 401 dispatched nothing');
	assert.equal(t.snapshots.length, notified); assert.equal(t.runner.snapshot(), accountNow);
});
/** From signed out: signs in again as the same person with organisation A. */
async function signOutAndBackInFromSignedOut(t: ReturnType<typeof harness>) {
	t.runner.send({ type: 'sign-in' }); await drain();
	t.calls.take('start').resolve({ kind: 'signed-in', session: { token: token('c'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/' } });
	await drain();
	await t.calls.answer('install', 'written');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	await t.calls.answer('readOrg', orgA);
}

test('revocation: a membership refresh and an organisation switch in flight keep the person scope, so the answer still applies', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA);
	const expected = personShown(t.runner);
	const outcome = t.runner.revokeOthers(expected);
	t.clock.now = 30_000; t.runner.send({ type: 'refresh' }); await drain();
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	t.runner.send({ type: 'choose-organisation', organisationId: orgB }); await drain();
	const now = account(t.runner);
	assert.ok(now.kind === 'signed-in' && now.org.kind === 'chosen' && now.org.membership.organisationId === orgB);
	assert.deepEqual(now.person, expected, 'the same person scope');
	assert.equal(t.runner.revocationView().inFlight, true, 'still in flight');
	await t.calls.answer('post', { ok: true, value: { ended: 1 } });
	assert.deepEqual(await outcome, { kind: 'ok', ended: 1 });
	assert.deepEqual(t.runner.revocationView().last, { kind: 'ok', ended: 1 });
});

test('revocation C3: slow after the injected delay, one notification per flip, and the timer cleared on every settle', async () => {
	const t = await signedInWithStoredSession([orgA, orgB], orgA, { slowAfterMs: 5_000 });
	const expected = personShown(t.runner);
	let before = t.timers.next;
	const first = t.runner.revokeOthers(expected);
	const timer = newestTimer(t, before);
	assert.equal(timer.delay, 5_000, 'the injected delay');
	let notified = t.snapshots.length;
	timer.fire(); t.timers.fired.delete(timer.id);
	assert.equal(t.snapshots.length, notified + 1, 'false → true: one notification');
	assert.deepEqual(t.runner.revocationView(), { inFlight: true, slow: true, wait: null, last: null });
	timer.fire();
	assert.equal(t.snapshots.length, notified + 1, 'a repeated tick changes nothing');
	await t.calls.answer('post', { ok: true, value: { ended: 1 } }); await first;
	assert.equal(t.snapshots.length, notified + 2, 'settling clears slow in the same single notification');
	assert.equal(t.runner.revocationView().slow, false);
	// Settled before the delay: the timer is cleared, and a late tick does nothing.
	before = t.timers.next;
	const second = t.runner.revokeOthers(expected);
	const early = newestTimer(t, before);
	await t.calls.answer('post', { ok: true, value: { ended: 0 } }); await second;
	assert.ok(!t.timers.fired.has(early.id), 'cleared at settle');
	notified = t.snapshots.length; const view = t.runner.revocationView();
	early.fire();
	assert.equal(t.snapshots.length, notified); assert.equal(t.runner.revocationView(), view);
});

test('revocation: the default slow delay is the account\'s ten seconds; with no person, nothing is sent', async () => {
	const t = harness();
	t.runner.start();
	assert.deepEqual(await t.runner.revokeOthers({ epoch: 'a0', userId }), { kind: 'stale' }, 'starting: nothing sent');
	await t.calls.answer('read', stored('a'));
	assert.deepEqual(await t.runner.revokeOthers({ epoch: 'a0', userId }), { kind: 'stale' }, 'checking: not signed in yet');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	const expected = personShown(t.runner);
	assert.deepEqual(await t.runner.revokeOthers({ ...expected, userId: orgA }), { kind: 'stale' }, 'another person');
	const before = t.timers.next;
	const outcome = t.runner.revokeOthers(expected);
	assert.equal(newestTimer(t, before).delay, 10_000);
	await t.calls.answer('post', { ok: true, value: { ended: 0 } });
	assert.deepEqual(await outcome, { kind: 'ok', ended: 0 }, 'signed in without a chosen organisation is enough: it is per person');
	assert.equal(postCount(t), 1);
});

test('byte budget: an oversized 200 from "Sign out everywhere else" is unknown, never a count', async () => {
	const { t } = await readyOverRealTransport([(url) => streamed(url, 200, oversizedChunks())]);
	const outcome = await t.runner.revokeOthers(personShown(t.runner));
	assert.deepEqual(outcome, { kind: 'unknown', status: 200, wait: null, seconds: null });
	assert.equal(account(t.runner).kind, 'signed-in', 'the account is untouched');
});

test('byte budget: an oversized 429 keeps its Retry-After as the read\'s own wait', async () => {
	const { t } = await readyOverRealTransport([(url) => streamed(url, 429, oversizedChunks(), { 'retry-after': '20' })]);
	const scope = shown(t.runner);
	const outcome = await t.runner.organisationRead(scope, (current) => myWorkPath(current, 0), (value) => parseMyWorkPage(value, { scope, offset: 0 }));
	assert.deepEqual(outcome, { kind: 'unavailable', wait: { until: 20_000, about: new Date(20_000).toISOString() } });
	const view = account(t.runner);
	assert.ok(view.kind === 'signed-in' && view.ready, 'a business wait never touches the account');
});
