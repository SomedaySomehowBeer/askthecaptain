import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Send, Transport } from '../api/client.ts';
import type { Cleanup } from '../auth/cleanup.ts';
import type { AuthPlatform } from '../auth/contracts.ts';
import type { AccountPlatform } from '../platform/account-platform.ts';
import type { DeviceStorage } from '../platform/secure-storage.ts';
import { compose, defaultBuilders, type Builders } from './compose.ts';
import type { AccountRunner, AccountRunnerDeps } from './runner.ts';

const refusedOrigin = 'http://secret-host.invalid:9999';

/** A platform whose every part records being touched. */
function fakePlatform(options: { auth?: boolean; origin?: string | null; storage?: 'available' | 'unavailable' | 'never' } = {}) {
	const touched: string[] = [];
	let raw = 0;
	const platform: AccountPlatform = {
		authPlatform: options.auth === false ? null : ({} as AuthPlatform),
		apiOrigin: options.origin === undefined ? 'https://api.example.test' : options.origin,
		openDeviceStorage: () => {
			touched.push('storage');
			if (options.storage === 'never') return new Promise<DeviceStorage>(() => undefined);
			return Promise.resolve(options.storage === 'unavailable' ? { available: false } : { available: true, storage: {} as never });
		},
		send: (() => { touched.push('send'); throw new Error('no send in compose'); }) as unknown as Send,
		monotonicNow: () => { touched.push('clock'); return raw; },
		wallNow: () => 0
	};
	return { platform, touched, setRaw: (value: number) => { raw = value; } };
}

/** Builders that record the graph instead of building real parts. */
function recordingBuilders(overrides: Partial<Builders> = {}) {
	const made = { cleanups: [] as { transport: Transport; now: () => number; cleanup: Cleanup }[], attempts: [] as unknown[], runners: [] as AccountRunnerDeps[], starts: 0 };
	const builders: Builders = {
		...defaultBuilders,
		createCleanup: (options) => { const cleanup = { tag: made.cleanups.length } as unknown as Cleanup; made.cleanups.push({ ...options, cleanup }); return cleanup; },
		createAttempts: (options) => { made.attempts.push(options); return {} as never; },
		createAccountRunner: (deps) => {
			made.runners.push(deps);
			return { start: () => { made.starts += 1; }, snapshot: () => ({}) as never, send: () => undefined, subscribe: () => () => undefined, organisationRead: async () => ({}) as never } as AccountRunner;
		},
		...overrides
	};
	return { builders, made };
}

test('web-only: no auth platform means nothing else is touched', async () => {
	const { platform, touched } = fakePlatform({ auth: false });
	const { builders, made } = recordingBuilders();
	assert.deepEqual(await compose(platform, builders), { kind: 'web-only' });
	assert.deepEqual(touched, []); assert.equal(made.runners.length, 0);
});

test('misconfigured: a refused API address builds nothing and repeats no value', async () => {
	const { platform, touched } = fakePlatform({ origin: null });
	const { builders, made } = recordingBuilders();
	const result = await compose(platform, builders);
	assert.deepEqual(result, { kind: 'misconfigured' });
	assert.ok(!JSON.stringify(result).includes(refusedOrigin));
	assert.deepEqual(touched, []); assert.equal(made.runners.length, 0);
});

test('ready: storage opened once, two distinct cleanups on one clamped clock, the runner started once', async () => {
	const { platform, touched, setRaw } = fakePlatform();
	const { builders, made } = recordingBuilders();
	const result = await compose(platform, builders);
	assert.equal(result.kind, 'ready');
	assert.equal(touched.filter((t) => t === 'storage').length, 1);
	assert.equal(made.cleanups.length, 2);
	assert.notEqual(made.cleanups[0]!.cleanup, made.cleanups[1]!.cleanup);
	assert.equal(made.cleanups[0]!.transport, made.cleanups[1]!.transport, 'one transport');
	assert.equal(made.cleanups[0]!.transport.origin, 'https://api.example.test');
	const runner = made.runners[0]!;
	assert.equal(runner.cleanup, made.cleanups[1]!.cleanup, "the runner gets its own cleanup, not the attempt core's");
	assert.equal((made.attempts[0] as { cleanup: Cleanup }).cleanup, made.cleanups[0]!.cleanup);
	assert.notEqual(runner.createStore, null);
	assert.equal(made.starts, 1);
	// One clamped clock everywhere: a backward reading is the last one for the runner, both cleanups and the source.
	setRaw(500); assert.equal(runner.clock!.now(), 500);
	setRaw(100);
	assert.equal(made.cleanups[0]!.now(), 500); assert.equal(made.cleanups[1]!.now(), 500);
	assert.equal(result.kind === 'ready' && result.clock.now(), 500);
	assert.equal(result.kind === 'ready' && result.clock, runner.clock);
});

test('storage unavailable: a runner with no store, so no sign-in', async () => {
	const { platform } = fakePlatform({ storage: 'unavailable' });
	const { builders, made } = recordingBuilders();
	assert.equal((await compose(platform, builders)).kind, 'ready');
	assert.equal(made.runners[0]!.createStore, null);
});

test('compose throws when both cleanups are one object', async () => {
	const { platform } = fakePlatform();
	const shared = {} as Cleanup;
	const { builders, made } = recordingBuilders({ createCleanup: () => shared });
	await assert.rejects(compose(platform, builders), /must not share a cleanup/);
	assert.equal(made.runners.length, 0);
});
