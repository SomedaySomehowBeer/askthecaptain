import type { Wait } from './clock.ts';
import type { AccountSnapshot, AccountView, LocalState, OrgNotice, ReleaseReason, ServerState, SignInFailure } from './machine.ts';
import type { Membership } from './me.ts';
import type { RevocationView } from './revocation.ts';
import type { UiCommand } from './runner.ts';

/** Every account wording, as pure functions and fixed tables (docs/plans/expo-mobile-auth-composition-2026-09.md §4;
 *  docs/plans/expo-web-session-2026-09.md §B.2). Screens render what these return; node tests cover every state.
 *
 *  Honesty rules this file carries: nothing says "signed in" before identity is verified; nothing says a session is
 *  being ended unless its revocation has begun; no expiry date is shown and nothing is inferred from the phone's clock
 *  (a server wait is shown only as "about {time}", from the wall-clock estimate recorded when the answer arrived). */

// ---------------------------------------------------------------------------------------------------------------
// The account's states as screens see them.

export type SignedInView = Extract<AccountView, { kind: 'signed-in' }>;

export const isSignedIn = (account: AccountView): account is SignedInView => account.kind === 'signed-in';
export const isReady = (account: AccountView): boolean => isSignedIn(account) && account.org.kind === 'chosen';

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
	| { readonly kind: 'sign-out'; readonly id: 'sign-out'; readonly label: 'Sign out'; readonly primary: boolean };

export type Line = { readonly title: string; readonly text: string };
export type Page = { readonly heading: string; readonly body: readonly string[]; readonly notices: readonly Line[]; readonly actions: readonly Action[] };

const command = (id: string, label: string, cmd: UiCommand, primary: boolean, disabled: string | null = null, note?: string): Action =>
	note === undefined ? { kind: 'command', id, label, command: cmd, primary, disabled } : { kind: 'command', id, label, command: cmd, primary, disabled, note };

export const copy = {
	captain: 'Captain',
	webOnly: "Signing in isn't available in this preview.",
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
	signOutConfirm: "Sign out of Captain on this phone? Uninstalling Captain doesn't sign you out."
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

export type PageOptions = { readonly now: number; readonly format?: FormatAbout; readonly returnTo?: string | null };

/** `welcome` on iOS and Android: every state that is not signed in (§4.2). The web welcome is `webWelcomePage`. */
export function welcomePage(snapshot: AccountSnapshot, options: PageOptions): Page {
	const { now } = options; const format = options.format ?? formatAbout;
	const base = welcomeBase(snapshot, now, format, options.returnTo ?? null);
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

function welcomeBase(snapshot: AccountSnapshot, now: number, format: FormatAbout, returnTo: string | null): Page {
	const account = snapshot.account;
	const plain = (body: string, heading: string = copy.captain): Page => ({ heading, body: [body], notices: [], actions: [] });
	switch (account.kind) {
		case 'web-only': return plain(copy.webOnly);
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
	none: "You aren't in an organisation yet. Ask the person who runs your business for an invitation.",
	notRemembered: "Captain will use this organisation now but couldn't remember it for next time.",
	current: 'Current'
} as const;

export const roleLabel = (membership: Membership): string =>
	membership.role === 'owner' ? 'Owner' : membership.role === 'admin' ? 'Admin' : 'Member';

export const accountCopy = {
	heading: 'Account',
	checking: 'Checking your access…',
	switch: 'Switch organisation',
	passkeys: 'Passkeys',
	passkeysIntro: 'A passkey is a second check at sign-in: after Google, your device confirms it is you.',
	passkeysLoading: 'Loading your passkeys…',
	passkeysNone: 'No passkeys yet. Sign-in is Google alone.',
	passkeysUnavailable: "Passkeys aren't available on this Captain.",
	passkeysFailed: "Couldn't load your passkeys.",
	passkeysNative: 'This version lists passkeys in the browser only.',
	passkeysManage: 'Adding and removing passkeys comes in a later version.',
	synced: 'synced passkey',
	thisDevice: 'this device only',
	notUsed: 'not used yet',
	tryAgain: 'Try again'
} as const;

/** One passkey's second line: "synced passkey, added {date}, last used {date}" from the API's instants, in the
 *  person's own calendar ("added" is always present; a never-used passkey says so). */
export function passkeyDetail(passkey: { readonly backedUp: boolean; readonly createdAt: string; readonly lastUsedAt: string | null }, formatDate: (iso: string) => string = shortDate): string {
	const kind = passkey.backedUp ? accountCopy.synced : accountCopy.thisDevice;
	const used = passkey.lastUsedAt === null ? accountCopy.notUsed : `last used ${formatDate(passkey.lastUsedAt)}`;
	return `${kind}, added ${formatDate(passkey.createdAt)}, ${used}`;
}

/** "3 Oct 2026" from an API instant; the instant itself if it cannot be read. */
export const shortDate = (iso: string): string => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §3-4, C2). The same results as the web,
 *  with "this phone". A refusal or an unknown answer never says that nothing changed: the write may have committed. */
export const revokeOthersCopy = {
	action: 'Sign out everywhere else',
	confirm: "Sign out of Captain everywhere else, including web browsers on computers? You'll stay signed in on this phone.",
	cancel: 'Cancel',
	sending: 'Signing out everywhere else…',
	slow: 'Still waiting for Captain…',
	none: 'No other active sessions were ended.',
	afterEnded: 'Anything already open on another screen stays visible until that screen next checks with Captain. Sign-ins already in progress, and new sign-ins, can still start new sessions.',
	refused: "Captain couldn't sign out your other sessions.",
	unknown: "Captain couldn't confirm whether your other sessions were ended. It's safe to try again.",
	tooManyLater: 'Too many attempts. Try again later.',
	waiting: 'You can try again shortly.'
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The lines for the current person's revocation state: in flight (and slow), or the last result. Plain text only; no
 *  identifier, token or server message ever appears. */
export function revocationLines(view: RevocationView): readonly string[] {
	if (view.inFlight) return view.slow ? [revokeOthersCopy.sending, revokeOthersCopy.slow] : [revokeOthersCopy.sending];
	const last = view.last;
	if (last === null) return [];
	if (last.kind === 'ok') {
		return last.ended === 0 ? [revokeOthersCopy.none] : [`${plural(last.ended, 'other active session', 'other active sessions')} ended.`, revokeOthersCopy.afterEnded];
	}
	if (last.kind === 'refused') return [revokeOthersCopy.refused];
	if (last.status === 429) {
		return [last.seconds === null ? revokeOthersCopy.tooManyLater : `Too many attempts. Try again in ${plural(Math.max(1, Math.ceil(last.seconds)), 'second', 'seconds')}.`];
	}
	return [revokeOthersCopy.unknown];
}

/** Why the control is disabled now, or null when it may be pressed. */
export function revocationDisabled(view: RevocationView, now: number): string | null {
	if (view.inFlight) return revokeOthersCopy.sending;
	if (waiting(view.wait, now)) return revokeOthersCopy.waiting;
	return null;
}

/** Signed-in notices shared by the organisation and account pages. */
export function signedInNotices(account: SignedInView): readonly Line[] {
	const lines: Line[] = [];
	if (account.orgNotice !== null) lines.push({ title: 'Organisation', text: orgNoticeText(account.orgNotice) });
	if (account.notice?.kind === 'refresh-unavailable') lines.push({ title: 'Connection unavailable', text: 'Captain could not check your session. Your last verified workspace is still shown. Try again when the connection returns.' });
	if (account.notice?.kind === 'organisation-not-remembered') lines.push({ title: 'Organisation', text: organisationCopy.notRemembered });
	return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Equipment schedule.

/** The read-only equipment schedule (docs/plans/expo-mobile-equipment-read-2026-09.md §5). Only a fully read period may
 *  leave time blank, and only as "no confirmed reservations when it was read"; every other state is hatched and named
 *  here. Nothing says a time is free or available. No fixed wording contains a digit: numbers come only from the data
 *  (times, setup and cleanup minutes). */
export const equipmentCopy = {
	heading: 'Equipment schedule',
	subtitle: 'Bookings for shared equipment',
	loading: 'Loading the schedule…',
	zoneUnsupported: "Times can't be shown in the business time zone on this device.",
	zoneChanged: 'The business time zone changed. Refresh to see the schedule.',
	emptyTitle: 'No equipment is listed yet.',
	emptyBody: 'Equipment appears here once it is added.',
	access: "Captain couldn't read this organisation's equipment. If your access has changed, Captain will show it the next time it checks.",
	failedFirst: "Couldn't load the schedule.",
	failedRefresh: "Couldn't refresh. The schedule may be out of date.",
	refresh: 'Refresh',
	tryAgain: 'Try again',
	tryAgainShown: 'Try again for the dates shown',
	busy: 'Loading…',
	moreLoading: 'Loading more equipment…',
	pacing: 'Captain is pacing its reads. Try again in a moment.',
	checkingAccess: 'Captain is checking your access.',
	stoppedRefresh: 'Captain stopped reading after a problem. Refresh to read the schedule again.',
	tryAgainFirst: 'Try again first, or Refresh.',
	more: 'More equipment',
	moreNotLoaded: 'More equipment not loaded yet',
	ceiling: 'More equipment exists than this version can list',
	listChanged: 'The equipment list changed while loading. Refresh for the current list.',
	incomplete: "Couldn't load more equipment. The columns shown aren't the whole list.",
	stale: 'May be out of date',
	archived: "Archived equipment isn't shown, including its bookings from the last month.",
	unread: 'Not loaded yet',
	cellLoading: 'Loading…',
	cellFailed: "Captain couldn't read these dates.",
	partial: 'Not every reservation is shown for these dates. Gaps are not confirmed free.',
	conflict: 'Captain received conflicting details for a reservation. Refresh to read it again.',
	staleFailed: "May be out of date. Captain couldn't read these dates again.",
	complete: 'Every confirmed reservation for these dates is shown, as of when it was last read.',
	hours: 'Hours',
	days: 'Days',
	weeks: 'Weeks',
	scale: 'Time scale',
	today: 'Today',
	earlier: 'Earlier dates',
	later: 'Later dates',
	previousColumn: 'Previous equipment',
	nextColumn: 'Next equipment',
	legend: 'Hatched: not known. Blank time in a fully read period had no confirmed reservations when it was read; availability can change before a reservation is saved.',
	booking: 'Booking',
	maintenance: 'Maintenance',
	panelNote: 'As of the last read. Availability can change before a reservation is saved.',
	close: 'Close'
} as const;

/** "Times in {zone}", the zone exactly as the organisation stores it. */
export const equipmentTimesIn = (zone: string): string => `Times in ${zone}`;

/** "Try again after about {time}" for a screen-wide server wait, as on the other lists. */
export const equipmentWaitText = (wait: Wait, format: FormatAbout = formatAbout): string => `Try again after about ${format(wait.about)}`;

/** The cell states the wording distinguishes (a marker passes the state it stands for). */
export type EquipmentCellState = 'unread' | 'loading' | 'failed' | 'partial' | 'complete' | 'conflict' | 'stale';
/** The §5 line for a cell. A failed or stale cell's own failure picks the access wording or "couldn't read"; a stale
 *  cell without a failure is only "May be out of date". A marker uses its state's line; none of these lines claim bars
 *  are shown (cells review note 4). */
export function equipmentCellText(state: EquipmentCellState, failure: 'unavailable' | 'access' | 'unreadable' | null): string {
	switch (state) {
	case 'unread': return equipmentCopy.unread;
	case 'loading': return equipmentCopy.cellLoading;
	case 'failed': return failure === 'access' ? equipmentCopy.access : equipmentCopy.cellFailed;
	case 'partial': return equipmentCopy.partial;
	case 'complete': return equipmentCopy.complete;
	case 'conflict': return equipmentCopy.conflict;
	case 'stale': return failure === null ? equipmentCopy.stale : failure === 'access' ? `${equipmentCopy.stale}. ${equipmentCopy.access}` : equipmentCopy.staleFailed;
	}
}

type ReservationText = {
	readonly title: string; readonly kind: 'booking' | 'maintenance';
	readonly startsAt: string; readonly endsAt: string; readonly occupiedStartsAt: string; readonly occupiedEndsAt: string;
	readonly setupMinutes: number; readonly cleanupMinutes: number;
};
/** A reservation time for people, in the organisation zone with its UTC offset (the screen passes `displayTime`). */
export type FormatInstant = (instant: string) => string;

export const reservationKindText = (kind: 'booking' | 'maintenance'): string => (kind === 'booking' ? equipmentCopy.booking : equipmentCopy.maintenance);
/** The actual start–end. */
export const reservationSpanText = (r: ReservationText, time: FormatInstant): string => `${time(r.startsAt)}–${time(r.endsAt)}`;
/** "Occupied {start}–{end}": the actual time widened by setup and cleanup. */
export const reservationOccupiedText = (r: ReservationText, time: FormatInstant): string => `Occupied ${time(r.occupiedStartsAt)}–${time(r.occupiedEndsAt)}`;
/** "includes setup N min, cleanup M min", naming only the buffers that are set; null when neither is. */
export function reservationBuffersText(r: ReservationText): string | null {
	const parts = [...(r.setupMinutes > 0 ? [`setup ${r.setupMinutes} min`] : []), ...(r.cleanupMinutes > 0 ? [`cleanup ${r.cleanupMinutes} min`] : [])];
	return parts.length ? `includes ${parts.join(', ')}` : null;
}
/** A bar's accessibility label (§5 "Labels"): always led by the equipment name, so a bar is never attributed to the
 *  wrong column; then the title, the kind, the actual time with its offset, and the buffers when present. */
export function reservationLabel(equipmentName: string, r: ReservationText, time: FormatInstant): string {
	const buffers = reservationBuffersText(r);
	return [equipmentName, r.title, reservationKindText(r.kind), reservationSpanText(r, time), ...(buffers === null ? [] : [buffers])].join(' · ');
}
/** One column's accessibility summary for the dates shown: its name, then the state's line. */
export const equipmentColumnSummary = (equipmentName: string, text: string): string => `${equipmentName}: ${text}`;

// ---------------------------------------------------------------------------------------------------------------
// The web (docs/plans/expo-web-session-2026-09.md §B.2).

/** The web welcome's wording. Nothing says "signed in" before `/v1/me` answered 200; an unavailable check never says
 *  the person is signed out, and a failed sign-out never says the session ended. */
export const webCopy = {
	checking: 'Checking your sign-in…',
	signInHeading: 'Sign in to Captain',
	signIn: 'Continue with Google. If your account has a passkey, your browser asks for it next.',
	signInAction: 'Sign in with Google',
	inviteOnly: 'Access is by invitation while Captain is in its first voyage.',
	unavailableHeading: "Couldn't check your sign-in",
	unavailable: "Captain's service didn't answer, so it can't tell whether you're signed in. If you were, nothing has changed.",
	unavailableRetrying: 'Checking again…',
	signedOutHeading: 'Signed out',
	signedOut: 'Signed out.',
	sessionEnded: 'Your session has ended. Sign in again.',
	signingOut: 'Signing out…',
	signOutFailedHeading: "Couldn't confirm you're signed out",
	signOutFailed: "Captain's service didn't answer. You may still be signed in.",
	misconfigured: "This page isn't served from a Captain address, so it can't sign you in.",
	signOutConfirm: 'Sign out of Captain in this browser?',
	errorTitle: 'Sign-in',
	errorFallback: 'Sign-in did not finish. Try again.'
} as const;

/** The API's sign-in error codes, as `/welcome?error=<code>` carries them (the vocabulary of the old sign-in page). */
export const signInErrors: Readonly<Record<string, string>> = Object.freeze({
	request_invalid: 'That sign-in link had expired. Start again.',
	google_failed: 'Google did not complete the sign-in. Try again.',
	exchange_failed: 'The sign-in could not be finished. Try again.',
	passkey_failed: 'The passkey could not be checked. Start again from sign-in.',
	native_sign_in_disabled: 'Signing in from the Captain app is not available on this Captain. Close this window to return to the app.'
});

/** The line for `?error=`: a known code's wording, the fallback for any other value, nothing when there is none. The
 *  code itself is never shown. */
export function signInErrorText(code: unknown): string | null {
	if (code === undefined || code === null || code === '') return null;
	return (typeof code === 'string' ? signInErrors[code] : undefined) ?? webCopy.errorFallback;
}

export type WebWelcome = {
	readonly heading: string; readonly body: readonly string[]; readonly notices: readonly Line[];
	/** The sign-in link is offered. */
	readonly signIn: boolean;
	/** Try again: enabled, disabled with its reason, or absent. */
	readonly retry: { readonly disabled: string | null } | null;
};

/** The web welcome for every state that is not signed in. `error` is the page's `?error=` value, if any. */
export function webWelcomePage(snapshot: AccountSnapshot, options: { readonly now: number; readonly error?: unknown; readonly format?: FormatAbout }): WebWelcome {
	const account = snapshot.account; const format = options.format ?? formatAbout;
	const errorText = signInErrorText(options.error);
	const errorNotice: Line[] = errorText === null ? [] : [{ title: webCopy.errorTitle, text: errorText }];
	const plain = (heading: string, body: readonly string[]): WebWelcome => ({ heading, body, notices: errorNotice, signIn: false, retry: null });
	switch (account.kind) {
		case 'checking': return plain(copy.captain, [webCopy.checking]);
		case 'misconfigured': return plain(copy.captain, [webCopy.misconfigured]);
		case 'signed-out': {
			const notice = account.notice;
			if (notice?.kind === 'released') {
				const text = notice.reason === 'session-ended' ? webCopy.sessionEnded : webCopy.signedOut;
				return { heading: webCopy.signedOutHeading, body: [webCopy.signIn], notices: [{ title: webCopy.signedOutHeading, text }, ...errorNotice], signIn: true, retry: null };
			}
			return { heading: webCopy.signInHeading, body: [webCopy.signIn], notices: errorNotice, signIn: true, retry: null };
		}
		case 'unverified': {
			const blocked = waiting(account.wait, options.now);
			const body = [webCopy.unavailable, ...(account.retrying ? [webCopy.unavailableRetrying] : blocked ? [tryAgainAfter(account.wait!, format)] : [])];
			return { heading: webCopy.unavailableHeading, body, notices: errorNotice, signIn: false, retry: { disabled: account.retrying ? webCopy.unavailableRetrying : blocked ? tryAgainAfter(account.wait!, format) : null } };
		}
		case 'releasing':
			if (!account.canRetry) return plain(webCopy.signingOut, []);
			return { heading: webCopy.signOutFailedHeading, body: [webCopy.signOutFailed], notices: errorNotice, signIn: false, retry: { disabled: waiting(account.wait, options.now) ? tryAgainAfter(account.wait!, format) : null } };
		default:
			// The native machine's other states never occur on the web; a neutral page if one ever did.
			return plain(copy.captain, []);
	}
}

/** The passkey step-up page (§B.2). */
export const stepUpCopy = {
	heading: 'One more step',
	body: 'This account is protected by a passkey. Confirm it is you.',
	waiting: 'Your browser is asking for your passkey.',
	checking: 'Checking…',
	use: 'Use my passkey',
	tryAgain: 'Try again',
	dismissed: 'The passkey prompt was dismissed.',
	unsupported: "This browser couldn't use a passkey.",
	optionsFailed: "Captain couldn't start the passkey check. Start again from sign-in.",
	expired: 'This sign-in has expired. Start again from sign-in.',
	verifyFailed: 'The passkey could not be checked. Start again from sign-in.',
	startOver: 'Back to sign in',
	done: 'Your passkey is confirmed. Opening Captain…',
	native: 'Passkeys are confirmed in the browser while signing in. There is nothing to do here.'
} as const;

/** Accepting an invitation (§B.2). A refusal is definitive; no answer is not, and never suggests opening the
 *  single-use link again. */
export const invitationCopy = {
	heading: 'Invitation',
	missing: 'This link is missing its invitation.',
	signInFirst: 'Sign in with the address the invitation was sent to, then it can be accepted.',
	ready: "You've been invited to join an organisation on Captain.",
	accept: 'Accept the invitation',
	accepting: 'Accepting…',
	refusedTitle: "This invitation can't be used.",
	unknownTitle: "The invitation's result isn't confirmed.",
	unknown: "Captain couldn't confirm whether the invitation was accepted. Check whether the organisation is now listed for you; if it isn't, ask for a new invitation link.",
	organisations: 'Your organisations',
	openThreads: 'Open threads'
} as const;

/** "You're now part of {name}." */
export const invitationAcceptedText = (organisationName: string): string => `You're now part of ${organisationName}.`;

/** The API's refusal codes for an invitation; any other code gets the general line. */
export const invitationRefusals: Readonly<Record<string, string>> = Object.freeze({
	invitation_invalid: 'This invitation is not open: it may have been used, withdrawn or expired.',
	forbidden: 'This invitation was sent to another address. Sign in with that address.'
});
export const invitationRefusalText = (code: string): string => invitationRefusals[code] ?? 'Captain refused this invitation.';

/** The thread list shell (docs/proposals/2026-09-29-chat-first-captain.md "Navigation"), empty in R1. */
export const threadsCopy = {
	heading: 'Threads',
	filters: ['All', 'Needs you', 'Tasks', 'Bookings', 'Stock', 'Records', 'Files', 'People'] as const,
	filterGroup: 'Filter threads',
	pinnedEquipment: 'Equipment schedule',
	pinnedEquipmentDetail: 'Bookings for shared equipment',
	pinnedTeam: 'Team',
	pinnedTeamDetail: 'Not in this version yet',
	emptyTitle: 'No threads to show yet',
	emptyBody: "Threads are not available yet. You can open the equipment schedule above.",
	search: 'Search',
	searchHint: 'Not available yet',
	account: 'Account and settings'
} as const;

/** A link this app will not open. */
export const refusedCopy = {
	heading: 'This link can’t be opened in Captain',
	title: 'Nothing was opened',
	body: 'The link is not one this app can open. Nothing was changed.',
	back: 'Go to threads'
} as const;
