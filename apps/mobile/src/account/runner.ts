import { apiPaths, type OrganisationPath } from '../api/paths.ts';
import type { Cleanup } from '../auth/cleanup.ts';
import type { ApiClient, ApiOutcome, Attempts, AttemptOutcome, Parse } from '../auth/contracts.ts';
import { createClampedClock, waitFor, type Clock } from './clock.ts';
import type { CredentialStore, Generation, ReadOutcome, ReadScope, ScopedRead } from './contracts.ts';
import {
	holds, initial, personScope, readScope, reduce, slowAfterMs, storeGeneration, view as viewOf,
	type AccountSnapshot, type Command, type CredentialHandle, type Effect, type Event, type LocalResult, type Machine
} from './machine.ts';
import { parseMe } from './me.ts';
import {
	admit, clientBugOutcome, idleRevocation, parseRevoked, resultOf, samePerson, sendingRevocation, settledRevocation, slowRevocation,
	staleOutcome, unknownResult, type PersonScope, type RevocationView, type Revoked, type RevokeOutcome
} from './revocation.ts';

export type { AccountSnapshot } from './machine.ts';

/** The account effect runner: the only place a session token lives in memory (docs/plans/
 *  expo-mobile-platform-account-2026-09.md "Account contract"). It performs the reducer's effects against the injected
 *  credential store, attempt core, API client and its own cleanup, and feeds each completion back as exactly one event.
 *
 *  - Tokens are kept in a private map keyed by opaque handles. Nothing it returns, emits or throws contains one.
 *  - A handle's token is forgotten only when the reducer says every obligation has a result (`release`).
 *  - A duplicate completion is harmless: the reducer ignores events for anything no longer current. Only the person's
 *    Try again repeats a removal or revocation, and the cleanup never sends before the server's retry time.
 *  - The runner's cleanup is its own instance, never the attempt core's.
 *  - Timers only change wording after ten seconds; they never cancel a storage write, a browser call or a request. */

export type Timers = { set(ms: number, run: () => void): unknown; clear(timer: unknown): void };

export type AccountRunnerDeps = {
	/** Builds the credential store over the platform storage, reading this runner's generations at execution. Null
	 *  when secure storage is unavailable (web, or the platform says so): native sign-in is then never offered. */
	readonly createStore: ((currentGeneration: () => Generation) => CredentialStore) | null;
	readonly attempts: Attempts;
	readonly client: ApiClient;
	/** This runner's own revocation cleanup (createCleanup), never the attempt core's. */
	readonly cleanup: Cleanup;
	readonly timers?: Timers;
	/** The shared clamped monotonic clock (clock.ts): the same instance the cleanups use. Decides every send. */
	readonly clock?: Clock;
	/** Wall-clock milliseconds, for wording "about {time}" only; never to decide a send. */
	readonly wallNow?: () => number;
	/** When an in-flight "Sign out everywhere else" is worded as slow (default: the account's ten seconds). */
	readonly slowAfterMs?: number;
};

/** Commands from screens. Try again and a foreground refresh carry no time; the runner adds its clock. */
export type UiCommand = Exclude<Command, { type: 'retry' } | { type: 'refresh' }> | { readonly type: 'retry' } | { readonly type: 'refresh' };

export type AccountRunner = {
	/** Reads the saved sign-in once. */
	start(): void;
	snapshot(): AccountSnapshot;
	send(command: UiCommand): void;
	subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
	/** The single entry point for organisation-scoped reads (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1).
	 *  - Before sending, in one synchronous step (no `await` before the send): if not ready, or the current read scope
	 *    differs from `expected` in epoch, user or organisation, it answers `superseded` and sends nothing. Otherwise it
	 *    builds the path from its own current scope and sends with the current credential. A path that throws is
	 *    `client-bug`, and nothing is sent.
	 *  - After the answer: a 401 ends the session and a 403/404 asks for a fresh membership list (paced by the reducer),
	 *    both tied to the handle and organisation generation it was sent under. Then, if the handle or epoch changed, it
	 *    answers `superseded` (so a 401 always does).
	 *  - A 429/5xx `Retry-After` becomes this read's own `wait` on the shared clamped clock; it never touches the
	 *    account's `/v1/me` wait.
	 *  - It never rejects, and the token never leaves the runner. */
	organisationRead: ScopedRead;
	/** Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §4, §5a.3-4, C1-C4).
	 *  - Before sending, in one synchronous step: `stale` if not signed in or the person scope differs from `expected`;
	 *    `in-flight` if one is already out for this person; `waiting` if this person's server wait has not passed. None of
	 *    these sends anything, changes anything or notifies.
	 *  - Sending clears the previous result (C4) and marks it in flight, in one change with one notification.
	 *  - After the answer: if the person scope or the handle changed meanwhile, `stale` and nothing else (C1): no result,
	 *    no wait, no dispatch (not even a 401 for the old handle) and no notification. Otherwise a 401 ends the session
	 *    through the existing event; any other answer becomes `last`, with its own server wait kept apart from the
	 *    `/v1/me` wait. A 403/404 here is a plain refusal: this route is not organisation-scoped.
	 *  - No `/v1/me` refresh follows. It never rejects, and the token never leaves the runner. */
	revokeOthers(expected: PersonScope): Promise<RevokeOutcome>;
	/** The current person's revocation state: one frozen object until it changes (the shared idle object when there is
	 *  none, or no person). Changes are published to `subscribe`'s listeners, once each. */
	revocationView(): RevocationView;
};

type Credential = { readonly token: string; readonly expiresAt: string; readonly userId: string };

const defaultTimers: Timers = {
	set: (ms, run) => setTimeout(run, ms),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export function createAccountRunner(deps: AccountRunnerDeps): AccountRunner {
	const { attempts, client, cleanup } = deps;
	const timers = deps.timers ?? defaultTimers;
	const clock = deps.clock ?? createClampedClock(() => performance.now());
	const now = clock.now; const wallNow = deps.wallNow ?? Date.now;
	let machine: Machine = initial();
	// The snapshot screens read: recomputed only when the machine object changes, so repeated reads return the same
	// object (useSyncExternalStore) and unchanged steps notify nobody.
	let viewed: Machine = machine;
	let current: AccountSnapshot = viewOf(machine);
	const store = deps.createStore ? deps.createStore(() => storeGeneration(machine.generations)) : null;
	const credentials = new Map<CredentialHandle, Credential>();
	const running = new Map<number, unknown>();
	const listeners = new Set<(snapshot: AccountSnapshot) => void>();
	let nextHandle = 1;
	const queue: Event[] = []; let dispatching = false;

	function dispatch(event: Event): void {
		queue.push(event);
		if (dispatching) return;
		dispatching = true;
		try {
			while (queue.length > 0) {
				const step = reduce(machine, queue.shift()!);
				machine = step.machine;
				for (const effect of step.effects) perform(effect);
			}
		} finally { dispatching = false; }
		// A person scope other than the one the revocation state belongs to discards that state before anyone can see it
		// (C1). Such a change always comes with a machine change, so the notification below covers it.
		alignRevocation();
		if (machine === viewed) return;
		viewed = machine; current = viewOf(machine);
		const snapshot = current;
		for (const listener of [...listeners]) { try { listener(snapshot); } catch { /* a screen's error is its own */ } }
	}

	/** A token enters memory. A second live credential is a fault: both are kept, nothing is dropped. */
	function mint(credential: Credential): CredentialHandle {
		const fault = credentials.size > 0;
		const handle = nextHandle++ as CredentialHandle;
		credentials.set(handle, credential);
		if (fault) dispatch({ type: 'fault' });
		return handle;
	}

	function removeOnce(handle: CredentialHandle): void {
		const credential = credentials.get(handle);
		// Missing store or credential is a fault; the bounded, honest answer is that a copy may remain.
		if (!store || !credential) fault();
		const removal: Promise<LocalResult> = !store || !credential ? Promise.resolve('copy-may-remain')
			: store.removeIf(credential.token).then(
				(result): LocalResult => result === 'deleted' ? 'deleted' : result === 'absent' ? 'no-usable-copy' : 'newer-kept',
				(): LocalResult => 'copy-may-remain');
		void removal.then((result) => dispatch({ type: 'local-finished', handle, result }));
	}

	// The cleanup holds one token at a time (one slot; no queue). `holder` is the handle whose token it holds, so a
	// cleanup.retry() answer is only ever credited to that handle. A revocation that cannot begin because the slot holds
	// another token is `refused`: a fault, the handle is kept, sign-in stays blocked, and only a Try again made once the
	// slot is free can begin it.
	let holder: CredentialHandle | null = null;

	const fault = () => dispatch({ type: 'fault' });
	const refuse = (handle: CredentialHandle) => { fault(); dispatch({ type: 'server-finished', handle, result: 'refused', wait: null }); };

	function serverAnswer(handle: CredentialHandle, answer: Promise<'revoked' | 'still-pending'>): void {
		void answer.then(
			(result) => {
				if (result === 'revoked') {
					if (holder === handle) holder = null;
					dispatch({ type: 'server-finished', handle, result: 'ended', wait: null });
				} else dispatch({ type: 'server-finished', handle, result: 'pending', wait: waitFor(cleanup.retryAfterMs(), clock, wallNow) });
			},
			() => {
				// begin() refuses only when the cleanup already holds a token: it did not take this one.
				if (holder === handle) holder = null;
				refuse(handle);
			});
	}
	/** Begins revoking `handle` if the one cleanup slot is free; otherwise the revocation is refused (a fault). */
	function revoke(handle: CredentialHandle): void {
		const credential = credentials.get(handle);
		if (!credential) { refuse(handle); return; }
		if (holder !== null || cleanup.state() !== 'none') { refuse(handle); return; }
		holder = handle;
		serverAnswer(handle, Promise.resolve().then(() => cleanup.begin(credential.token, credential.expiresAt)));
	}

	function finishAttempt(outcome: AttemptOutcome): void {
		if (outcome.kind !== 'signed-in') { dispatch({ type: 'attempt-finished', outcome: { kind: outcome.kind } }); return; }
		const { token, expiresAt, user, returnTo } = outcome.session;
		const handle = mint({ token, expiresAt, userId: user.id });
		deliver({ type: 'attempt-finished', outcome: { kind: 'signed-in', handle, userId: user.id, returnTo } }, handle);
	}
	const installed = (handle: CredentialHandle, result: 'written' | 'stale' | 'failed') =>
		dispatch({ type: 'install-finished', handle, result, now: now() });

	/** Dispatches the event carrying a freshly minted handle; if no state then holds it, it is released as a stray
	 *  rather than left in memory holding the gate closed. (Completions run from promise callbacks, never inside a
	 *  dispatch, so the machine has applied the event when this checks.) */
	function deliver(event: Event, handle: CredentialHandle): void {
		dispatch(event);
		if (!dispatching && !holds(machine, handle)) dispatch({ type: 'unclaimed', handle });
	}

	function perform(effect: Effect): void {
		switch (effect.type) {
			case 'read-stored': {
				if (!store) { dispatch({ type: 'launch-read', now: now(), result: { kind: 'unavailable' } }); return; }
				void store.read().then(
					(session) => {
						if (session === null) { dispatch({ type: 'launch-read', now: now(), result: { kind: 'none' } }); return; }
						const handle = mint({ token: session.token, expiresAt: session.expiresAt, userId: session.userId });
						deliver({ type: 'launch-read', now: now(), result: { kind: 'session', handle, userId: session.userId } }, handle);
					},
					() => dispatch({ type: 'launch-read', now: now(), result: { kind: 'unreadable' } }));
				return;
			}
			case 'wait-settled': {
				// The runner's half of the global gate.
				if (!store || credentials.size > 0 || cleanup.state() !== 'none' || attempts.state() !== 'idle') {
					dispatch({ type: 'gate-checked', result: 'blocked' }); return;
				}
				void store.settled(slowAfterMs).then(
					(result) => dispatch({ type: 'gate-checked', result }),
					() => dispatch({ type: 'gate-checked', result: 'blocked' }));
				return;
			}
			case 'start-attempt': {
				void Promise.resolve()
					.then(() => attempts.start(effect.returnTo ?? undefined))
					.then(finishAttempt, () => dispatch({ type: 'attempt-finished', outcome: { kind: 'busy' } }));
				return;
			}
			case 'cancel-attempt': {
				if (attempts.cancel()) dispatch({ type: 'attempt-state', state: attempts.state() });
				return;
			}
			case 'install': {
				const credential = credentials.get(effect.handle);
				if (!store || !credential) { fault(); installed(effect.handle, 'failed'); return; }
				void store.install({ token: credential.token, expiresAt: credential.expiresAt, userId: credential.userId }, effect.generation).then(
					(result) => installed(effect.handle, result),
					() => installed(effect.handle, 'failed'));
				return;
			}
			case 'load-me': {
				const credential = credentials.get(effect.handle);
				const { handle, membership } = effect;
				// A missing credential is a fault; the bounded answer is "could not check", never signed in.
				if (!credential) { fault(); dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unavailable', wait: null } }); return; }
				void client.get(apiPaths.me, credential.token, parseMe).then(
					(answer) => {
						if (answer.ok) { dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'ok', me: answer.value } }); return; }
						if (answer.kind === 'unauthorised') { dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unauthorised' } }); return; }
						// Unavailable or refused: never a sign-out. A server's Retry-After paces every later load.
						const wait = answer.kind === 'unavailable' && answer.retryAfter !== undefined ? waitFor(answer.retryAfter * 1000, clock, wallNow) : null;
						dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unavailable', wait } });
					},
					() => dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unavailable', wait: null } }));
				return;
			}
			case 'read-org': {
				const { handle, organisation } = effect;
				// No store here is a fault; the bounded answer is "no usable hint", which means choose.
				if (!store) { fault(); dispatch({ type: 'org-read', handle, organisation, organisationId: null }); return; }
				void store.readOrg(effect.userId).then(
					(organisationId) => dispatch({ type: 'org-read', handle, organisation, organisationId }),
					() => dispatch({ type: 'org-read', handle, organisation, organisationId: null }));
				return;
			}
			case 'set-org': {
				const { handle } = effect; const organisation = effect.generation.organisation;
				if (!store) { fault(); dispatch({ type: 'org-saved', handle, organisation, result: 'failed' }); return; }
				void store.setOrg(effect.userId, effect.organisationId, effect.generation).then(
					(result) => dispatch({ type: 'org-saved', handle, organisation, result }),
					() => dispatch({ type: 'org-saved', handle, organisation, result: 'failed' }));
				return;
			}
			case 'forget-org-if': {
				// A hint only: whatever happens, the next membership list decides again.
				if (!store) { fault(); return; }
				void store.forgetOrgIf(effect.userId, effect.organisationId).catch(() => undefined);
				return;
			}
			case 'remove-if': { removeOnce(effect.handle); return; }
			case 'revoke': { revoke(effect.handle); return; }
			case 'retry-release': {
				const { handle } = effect;
				if (effect.local) removeOnce(handle);
				if (!effect.server) return;
				// Only the holder's own token is retried; a refused revocation begins only when the slot is free.
				if (holder === handle) serverAnswer(handle, Promise.resolve().then(() => cleanup.retry()));
				else revoke(handle);
				return;
			}
			case 'release': {
				credentials.delete(effect.handle);
				if (holder === effect.handle) holder = null;
				return;
			}
			case 'start-timer': {
				const { id } = effect;
				running.set(id, timers.set(effect.ms, () => { running.delete(id); dispatch({ type: 'slow', id }); }));
				return;
			}
			case 'stop-timer': {
				const timer = running.get(effect.id);
				if (timer !== undefined) { timers.clear(timer); running.delete(effect.id); }
				return;
			}
		}
	}

	const superseded = Object.freeze({ kind: 'superseded' as const });
	const clientBug = Object.freeze({ kind: 'client-bug' as const });
	const sameScope = (a: ReadScope | null, b: ReadScope) =>
		a !== null && a.epoch === b.epoch && a.userId === b.userId && a.organisationId === b.organisationId;

	/** Not `async`: everything up to and including the send runs synchronously in this call, so no event can come
	 *  between the scope check, the path build and the request (the client and transport call `send` before their first
	 *  `await`). */
	function organisationRead<T>(expected: ReadScope, path: (scope: ReadScope) => OrganisationPath, parse: Parse<T>): Promise<ReadOutcome<T>> {
		try {
			const scope = readScope(machine); const state = machine.state;
			if (!sameScope(scope, expected) || state.kind !== 'signed-in') return Promise.resolve(superseded);
			const handle = state.handle; const credential = credentials.get(handle);
			if (!credential) return Promise.resolve(superseded);
			const organisation = machine.generations.organisation;
			let target: OrganisationPath;
			try { target = path(scope!); } catch { return Promise.resolve(clientBug); }
			const sent: Promise<ApiOutcome<T>> = client.get(target, credential.token, parse);
			return sent.then(
				(answer): ReadOutcome<T> => settleRead(answer, handle, organisation, scope!),
				// The client resolves every network failure as `unavailable`; a rejection is a bug in this app, not the
				// network. No account effect: `client-bug` if the scope still holds, else `superseded`.
				(): ReadOutcome<T> => (stillSent(handle, scope!) ? clientBug : superseded)
			).catch((): ReadOutcome<T> => clientBug);
		} catch { return Promise.resolve(clientBug); }
	}

	/** Whether the handle and scope a read was sent under are still current. */
	function stillSent(handle: CredentialHandle, sentScope: ReadScope): boolean {
		const after = machine.state;
		return after.kind === 'signed-in' && after.handle === handle && sameScope(readScope(machine), sentScope);
	}

	/** After the answer: account effects first (tied to what it was sent under), then the scope check. */
	function settleRead<T>(answer: ApiOutcome<T>, handle: CredentialHandle, organisation: number, sentScope: ReadScope): ReadOutcome<T> {
		if (!answer.ok && answer.kind === 'unauthorised') dispatch({ type: 'unauthorised', handle });
		else if (!answer.ok && answer.kind === 'refused' && (answer.status === 403 || answer.status === 404)) dispatch({ type: 'org-refused', handle, organisation, now: now() });
		if (!stillSent(handle, sentScope)) return superseded;
		if (answer.ok) return { kind: 'ok', value: answer.value };
		if (answer.kind === 'unauthorised') return superseded; // unreachable: the dispatch above ended the session
		if (answer.kind === 'refused') return { kind: 'refused', status: answer.status };
		return { kind: 'unavailable', wait: answer.retryAfter === undefined ? null : waitFor(answer.retryAfter * 1000, clock, wallNow) };
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Sign out everywhere else. The state belongs to one person scope and lives here, outside the reducer, so it
	// survives any screen or stack remount (this runner is the process's one instance) and is discarded only when the
	// person scope changes. `sent` numbers each request; an answer for any other number is not current.

	const revocationSlowMs = deps.slowAfterMs ?? slowAfterMs;
	let revocation: { readonly person: PersonScope | null; readonly view: RevocationView } = { person: null, view: idleRevocation };
	let sent = 0; let slowTimer: { readonly send: number; readonly timer: unknown } | null = null;

	/** Tells the listeners that the revocation view changed, with the (unchanged) account snapshot: account consumers
	 *  see the same object and do not re-render. */
	function publish(): void {
		const snapshot = current;
		for (const listener of [...listeners]) { try { listener(snapshot); } catch { /* a screen's error is its own */ } }
	}
	function clearSlowTimer(): void {
		if (slowTimer !== null) { timers.clear(slowTimer.timer); slowTimer = null; }
	}
	/** One change of the current person's view, published once. Nothing is published if nothing changed. */
	function setRevocation(view: RevocationView): void {
		if (view === revocation.view) return;
		revocation = { person: revocation.person, view };
		publish();
	}
	/** Keeps the state with the current person scope: a different scope drops the view, ends the current request's
	 *  claim to it and clears its slow timer (C1). No notification: the caller's machine change carries one. */
	function alignRevocation(): void {
		const person = personScope(machine);
		if (samePerson(revocation.person, person) || (revocation.person === null && person === null)) return;
		if (revocation.view.inFlight) sent += 1;
		clearSlowTimer();
		revocation = { person, view: idleRevocation };
	}
	/** Whether the handle and person scope a request was sent under, and that request itself, are still current. */
	function stillRevoking(id: number, handle: CredentialHandle, sentFor: PersonScope): boolean {
		const state = machine.state;
		return id === sent && state.kind === 'signed-in' && state.handle === handle && samePerson(personScope(machine), sentFor);
	}

	/** Not `async`: everything up to and including the send runs synchronously in this call. */
	function revokeOthers(expected: PersonScope): Promise<RevokeOutcome> {
		try {
			const state = machine.state; const person = personScope(machine);
			if (state.kind !== 'signed-in' || !samePerson(person, expected)) return Promise.resolve(staleOutcome);
			alignRevocation();
			const refusal = admit(revocation.view, now());
			if (refusal !== null) return Promise.resolve(refusal);
			const handle = state.handle; const credential = credentials.get(handle);
			if (!credential) return Promise.resolve(staleOutcome);
			const id = ++sent;
			clearSlowTimer();
			setRevocation(sendingRevocation);
			slowTimer = { send: id, timer: timers.set(revocationSlowMs, () => {
				if (slowTimer === null || slowTimer.send !== id) return;
				slowTimer = null;
				if (id === sent && samePerson(revocation.person, personScope(machine))) setRevocation(slowRevocation(revocation.view));
			}) };
			let request: Promise<ApiOutcome<Revoked>>;
			try { request = client.post(apiPaths.revokeOthers, credential.token, {}, parseRevoked); } catch (error) { request = Promise.reject(error); }
			return request.then(
				(answer) => settleRevocation(id, handle, person!, answer),
				() => settleRevocation(id, handle, person!, null)
			).catch((): RevokeOutcome => clientBugOutcome);
		} catch { return Promise.resolve(clientBugOutcome); }
	}

	/** After the answer (`null`: the client rejected, a bug in this app, not the network). */
	function settleRevocation(id: number, handle: CredentialHandle, sentFor: PersonScope, answer: ApiOutcome<Revoked> | null): RevokeOutcome {
		// C1: an answer for a person scope, handle or request no longer current changes nothing and notifies nobody.
		if (!stillRevoking(id, handle, sentFor)) return staleOutcome;
		clearSlowTimer();
		if (answer === null) { setRevocation(settledRevocation(unknownResult)); return clientBugOutcome; }
		const result = resultOf(answer, (seconds) => waitFor(seconds * 1000, clock, wallNow));
		if (result === 'unauthorised') {
			// The session has ended: the existing event releases it (and advances the account generation, which drops this
			// state). The request no longer claims the view either way.
			sent += 1;
			revocation = { person: revocation.person, view: idleRevocation };
			const before = machine;
			dispatch({ type: 'unauthorised', handle });
			if (machine === before) publish();
			return staleOutcome;
		}
		setRevocation(settledRevocation(result));
		return result;
	}

	function revocationView(): RevocationView {
		return samePerson(revocation.person, personScope(machine)) ? revocation.view : idleRevocation;
	}

	return {
		organisationRead,
		revokeOthers,
		revocationView,
		start: () => dispatch({ type: 'boot' }),
		snapshot: () => current,
		send: (command) => dispatch(command.type === 'retry' || command.type === 'refresh' ? { type: command.type, now: now() } : command),
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
	};
}
