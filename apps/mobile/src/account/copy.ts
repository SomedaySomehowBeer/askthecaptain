import type { WorkView } from '../api/paths.ts';
import type { WebPath } from '../config.ts';
import { linkableRoutes, refusedLink } from '../lib/links.ts';
import type { Wait } from './clock.ts';
import type { AccountSnapshot, AccountView, LocalState, OrgNotice, ReleaseReason, ServerState, SignInFailure } from './machine.ts';
import type { Membership } from './me.ts';
import type { UiCommand } from './runner.ts';

/** Every account wording and every navigation decision, as pure functions (docs/plans/expo-mobile-auth-composition-
 *  2026-09.md §4). Screens render what these return; node tests cover every state.
 *
 *  Honesty rules this file carries: nothing says "signed in" before identity is verified; nothing says a session is
 *  being ended unless its revocation has begun; no expiry date is shown and nothing is inferred from the phone's clock
 *  (a server wait is shown only as "about {time}", from the wall-clock estimate recorded when the answer arrived). */

// ---------------------------------------------------------------------------------------------------------------
// Navigation.

export type SignedInView = Extract<AccountView, { kind: 'signed-in' }>;
export type RootRoute = '/welcome' | '/organisation' | '/work';

export const isSignedIn = (account: AccountView): account is SignedInView => account.kind === 'signed-in';
export const isReady = (account: AccountView): boolean => isSignedIn(account) && account.org.kind === 'chosen';

/** Where the person should be: the tabs when ready, the chooser when signed in but not ready, otherwise welcome. The
 *  index route uses this too, so `/` can never reach a tab before the guards allow it. */
export function routeFor(account: AccountView): RootRoute {
	if (!isSignedIn(account)) return '/welcome';
	return account.org.kind === 'chosen' ? '/work' : '/organisation';
}

/** Whether a pathname already satisfies `routeFor`'s answer when that answer has just changed. The refusal page is open
 *  in every state (outside the guards); when ready, any tab route and Account satisfy `/work`. The organisation page
 *  does not: becoming ready from the chooser must leave it.
 *
 *  A deliberate visit to the organisation page while ready (Switch organisation) is never redirected, because
 *  `AccountStack` replaces only when `routeFor`'s answer changes, never because the pathname differs from it. */
export function routeHolds(route: RootRoute, pathname: string): boolean {
	if (pathname === refusedLink) return true;
	if (route === '/work') return pathname !== '/welcome' && pathname !== '/organisation' && pathname !== '/';
	return pathname === route;
}

/** The tab route the person opened the app at, kept through sign-in (§4.7): only a linkable tab route, else null. The
 *  attempt core and the API check it again; record links are not carried in this increment. */
export function requestedDestination(pathname: string | null): string | null {
	return pathname !== null && pathname !== '/' && linkableRoutes.has(pathname) ? pathname : null;
}

/** The tabs subtree's key: everything under it is dropped when the person or the organisation changes. */
export function tabsKey(account: AccountView): string | null {
	if (!isSignedIn(account) || account.org.kind !== 'chosen') return null;
	return `${account.user.id}:${account.org.membership.organisationId}`;
}

/** The destination to replace to, once, when ready: keyed so a re-render or a second effect cannot apply it twice. */
export function destinationStep(account: AccountView, appliedKey: string | null): { readonly href: string; readonly key: string } | null {
	if (!isSignedIn(account) || !account.ready || account.destination === null) return null;
	const key = `${tabsKey(account)}:${account.destination}`;
	return key === appliedKey ? null : { href: account.destination, key };
}

/** What `AccountStack` remembers between renders: the last `routeFor` answer, the last tabs key, the destination step
 *  already applied, and whether the tab route the app was opened at has had its one chance. */
export type NavMemory = {
	readonly route: RootRoute | null; readonly key: string | null; readonly applied: string | null; readonly requestedUsed: boolean;
};
export const navStart: NavMemory = Object.freeze({ route: null, key: null, applied: null, requestedUsed: false });
/** The memory a newly mounted `AccountStack` starts with. Only the requested destination's one-use flag carries over
 *  (from requested.ts, per process); route, tabs key and applied destination start empty. */
export const navMount = (requestedUsed: boolean): NavMemory => Object.freeze({ ...navStart, requestedUsed });
export type NavAction =
	| { readonly kind: 'none' }
	/** The tabs' person or organisation changed while ready (a switch, or a loss that auto-chose the one remaining
	 *  membership): reset the root stack to a fresh tabs route, so no tab stack or screen state from before survives. */
	| { readonly kind: 'reset-tabs' }
	/** Replace to the verified sign-in destination once, then send `destination-used`. */
	| { readonly kind: 'destination'; readonly href: string }
	/** Replace to the tab route the app was opened at, once, when a saved session first becomes ready. Sends nothing. */
	| { readonly kind: 'open-requested'; readonly href: string }
	| { readonly kind: 'replace'; readonly href: RootRoute };

/** The one navigation decision per snapshot (§4.1).
 *  - Replaces only when `routeFor`'s answer changes, never merely because the pathname differs, so a deliberate visit
 *    (Switch organisation while ready) stays put. `/` is left to the index route's own redirect.
 *  - A new tabs key while ready always resets the tabs, whatever caused it.
 *  - A sign-in destination is applied once; leaving ready forgets it, so a later sign-in applies its own anew.
 *  - `requested`, the tab route the app was opened at (captured once, before any guard redirect), is opened the first
 *    time the account becomes ready with no sign-in destination (a restored saved session). It is used at most once
 *    per process: the first time ready is reached consumes it either way. */
export function navigationStep(memory: NavMemory, account: AccountView, pathname: string, requested: string | null = null): { readonly memory: NavMemory; readonly action: NavAction } {
	const route = routeFor(account); const key = tabsKey(account); const ready = isReady(account);
	const applied = ready ? memory.applied : null;
	const requestedUsed = memory.requestedUsed || ready;
	if (memory.key !== null && key !== null && memory.key !== key) return { memory: { route, key, applied, requestedUsed }, action: { kind: 'reset-tabs' } };
	const step = destinationStep(account, applied);
	if (step !== null) return { memory: { route, key, applied: step.key, requestedUsed }, action: { kind: 'destination', href: step.href } };
	const next: NavMemory = { route, key, applied, requestedUsed };
	if (ready && !memory.requestedUsed && requested !== null && memory.route !== '/work') {
		return { memory: next, action: pathname === requested ? { kind: 'none' } : { kind: 'open-requested', href: requested } };
	}
	if (memory.route === route || pathname === '/' || routeHolds(route, pathname)) return { memory: next, action: { kind: 'none' } };
	return { memory: next, action: { kind: 'replace', href: route } };
}

/** The account stack's navigator key inside the container's root state: the first state, depth first, whose allowed
 *  screens include `(tabs)`. Only the account stack declares `(tabs)` (the tabs navigator's screens are work, chat and
 *  resources; the container's root slot is `__root`), and `(tabs)` is allowed exactly when ready, which is the only
 *  time a reset is issued. Null otherwise. */
type NavState = { readonly key?: unknown; readonly routeNames?: readonly string[]; readonly routes?: readonly { readonly state?: unknown }[] };
export function findAccountStack(state: unknown): string | null {
	if (typeof state !== 'object' || state === null) return null;
	const nav = state as NavState;
	if (typeof nav.key === 'string' && nav.routeNames?.includes('(tabs)')) return nav.key;
	for (const route of nav.routes ?? []) {
		const found = findAccountStack(route.state);
		if (found !== null) return found;
	}
	return null;
}

/** Replaces every route in the account stack with one fresh tabs route (docs/plans/expo-mobile-native-navigation-
 *  2026-09.md §3.3). The installed StackRouter defers RESET to BaseRouter, which returns it as partial state; rehydration
 *  gives every route a new key, so the old tabs subtree unmounts and a new one mounts at Work. Handled only by the
 *  navigator whose key is `target`.
 *  - `seedViews` (iOS and Android): Work is given as `[views, index]` with My work focused, so the view list is beneath
 *    it from the first render. The tab router fills in Chat and Resources with no state; their first visit is the tab
 *    bar's (`firstVisitParams`).
 *  - Otherwise (the web): no nested state, as before, so Work starts at `index` alone.
 *  No key is given at any depth. */
export const resetToFreshTabs = (target: string, seedViews: boolean) =>
	({
		type: 'RESET',
		payload: {
			index: 0,
			routes: [seedViews
				? { name: '(tabs)', state: { index: 0, routes: [{ name: 'work', state: { index: 1, routes: [{ name: 'views' }, { name: 'index' }] } }] } }
				: { name: '(tabs)' }]
		},
		target
	}) as const;

/** The tab bar's params for a tab never visited (§3.2, E1). With the view list as the section stack's initial route
 *  (iOS and Android), `initial: false` builds `[views, index]` in the section navigator's first render; on the web the
 *  default view opens alone, because there every route needs its own history entry. */
export const firstVisitParams = (anchored: boolean): { readonly screen: 'index'; readonly initial?: false } =>
	(anchored ? { screen: 'index', initial: false } : { screen: 'index' });

/** An app-initiated entry into the tabs (§3.2a):
 *  - `arrive`: the account's own route changes (becoming ready, a sign-in destination, the requested cold-start route,
 *    the fail-closed reopen, and the index redirect);
 *  - `return-to-my-work`: a control that promises My work ("Go to My work", and Back fallbacks with nowhere to go back). */
export type TabEntry = { readonly intent: 'arrive'; readonly href: string } | { readonly intent: 'return-to-my-work' };
export type TabEntryCall = { readonly method: 'replace' | 'dismissTo'; readonly href: string; readonly options: { readonly withAnchor?: true } };

const tabHref = (href: string) => /^\/(work|chat|resources)(\/|$)/.test(href);

/** The one router call for an app-initiated tab entry.
 *  - Native (`anchored`): `withAnchor` makes every nested level `initial: false`, so a section stack built by the entry
 *    has its view list beneath the target from its first render. `return-to-my-work` is `dismissTo('/work')`: it pops back
 *    to the existing tabs (never a second tabs route) and opens My work there, or builds fresh tabs when there are none.
 *    It is never `back()`, which could reach any page. `withAnchor` is applied only to tab routes; the account's other
 *    routes (welcome, the chooser) take no anchor.
 *  - Web: exactly the call made before this contract (`replace`, no options), so browser history is unchanged. */
export function tabEntryAction(anchored: boolean, entry: TabEntry): TabEntryCall {
	if (entry.intent === 'return-to-my-work') {
		return anchored ? { method: 'dismissTo', href: '/work', options: { withAnchor: true } } : { method: 'replace', href: '/work', options: {} };
	}
	return { method: 'replace', href: entry.href, options: anchored && tabHref(entry.href) ? { withAnchor: true } : {} };
}

// ---------------------------------------------------------------------------------------------------------------
// Waits.

/** Whether `wait` still blocks at `now` (exactly at `until`, it no longer does: the reducer's boundary). */
export const waiting = (wait: Wait | null, now: number): boolean => wait !== null && now < wait.until;

/** Milliseconds until the earliest wait still in force ends, for a UI-only re-render timer; null when none is. The
 *  timer only re-renders: it sends nothing, and the reducer still refuses a press made before the deadline. */
export function nextWake(waits: readonly (Wait | null)[], now: number): number | null {
	let soonest: number | null = null;
	for (const wait of waits) if (waiting(wait, now) && (soonest === null || wait!.until - now < soonest)) soonest = wait!.until - now;
	return soonest;
}

/** Every wait the snapshot's buttons depend on. */
export function snapshotWaits(snapshot: AccountSnapshot): readonly (Wait | null)[] {
	const account = snapshot.account;
	const own = account.kind === 'unverified' || account.kind === 'releasing' ? [account.wait] : [];
	return [...own, ...snapshot.strays.map((stray) => stray.wait)];
}

/** "about 14:05" style text from a wait's wall-clock estimate. Injectable for tests. */
export type FormatAbout = (iso: string) => string;
export const formatAbout: FormatAbout = (iso) => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? 'a short while' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// ---------------------------------------------------------------------------------------------------------------
// Actions.

export type Action =
	| {
		readonly kind: 'command'; readonly id: string; readonly label: string; readonly command: UiCommand; readonly primary: boolean;
		/** Why the button is disabled, shown with it; null when enabled. A forbidden action is shown disabled, never hidden. */
		readonly disabled: string | null;
		/** A note shown under the button (never a reason it is disabled). */
		readonly note?: string;
	}
	/** Sign out, behind a confirmation step (§4.3). */
	| { readonly kind: 'sign-out'; readonly id: 'sign-out'; readonly label: 'Sign out'; readonly primary: boolean }
	| { readonly kind: 'web'; readonly id: string; readonly label: string; readonly path: WebPath };

export type Line = { readonly title: string; readonly text: string };
export type Page = { readonly heading: string; readonly body: readonly string[]; readonly notices: readonly Line[]; readonly actions: readonly Action[] };

const command = (id: string, label: string, cmd: UiCommand, primary: boolean, disabled: string | null = null, note?: string): Action =>
	note === undefined ? { kind: 'command', id, label, command: cmd, primary, disabled } : { kind: 'command', id, label, command: cmd, primary, disabled, note };

export const copy = {
	captain: 'Captain',
	webOnly: "Signing in isn't available in this preview. Use Captain on the web.",
	misconfigured: 'This build has no valid Captain address.',
	opening: 'Opening…',
	openingSlow: "Still opening this phone's secure storage. If this continues, close and reopen Captain.",
	startupFailed: "Captain couldn't start sign-in on this phone. Close and reopen Captain.",
	storageUnavailable: "This phone can't keep a saved sign-in, so Captain can't sign in here.",
	unreadableHeading: "Couldn't read your saved sign-in",
	unreadable: "Captain couldn't read the sign-in saved on this phone.",
	rereading: 'Reading the saved sign-in again…',
	rereadingSlow: "Still reading this phone's secure storage. If this continues, close and reopen Captain.",
	signInAgainNote: 'Signing in again replaces the saved sign-in on this phone. If that sign-in was still active, it stays active until it expires.',
	signInHeading: 'Sign in to Captain',
	signIn: "You'll continue in your browser with Google, and a passkey if you have one.",
	signedOutHeading: 'Signed out',
	gateWaiting: 'Checking that no earlier sign-in is still finishing…',
	browserHeading: 'Continue in your browser',
	browser: 'Finish signing in in the browser window. Captain is waiting for it.',
	closingHeading: 'Closing the sign-in window…',
	closingSlow: 'Still waiting for the sign-in window to close.',
	savingHeading: 'Saving your sign-in…',
	savingSlow: 'Still saving your sign-in on this phone.',
	checkingHeading: 'Checking your saved sign-in…',
	unverifiedHeading: "Couldn't check your saved sign-in",
	/** No request is claimed: under an inherited server wait none was sent, and a refused or unreadable answer is not
	 *  "couldn't reach". Never "signed in". */
	unverified: "Captain couldn't check your saved sign-in with the server. It is still saved on this phone.",
	unverifiedWaiting: "Captain can't check your saved sign-in yet.",
	signingOutHeading: 'Signing out…',
	/** Only while a revocation is under way (server `revoking`). */
	endingHeading: 'Ending the session…',
	removingHeading: 'Removing the saved sign-in…',
	removingSlow: 'Still removing the saved sign-in from this phone.',
	fault: 'Captain hit an unexpected problem with a sign-in on this phone.',
	strayEnding: 'Captain is ending that session.',
	sessionEnded: 'Your session has ended. Sign in again.',
	saveFailed: "Captain couldn't save this sign-in on this phone.",
	signOutConfirm: "Sign out of Captain on this phone? Uninstalling Captain doesn't sign you out.",
	webMissing: "The Captain website address isn't set in this build.",
	openWeb: 'Open Captain on the web'
} as const;

export const signInNotices: Readonly<Record<SignInFailure, string>> = Object.freeze({
	cancelled: 'Sign-in was cancelled.',
	'callback-invalid': "Sign-in didn't come back to Captain correctly; nothing was sent.",
	'native-disabled': "Signing in from this app isn't available on this Captain.",
	'cannot-finish': "Captain couldn't finish signing in; start again.",
	'start-again': "Captain couldn't finish signing in; start again in a moment.",
	uncertain: "Captain couldn't confirm the sign-in; start again.",
	busy: 'Captain is still finishing a previous step.'
});

const tryAgainAfter = (wait: Wait, format: FormatAbout) => `Try again after about ${format(wait.about)}.`;

/** §4.3: what is true of a release, from its two results. Null while either is still in progress. */
export function releaseWording(local: LocalState, server: ServerState): string | null {
	if (local === 'removing' || server === 'revoking') return null;
	const ended = server === 'ended' || server === 'not-needed';
	if (local === 'copy-may-remain') {
		return ended ? 'Signed out. A saved copy may remain on this phone, but it no longer works.'
			: "Your saved sign-in may still be on this phone and the session hasn't ended. If you close Captain now, you may still be signed in the next time you open it.";
	}
	return ended ? 'Signed out.' : "Signed out on this phone. Captain couldn't confirm that the session has ended.";
}

/** The release wording with its reason's prefix. */
export function releasedText(reason: ReleaseReason, local: LocalState, server: ServerState): string | null {
	const wording = releaseWording(local, server);
	if (wording === null) return null;
	if (reason === 'session-ended') return `${copy.sessionEnded} ${wording}`;
	if (reason === 'save-failed') return `${copy.saveFailed} ${wording}`;
	return wording;
}

/** Fault and stray lines, shown in any state. Never "ending" unless a revocation has begun. */
export function faultLines(snapshot: AccountSnapshot): readonly string[] {
	if (!snapshot.fault && snapshot.strays.length === 0) return [];
	const lines: string[] = [copy.fault];
	for (const stray of snapshot.strays) {
		if (stray.server === 'revoking') lines.push(copy.strayEnding);
		else if (stray.server === 'pending' || stray.server === 'refused') {
			const wording = releaseWording(stray.local, stray.server);
			if (wording !== null) lines.push(wording);
		}
	}
	return lines;
}

/** Try again for strays, when any can be retried; disabled until the earliest retryable one's wait ends. */
function strayRetry(snapshot: AccountSnapshot, now: number, format: FormatAbout): Action | null {
	const retryable = snapshot.strays.filter((stray) => stray.canRetry);
	if (retryable.length === 0) return null;
	const ready = retryable.some((stray) => !waiting(stray.wait, now));
	if (ready) return command('retry-strays', 'Try again', { type: 'retry' }, false);
	const soonest = retryable.reduce((a, b) => (a.wait!.until <= b.wait!.until ? a : b)).wait!;
	return command('retry-strays', 'Try again', { type: 'retry' }, false, tryAgainAfter(soonest, format));
}

// ---------------------------------------------------------------------------------------------------------------
// Pages.

export type PageOptions = { readonly now: number; readonly webAvailable: boolean; readonly format?: FormatAbout; readonly returnTo?: string | null };

/** `welcome`: every state that is not signed in (§4.2). */
export function welcomePage(snapshot: AccountSnapshot, options: PageOptions): Page {
	const { now, webAvailable } = options; const format = options.format ?? formatAbout;
	const base = welcomeBase(snapshot, now, webAvailable, format, options.returnTo ?? null);
	const faults = faultLines(snapshot);
	const retry = strayRetry(snapshot, now, format);
	return {
		...base,
		notices: faults.length === 0 ? base.notices : [...base.notices, { title: 'Unexpected problem', text: faults.join(' ') }],
		actions: retry && !base.actions.some((a) => a.id === 'retry') ? [...base.actions, retry] : base.actions
	};
}

function signInAction(snapshot: AccountSnapshot, returnTo: string | null, label = 'Sign in with Google', primary = true, note?: string): Action {
	const cmd: UiCommand = returnTo === null ? { type: 'sign-in' } : { type: 'sign-in', returnTo };
	const reason = snapshot.strays.length > 0 ? 'Captain is still dealing with an earlier sign-in on this phone.'
		: snapshot.account.kind === 'signed-out' && snapshot.account.gate === 'waiting' ? copy.gateWaiting
			: snapshot.signInOffered ? null : 'Not available right now.';
	return command('sign-in', label, cmd, primary, reason, note);
}

function welcomeBase(snapshot: AccountSnapshot, now: number, webAvailable: boolean, format: FormatAbout, returnTo: string | null): Page {
	const account = snapshot.account;
	const plain = (body: string, heading: string = copy.captain): Page => ({ heading, body: [body], notices: [], actions: [] });
	switch (account.kind) {
		case 'web-only':
			return webAvailable
				? { heading: copy.captain, body: [copy.webOnly], notices: [], actions: [{ kind: 'web', id: 'web', label: copy.openWeb, path: '/' }] }
				: { heading: copy.captain, body: [copy.webOnly, copy.webMissing], notices: [], actions: [] };
		case 'misconfigured': return plain(copy.misconfigured);
		case 'starting': return plain(account.slow ? copy.openingSlow : copy.opening);
		case 'startup-failed': return plain(copy.startupFailed);
		case 'storage-unavailable': return plain(copy.storageUnavailable);
		case 'storage-unreadable': {
			const body = account.reading ? [account.slow ? copy.rereadingSlow : copy.rereading] : [copy.unreadable];
			return {
				heading: copy.unreadableHeading, body, notices: [],
				actions: [
					command('retry', 'Try reading again', { type: 'retry' }, true, account.reading ? 'Reading…' : null),
					signInAction(snapshot, returnTo, 'Sign in again', false, copy.signInAgainNote)
				]
			};
		}
		case 'signed-out': {
			const notice = account.notice;
			const notices: Line[] = [];
			let heading: string = copy.signInHeading;
			if (notice?.kind === 'sign-in') notices.push({ title: 'Sign-in', text: signInNotices[notice.outcome] });
			if (notice?.kind === 'released') {
				heading = copy.signedOutHeading;
				notices.push({ title: 'Signed out', text: releasedText(notice.reason, notice.local, notice.server) ?? 'Signed out.' });
			}
			if (account.gate === 'busy') {
				return {
					heading, body: [copy.signIn], notices: [...notices, { title: 'Sign-in', text: signInNotices.busy }],
					actions: [command('retry', 'Try again', { type: 'retry' }, true)]
				};
			}
			return { heading, body: [copy.signIn], notices, actions: [signInAction(snapshot, returnTo)] };
		}
		case 'signing-in': {
			if (account.phase === 'browser') {
				return { heading: copy.browserHeading, body: [copy.browser], notices: [], actions: [command('cancel', 'Cancel', { type: 'cancel' }, false)] };
			}
			if (account.phase === 'closing') return { heading: copy.closingHeading, body: account.slow ? [copy.closingSlow] : [], notices: [], actions: [] };
			return { heading: copy.savingHeading, body: account.slow ? [copy.savingSlow] : [], notices: [], actions: [] };
		}
		case 'checking': return { heading: copy.checkingHeading, body: [], notices: [], actions: [] };
		case 'unverified': {
			const blocked = waiting(account.wait, now);
			const body: string[] = blocked ? [copy.unverifiedWaiting, tryAgainAfter(account.wait!, format)] : [copy.unverified];
			const reason = account.retrying ? 'Checking…' : blocked ? tryAgainAfter(account.wait!, format) : null;
			return {
				heading: copy.unverifiedHeading, body, notices: [],
				actions: [command('retry', 'Try again', { type: 'retry' }, true, reason), { kind: 'sign-out', id: 'sign-out', label: 'Sign out', primary: false }]
			};
		}
		case 'releasing': {
			const text = releasedText(account.reason, account.local, account.server);
			const body: string[] = text === null ? (account.slow && account.local === 'removing' ? [copy.removingSlow] : []) : [text];
			if (text === null && account.reason === 'session-ended') body.unshift(copy.sessionEnded);
			if (text === null && account.reason === 'save-failed') body.unshift(copy.saveFailed);
			// "Ending" only while a revocation is under way; nothing is being ended otherwise.
			const heading = account.server === 'revoking' ? copy.endingHeading
				: account.local === 'removing' ? copy.removingHeading : copy.signingOutHeading;
			if (!account.canRetry) return { heading, body, notices: [], actions: [] };
			const reason = waiting(account.wait, now) ? tryAgainAfter(account.wait!, format) : null;
			return { heading, body, notices: [], actions: [command('retry', 'Try again', { type: 'retry' }, true, reason)] };
		}
		case 'signed-in':
			// Not shown on welcome (routeFor sends a signed-in person elsewhere); a neutral page if it ever is.
			return { heading: copy.captain, body: [], notices: [], actions: [] };
	}
}

/** The organisation loss notice (§4.4). */
export function orgNoticeText(notice: OrgNotice): string {
	return notice.kind === 'lost' ? `You no longer have access to ${notice.name}.`
		: "The organisation Captain remembered for you isn't available to you any more.";
}

export const organisationCopy = {
	chooseHeading: 'Choose an organisation',
	switchHeading: 'Switch organisation',
	loading: 'Checking your organisations…',
	none: "You aren't in an organisation yet. Organisations are created and joined on the Captain website.",
	notRemembered: "Captain will use this organisation now but couldn't remember it for next time.",
	current: 'Current'
} as const;

export const roleLabel = (membership: Membership): string =>
	membership.role === 'owner' ? 'Owner' : membership.role === 'admin' ? 'Admin' : 'Member';

export const accountCopy = {
	heading: 'Account',
	checking: 'Checking your access…',
	elsewhere: 'Organisation creation, invitations, passkeys and other settings are on the Captain website.',
	switch: 'Switch organisation',
	otherSettings: 'Other settings on the web'
} as const;

/** Signed-in notices shared by the organisation and account pages. */
export function signedInNotices(account: SignedInView): readonly Line[] {
	const lines: Line[] = [];
	if (account.orgNotice !== null) lines.push({ title: 'Organisation', text: orgNoticeText(account.orgNotice) });
	if (account.notice?.kind === 'organisation-not-remembered') lines.push({ title: 'Organisation', text: organisationCopy.notRemembered });
	return lines;
}

/** My work (docs/plans/expo-mobile-my-work-read-2026-09.md §3.5). No wording claims an access check is under way, and
 *  a failed read is never described as an empty list. */
export const workCopy = {
	heading: 'My work',
	subtitle: 'Open tasks assigned to you',
	loading: 'Loading your work…',
	emptyTitle: 'Nothing open is assigned to you',
	emptyBody: 'Tasks you own appear here while they are open.',
	failedFirst: "Couldn't load your work",
	failedRefresh: "Couldn't refresh. This list may be out of date.",
	failedMore: "Couldn't load more",
	access: "Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks.",
	list: "Captain couldn't read this list.",
	open: 'Open',
	refresh: 'Refresh',
	more: 'More',
	tryAgain: 'Try again',
	busy: 'Loading…',
	capNotice: 'Some more open tasks may be available on the Captain website.',
	openWebWork: 'Open My work on the web'
} as const;

/** All tasks (docs/plans/expo-mobile-all-tasks-read-2026-09.md §5): open tasks only, assigned to anyone. It never says
 *  "in progress" or "everything", names no total, and says nothing about a person beyond the three owner facts. */
export const allWorkCopy = {
	heading: 'All tasks',
	subtitle: 'Open tasks assigned to anyone',
	loading: 'Loading open tasks…',
	emptyTitle: 'No open tasks in this organisation',
	emptyBody: 'Tasks appear here while they are open, whoever they are assigned to.',
	failedFirst: "Couldn't load open tasks",
	failedRefresh: workCopy.failedRefresh,
	failedMore: workCopy.failedMore,
	access: workCopy.access,
	list: workCopy.list,
	open: workCopy.open,
	refresh: workCopy.refresh,
	more: workCopy.more,
	tryAgain: workCopy.tryAgain,
	busy: workCopy.busy,
	capNotice: workCopy.capNotice,
	// Tied to the checked web title for owner=all ("All tasks"); if that title changes, this label changes with it.
	openWebWork: 'Open All tasks on the Captain website'
} as const;

export type WorkViewCopy = { readonly [K in keyof typeof workCopy]: string };

/** The whole wording for one view, looked up once by the screen's bound view (never picked string by string). */
export const workViewCopy = (view: WorkView): WorkViewCopy => (view === 'all' ? allWorkCopy : workCopy);

/** The owner facts All tasks shows, and nothing more: no names in this slice. */
export const ownerLabels = Object.freeze({ you: 'Assigned to you', 'someone-else': 'Assigned to someone else', none: 'No owner' } as const);

/** "+N more" for a row's tags beyond the ones shown; null when there are none. */
export const moreTags = (tagCount: number, shown: number): string | null => (tagCount > shown ? `+${tagCount - shown} more` : null);

type WorkProblemView = { readonly op: 'first' | 'refresh' | 'more'; readonly kind: 'unavailable' | 'access' | 'list' };

/** The wording for a failed read in one view: the operation decides the line for an unavailable answer; a refusal says
 *  what kind it was, the same for every operation. */
export function workViewProblemText(copy: WorkViewCopy, problem: WorkProblemView): string {
	if (problem.kind === 'access') return copy.access;
	if (problem.kind === 'list') return copy.list;
	return problem.op === 'first' ? copy.failedFirst : problem.op === 'refresh' ? copy.failedRefresh : copy.failedMore;
}

/** My work's failure wording (unchanged). */
export const workProblemText = (problem: WorkProblemView): string => workViewProblemText(workCopy, problem);
