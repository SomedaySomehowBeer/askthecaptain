import type { AccountSource } from '../src/account/account-source.ts';
import { outsideSnapshots } from '../src/account/account-source.ts';
import { createClampedClock, type Wait } from '../src/account/clock.ts';
import type { ReadOutcome, ReadScope, ScopedRead } from '../src/account/contracts.ts';
import type { OrganisationPath } from '../src/api/paths.ts';
import type { Parse } from '../src/auth/contracts.ts';
import { fixtureBody, type ReadControl } from './work-fixtures.ts';
import type { AccountSnapshot, AccountView } from '../src/account/machine.ts';
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
	'ready', 'ready-destination', 'web-only', 'misconfigured', 'starting', 'starting-slow', 'startup-failed',
	'storage-unavailable', 'storage-unreadable', 'signed-out', 'signed-out-busy', 'signed-out-cancelled', 'signed-out-released',
	'signing-in', 'closing', 'saving', 'checking', 'unverified', 'unverified-retry-at', 'releasing', 'releasing-warning',
	'releasing-retry-at', 'choose', 'none', 'lost-named', 'lost-unnamed', 'not-remembered', 'refreshing', 'fault'
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
const signedIn = (overrides: Partial<Extract<AccountView, { kind: 'signed-in' }>> = {}): AccountView => {
	const base = {
		kind: 'signed-in' as const, user: harnessUser, memberships: [harnessOrgA, harnessOrgB], org: { kind: 'chosen' as const, membership: harnessOrgA },
		refreshing: false, destination: null, notice: null, orgNotice: null, ready: true, scope: null
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
		case 'ready': return snap(signedIn());
		case 'ready-destination': return snap(signedIn({ destination: '/chat/views' }));
		case 'web-only': return outsideSnapshots.webOnly;
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
 *    throughout, a new tabs key: the tabs must still be reset);
 *  - `switch`: ready with organisation A to ready with organisation B (as from Switch organisation);
 *  - `release`: ready to releasing with the close-app warning;
 *  - `verify`: identity verified with organisation A chosen and no sign-in destination (a restored saved session). */
export type Transition = 'lost' | 'lost-single' | 'switch' | 'release' | 'verify';
export const transitions: readonly Transition[] = ['lost', 'lost-single', 'switch', 'release', 'verify'];

/** One read the harness has "sent": its identity, exact path and the epoch it was sent under. */
export type ReadLogEntry = { readonly id: number; readonly path: string; readonly epoch: string };
export type ReadsView = { readonly log: readonly ReadLogEntry[]; readonly pending: readonly number[] };

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
};

export function createScriptedSource(name: ScenarioName, readClock: () => number = () => performance.now()): ScriptedSource {
	const clock = createClampedClock(readClock);
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
		// The fixture's offset and view (owners) come from the exact path this read asked for.
		try { return { kind: 'ok', value: p.parse(fixtureBody(control, p.entry.path, p.scope.userId)) }; } catch { return { kind: 'unavailable', wait: null }; }
	}

	return Object.freeze({
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
