import type { AttemptKind, AttemptState, SessionUser } from '../auth/contracts.ts';
import { linkTarget, refusedLink } from '../lib/links.ts';
import { laterWait, type Wait } from './clock.ts';
import type { Generation, ReadScope } from './contracts.ts';
import type { Me, Membership } from './me.ts';

/** The account state machine (docs/plans/expo-mobile-platform-account-2026-09.md "Account contract"; reviewed plan
 *  /tmp/captain-business-chat/mobile-account-proposal.md, revision 2). Pure: `reduce` takes the machine and one event
 *  and returns the next machine and the effects the runner must perform. No token ever appears here: credentials are
 *  opaque handles that only the runner (runner.ts) can resolve.
 *
 *  Rules this file carries:
 *  - Every result event names the handle and the generation it was issued under; a result for anything no longer
 *    current changes nothing.
 *  - Nothing is shown as signed in, and no destination is applied, until `/v1/me` has answered for the current handle
 *    and an organisation has been chosen from that answer.
 *  - Only a freshly applied membership list removes an organisation. A refusal (403/404) only asks for a new list.
 *  - A credential being released keeps sign-in blocked until its local removal has a result and its session is known
 *    to be unusable. "A copy may remain" and "not yet ended" are reported, never hidden.
 *  - Slow operations change wording after ten seconds; they are never cancelled or replaced.
 *  - Every `/v1/me` load (launch, Try again, a refusal, a foreground refresh) follows one pacing rule
 *    (docs/plans/expo-mobile-auth-composition-2026-09.md §3): nothing is sent before the latest server wait, from any
 *    trigger; a foreground refresh also waits 30 s after the last load started. Times come from the runner's clamped
 *    monotonic clock. The pacing lives on the machine, so it survives sign-out and a later sign-in in this process. */

declare const handleBrand: unique symbol;
/** A credential in the runner's memory. Minted only by the runner; meaningless anywhere else. */
export type CredentialHandle = number & { readonly [handleBrand]: true };

export type Generations = { readonly account: number; readonly organisation: number; readonly membership: number };

/** What happened to the saved copy on this device. `no-usable-copy` is the store's `absent`: no usable saved sign-in
 *  was returned, which is not proof that no bytes remain (contracts.ts). */
export type LocalResult = 'deleted' | 'no-usable-copy' | 'newer-kept' | 'copy-may-remain';
export type LocalState = 'removing' | LocalResult;
/** Whether the session is known to be unusable. `ended`: sign-out answered 2xx or 401. `not-needed`: the API already
 *  refused it with 401. `pending`: not yet confirmed; the runner's cleanup holds it for Try again. `refused`: the
 *  revocation could not even begin because the runner's one cleanup slot held another session (a fault); the token is
 *  kept, sign-in stays blocked, and only a Try again made when the slot is free can begin it. */
export type ServerState = 'revoking' | 'pending' | 'refused' | 'ended' | 'not-needed';
/** A server state that Try again may act on. */
const retryable = (server: ServerState) => server === 'pending' || server === 'refused';
export type ReleaseReason = 'sign-out' | 'save-failed' | 'save-stale' | 'session-ended';
export type Release = {
	readonly handle: CredentialHandle; readonly reason: ReleaseReason;
	/** `wait`: the revocation's server wait while `pending` (the cleanup sends nothing before it). */
	readonly local: LocalState; readonly server: ServerState; readonly wait: Wait | null;
};

/** Why the organisation that was in use is gone. `lost` names it from the membership that was chosen; `lost-unnamed`
 *  is a stored choice (only its ID is known) that the fresh list does not include. Token-free. */
export type OrgNotice = { readonly kind: 'lost'; readonly name: string } | { readonly kind: 'lost-unnamed' };

/** Minimum spacing between foreground refreshes (root decision). A longer server wait always wins. */
export const refreshSpacingMs = 30_000;

/** A sign-in that did not finish: the attempt outcomes, or `busy` when the gate could not be passed. */
export type SignInFailure = Exclude<AttemptKind, 'signed-in'> | 'busy';
export type Notice =
	| { readonly kind: 'sign-in'; readonly outcome: SignInFailure }
	| { readonly kind: 'released'; readonly reason: ReleaseReason; readonly local: LocalResult; readonly server: 'ended' | 'not-needed' }
	| { readonly kind: 'organisation-not-remembered' };

export type OrgState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'none' }
	| { readonly kind: 'choose' }
	| { readonly kind: 'chosen'; readonly membership: Membership };

export type AccountState =
	| { readonly kind: 'starting'; readonly slow: boolean }
	| { readonly kind: 'storage-unavailable' }
	| { readonly kind: 'storage-unreadable'; readonly reading: boolean; readonly slow: boolean }
	| { readonly kind: 'signed-out'; readonly notice: Notice | null; readonly gate: 'idle' | 'waiting' | 'busy' }
	| { readonly kind: 'signing-in'; readonly phase: 'browser' | 'closing'; readonly slow: boolean }
	| { readonly kind: 'saving'; readonly handle: CredentialHandle; readonly userId: string; readonly slow: boolean }
	| { readonly kind: 'checking'; readonly handle: CredentialHandle; readonly userId: string }
	| { readonly kind: 'unverified'; readonly handle: CredentialHandle; readonly userId: string; readonly retrying: boolean }
	| {
		readonly kind: 'signed-in'; readonly handle: CredentialHandle; readonly user: SessionUser;
		readonly memberships: readonly Membership[]; readonly org: OrgState; readonly refreshing: boolean;
		readonly destination: string | null; readonly notice: Notice | null; readonly orgNotice: OrgNotice | null;
	}
	| { readonly kind: 'releasing'; readonly release: Release; readonly slow: boolean };

type SlowKind = 'read' | 'closing' | 'install' | 'removal';

export type Machine = {
	readonly state: AccountState;
	readonly generations: Generations;
	/** The destination asked for when sign-in started (passed to the attempt core). */
	readonly requested: string | null;
	/** The app route to open once identity and an organisation are verified; dropped when the account changes. */
	readonly returnTo: string | null;
	readonly watch: { readonly kind: SlowKind; readonly id: number } | null;
	readonly nextWatch: number;
	/** Credentials that arrived when no state could take them (a sign-in result outside `signing-in`: unreachable by
	 *  construction, since only that state starts an attempt). Each is released exactly like any other: compare-delete,
	 *  revoke, Try again, and forgotten only when both have results. Sign-in stays blocked while any is held. */
	readonly strays: readonly Release[];
	/** A second credential was minted while one was live (plan §2.2). Both are kept and released; nothing is dropped. */
	readonly fault: boolean;
	/** `/v1/me` pacing, kept for the life of the process (a full restart resets it). */
	readonly pacing: { readonly lastLoadStarted: number | null; readonly serverNotBefore: Wait | null };
};

export const slowAfterMs = 10_000;

/** What the person asked for. `retry` carries the runner's clock so the reducer stays pure. */
export type Command =
	| { readonly type: 'sign-in'; readonly returnTo?: string }
	| { readonly type: 'cancel' }
	| { readonly type: 'sign-out' }
	| { readonly type: 'retry'; readonly now: number }
	/** The app came to the foreground: check memberships again, if pacing allows. */
	| { readonly type: 'refresh'; readonly now: number }
	| { readonly type: 'choose-organisation'; readonly organisationId: string }
	| { readonly type: 'destination-used' };

export type Event =
	| Command
	| { readonly type: 'boot' }
	| {
		readonly type: 'launch-read'; readonly now: number;
		readonly result:
			| { readonly kind: 'session'; readonly handle: CredentialHandle; readonly userId: string }
			| { readonly kind: 'none' } | { readonly kind: 'unreadable' } | { readonly kind: 'unavailable' };
	}
	| { readonly type: 'gate-checked'; readonly result: 'settled' | 'timed-out' | 'blocked' }
	| { readonly type: 'attempt-state'; readonly state: AttemptState }
	| {
		readonly type: 'attempt-finished';
		readonly outcome:
			| { readonly kind: 'signed-in'; readonly handle: CredentialHandle; readonly userId: string; readonly returnTo: string }
			| { readonly kind: SignInFailure };
	}
	| { readonly type: 'install-finished'; readonly handle: CredentialHandle; readonly result: 'written' | 'stale' | 'failed'; readonly now: number }
	| {
		readonly type: 'me-finished'; readonly handle: CredentialHandle; readonly membership: number;
		readonly outcome: { readonly kind: 'ok'; readonly me: Me } | { readonly kind: 'unauthorised' } | { readonly kind: 'unavailable'; readonly wait: Wait | null };
	}
	/** The stored choice for this person: an ID, or null when none is usable (unreadable counts as none: it is a hint). */
	| { readonly type: 'org-read'; readonly handle: CredentialHandle; readonly organisation: number; readonly organisationId: string | null }
	| { readonly type: 'org-saved'; readonly handle: CredentialHandle; readonly organisation: number; readonly result: 'written' | 'stale' | 'failed' }
	/** A business read scoped to the chosen organisation answered 403 or 404 (next increment's reads report this). */
	| { readonly type: 'org-refused'; readonly handle: CredentialHandle; readonly organisation: number; readonly now: number }
	| { readonly type: 'unauthorised'; readonly handle: CredentialHandle }
	| { readonly type: 'local-finished'; readonly handle: CredentialHandle; readonly result: LocalResult }
	| { readonly type: 'server-finished'; readonly handle: CredentialHandle; readonly result: 'ended' | 'pending' | 'refused'; readonly wait: Wait | null }
	| { readonly type: 'slow'; readonly id: number }
	| { readonly type: 'fault' }
	/** The runner minted `handle` and, after the event carrying it, no state holds it (see `holds`). */
	| { readonly type: 'unclaimed'; readonly handle: CredentialHandle };

export type Effect =
	| { readonly type: 'read-stored' }
	/** The runner's half of the global gate: no live credential, no cleanup held, the attempt core idle, then
	 *  `store.settled(slowAfterMs)`. */
	| { readonly type: 'wait-settled' }
	| { readonly type: 'start-attempt'; readonly returnTo: string | null }
	| { readonly type: 'cancel-attempt' }
	| { readonly type: 'install'; readonly handle: CredentialHandle; readonly generation: Generation }
	| { readonly type: 'load-me'; readonly handle: CredentialHandle; readonly membership: number }
	| { readonly type: 'read-org'; readonly handle: CredentialHandle; readonly userId: string; readonly organisation: number }
	| { readonly type: 'set-org'; readonly handle: CredentialHandle; readonly userId: string; readonly organisationId: string; readonly generation: Generation }
	| { readonly type: 'forget-org-if'; readonly userId: string; readonly organisationId: string }
	| { readonly type: 'remove-if'; readonly handle: CredentialHandle }
	| { readonly type: 'revoke'; readonly handle: CredentialHandle }
	/** The person's Try again: repeat the local compare-delete and/or the server revocation (which itself never sends
	 *  before the server's retry time). */
	| { readonly type: 'retry-release'; readonly handle: CredentialHandle; readonly local: boolean; readonly server: boolean }
	/** Every obligation has a result: forget the token. */
	| { readonly type: 'release'; readonly handle: CredentialHandle }
	| { readonly type: 'start-timer'; readonly id: number; readonly ms: number }
	| { readonly type: 'stop-timer'; readonly id: number };

export type Step = { readonly machine: Machine; readonly effects: readonly Effect[] };

export function initial(): Machine {
	return {
		state: { kind: 'starting', slow: false }, generations: { account: 0, organisation: 0, membership: 0 },
		requested: null, returnTo: null, watch: null, nextWatch: 1, strays: [], fault: false,
		pacing: { lastLoadStarted: null, serverNotBefore: null }
	};
}

/** The store's view of the generations (contracts.ts `Generation`). */
export const storeGeneration = (generations: Generations): Generation =>
	({ account: generations.account, organisation: generations.organisation });

// ---------------------------------------------------------------------------------------------------------------
// Helpers. Each takes the effects array it may append to.

function startWatch(machine: Machine, kind: SlowKind, effects: Effect[]): Machine {
	const stopped = stopWatch(machine, effects);
	const id = stopped.nextWatch;
	effects.push({ type: 'start-timer', id, ms: slowAfterMs });
	return { ...stopped, watch: { kind, id }, nextWatch: id + 1 };
}
function stopWatch(machine: Machine, effects: Effect[]): Machine {
	if (machine.watch === null) return machine;
	effects.push({ type: 'stop-timer', id: machine.watch.id });
	return { ...machine, watch: null };
}
function advance(machine: Machine, ...parts: (keyof Generations)[]): Machine {
	const next: { account: number; organisation: number; membership: number } = { ...machine.generations };
	for (const part of parts) next[part] += 1;
	return { ...machine, generations: next };
}
/** Only an app route, and only one that the link rule accepts, is kept as a destination. */
const destinationFor = (returnTo: string | null | undefined): string | null => {
	if (typeof returnTo !== 'string') return null;
	const route = linkTarget(returnTo);
	return route === refusedLink ? null : route;
};
const currentHandle = (state: AccountState): CredentialHandle | null =>
	state.kind === 'saving' || state.kind === 'checking' || state.kind === 'unverified' || state.kind === 'signed-in' ? state.handle
		: state.kind === 'releasing' ? state.release.handle : null;

/** Start releasing `handle`: compare-delete the local copy and, unless the API already refused the session, revoke it.
 *  The destination goes with the account. */
function beginRelease(machine: Machine, handle: CredentialHandle, reason: ReleaseReason, revoke: boolean, effects: Effect[]): Machine {
	effects.push({ type: 'remove-if', handle });
	if (revoke) effects.push({ type: 'revoke', handle });
	const release: Release = { handle, reason, local: 'removing', server: revoke ? 'revoking' : 'not-needed', wait: null };
	return startWatch({ ...machine, state: { kind: 'releasing', release, slow: false }, returnTo: null }, 'removal', effects);
}

/** Whether the latest server wait still blocks a `/v1/me` load at `now` (exactly at `until`, it no longer does). */
const blockedByServer = (machine: Machine, now: number): boolean =>
	machine.pacing.serverNotBefore !== null && now < machine.pacing.serverNotBefore.until;

/** Sends one `/v1/me` load for `handle` at the next membership generation and records when it started. The caller has
 *  already checked the pacing rule for its trigger. */
function loadMe(machine: Machine, handle: CredentialHandle, now: number, effects: Effect[]): Machine {
	const next = advance(machine, 'membership');
	effects.push({ type: 'load-me', handle, membership: next.generations.membership });
	return { ...next, pacing: { ...next.pacing, lastLoadStarted: now } };
}

/** The first check of a session (at launch, or after a sign-in's save). A server wait inherited in this process that
 *  still blocks it shows `unverified` with that wait and Try again, never a silent `checking`. */
function firstCheck(machine: Machine, handle: CredentialHandle, userId: string, now: number, effects: Effect[]): Machine {
	if (blockedByServer(machine, now)) return { ...machine, state: { kind: 'unverified', handle, userId, retrying: false } };
	return { ...loadMe(machine, handle, now, effects), state: { kind: 'checking', handle, userId } };
}

/** When the local removal has a result and the session is known to be unusable, forget the token and sign out with a
 *  notice of both results. Otherwise stay releasing (sign-in stays blocked). */
function settleRelease(machine: Machine, effects: Effect[]): Machine {
	const state = machine.state;
	if (state.kind !== 'releasing') return machine;
	const { local, server, handle, reason } = state.release;
	let next = machine;
	if (local !== 'removing' && next.watch?.kind === 'removal') next = stopWatch(next, effects);
	if (local === 'removing' || (server !== 'ended' && server !== 'not-needed')) return next;
	effects.push({ type: 'release', handle });
	return { ...next, state: { kind: 'signed-out', notice: { kind: 'released', reason, local, server }, gate: 'idle' } };
}

/** A stray release has a new result: forget its token once both obligations have results, else keep it. */
function settleStray(machine: Machine, release: Release, effects: Effect[]): Machine {
	const others = machine.strays.filter((r) => r.handle !== release.handle);
	const done = release.local !== 'removing' && (release.server === 'ended' || release.server === 'not-needed');
	if (done) { effects.push({ type: 'release', handle: release.handle }); return { ...machine, strays: others }; }
	return { ...machine, strays: [...others, release] };
}

/** Try again for strays: the same deliberate retry as for the main release (§6.8 of the plan). */
function retryStrays(machine: Machine, now: number, effects: Effect[]): Machine {
	let next = machine;
	for (const stray of machine.strays) {
		if (!retryable(stray.server) || stray.local === 'removing') continue;
		if (stray.wait !== null && now < stray.wait.until) continue; // the server's wait is honoured, never shortened
		const again = stray.local === 'copy-may-remain';
		effects.push({ type: 'retry-release', handle: stray.handle, local: again, server: true });
		next = { ...next, strays: next.strays.map((r): Release => r.handle === stray.handle ? { ...r, local: again ? 'removing' : r.local, server: 'revoking', wait: null } : r) };
	}
	return next;
}

/** An organisation has been chosen: record it and open the deferred destination, if any. A person's own choice clears
 *  the loss notice; an automatic one (the only membership) keeps it, so the loss is still reported. */
function choose(machine: Machine, membership: Membership, effects: Effect[], save: boolean, clearsNotice = false): Machine {
	const current = machine.state;
	if (current.kind !== 'signed-in') return machine;
	const state = clearsNotice ? { ...current, orgNotice: null } : current;
	let next = machine;
	if (save) {
		next = advance(next, 'organisation');
		effects.push({
			type: 'set-org', handle: state.handle, userId: state.user.id, organisationId: membership.organisationId,
			generation: storeGeneration(next.generations)
		});
	}
	return {
		...next, returnTo: null,
		state: { ...state, org: { kind: 'chosen', membership }, destination: state.destination ?? next.returnTo }
	};
}

/** No usable choice: none with no memberships, the only one when there is exactly one (saved as the choice), else ask.
 *  Reached only from a freshly applied `/v1/me` answer for the current handle, after `applyMe` has checked that the
 *  answer names the user the credential was saved for (a different user fails closed as `session-ended`). So a choice
 *  is only ever made from verified memberships and saved under that verified user's own key (`org.{userId}`); an
 *  unreadable stored hint just means "choose", and nothing is ever written for another user. */
function defaultOrganisation(machine: Machine, effects: Effect[]): Machine {
	const state = machine.state;
	if (state.kind !== 'signed-in') return machine;
	if (state.memberships.length === 0) return { ...machine, state: { ...state, org: { kind: 'none' } } };
	if (state.memberships.length === 1) return choose(machine, state.memberships[0]!, effects, true);
	return { ...machine, state: { ...state, org: { kind: 'choose' } } };
}

/** A fresh membership list for the current handle. */
function applyMe(machine: Machine, me: Me, effects: Effect[]): Machine {
	const state = machine.state;
	if (state.kind !== 'checking' && state.kind !== 'unverified' && state.kind !== 'signed-in') return machine;
	const userId = state.kind === 'signed-in' ? state.user.id : state.userId;
	if (me.user.id !== userId) {
		// The saved credential belongs to someone else than it said: release it, and revoke it (it is still ours).
		return beginRelease(advance(machine, 'account', 'organisation'), state.handle, 'session-ended', true, effects);
	}
	if (state.kind !== 'signed-in') {
		const next: Machine = {
			...machine,
			state: { kind: 'signed-in', handle: state.handle, user: me.user, memberships: me.memberships, org: { kind: 'loading' }, refreshing: false, destination: null, notice: null, orgNotice: null }
		};
		if (me.memberships.length === 0) return defaultOrganisation(next, effects);
		effects.push({ type: 'read-org', handle: state.handle, userId, organisation: next.generations.organisation });
		return next;
	}
	const refreshed: Machine = { ...machine, state: { ...state, user: me.user, memberships: me.memberships, refreshing: false } };
	if (state.org.kind === 'loading') return refreshed; // the stored choice is still being read; it is checked on arrival
	if (state.org.kind === 'chosen') {
		const chosenId = state.org.membership.organisationId;
		const still = me.memberships.find((m) => m.organisationId === chosenId);
		if (still) return choose(refreshed, still, effects, false);
		// Lost: the fresh list no longer has it. Its name is the one from the membership that was chosen.
		effects.push({ type: 'forget-org-if', userId, organisationId: chosenId });
		const lost = advance(refreshed, 'organisation');
		const orgNotice: OrgNotice = { kind: 'lost', name: state.org.membership.organisationName };
		return defaultOrganisation({
			...lost, state: { ...state, user: me.user, memberships: me.memberships, refreshing: false, org: { kind: 'choose' }, orgNotice }
		}, effects);
	}
	return defaultOrganisation(refreshed, effects);
}

// ---------------------------------------------------------------------------------------------------------------

export function reduce(machine: Machine, event: Event): Step {
	const effects: Effect[] = [];
	const next = step(machine, event, effects);
	return { machine: next, effects };
}

function step(machine: Machine, event: Event, effects: Effect[]): Machine {
	const state = machine.state;
	switch (event.type) {
		case 'boot': {
			// Once only: a second boot would read (and mint) the saved session twice.
			if (state.kind !== 'starting' || machine.nextWatch !== 1) return machine;
			effects.push({ type: 'read-stored' });
			return startWatch(machine, 'read', effects);
		}

		case 'launch-read': {
			const reading = state.kind === 'starting' || (state.kind === 'storage-unreadable' && state.reading);
			if (!reading) return machine;
			const next = stopWatch(machine, effects);
			const result = event.result;
			if (result.kind === 'unavailable') return { ...next, state: { kind: 'storage-unavailable' } };
			if (result.kind === 'unreadable') return { ...next, state: { kind: 'storage-unreadable', reading: false, slow: false } };
			if (result.kind === 'none') return { ...next, state: { kind: 'signed-out', notice: null, gate: 'idle' } };
			return firstCheck(next, result.handle, result.userId, event.now, effects);
		}

		case 'sign-in': {
			if (!signInOffered(machine)) return machine;
			effects.push({ type: 'wait-settled' });
			return { ...machine, requested: typeof event.returnTo === 'string' ? event.returnTo : null, state: { kind: 'signed-out', notice: null, gate: 'waiting' } };
		}

		case 'gate-checked': {
			if (state.kind !== 'signed-out' || state.gate !== 'waiting') return machine;
			if (event.result !== 'settled') return { ...machine, state: { ...state, gate: 'busy' } };
			effects.push({ type: 'start-attempt', returnTo: machine.requested });
			return { ...machine, state: { kind: 'signing-in', phase: 'browser', slow: false } };
		}

		case 'cancel': {
			if (state.kind !== 'signing-in' || state.phase !== 'browser') return machine;
			effects.push({ type: 'cancel-attempt' });
			return machine;
		}

		case 'attempt-state': {
			if (state.kind !== 'signing-in' || state.phase !== 'browser' || event.state !== 'closing') return machine;
			return startWatch({ ...machine, state: { kind: 'signing-in', phase: 'closing', slow: false } }, 'closing', effects);
		}

		case 'attempt-finished': {
			const outcome = event.outcome;
			if (state.kind !== 'signing-in') {
				// Only a signing-in state starts an attempt, so this is unreachable. A live session in it is still
				// released and tracked to the end, never dropped or left holding the gate closed.
				if (outcome.kind !== 'signed-in') return machine;
				effects.push({ type: 'remove-if', handle: outcome.handle }, { type: 'revoke', handle: outcome.handle });
				const stray: Release = { handle: outcome.handle, reason: 'save-stale', local: 'removing', server: 'revoking', wait: null };
				return { ...machine, strays: [...machine.strays, stray], fault: true };
			}
			const next = stopWatch(machine, effects);
			if (outcome.kind !== 'signed-in') {
				return { ...next, requested: null, state: { kind: 'signed-out', notice: { kind: 'sign-in', outcome: outcome.kind }, gate: 'idle' } };
			}
			// The account changes before the save is queued, so the store can tell a stale save (contracts.ts).
			const advanced = advance(next, 'account', 'organisation');
			effects.push({ type: 'install', handle: outcome.handle, generation: storeGeneration(advanced.generations) });
			return startWatch({
				...advanced, requested: null, returnTo: destinationFor(outcome.returnTo),
				state: { kind: 'saving', handle: outcome.handle, userId: outcome.userId, slow: false }
			}, 'install', effects);
		}

		case 'install-finished': {
			if (state.kind !== 'saving' || state.handle !== event.handle) return machine;
			const next = stopWatch(machine, effects);
			if (event.result === 'written') return firstCheck(next, state.handle, state.userId, event.now, effects);
			// Stale, or a failed save that may still have written: compare-delete it and revoke it; never keep it in
			// memory only.
			return beginRelease(next, state.handle, event.result === 'stale' ? 'save-stale' : 'save-failed', true, effects);
		}

		case 'me-finished': {
			const outcome = event.outcome;
			// A server wait is kept from every answer, even one no longer current: it only ever makes waiting longer.
			const paced: Machine = outcome.kind === 'unavailable' && outcome.wait !== null
				? { ...machine, pacing: { ...machine.pacing, serverNotBefore: laterWait(machine.pacing.serverNotBefore, outcome.wait) } }
				: machine;
			if (currentHandle(state) !== event.handle || machine.generations.membership !== event.membership) return paced;
			if (state.kind !== 'checking' && state.kind !== 'unverified' && state.kind !== 'signed-in') return paced;
			if (outcome.kind === 'ok') return applyMe({ ...machine, pacing: { ...machine.pacing, serverNotBefore: null } }, outcome.me, effects);
			if (outcome.kind === 'unauthorised') return beginRelease(advance(machine, 'account', 'organisation'), state.handle, 'session-ended', false, effects);
			// Unavailable: never inferred to be a sign-out. A saved session that could not be checked is not signed in.
			if (state.kind === 'signed-in') return { ...paced, state: { ...state, refreshing: false } };
			return { ...paced, state: { kind: 'unverified', handle: state.handle, userId: state.userId, retrying: false } };
		}

		case 'org-read': {
			if (state.kind !== 'signed-in' || state.handle !== event.handle || state.org.kind !== 'loading') return machine;
			if (machine.generations.organisation !== event.organisation) return machine;
			const stored = event.organisationId;
			const member = stored === null ? undefined : state.memberships.find((m) => m.organisationId === stored);
			if (member) return choose(machine, member, effects, false);
			if (stored === null) return defaultOrganisation(machine, effects);
			// A remembered choice that the fresh list does not include: only its ID is known, so the notice names nothing.
			effects.push({ type: 'forget-org-if', userId: state.user.id, organisationId: stored });
			const forgotten = advance(machine, 'organisation');
			return defaultOrganisation({ ...forgotten, state: { ...state, orgNotice: { kind: 'lost-unnamed' } } }, effects);
		}

		case 'choose-organisation': {
			if (state.kind !== 'signed-in' || state.org.kind === 'loading') return machine;
			const member = state.memberships.find((m) => m.organisationId === event.organisationId);
			if (!member) return machine;
			if (state.org.kind === 'chosen' && state.org.membership.organisationId === member.organisationId) return machine;
			return choose(machine, member, effects, true, true);
		}

		case 'org-saved': {
			if (state.kind !== 'signed-in' || state.handle !== event.handle || machine.generations.organisation !== event.organisation) return machine;
			if (event.result !== 'failed') return machine;
			// The choice stands for this session; it just will not be remembered.
			return { ...machine, state: { ...state, notice: { kind: 'organisation-not-remembered' } } };
		}

		case 'org-refused': {
			// Only a fresh membership list can remove an organisation: ask for one (refusals already in flight join it).
			// An automatic trigger, like a foreground refresh: never before the server's wait, and never within 30 s of
			// the latest `/v1/me` load of any kind (docs/plans/expo-mobile-my-work-read-2026-09.md §3.2). A refusal
			// inside either records nothing to retry.
			if (state.kind !== 'signed-in' || state.handle !== event.handle || state.refreshing) return machine;
			if (machine.generations.organisation !== event.organisation || blockedByServer(machine, event.now)) return machine;
			const last = machine.pacing.lastLoadStarted;
			if (last !== null && event.now < last + refreshSpacingMs) return machine;
			return { ...loadMe(machine, state.handle, event.now, effects), state: { ...state, refreshing: true } };
		}

		case 'refresh': {
			// Foreground: coalesced with a load in flight, never before the server's wait, and at most every 30 s.
			if (state.kind !== 'signed-in' || state.refreshing || blockedByServer(machine, event.now)) return machine;
			const last = machine.pacing.lastLoadStarted;
			if (last !== null && event.now < last + refreshSpacingMs) return machine;
			return { ...loadMe(machine, state.handle, event.now, effects), state: { ...state, refreshing: true } };
		}

		case 'unauthorised': {
			if (currentHandle(state) !== event.handle) return machine;
			if (state.kind !== 'checking' && state.kind !== 'unverified' && state.kind !== 'signed-in') return machine;
			return beginRelease(advance(machine, 'account', 'organisation'), state.handle, 'session-ended', false, effects);
		}

		case 'sign-out': {
			if (state.kind !== 'signed-in' && state.kind !== 'unverified') return machine;
			return beginRelease(advance(machine, 'account', 'organisation'), state.handle, 'sign-out', true, effects);
		}

		case 'local-finished': {
			const stray = machine.strays.find((r) => r.handle === event.handle);
			if (stray) return stray.local === 'removing' ? settleStray(machine, { ...stray, local: event.result }, effects) : machine;
			if (state.kind !== 'releasing' || state.release.handle !== event.handle || state.release.local !== 'removing') return machine;
			return settleRelease({ ...machine, state: { ...state, release: { ...state.release, local: event.result } } }, effects);
		}

		case 'server-finished': {
			const stray = machine.strays.find((r) => r.handle === event.handle);
			if (stray) {
				if (stray.server !== 'revoking') return machine;
				return settleStray(machine, { ...stray, server: event.result, wait: event.result === 'pending' ? event.wait : null }, effects);
			}
			if (state.kind !== 'releasing' || state.release.handle !== event.handle || state.release.server !== 'revoking') return machine;
			const release: Release = { ...state.release, server: event.result, wait: event.result === 'pending' ? event.wait : null };
			return settleRelease({ ...machine, state: { ...state, release } }, effects);
		}

		case 'retry':
			return retryStrays(retryMain(machine, event.now, effects), event.now, effects);

		case 'destination-used': {
			if (state.kind !== 'signed-in' || state.destination === null) return machine;
			return { ...machine, state: { ...state, destination: null } };
		}

		case 'slow': {
			if (machine.watch === null || machine.watch.id !== event.id) return machine;
			const slow = { ...machine, watch: null };
			if (state.kind === 'starting') return { ...slow, state: { ...state, slow: true } };
			if (state.kind === 'storage-unreadable' && state.reading) return { ...slow, state: { ...state, slow: true } };
			if (state.kind === 'signing-in' && state.phase === 'closing') return { ...slow, state: { ...state, slow: true } };
			if (state.kind === 'saving') return { ...slow, state: { ...state, slow: true } };
			if (state.kind === 'releasing' && state.release.local === 'removing') return { ...slow, state: { ...state, slow: true } };
			return slow;
		}

		case 'fault':
			return { ...machine, fault: true };

		case 'unclaimed': {
			// A credential the runner minted that no state took: release it like any other, never drop it.
			if (holds(machine, event.handle)) return machine;
			effects.push({ type: 'remove-if', handle: event.handle }, { type: 'revoke', handle: event.handle });
			const stray: Release = { handle: event.handle, reason: 'save-stale', local: 'removing', server: 'revoking', wait: null };
			return { ...machine, strays: [...machine.strays, stray], fault: true };
		}
	}
}

/** Whether this machine accounts for `handle`: the current credential, one being released, or a stray. */
export function holds(machine: Machine, handle: CredentialHandle): boolean {
	return currentHandle(machine.state) === handle || machine.strays.some((r) => r.handle === handle);
}

/** Try again, by state: check the saved sign-in again, retry a release, read storage again, or pass the gate again. */
function retryMain(machine: Machine, now: number, effects: Effect[]): Machine {
	const state = machine.state;
	if (state.kind === 'unverified') {
		// The server's Retry-After is honoured: no early Try again (from any trigger, by the shared pacing).
		if (state.retrying || blockedByServer(machine, now)) return machine;
		return { ...loadMe(machine, state.handle, now, effects), state: { ...state, retrying: true } };
	}
	if (state.kind === 'releasing') {
		const { local, server, handle, wait } = state.release;
		if (!retryable(server) || local === 'removing') return machine;
		if (wait !== null && now < wait.until) return machine; // the revocation's server wait is honoured too
		const again = local === 'copy-may-remain';
		effects.push({ type: 'retry-release', handle, local: again, server: true });
		const release: Release = { ...state.release, local: again ? 'removing' : local, server: 'revoking', wait: null };
		const next: Machine = { ...machine, state: { ...state, release } };
		return again ? startWatch({ ...next, state: { ...state, release, slow: false } }, 'removal', effects) : next;
	}
	if (state.kind === 'storage-unreadable' && !state.reading) {
		effects.push({ type: 'read-stored' });
		return startWatch({ ...machine, state: { kind: 'storage-unreadable', reading: true, slow: false } }, 'read', effects);
	}
	if (state.kind === 'signed-out' && state.gate === 'busy') {
		effects.push({ type: 'wait-settled' });
		return { ...machine, state: { ...state, gate: 'waiting' } };
	}
	return machine;
}

// ---------------------------------------------------------------------------------------------------------------
// What screens may see: no handles, no tokens.

export type AccountView =
	/** Provider states outside any runner (account-source.ts): not a native build, no valid API address, or composition
	 *  failed. The machine never produces these. */
	| { readonly kind: 'web-only' }
	| { readonly kind: 'misconfigured' }
	| { readonly kind: 'startup-failed' }
	| { readonly kind: 'starting'; readonly slow: boolean }
	| { readonly kind: 'storage-unavailable' }
	| { readonly kind: 'storage-unreadable'; readonly reading: boolean; readonly slow: boolean }
	| { readonly kind: 'signed-out'; readonly notice: Notice | null; readonly gate: 'idle' | 'waiting' | 'busy' }
	| { readonly kind: 'signing-in'; readonly phase: 'browser' | 'closing' | 'saving'; readonly slow: boolean }
	| { readonly kind: 'checking' }
	/** `wait`: the server's wait still in force, if any (Try again stays disabled until `wait.until`). */
	| { readonly kind: 'unverified'; readonly retrying: boolean; readonly wait: Wait | null }
	| {
		readonly kind: 'signed-in'; readonly user: SessionUser; readonly memberships: readonly Membership[];
		readonly org: OrgState; readonly refreshing: boolean; readonly destination: string | null; readonly notice: Notice | null;
		readonly orgNotice: OrgNotice | null;
		/** True only with verified identity and a chosen organisation: the only time business reads may start. */
		readonly ready: boolean;
		/** Who and where reads are for, exactly when `ready`; otherwise null (readScope below). */
		readonly scope: ReadScope | null;
	}
	| {
		readonly kind: 'releasing'; readonly reason: ReleaseReason; readonly local: LocalState; readonly server: ServerState;
		readonly wait: Wait | null; readonly slow: boolean;
		/** A copy may remain and the session is not yet ended: closing the app now may leave the person signed in the
		 *  next time it opens (no sign-out marker exists). */
		readonly closeAppWarning: boolean;
		readonly canRetry: boolean;
	};

/** The read scope (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1), exactly when ready: verified identity and a
 *  chosen organisation. The one definition both the view and the runner's read check use.
 *  - `epoch` is made only from the account and organisation generations, never from a handle, token or storage key.
 *    Both only increase, so an epoch never repeats in a process (A → B → A gives three). The membership generation is
 *    left out, so a refresh that keeps the organisation keeps the epoch.
 *  - Every change of person or organisation while staying ready advances the organisation generation (a person's
 *    choice, and the single-membership auto-choice after a loss both save it); so does every sign-in, sign-out and
 *    session end. Choosing from the stored hint at launch does not, but that is the first ready scope, with none before
 *    it. */
export function readScope(machine: Machine): ReadScope | null {
	const state = machine.state;
	if (state.kind !== 'signed-in' || state.org.kind !== 'chosen') return null;
	const { account, organisation } = machine.generations;
	return Object.freeze({ epoch: `a${account}.o${organisation}`, userId: state.user.id, organisationId: state.org.membership.organisationId });
}

/** The reducer's half of the global gate: a state that offers sign-in, and no stray credential still being released. */
function signInOffered(machine: Machine): boolean {
	const state = machine.state;
	if (machine.strays.length > 0) return false;
	return (state.kind === 'signed-out' && state.gate !== 'waiting') || (state.kind === 'storage-unreadable' && !state.reading);
}

/** A stray credential still being released (unreachable by construction; shown so it is never silent). */
export type StrayView = { readonly local: LocalState; readonly server: ServerState; readonly wait: Wait | null; readonly closeAppWarning: boolean; readonly canRetry: boolean };

/** Everything a screen may see: token-free, and handle-free. */
export type AccountSnapshot = {
	readonly account: AccountView; readonly signInOffered: boolean; readonly fault: boolean; readonly strays: readonly StrayView[];
};

export function view(machine: Machine): AccountSnapshot {
	const strays = machine.strays.map(({ local, server, wait }): StrayView => ({
		local, server, wait, closeAppWarning: local === 'copy-may-remain' && retryable(server), canRetry: retryable(server) && local !== 'removing'
	}));
	return { account: accountView(machine), signInOffered: signInOffered(machine), fault: machine.fault, strays };
}

function accountView(machine: Machine): AccountView {
	const state = machine.state;
	switch (state.kind) {
		case 'starting': case 'storage-unavailable': case 'storage-unreadable': case 'signed-out': return state;
		case 'signing-in': return { kind: 'signing-in', phase: state.phase, slow: state.slow };
		case 'saving': return { kind: 'signing-in', phase: 'saving', slow: state.slow };
		case 'checking': return { kind: 'checking' };
		case 'unverified': return { kind: 'unverified', retrying: state.retrying, wait: machine.pacing.serverNotBefore };
		case 'signed-in': return {
			kind: 'signed-in', user: state.user, memberships: state.memberships, org: state.org, refreshing: state.refreshing,
			destination: state.org.kind === 'chosen' ? state.destination : null, notice: state.notice, orgNotice: state.orgNotice,
			ready: state.org.kind === 'chosen', scope: readScope(machine)
		};
		case 'releasing': {
			const { reason, local, server, wait } = state.release;
			return {
				kind: 'releasing', reason, local, server, wait, slow: state.slow,
				closeAppWarning: local === 'copy-may-remain' && retryable(server),
				canRetry: retryable(server) && local !== 'removing'
			};
		}
	}
}
