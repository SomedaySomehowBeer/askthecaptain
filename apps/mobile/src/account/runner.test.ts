import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cleanup } from '../auth/cleanup.ts';
import type { ApiClient, ApiOutcome, AttemptOutcome, Attempts, AttemptState } from '../auth/contracts.ts';
import { createClampedClock } from './clock.ts';
import type { CredentialStore, Generation, StoredSession } from './contracts.ts';
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

function harness(options: { storage?: boolean } = {}) {
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
	const client: ApiClient = {
		get: <T>(path: unknown, t: string | null, parse: (value: unknown) => T) =>
			calls.make<ApiOutcome<unknown>>('get', [path, t]).then((answer) => answer.ok ? { ok: true as const, value: parse(answer.value) } : answer as ApiOutcome<T>),
		post: () => { throw new Error('no post expected'); }
	};
	const cleanupState = { value: 'none' as 'none' | 'running' | 'pending', retryAfterMs: null as number | null };
	const cleanup: Cleanup = {
		state: () => cleanupState.value,
		begin: (t, e) => { cleanupState.value = 'running'; return calls.make<'revoked' | 'still-pending'>('begin', [t, e]).then((r) => { cleanupState.value = r === 'revoked' ? 'none' : 'pending'; return r; }); },
		retry: () => { cleanupState.value = 'running'; return calls.make<'revoked' | 'still-pending'>('retry', []).then((r) => { cleanupState.value = r === 'revoked' ? 'none' : 'pending'; return r; }); },
		expiresAt: () => null, retryAfterMs: () => cleanupState.retryAfterMs
	};
	const timers = { fired: new Map<number, () => void>(), next: 0 };
	const fakeTimers: Timers = { set: (_ms, run) => { const id = ++timers.next; timers.fired.set(id, run); return id; }, clear: (id) => { timers.fired.delete(id as number); } };
	// `clock.now` is the raw monotonic reading the test controls; the runner clamps it. The wall clock is fixed at the
	// epoch, so a wait of N ms reads "about" new Date(N).
	const clock = { now: 0 };
	const snapshots: unknown[] = [];
	const runner = createAccountRunner({
		createStore: options.storage === false ? null : (current) => { generation = current; return store; },
		attempts, client, cleanup, timers: fakeTimers, clock: createClampedClock(() => clock.now), wallNow: () => 0
	});
	runner.subscribe((s) => snapshots.push(s));
	return { calls, runner, attemptState, cleanupState, timers, clock, snapshots, generation: () => generation!() };
}
const account = (runner: AccountRunner) => runner.snapshot().account;
/** Nothing a screen can see ever holds a token. */
const tokenFree = (snapshots: unknown[]) => { const text = JSON.stringify(snapshots); assert.ok(!text.includes('sess_'), 'a token reached a snapshot'); };

async function signedInWithStoredSession(organisations: string[], storedChoice: string | null) {
	const t = harness();
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
	t.runner.send({ type: 'sign-in', returnTo: '/chat' }); await drain();
	const start = t.calls.take('start');
	assert.deepEqual(start.args, ['/chat']);
	start.resolve({ kind: 'signed-in', session: { token: token('b'), expiresAt: '2030-10-01T08:30:00.000Z', user: { id: userId, email: 'o@example.test', name: 'O' }, returnTo: '/chat' } });
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
	assert.ok(ready.kind === 'signed-in' && ready.ready && ready.destination === '/chat');
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

test('organisation reads: nothing is sent before verification; 403 only refreshes membership; a late answer is superseded', async () => {
	const t = harness();
	t.runner.start(); await t.calls.answer('read', stored('a'));
	const parse = (value: unknown) => value;
	const path = (organisationId: string) => `/v1/organisations/${organisationId}/stock` as never;
	assert.deepEqual(await t.runner.organisationRead(path, parse), { ok: false, kind: 'not-ready' }, 'checking: not sent');
	await t.calls.answer('get', { ok: true, value: meBody(orgA, orgB) });
	await t.calls.answer('readOrg', orgA);
	const read = t.runner.organisationRead(path, parse); await drain();
	const sent = t.calls.take('get');
	assert.deepEqual(sent.args, [`/v1/organisations/${orgA}/stock`, token('a')]);
	sent.resolve({ ok: false, kind: 'refused', status: 403, code: 'forbidden' });
	assert.deepEqual(await read, { ok: false, kind: 'refused', status: 403, code: 'forbidden' });
	const refresh = t.calls.take('get');
	assert.deepEqual(refresh.args, ['/v1/me', token('a')], 'only a fresh membership list is asked for');
	const chosen = account(t.runner);
	assert.ok(chosen.kind === 'signed-in' && chosen.org.kind === 'chosen' && chosen.org.membership.organisationId === orgA, 'nothing removed on the refusal');
	refresh.resolve({ ok: true, value: meBody(orgA, orgB) }); await drain();
	// A read in flight when the person switches organisation is superseded.
	const late = t.runner.organisationRead(path, parse); await drain();
	const lateCall = t.calls.take('get');
	t.runner.send({ type: 'choose-organisation', organisationId: orgB }); await drain();
	lateCall.resolve({ ok: true, value: { items: [] } });
	assert.deepEqual(await late, { ok: false, kind: 'superseded' });
	tokenFree(t.snapshots);
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
	// A refusal from an organisation read is subject to the server wait too.
	const read = t.runner.organisationRead((id) => `/v1/organisations/${id}/stock` as never, (v) => v); await drain();
	t.clock.now = 89_999;
	t.calls.take('get').resolve({ ok: false, kind: 'refused', status: 403, code: 'forbidden' }); await read; await drain();
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
