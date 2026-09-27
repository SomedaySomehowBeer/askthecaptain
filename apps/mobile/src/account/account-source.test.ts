import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountPlatform } from '../platform/account-platform.ts';
import { createAccountSource, outsideSnapshots } from './account-source.ts';
import { createClampedClock } from './clock.ts';
import type { Composition } from './compose.ts';
import { accountInstance, instanceKey, type Holder } from './instance.ts';
import type { AccountSnapshot } from './machine.ts';
import { idleRevocation } from './revocation.ts';
import type { AccountRunner, Timers, UiCommand } from './runner.ts';

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
function fakeTimers() {
	const pending = new Map<number, () => void>(); let next = 0; const delays: number[] = [];
	const timers: Timers = { set: (ms, run) => { const id = ++next; pending.set(id, run); delays.push(ms); return id; }, clear: (id) => { pending.delete(id as number); } };
	return { timers, delays, fireAll: () => { for (const [id, run] of [...pending]) { pending.delete(id); run(); } }, count: () => pending.size };
}
function fakeRunner(first: AccountSnapshot) {
	let current = first; const listeners = new Set<(s: AccountSnapshot) => void>(); const sent: UiCommand[] = []; const reads: unknown[][] = [];
	const revocations: unknown[] = []; const revocationView = Object.freeze({ inFlight: true, slow: false, wait: null, last: null });
	const runner = {
		start: () => undefined, snapshot: () => current, send: (c: UiCommand) => { sent.push(c); },
		subscribe: (l: (s: AccountSnapshot) => void) => { listeners.add(l); return () => listeners.delete(l); },
		organisationRead: async (...args: unknown[]) => { reads.push(args); return { kind: 'ok', value: 'from runner' }; },
		revokeOthers: async (expected: unknown) => { revocations.push(expected); return { kind: 'ok', ended: 1 }; },
		revocationView: () => revocationView
	} as unknown as AccountRunner;
	return { runner, sent, reads, revocations, revocationView, set(next: AccountSnapshot) { current = next; for (const l of listeners) l(next); } };
}
const snap = (account: AccountSnapshot['account']): AccountSnapshot => ({ account, signInOffered: false, fault: false, strays: [] });

test('before composition answers: starting, slow after ten seconds on its own timer, one composition only', async () => {
	const t = fakeTimers(); let calls = 0;
	const source = createAccountSource(() => { calls += 1; return new Promise<Composition>(() => undefined); }, t.timers);
	assert.deepEqual(t.delays, [10_000]);
	assert.equal(source.snapshot(), outsideSnapshots.starting);
	assert.equal(source.snapshot(), source.snapshot(), 'stable until it changes');
	let notified = 0; source.subscribe(() => { notified += 1; });
	t.fireAll();
	assert.equal(source.snapshot(), outsideSnapshots.startingSlow);
	assert.equal(notified, 1);
	await drain();
	assert.equal(calls, 1, 'the slow notice never composes again');
	source.send({ type: 'sign-in' }); // dropped: nothing to act on
	assert.equal(source.now(), 0);
});

test('web-only and misconfigured are fixed frozen snapshots; the timer is cleared', async () => {
	for (const [kind, expected] of [['web-only', outsideSnapshots.webOnly], ['misconfigured', outsideSnapshots.misconfigured]] as const) {
		const t = fakeTimers();
		const source = createAccountSource(async () => ({ kind }), t.timers);
		await drain();
		assert.equal(source.snapshot(), expected);
		assert.ok(Object.isFrozen(expected) && Object.isFrozen(expected.account));
		assert.equal(t.count(), 0);
	}
});

test('a rejected or throwing composition gives the fixed startup-failed snapshot and no second attempt', async () => {
	for (const composition of [() => Promise.reject(new Error('detail sess_x')), () => { throw new Error('sync'); }]) {
		let calls = 0;
		const source = createAccountSource(() => { calls += 1; return (composition as () => Promise<Composition>)(); }, fakeTimers().timers);
		await drain();
		assert.equal(source.snapshot(), outsideSnapshots.startupFailed);
		assert.ok(!JSON.stringify(source.snapshot()).includes('detail'), 'no error text');
		assert.equal(calls, 1);
	}
});

test('with a runner: its snapshot and commands pass through; a slow notice already shown stays slow while starting', async () => {
	const t = fakeTimers();
	const fake = fakeRunner(snap({ kind: 'starting', slow: false }));
	let resolve!: (c: Composition) => void;
	const clock = createClampedClock(() => 42);
	const source = createAccountSource(() => new Promise<Composition>((r) => { resolve = r; }), t.timers);
	t.fireAll();
	assert.equal(source.snapshot(), outsideSnapshots.startingSlow);
	resolve({ kind: 'ready', runner: fake.runner, clock }); await drain();
	const shown = source.snapshot();
	assert.deepEqual(shown.account, { kind: 'starting', slow: true }, 'the wording never steps back');
	assert.equal(source.snapshot(), shown, 'cached by the runner snapshot');
	let notified = 0; source.subscribe(() => { notified += 1; });
	const signedOut = snap({ kind: 'signed-out', notice: null, gate: 'idle' });
	fake.set(signedOut);
	assert.equal(notified, 1);
	assert.equal(source.snapshot(), signedOut, "the runner's own object once starting ends");
	source.send({ type: 'retry' });
	assert.deepEqual(fake.sent, [{ type: 'retry' }]);
	assert.equal(source.now(), 42);
});

test('read: with no runner it answers superseded and builds nothing; with a runner it delegates unchanged', async () => {
	const scope = { epoch: 'a1.o1', userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', organisationId: 'c0ffee00-1234-4abc-9def-0123456789ab' };
	let built = 0;
	const path = () => { built += 1; return '/v1/organisations/x' as never; };
	const parse = (value: unknown) => value;
	for (const composition of [() => new Promise<Composition>(() => undefined), async (): Promise<Composition> => ({ kind: 'web-only' }), async (): Promise<Composition> => ({ kind: 'misconfigured' }), () => Promise.reject(new Error('x'))]) {
		const source = createAccountSource(composition, fakeTimers().timers);
		await drain();
		assert.deepEqual(await source.read(scope, path, parse), { kind: 'superseded' });
	}
	assert.equal(built, 0, 'no path is built, so nothing can be sent');
	const fake = fakeRunner(snap({ kind: 'checking' }));
	let resolve!: (c: Composition) => void;
	const source = createAccountSource(() => new Promise<Composition>((r) => { resolve = r; }), fakeTimers().timers);
	resolve({ kind: 'ready', runner: fake.runner, clock: createClampedClock(() => 0) }); await drain();
	assert.deepEqual(await source.read(scope, path, parse), { kind: 'ok', value: 'from runner' });
	assert.equal(fake.reads.length, 1);
	assert.equal(fake.reads[0]![0], scope); assert.equal(fake.reads[0]![1], path); assert.equal(fake.reads[0]![2], parse);
});

test('sign out everywhere else: with no runner it answers stale and shows the shared idle view; with a runner it delegates unchanged', async () => {
	const expected = { epoch: 'a1', userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };
	for (const composition of [() => new Promise<Composition>(() => undefined), async (): Promise<Composition> => ({ kind: 'web-only' }), async (): Promise<Composition> => ({ kind: 'misconfigured' }), () => Promise.reject(new Error('x'))]) {
		const source = createAccountSource(composition, fakeTimers().timers);
		await drain();
		assert.deepEqual(await source.revokeOthers(expected), { kind: 'stale' });
		assert.equal(source.revocationView(), idleRevocation);
	}
	const fake = fakeRunner(snap({ kind: 'checking' }));
	let resolve!: (c: Composition) => void;
	const source = createAccountSource(() => new Promise<Composition>((r) => { resolve = r; }), fakeTimers().timers);
	resolve({ kind: 'ready', runner: fake.runner, clock: createClampedClock(() => 0) }); await drain();
	assert.deepEqual(await source.revokeOthers(expected), { kind: 'ok', ended: 1 });
	assert.deepEqual(fake.revocations, [expected]); assert.equal(fake.revocations[0], expected, 'the same scope object');
	assert.equal(source.revocationView(), fake.revocationView, "the runner's own object, so identity is stable");
});

test('instance: one source per holder; a development re-evaluation reuses it; release and development are isolated', () => {
	const platform = (): AccountPlatform => { throw new Error('unused'); };
	let created = 0;
	const create = () => { created += 1; return createAccountSource(() => new Promise<Composition>(() => undefined), fakeTimers().timers); };
	const devGlobal: Holder = {};
	const a = accountInstance(platform, { holder: devGlobal, development: true, create });
	const b = accountInstance(platform, { holder: devGlobal, development: true, create });
	assert.equal(a, b); assert.equal(created, 1); assert.equal(devGlobal[instanceKey], a);
	const release: Holder = {};
	const c = accountInstance(platform, { holder: release, development: false, create });
	assert.notEqual(c, a); assert.equal(accountInstance(platform, { holder: release, development: false, create }), c);
	assert.equal(created, 2);
});

test('instance: a platform that throws while resolving gives startup-failed, not a render error', async () => {
	const source = accountInstance(() => { throw new Error('native module'); }, { holder: {}, development: true });
	await drain();
	assert.equal(source.snapshot(), outsideSnapshots.startupFailed);
});
