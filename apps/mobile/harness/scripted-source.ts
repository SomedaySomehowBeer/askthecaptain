import { pushHarness } from './push-fixtures.ts';
import { threadHarness } from './thread-fixtures.ts';
import { memberHarness } from './member-fixtures.ts';
import { passkeyHarness } from './passkey-fixtures.ts';
import type { AccountSource } from '../src/account/account-source.ts';
import { outsideSnapshots } from '../src/account/account-source.ts';
import { createClampedClock, type Wait } from '../src/account/clock.ts';
import type { ReadOutcome, ReadScope, ScopedRead } from '../src/account/contracts.ts';
import type { OrganisationPath } from '../src/api/paths.ts';
import type { Parse } from '../src/auth/contracts.ts';
import { equipmentFixture, isEquipmentControl, isEquipmentPath } from './equipment-fixtures.ts';
import type { ReadControl } from './read-controls.ts';

import { slowAfterMs, type AccountSnapshot, type AccountView } from '../src/account/machine.ts';
import {
	admit, idleRevocation, samePerson, sendingRevocation, settledRevocation, slowRevocation, staleOutcome,
	type PersonScope, type RevocationView, type RevokeOutcome, type RevokeResult
} from '../src/account/revocation.ts';
import type { Membership } from '../src/account/me.ts';
import type { UiCommand } from '../src/account/runner.ts';

/** The test harness's account source (docs/plans/expo-mobile-auth-composition-2026-09.md §7.1). Not a route: it lives
 *  outside harness/app. It has the production source's surface (`subscribe`, `snapshot`, `send`, `now`) and never a
 *  token, handle or runner. The scenario is chosen once, from the initial page URL, and kept for the page's life.
 *
 *  - Every `send` is recorded in the command log (shown on the page for Playwright). Only `destination-used` changes the
 *    snapshot (it clears the destination, as the reducer does); everything else is only recorded.
 *  - Timed scenarios put their server wait 5 000 ms after the source is created, on the same clamped clock screens use
 *    (`performance.now()`, which Playwright's clock control drives).
 *  - `transition` scripts the changes the browser check drives (see `Transition`). */

export const harnessUser = Object.freeze({ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'skipper@example.test', name: 'Sam Skipper' });
export const harnessOrgA: Membership = Object.freeze({ organisationId: 'c0ffee00-1234-4abc-9def-0123456789ab', organisationName: 'Harbour Brewing', role: 'owner' });
export const harnessOrgB: Membership = Object.freeze({ organisationId: 'd00dfeed-5678-4def-8abc-ba9876543210', organisationName: 'Quayside Cellars', role: 'member' });
export const harnessOrgC: Membership = Object.freeze({ organisationId: 'feedface-9999-4aaa-8bbb-cccccccccccc', organisationName: 'Dockside Distillers', role: 'admin' });
export const timedWaitMs = 5_000;

export const scenarioNames = [
	'threads-new', 'threads-new-empty', 'threads-new-failed', 'threads-new-wait', 'threads-new-pending', 'threads-new-refused', 'threads-loaded', 'threads-empty', 'threads-failed', 'threads-lost', 'threads-wait', 'threads-unavailable', 'threads-lines', 'threads-card-task', 'threads-card-task-failed', 'threads-card-booking', 'threads-card-booking-cancelled', 'threads-card-stock', 'threads-card-stock-archived', 'threads-history', 'threads-history-failed', 'threads-history-empty', 'threads-history-conflict', 'threads-history-booking', 'threads-history-stale', 'threads-history-applied', 'threads-history-recovered', 'threads-topic-task', 'push-empty', 'push-loaded', 'push-unavailable', 'push-failed', 'members-owner', 'members-admin', 'members-empty', 'members-failed', 'members-refused', 'members-denied', 'members-none', 'passkeys-empty', 'passkeys-loaded', 'passkeys-unavailable', 'passkeys-failed', 'ready', 'ready-destination', 'misconfigured', 'starting', 'starting-slow', 'startup-failed',
	'storage-unavailable', 'storage-unreadable', 'signed-out', 'signed-out-busy', 'signed-out-cancelled', 'signed-out-released',
	'signing-in', 'closing', 'saving', 'checking', 'unverified', 'unverified-retry-at', 'releasing', 'releasing-warning',
	'releasing-retry-at', 'choose', 'none', 'lost-named', 'lost-unnamed', 'not-remembered', 'refreshing', 'fault',
] as const;
export type ScenarioName = (typeof scenarioNames)[number];
export const scenarioFrom = (search: string): ScenarioName => {
	const value = new URLSearchParams(search).get('scenario');
	return (scenarioNames as readonly string[]).includes(value ?? '') ? (value as ScenarioName) : 'ready';
};

const snap = (account: AccountView, extra: Partial<AccountSnapshot> = {}): AccountSnapshot =>
	Object.freeze({ account: Object.freeze(account), signInOffered: false, fault: false, strays: Object.freeze([]), ...extra });

/** Scripted epochs: every ready snapshot the harness builds is a new account/organisation scope (h1, h2, …), as a real
 *  switch, loss or sign-in would be. Clearing a destination keeps the scope. */
let epochs = 0;
/** The person scope is the same across every scripted snapshot of the one harness sign-in: an organisation change keeps
 *  it, as in the runner. Releasing leaves the signed-in state, so there is then no person. */
export const harnessPerson: PersonScope = Object.freeze({ epoch: 'p1', userId: harnessUser.id });
const signedIn = (overrides: Partial<Extract<AccountView, { kind: 'signed-in' }>> = {}): AccountView => {
	const base = {
		kind: 'signed-in' as const, user: harnessUser, memberships: [harnessOrgA, harnessOrgB], org: { kind: 'chosen' as const, membership: harnessOrgA },
		refreshing: false, destination: null, notice: null, orgNotice: null, ready: true, scope: null, person: harnessPerson
	};
	const merged = { ...base, ...overrides };
	const ready = merged.org.kind === 'chosen';
	const scope: ReadScope | null = merged.org.kind === 'chosen'
		? Object.freeze({ epoch: `h${++epochs}`, userId: merged.user.id, organisationId: merged.org.membership.organisationId })
		: null;
	return { ...merged, ready, scope, destination: ready ? merged.destination : null };
};

function scenario(name: ScenarioName, wait: Wait): AccountSnapshot {
	switch (name) {
		case 'members-admin': return snap(signedIn({ org: { kind: 'chosen', membership: { ...harnessOrgA, role: 'admin' } } }));
		case 'members-denied': return snap(signedIn({ org: { kind: 'chosen', membership: { ...harnessOrgA, role: 'member' } } }));
		case 'members-none': return snap(signedIn({ org: { kind: 'none' }, memberships: [] }));
		case 'passkeys-empty': case 'passkeys-loaded': case 'passkeys-unavailable': case 'passkeys-failed':
		case 'push-empty': case 'push-loaded': case 'push-unavailable': case 'push-failed':
		case 'threads-new': case 'threads-new-empty': case 'threads-new-failed': case 'threads-new-wait': case 'threads-new-pending': case 'threads-new-refused':
		case 'threads-loaded': case 'threads-empty': case 'threads-failed': case 'threads-lost': case 'threads-wait': case 'threads-unavailable':
		case 'threads-history': case 'threads-history-failed': case 'threads-history-empty': case 'threads-history-conflict': case 'threads-history-booking': case 'threads-history-stale': case 'threads-history-applied': case 'threads-history-recovered': case 'threads-topic-task':
		case 'threads-lines': case 'threads-card-task': case 'threads-card-task-failed': case 'threads-card-booking': case 'threads-card-booking-cancelled': case 'threads-card-stock': case 'threads-card-stock-archived':
		case 'members-owner': case 'members-empty': case 'members-failed': case 'members-refused':
		case 'ready': return snap(signedIn());
		case 'ready-destination': return snap(signedIn({ destination: '/equipment' }));
		case 'misconfigured': return outsideSnapshots.misconfigured;
		case 'starting': return outsideSnapshots.starting;
		case 'starting-slow': return outsideSnapshots.startingSlow;
		case 'startup-failed': return outsideSnapshots.startupFailed;
		case 'storage-unavailable': return snap({ kind: 'storage-unavailable' });
		case 'storage-unreadable': return snap({ kind: 'storage-unreadable', reading: false, slow: false }, { signInOffered: true });
		case 'signed-out': return snap({ kind: 'signed-out', notice: null, gate: 'idle' }, { signInOffered: true });
		case 'signed-out-busy': return snap({ kind: 'signed-out', notice: null, gate: 'busy' }, { signInOffered: true });
		case 'signed-out-cancelled': return snap({ kind: 'signed-out', notice: { kind: 'sign-in', outcome: 'cancelled' }, gate: 'idle' }, { signInOffered: true });
		case 'signed-out-released': return snap({ kind: 'signed-out', notice: { kind: 'released', reason: 'session-ended', local: 'deleted', server: 'not-needed' }, gate: 'idle' }, { signInOffered: true });
		case 'signing-in': return snap({ kind: 'signing-in', phase: 'browser', slow: false });
		case 'closing': return snap({ kind: 'signing-in', phase: 'closing', slow: true });
		case 'saving': return snap({ kind: 'signing-in', phase: 'saving', slow: false });
		case 'checking': return snap({ kind: 'checking' });
		case 'unverified': return snap({ kind: 'unverified', retrying: false, wait: null });
		case 'unverified-retry-at': return snap({ kind: 'unverified', retrying: false, wait });
		case 'releasing': return snap({ kind: 'releasing', reason: 'sign-out', local: 'removing', server: 'revoking', wait: null, slow: false, closeAppWarning: false, canRetry: false });
		case 'releasing-warning': return snap({ kind: 'releasing', reason: 'sign-out', local: 'copy-may-remain', server: 'pending', wait: null, slow: false, closeAppWarning: true, canRetry: true });
		case 'releasing-retry-at': return snap({ kind: 'releasing', reason: 'sign-out', local: 'deleted', server: 'pending', wait, slow: false, closeAppWarning: false, canRetry: true });
		case 'choose': return snap(signedIn({ org: { kind: 'choose' } }));
		case 'none': return snap(signedIn({ memberships: [], org: { kind: 'none' } }));
		case 'lost-named': return snap(signedIn({ memberships: [harnessOrgB, harnessOrgA], org: { kind: 'choose' }, orgNotice: { kind: 'lost', name: 'Anchor Ales' } }));
		case 'lost-unnamed': return snap(signedIn({ org: { kind: 'choose' }, orgNotice: { kind: 'lost-unnamed' } }));
		case 'not-remembered': return snap(signedIn({ notice: { kind: 'organisation-not-remembered' } }));
		case 'refreshing': return snap(signedIn({ refreshing: true }));
		case 'fault': return snap({ kind: 'signed-out', notice: null, gate: 'idle' }, {
			fault: true,
			strays: Object.freeze([
				Object.freeze({ local: 'removing' as const, server: 'revoking' as const, wait: null, closeAppWarning: false, canRetry: false }),
				Object.freeze({ local: 'copy-may-remain' as const, server: 'pending' as const, wait: null, closeAppWarning: true, canRetry: true })
			])
		});
	}
}

/** Scripted changes the browser check drives:
 *  - `lost`: the chosen organisation is gone and two memberships remain, so the chooser shows (not ready);
 *  - `lost-single`: the chosen organisation is gone and the one remaining membership is chosen at once (ready
 *    throughout, a new scope: the root stack must still return to the thread list);
 *  - `switch`: ready with organisation A to ready with organisation B (as from Switch organisation);
 *  - `release`: ready to releasing with the close-app warning;
 *  - `verify`: identity verified with organisation A chosen and no sign-in destination (a restored saved session). */
export type Transition = 'lost' | 'lost-single' | 'switch' | 'release' | 'verify';
export const transitions: readonly Transition[] = ['lost', 'lost-single', 'switch', 'release', 'verify'];

/** One read the harness has "sent": its identity, exact path and the epoch it was sent under. */
export type ReadLogEntry = { readonly id: number; readonly path: string; readonly epoch: string };
export type ReadsView = { readonly log: readonly ReadLogEntry[]; readonly pending: readonly number[] };

/** Answers the browser check can give the pending "Sign out everywhere else" (docs/plans/mobile-session-revocation-
 *  2026-09.md §5, increment 3):
 *  - `ended-2`, `ended-1`, `ended-0`: the API's count;
 *  - `unknown`: a 503 without a wait; `unknown-wait`: a 503 with a 5 s `Retry-After`;
 *  - `rate-limited`: a 429 with a 5 s `Retry-After`; `rate-limited-later`: a 429 without one;
 *  - `refused`: a 403 (as from a proxy);
 *  - `unauthorised`: a 401, which ends the session (the account shows it released). */
export const revocationControls = [
	'ended-2', 'ended-1', 'ended-0', 'unknown', 'unknown-wait', 'rate-limited', 'rate-limited-later', 'refused', 'unauthorised'
] as const;
export type RevocationControl = (typeof revocationControls)[number];
/** Every revocation "sent" (the person epoch it was sent for), and whether one is pending. */
export type RevocationsSent = { readonly log: readonly string[]; readonly pending: boolean };

export type ScriptedSource = AccountSource & {
	readonly scenario: ScenarioName;
	/** The send-only command log (unchanged: reads are never in it). */
	readonly log: () => readonly UiCommand[];
	readonly subscribeLog: (listener: () => void) => () => void;
	readonly transition: (to: Transition) => void;
	/** Every read sent, and the IDs still pending, oldest first. */
	readonly reads: () => ReadsView;
	readonly subscribeReads: (listener: () => void) => () => void;
	/** Resolves the oldest pending read with `control`. Nothing happens when none is pending. */
	readonly resolveRead: (control: ReadControl) => void;
	/** Every revocation sent, and whether one is pending. */
	readonly revocations: () => RevocationsSent;
	readonly subscribeRevocations: (listener: () => void) => () => void;
	/** Answers the pending revocation with `control`. Nothing happens when none is pending. */
	readonly resolveRevocation: (control: RevocationControl) => void;
};

export function createScriptedSource(name: ScenarioName, options: {
	readonly readClock?: () => number;
} = {}): ScriptedSource {
	const clock = createClampedClock(options.readClock ?? (() => performance.now()));
	const until = clock.now() + timedWaitMs;
	const wait: Wait = Object.freeze({ until, about: new Date(Date.now() + timedWaitMs).toISOString() });
	let current = scenario(name, wait);
	let log: readonly UiCommand[] = Object.freeze([]);
	const listeners = new Set<() => void>(); const logListeners = new Set<() => void>(); const readListeners = new Set<() => void>();
	const set = (next: AccountSnapshot) => { current = next; for (const l of [...listeners]) l(); };

	// Reads, as the runner would send them: checked against the current scope before "sending", then pending until a
	// harness control resolves the oldest one. Its answer goes through the screen's own parser, and is `superseded` if
	// the scope changed meanwhile, exactly as in the runner.
	type Pending = { readonly entry: ReadLogEntry; readonly scope: ReadScope; readonly parse: Parse<unknown>; readonly resolve: (outcome: ReadOutcome<unknown>) => void };
	let readLog: readonly ReadLogEntry[] = Object.freeze([]); let pending: readonly Pending[] = Object.freeze([]);
	let readsView: ReadsView = Object.freeze({ log: readLog, pending: Object.freeze([]) });
	const readsChanged = () => {
		readsView = Object.freeze({ log: readLog, pending: Object.freeze(pending.map((p) => p.entry.id)) });
		for (const l of [...readListeners]) l();
	};
	const currentScope = (): ReadScope | null => (current.account.kind === 'signed-in' ? current.account.scope : null);
	const same = (a: ReadScope | null, b: ReadScope) => a !== null && a.epoch === b.epoch && a.userId === b.userId && a.organisationId === b.organisationId;
	const superseded = Object.freeze({ kind: 'superseded' as const });

	const read: ScopedRead = <T>(expected: ReadScope, path: (scope: ReadScope) => OrganisationPath, parse: Parse<T>): Promise<ReadOutcome<T>> => {
		const scope = currentScope();
		if (!same(scope, expected)) return Promise.resolve(superseded);
		let target: string;
		try { target = path(scope!); } catch { return Promise.resolve(Object.freeze({ kind: 'client-bug' as const })); }
		return new Promise<ReadOutcome<T>>((resolve) => {
			const entry: ReadLogEntry = Object.freeze({ id: readLog.length + 1, path: target, epoch: scope!.epoch });
			readLog = Object.freeze([...readLog, entry]);
			pending = Object.freeze([...pending, { entry, scope: scope!, parse, resolve: resolve as (o: ReadOutcome<unknown>) => void }]);
			readsChanged();
		});
	};

	function outcomeFor(control: ReadControl, p: Pending): ReadOutcome<unknown> {
		if (control === 'unavailable') return { kind: 'unavailable', wait: null };
		if (control === 'unavailable-wait') return { kind: 'unavailable', wait: Object.freeze({ until: clock.now() + timedWaitMs, about: new Date(Date.now() + timedWaitMs).toISOString() }) };
		if (control === 'refused-404') return { kind: 'refused', status: 404 };
		if (control === 'refused-400') return { kind: 'refused', status: 400 };
		if (control === 'unauthorised') return superseded; // as a 401 does in production: the screen applies nothing
		if (control === 'client-bug') return { kind: 'client-bug' };
		// The read's own path selects its equipment fixture; unmatched controls yield an unreadable body.
		try {
			if (isEquipmentPath(p.entry.path)) {
				if (!isEquipmentControl(control)) return { kind: 'unavailable', wait: null };
				return { kind: 'ok', value: p.parse(equipmentFixture(control, p.entry.path)) };
			}
			return { kind: 'unavailable', wait: null };
		} catch { return { kind: 'unavailable', wait: null }; }
	}

	// Sign out everywhere else, as the runner does it, with the same pure rules (src/account/revocation.ts): checked
	// against the current person before "sending", then pending until a harness control answers it. The state lives
	// here, for the page's life, so leaving and re-entering Account shows it as it is. An answer after the person changed
	// changes nothing.
	const currentPerson = (): PersonScope | null => (current.account.kind === 'signed-in' ? current.account.person : null);
	let revocationFor: PersonScope | null = currentPerson(); let revocation: RevocationView = idleRevocation;
	let revocationPending: { readonly person: PersonScope; readonly resolve: (outcome: RevokeOutcome) => void } | null = null;
	let revocationSent: RevocationsSent = Object.freeze({ log: Object.freeze([]), pending: false });
	let slowTimer: ReturnType<typeof setTimeout> | null = null;
	const revocationListeners = new Set<() => void>();
	const sentChanged = (log: readonly string[]) => {
		revocationSent = Object.freeze({ log: Object.freeze(log), pending: revocationPending !== null });
		for (const l of [...revocationListeners]) l();
	};
	const setRevocation = (view: RevocationView) => {
		if (view === revocation) return;
		revocation = view;
		for (const l of [...listeners]) l();
	};
	const revocationView = (): RevocationView => (samePerson(revocationFor, currentPerson()) ? revocation : idleRevocation);
	/** A person change drops the state, as in the runner (C1). */
	const alignRevocation = () => {
		const person = currentPerson();
		if (samePerson(revocationFor, person) || (revocationFor === null && person === null)) return;
		if (slowTimer !== null) { clearTimeout(slowTimer); slowTimer = null; }
		revocationFor = person; revocation = idleRevocation;
	};
	const revokeOthers = (expected: PersonScope): Promise<RevokeOutcome> => {
		alignRevocation();
		const person = currentPerson();
		if (!samePerson(person, expected)) return Promise.resolve(staleOutcome);
		const refusal = admit(revocation, clock.now());
		if (refusal !== null) return Promise.resolve(refusal);
		return new Promise<RevokeOutcome>((resolve) => {
			revocationPending = { person: person!, resolve };
			setRevocation(sendingRevocation);
			slowTimer = setTimeout(() => { slowTimer = null; if (revocationPending !== null) setRevocation(slowRevocation(revocation)); }, slowAfterMs);
			sentChanged([...revocationSent.log, person!.epoch]);
		});
	};
	const waitOf = (seconds: number): Wait => Object.freeze({ until: clock.now() + seconds * 1000, about: new Date(Date.now() + seconds * 1000).toISOString() });
	function revocationResult(control: RevocationControl): RevokeResult | 'unauthorised' {
		switch (control) {
			case 'ended-2': return Object.freeze({ kind: 'ok' as const, ended: 2 });
			case 'ended-1': return Object.freeze({ kind: 'ok' as const, ended: 1 });
			case 'ended-0': return Object.freeze({ kind: 'ok' as const, ended: 0 });
			case 'unknown': return Object.freeze({ kind: 'unknown' as const, status: 503, wait: null, seconds: null });
			case 'unknown-wait': return Object.freeze({ kind: 'unknown' as const, status: 503, wait: waitOf(timedWaitMs / 1000), seconds: timedWaitMs / 1000 });
			case 'rate-limited': return Object.freeze({ kind: 'unknown' as const, status: 429, wait: waitOf(timedWaitMs / 1000), seconds: timedWaitMs / 1000 });
			case 'rate-limited-later': return Object.freeze({ kind: 'unknown' as const, status: 429, wait: null, seconds: null });
			case 'refused': return Object.freeze({ kind: 'refused' as const, status: 403 });
			case 'unauthorised': return 'unauthorised';
		}
	}


	return Object.freeze({
		web: (name.startsWith('members-') || name.startsWith('push-') || name.startsWith('threads-')) ? (name.startsWith('threads-') ? threadHarness : name.startsWith('push-') ? pushHarness : memberHarness)(name, () => { const account = current.account; return account.kind === 'signed-in' && account.scope && account.org.kind === 'chosen' ? { ...account.scope, role: account.org.membership.role } : null; }) : name.startsWith('passkeys-') ? passkeyHarness(name, () => currentPerson()?.epoch ?? null) : null,
		revokeOthers,
		revocationView,
		revocations: () => revocationSent,
		subscribeRevocations(listener: () => void) { revocationListeners.add(listener); return () => { revocationListeners.delete(listener); }; },
		resolveRevocation(control: RevocationControl) {
			const pending = revocationPending;
			if (pending === null) return;
			revocationPending = null;
			if (slowTimer !== null) { clearTimeout(slowTimer); slowTimer = null; }
			sentChanged(revocationSent.log);
			alignRevocation();
			if (!samePerson(currentPerson(), pending.person)) { pending.resolve(staleOutcome); return; }
			const result = revocationResult(control);
			if (result === 'unauthorised') {
				// As in the runner: the session ends through the account (here, a scripted release), and the state goes with it.
				revocation = idleRevocation;
				set(snap({ kind: 'signed-out', notice: { kind: 'released', reason: 'session-ended', local: 'deleted', server: 'not-needed' }, gate: 'idle' }, { signInOffered: true }));
				alignRevocation();
				pending.resolve(staleOutcome);
				return;
			}
			setRevocation(settledRevocation(result));
			pending.resolve(result);
		},
		read,
		reads: () => readsView,
		subscribeReads(listener: () => void) { readListeners.add(listener); return () => { readListeners.delete(listener); }; },
		resolveRead(control: ReadControl) {
			const [oldest, ...rest] = pending;
			if (oldest === undefined) return;
			pending = Object.freeze(rest);
			readsChanged();
			oldest.resolve(same(currentScope(), oldest.scope) ? outcomeFor(control, oldest) : superseded);
		},
		scenario: name,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		snapshot: () => current,
		now: clock.now,
		send(command: UiCommand) {
			log = Object.freeze([...log, command]);
			for (const l of [...logListeners]) l();
			const account = current.account;
			if (command.type === 'destination-used' && account.kind === 'signed-in' && account.destination !== null) {
				set(snap({ ...account, destination: null }, { signInOffered: current.signInOffered, fault: current.fault, strays: current.strays }));
			}
		},
		log: () => log,
		subscribeLog(listener: () => void) { logListeners.add(listener); return () => { logListeners.delete(listener); }; },
		transition(to: Transition) {
			const lostA = { kind: 'lost' as const, name: harnessOrgA.organisationName };
			if (to === 'lost') set(snap(signedIn({ memberships: [harnessOrgB, harnessOrgC], org: { kind: 'choose' }, orgNotice: lostA })));
			else if (to === 'lost-single') set(snap(signedIn({ memberships: [harnessOrgB], org: { kind: 'chosen', membership: harnessOrgB }, orgNotice: lostA })));
			else if (to === 'switch') set(snap(signedIn({ org: { kind: 'chosen', membership: harnessOrgB } })));
			else if (to === 'verify') set(snap(signedIn()));
			else set(snap({ kind: 'releasing', reason: 'sign-out', local: 'copy-may-remain', server: 'pending', wait: null, slow: false, closeAppWarning: true, canRetry: true }));
		}
	});
}
