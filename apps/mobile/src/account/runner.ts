import { apiPaths, type OrganisationPath } from '../api/paths.ts';
import type { Cleanup } from '../auth/cleanup.ts';
import type { ApiClient, ApiOutcome, Attempts, AttemptOutcome, Parse } from '../auth/contracts.ts';
import type { CredentialStore, Generation } from './contracts.ts';
import {
	holds, initial, reduce, slowAfterMs, storeGeneration, view as viewOf,
	type Command, type CredentialHandle, type Effect, type Event, type LocalResult, type Machine
} from './machine.ts';
import { parseMe } from './me.ts';

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
	readonly now?: () => number;
};

/** Commands from screens. Try again carries no time; the runner adds its clock. */
export type UiCommand = Exclude<Command, { type: 'retry' }> | { readonly type: 'retry' };
export type AccountSnapshot = ReturnType<typeof viewOf>;

/** An organisation-scoped read's result. `not-ready`: no verified identity with a chosen organisation, so nothing was
 *  sent. `superseded`: the account or organisation changed while it was in flight, so its answer must not be shown. */
export type OrganisationRead<T> = ApiOutcome<T> | { readonly ok: false; readonly kind: 'not-ready' } | { readonly ok: false; readonly kind: 'superseded' };

export type AccountRunner = {
	/** Reads the saved sign-in once. */
	start(): void;
	snapshot(): AccountSnapshot;
	send(command: UiCommand): void;
	subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
	/** The single entry point for organisation-scoped reads (none exist in this increment; the next one's business
	 *  reads use only this). It sends only when identity is verified and an organisation is chosen, with the current
	 *  credential, to `path(chosenOrganisationId)`. The token never leaves the runner. A 401 ends the session; a 403 or
	 *  404 only asks for a fresh membership list (only that list can remove the organisation). Both are tied to the
	 *  handle and organisation generation the read was sent under, so a late answer can never act on a newer session or
	 *  choice. */
	organisationRead<T>(path: (organisationId: string) => OrganisationPath, parse: Parse<T>): Promise<OrganisationRead<T>>;
};

type Credential = { readonly token: string; readonly expiresAt: string; readonly userId: string };

const defaultTimers: Timers = {
	set: (ms, run) => setTimeout(run, ms),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export function createAccountRunner(deps: AccountRunnerDeps): AccountRunner {
	const { attempts, client, cleanup } = deps;
	const timers = deps.timers ?? defaultTimers; const now = deps.now ?? Date.now;
	let machine: Machine = initial();
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
		const snapshot = viewOf(machine);
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
	const refuse = (handle: CredentialHandle) => { fault(); dispatch({ type: 'server-finished', handle, result: 'refused', retryAt: null }); };

	function serverAnswer(handle: CredentialHandle, answer: Promise<'revoked' | 'still-pending'>): void {
		void answer.then(
			(result) => {
				if (result === 'revoked') {
					if (holder === handle) holder = null;
					dispatch({ type: 'server-finished', handle, result: 'ended', retryAt: null });
				} else dispatch({ type: 'server-finished', handle, result: 'pending', retryAt: cleanup.retryAt() });
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
				if (!store) { dispatch({ type: 'launch-read', result: { kind: 'unavailable' } }); return; }
				void store.read().then(
					(session) => {
						if (session === null) { dispatch({ type: 'launch-read', result: { kind: 'none' } }); return; }
						const handle = mint({ token: session.token, expiresAt: session.expiresAt, userId: session.userId });
						deliver({ type: 'launch-read', result: { kind: 'session', handle, userId: session.userId } }, handle);
					},
					() => dispatch({ type: 'launch-read', result: { kind: 'unreadable' } }));
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
				if (!store || !credential) { fault(); dispatch({ type: 'install-finished', handle: effect.handle, result: 'failed' }); return; }
				void store.install({ token: credential.token, expiresAt: credential.expiresAt, userId: credential.userId }, effect.generation).then(
					(result) => dispatch({ type: 'install-finished', handle: effect.handle, result }),
					() => dispatch({ type: 'install-finished', handle: effect.handle, result: 'failed' }));
				return;
			}
			case 'load-me': {
				const credential = credentials.get(effect.handle);
				const { handle, membership } = effect;
				// A missing credential is a fault; the bounded answer is "could not check", never signed in.
				if (!credential) { fault(); dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unavailable', retryAt: null } }); return; }
				void client.get(apiPaths.me, credential.token, parseMe).then(
					(answer) => {
						if (answer.ok) { dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'ok', me: answer.value } }); return; }
						if (answer.kind === 'unauthorised') { dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unauthorised' } }); return; }
						// Unavailable or refused: never a sign-out. A server's Retry-After paces Try again.
						const retryAt = answer.kind === 'unavailable' && answer.retryAfter !== undefined ? now() + answer.retryAfter * 1000 : null;
						dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unavailable', retryAt } });
					},
					() => dispatch({ type: 'me-finished', handle, membership, outcome: { kind: 'unavailable', retryAt: null } }));
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

	async function organisationRead<T>(path: (organisationId: string) => OrganisationPath, parse: Parse<T>): Promise<OrganisationRead<T>> {
		const state = machine.state;
		if (state.kind !== 'signed-in' || state.org.kind !== 'chosen') return { ok: false, kind: 'not-ready' };
		const handle = state.handle; const credential = credentials.get(handle);
		if (!credential) return { ok: false, kind: 'not-ready' };
		const organisation = machine.generations.organisation;
		const target = path(state.org.membership.organisationId);
		let answer: ApiOutcome<T>;
		try { answer = await client.get(target, credential.token, parse); } catch { answer = { ok: false, kind: 'unavailable', status: 0 }; }
		if (!answer.ok && answer.kind === 'unauthorised') dispatch({ type: 'unauthorised', handle });
		else if (!answer.ok && answer.kind === 'refused' && (answer.status === 403 || answer.status === 404)) dispatch({ type: 'org-refused', handle, organisation });
		const after = machine.state;
		if (after.kind !== 'signed-in' || after.handle !== handle || machine.generations.organisation !== organisation) return { ok: false, kind: 'superseded' };
		return answer;
	}

	return {
		organisationRead,
		start: () => dispatch({ type: 'boot' }),
		snapshot: () => viewOf(machine),
		send: (command) => dispatch(command.type === 'retry' ? { type: 'retry', now: now() } : command),
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
	};
}
