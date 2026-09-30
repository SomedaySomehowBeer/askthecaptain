/** The web account source (docs/plans/expo-web-session-2026-09.md §B.1): on the web the app holds no token, the
 *  HttpOnly `captain_session` cookie is the truth, and the native account machine, SecureStore and the PKCE handoff
 *  stay dormant. Pure: the API client, the organisation memory, the clock and the timers are injected, so node tests
 *  cover every rule; src/platform/app-web.ts binds the browser's.
 *
 *  It presents the same token-free `AccountSnapshot` the native runner does, so the organisation, settings and
 *  equipment screens read one shape on every platform, and the same `ReadScope` (`epoch`, `userId`, `organisationId`)
 *  for organisation reads.
 *
 *  - On start, `GET /v1/me`: 200 is signed in; 401 is signed out; anything else is unavailable, said as `unverified`
 *    with the wait until the next try. While signed in, a failed refresh keeps the verified workspace and adds a connection notice.
 *  - `/v1/me` is paced as on device: never within 30 seconds of the last send (`refreshSpacingMs`), and never before
 *    a server's `Retry-After`. An unavailable first check tries again by itself when that wait ends; a foreground
 *    refresh or Try again before it is dropped. A successful invitation reloads memberships at once, since the
 *    person's own write changed them, still honouring a server wait.
 *  - The chosen organisation is remembered per person in the injected memory (localStorage), falling back to the
 *    first membership. A choice that could not be remembered is used for this page and said so.
 *  - Sign out is `POST /auth/sign-out` with the cookie; the API clears it. A 2xx or a 401 (already gone) is signed
 *    out; anything else keeps a Try again, never claiming the session ended.
 *  - Epochs: `w{account}.o{organisation}` for reads and `w{account}` for the person, from two counters that only
 *    increase, exactly as the native machine derives them. */
import { apiPaths, type OrganisationPath } from '../api/paths.ts';
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import type { OrganisationMemory } from '../platform/web-storage.ts';
import type { AccountSource } from './account-source.ts';
import { createClampedClock, laterWait, remaining, waitFor, type Clock, type Wait } from './clock.ts';
import type { ReadOutcome, ReadScope, ScopedRead } from './contracts.ts';
import { refreshSpacingMs, slowAfterMs, type AccountSnapshot, type AccountView, type Notice, type OrgNotice } from './machine.ts';
import { parseMe, type Me, type Membership } from './me.ts';
import {
	admit, idleRevocation, parseRevoked, resultOf, samePerson, sendingRevocation, settledRevocation, slowRevocation, staleOutcome, type PersonScope, type RevocationView, type RevokeOutcome
} from './revocation.ts';
import type { Timers, UiCommand } from './runner.ts';
import { createWebCalls, type WebCalls } from './web-calls.ts';

export type WebSessionDeps = {
	readonly client: ApiClient;
	/** The page's own origin, validated by `apiOrigin`: the API's, since it serves the export (§A.1). Only the sign-in
	 *  link is built from it; every request goes through `client`. */
	readonly origin: string;
	readonly memory: OrganisationMemory;
	/** A monotonic reading (`performance.now()`); clamped here. */
	readonly monotonicNow: () => number;
	/** Wall-clock milliseconds, for "about {time}" only. */
	readonly wallNow?: () => number;
	readonly timers?: Timers;
};

type Org = { readonly kind: 'none' } | { readonly kind: 'choose' } | { readonly kind: 'chosen'; readonly membership: Membership };
type State =
	| { readonly kind: 'checking' }
	| { readonly kind: 'unavailable'; readonly retrying: boolean }
	| { readonly kind: 'signed-out'; readonly notice: Notice | null }
	| { readonly kind: 'signed-in'; readonly me: Me; readonly org: Org; readonly refreshing: boolean; readonly notice: Notice | null; readonly orgNotice: OrgNotice | null }
	| { readonly kind: 'signing-out' }
	| { readonly kind: 'sign-out-failed' };

const defaultTimers: Timers = { set: (ms, run) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
const superseded: ReadOutcome<never> = Object.freeze({ kind: 'superseded' });
const clientBug: ReadOutcome<never> = Object.freeze({ kind: 'client-bug' });
const sameScope = (a: ReadScope | null, b: ReadScope) => a !== null && a.epoch === b.epoch && a.userId === b.userId && a.organisationId === b.organisationId;

export type WebAccountSource = AccountSource & {
	/** Sends the first `/v1/me`. Called once by the binding. */
	start(): void;
};

export function createWebSession(deps: WebSessionDeps): WebAccountSource {
	const { client, memory } = deps;
	const timers = deps.timers ?? defaultTimers;
	const wallNow = deps.wallNow ?? (() => Date.now());
	const clock: Clock = createClampedClock(deps.monotonicNow);

	let state: State = { kind: 'checking' };
	const generations = { account: 0, organisation: 0 };
	// Pacing for `/v1/me`: when the last one was sent, the server's wait, and whether one is out.
	let lastMeSent: number | null = null; let meWait: Wait | null = null; let meInFlight = false;
	let retryTimer: unknown = null;
	let started = false; let meRevision = 0; let reloadMemberships = false; let signOutWait: Wait | null = null;
	let snapshot: AccountSnapshot | null = null;
	const listeners = new Set<() => void>();
	const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* a screen's error is its own */ } } };
	const set = (next: State) => { state = next; snapshot = null; notify(); };

	// Scopes, from the counters only.
	const scope = (): ReadScope | null => (state.kind === 'signed-in' && state.org.kind === 'chosen'
		? Object.freeze({ epoch: `w${generations.account}.o${generations.organisation}`, userId: state.me.user.id, organisationId: state.org.membership.organisationId })
		: null);
	const person = (): PersonScope | null => (state.kind === 'signed-in' ? Object.freeze({ epoch: `w${generations.account}`, userId: state.me.user.id }) : null);
	const accountEpoch = (): string | null => (state.kind === 'signed-in' ? `w${generations.account}` : null);

	/** The wait before `/v1/me` may be sent again: 30 seconds after the last send, or the server's wait if later. */
	const pacingWait = (): Wait | null => {
		if (lastMeSent === null) return meWait;
		const until = lastMeSent + refreshSpacingMs;
		return laterWait(Object.freeze({ until, about: new Date(wallNow() + Math.max(0, until - clock.now())).toISOString() }), meWait);
	};
	const mayLoadMe = (ignoreSpacing = false): boolean => {
		if (meInFlight) return false;
		if (!ignoreSpacing && lastMeSent !== null && clock.now() < lastMeSent + refreshSpacingMs) return false;
		return remaining(meWait, clock.now()) === 0;
	};

	const chooseFor = (me: Me, remembered: string | null): Org => {
		if (me.memberships.length === 0) return { kind: 'none' };
		const kept = remembered === null ? undefined : me.memberships.find((m) => m.organisationId === remembered);
		const membership = kept ?? me.memberships[0]!;
		if (kept === undefined) memory.write(me.user.id, membership.organisationId);
		return { kind: 'chosen', membership };
	};

	/** A 200 from `/v1/me`. */
	const applyMe = (me: Me) => {
		if (state.kind === 'signed-in' && state.me.user.id === me.user.id) {
			// The same person: keep the organisation if still held; otherwise say it was lost and choose what is left.
			let org: Org; let orgNotice: OrgNotice | null = state.orgNotice;
			const current = state.org.kind === 'chosen' ? state.org.membership : null;
			const held = current === null ? undefined : me.memberships.find((m) => m.organisationId === current.organisationId);
			if (current !== null && held !== undefined) org = { kind: 'chosen', membership: held };
			else {
				if (current !== null) orgNotice = { kind: 'lost', name: current.organisationName };
				generations.organisation += 1;
				if (me.memberships.length === 0) org = { kind: 'none' };
				else if (me.memberships.length === 1 || current === null) org = chooseFor(me, current === null ? memory.read(me.user.id) : null);
				else org = { kind: 'choose' };
				if (current !== null && org.kind !== 'chosen') memory.forget(me.user.id);
			}
			set({ kind: 'signed-in', me, org, refreshing: false, notice: state.notice?.kind === 'refresh-unavailable' ? null : state.notice, orgNotice });
			return;
		}
		// A new sign-in (or another person than before): a new account and organisation generation.
		generations.account += 1; generations.organisation += 1;
		set({ kind: 'signed-in', me, org: chooseFor(me, memory.read(me.user.id)), refreshing: false, notice: null, orgNotice: null });
	};

	const sessionEnded = () => {
		if (state.kind !== 'signed-in' && state.kind !== 'signing-out' && state.kind !== 'sign-out-failed') return;
		generations.account += 1; generations.organisation += 1;
		set({ kind: 'signed-out', notice: { kind: 'released', reason: 'session-ended', local: 'deleted', server: 'not-needed' } });
	};

	const scheduleRetry = () => {
		if (retryTimer !== null) { timers.clear(retryTimer); retryTimer = null; }
		const wait = pacingWait(); const delay = wait === null ? 0 : remaining(wait, clock.now());
		retryTimer = timers.set(delay, () => { retryTimer = null; if (state.kind === 'signed-in' && reloadMemberships) loadMe(true); else if (state.kind === 'unavailable' || (state.kind === 'signed-in' && state.notice?.kind === 'refresh-unavailable')) loadMe(); });
	};

	const loadMe = (ignoreSpacing = false) => {
		if (!mayLoadMe(ignoreSpacing)) { if (ignoreSpacing) { reloadMemberships = true; if (!meInFlight) scheduleRetry(); } return; }
		reloadMemberships = false;
		meInFlight = true; lastMeSent = clock.now();
		if (state.kind === 'unavailable') set({ kind: 'unavailable', retrying: true });
		else if (state.kind === 'signed-in') set({ ...state, refreshing: true });
		const sentFor = generations.account; const revision = meRevision;
		void client.get(apiPaths.me, null, parseMe).catch((): ApiOutcome<Me> => ({ ok: false, kind: 'unavailable', status: 0 })).then((answer) => {
			meInFlight = false;
			if (sentFor !== generations.account) return;
			if (revision !== meRevision) { if (reloadMemberships) loadMe(true); return; }
			if (answer.ok) { meWait = null; applyMe(answer.value); return; }
			if (answer.kind === 'unauthorised') {
				if (state.kind === 'signed-in' || state.kind === 'signing-out' || state.kind === 'sign-out-failed') sessionEnded();
				else set({ kind: 'signed-out', notice: null });
				return;
			}
			meWait = answer.kind === 'unavailable' && answer.retryAfter !== undefined ? waitFor(answer.retryAfter * 1000, clock, wallNow) : null;
			if (state.kind === 'signed-in') { set({ ...state, refreshing: false, notice: { kind: 'refresh-unavailable' } }); scheduleRetry(); return; }
			if (state.kind === 'checking' || state.kind === 'unavailable') { set({ kind: 'unavailable', retrying: false }); scheduleRetry(); }
		});
	};

	const signOut = () => {
		if (state.kind !== 'signed-in' && state.kind !== 'sign-out-failed') return;
		if (remaining(signOutWait, clock.now()) > 0) return;
		generations.account += 1; generations.organisation += 1;
		set({ kind: 'signing-out' });
		const sentFor = generations.account;
		void client.post(apiPaths.signOut, null, {}, (value) => value).catch((): ApiOutcome<unknown> => ({ ok: false, kind: 'unavailable', status: 0 })).then((answer) => {
			if (state.kind !== 'signing-out' || sentFor !== generations.account) return;
			if (answer.ok || answer.kind === 'unauthorised') {
				generations.account += 1; generations.organisation += 1;
				set({ kind: 'signed-out', notice: { kind: 'released', reason: 'sign-out', local: 'deleted', server: 'ended' } });
				return;
			}
			signOutWait = answer.kind === 'unavailable' && answer.retryAfter !== undefined ? waitFor(answer.retryAfter * 1000, clock, wallNow) : null;
			set({ kind: 'sign-out-failed' });
		});
	};

	const choose = (organisationId: string) => {
		if (state.kind !== 'signed-in') return;
		const membership = state.me.memberships.find((m) => m.organisationId === organisationId);
		if (membership === undefined) return;
		if (state.org.kind === 'chosen' && state.org.membership.organisationId === organisationId) return;
		generations.organisation += 1;
		const remembered = memory.write(state.me.user.id, organisationId);
		set({ ...state, org: { kind: 'chosen', membership }, orgNotice: null, notice: remembered ? null : { kind: 'organisation-not-remembered' } });
	};

	/** A membership the person just accepted: chosen at once, then memberships reloaded. */
	const accepted = (membership: Membership) => {
		if (state.kind !== 'signed-in') return;
		meRevision += 1;
		const others = state.me.memberships.filter((m) => m.organisationId !== membership.organisationId);
		const me: Me = Object.freeze({ ...state.me, memberships: Object.freeze([...others, membership]) });
		generations.organisation += 1;
		const remembered = memory.write(me.user.id, membership.organisationId);
		set({ kind: 'signed-in', me, org: { kind: 'chosen', membership }, refreshing: false, notice: remembered ? null : { kind: 'organisation-not-remembered' }, orgNotice: null });
		loadMe(true);
	};

	// Organisation-scoped reads, with the runner's rules (contracts.ts `ScopedRead`).
	const read: ScopedRead = async <T>(expected: ReadScope, path: (scope: ReadScope) => OrganisationPath, parse: Parse<T>): Promise<ReadOutcome<T>> => {
		const current = scope();
		if (!sameScope(current, expected)) return superseded;
		let target: OrganisationPath;
		try { target = path(current!); } catch { return clientBug; }
		let answer: ApiOutcome<T>;
		try { answer = await client.get(target, null, parse); } catch { return clientBug; }
		if (!answer.ok && answer.kind === 'unauthorised') { if (person()?.userId === expected.userId && expected.epoch.startsWith(`${person()!.epoch}.`)) sessionEnded(); return superseded; }
		if (!sameScope(scope(), expected)) return superseded;
		if (answer.ok) return { kind: 'ok', value: answer.value };
		if (answer.kind === 'refused') { if (answer.status === 403 || answer.status === 404) loadMe(); return { kind: 'refused', status: answer.status }; }
		return { kind: 'unavailable', wait: answer.retryAfter === undefined ? null : waitFor(answer.retryAfter * 1000, clock, wallNow) };
	};

	// Sign out everywhere else, with the runner's rules (revocation.ts).
	let revocationFor: PersonScope | null = null; let revocation: RevocationView = idleRevocation;
	const revocationView = (): RevocationView => (samePerson(revocationFor, person()) ? revocation : idleRevocation);
	const setRevocation = (view: RevocationView) => { if (view === revocation) return; revocation = view; notify(); };
	const revokeOthers = async (expected: PersonScope): Promise<RevokeOutcome> => {
		const current = person();
		if (!samePerson(current, expected)) return staleOutcome;
		if (!samePerson(revocationFor, current)) { revocationFor = current; revocation = idleRevocation; }
		const refusal = admit(revocation, clock.now());
		if (refusal !== null) return refusal;
		setRevocation(sendingRevocation);
		const slowTimer = timers.set(slowAfterMs, () => { if (samePerson(person(), expected)) setRevocation(slowRevocation(revocation)); });
		let answer: ApiOutcome<{ readonly ended: number }>;
		try { answer = await client.post(apiPaths.revokeOthers, null, {}, parseRevoked); } catch { answer = { ok: false, kind: 'unavailable', status: 0 }; }
		timers.clear(slowTimer);
		if (!samePerson(person(), expected)) { return staleOutcome; }
		const result = resultOf(answer, (seconds) => waitFor(seconds * 1000, clock, wallNow));
		if (result === 'unauthorised') { revocation = idleRevocation; sessionEnded(); return staleOutcome; }
		setRevocation(settledRevocation(result));
		return result;
	};

	const view = (): AccountView => {
		switch (state.kind) {
			case 'checking': return { kind: 'checking' };
			case 'unavailable': return { kind: 'unverified', retrying: state.retrying, wait: pacingWait() };
			case 'signed-out': return { kind: 'signed-out', notice: state.notice, gate: 'idle' };
			case 'signing-out': return { kind: 'releasing', reason: 'sign-out', local: 'deleted', server: 'revoking', wait: null, slow: false, closeAppWarning: false, canRetry: false };
			case 'sign-out-failed': return { kind: 'releasing', reason: 'sign-out', local: 'deleted', server: 'pending', wait: signOutWait, slow: false, closeAppWarning: false, canRetry: true };
			case 'signed-in': return {
				kind: 'signed-in', user: state.me.user, memberships: state.me.memberships,
				org: state.org.kind === 'chosen' ? { kind: 'chosen', membership: state.org.membership } : { kind: state.org.kind },
				refreshing: state.refreshing, destination: null, notice: state.notice, orgNotice: state.orgNotice,
				ready: state.org.kind === 'chosen', scope: scope(), person: person()!
			};
		}
	};

	const web: WebCalls = createWebCalls(client, deps.origin, { accountEpoch, accepted, sessionEnded, reconcileMemberships: () => { meRevision += 1; loadMe(true); } });

	return Object.freeze({
		start() { if (!started) { started = true; loadMe(true); } },
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		snapshot(): AccountSnapshot {
			snapshot ??= Object.freeze({ account: Object.freeze(view()), signInOffered: state.kind === 'signed-out', fault: false, strays: Object.freeze([]) });
			return snapshot;
		},
		send(command: UiCommand) {
			switch (command.type) {
				case 'refresh': if (state.kind === 'signed-in' || state.kind === 'unavailable') loadMe(); return;
				case 'retry': if (state.kind === 'unavailable') loadMe(); else if (state.kind === 'sign-out-failed') signOut(); return;
				case 'sign-out': signOut(); return;
				case 'choose-organisation': choose(command.organisationId); return;
				default: return; // sign-in is a link on the web; cancel and destination-used have nothing to do
			}
		},
		now: clock.now,
		read,
		revokeOthers,
		revocationView,
		web
	});
}
