import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outsideSnapshots } from './account-source.ts';
import {
	copy, faultLines, nextWake, releaseWording, signInNotices, snapshotWaits, welcomePage, type Page,
	revocationDisabled, revocationLines, revokeOthersCopy,
	equipmentCellText, equipmentColumnSummary, equipmentCopy, equipmentTimesIn, equipmentWaitText, reservationBuffersText, reservationLabel,
	reservationOccupiedText, reservationSpanText,
	invitationRefusalText, passkeyDetail, signInErrorText, threadsCopy, webCopy, webWelcomePage
} from './copy.ts';
import { idleRevocation, sendingRevocation, settledRevocation, slowRevocation, unknownResult } from './revocation.ts';
import type { AccountSnapshot, AccountView, StrayView } from './machine.ts';
import type { Membership } from './me.ts';

const user = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'o@example.test', name: 'Owner' };
const orgA: Membership = { organisationId: 'c0ffee00-1234-4abc-9def-0123456789ab', organisationName: 'Harbour', role: 'owner' };
const orgB: Membership = { organisationId: 'd00dfeed-5678-4def-8abc-ba9876543210', organisationName: 'Quayside', role: 'member' };
const snap = (account: AccountView, extra: Partial<AccountSnapshot> = {}): AccountSnapshot => ({ account, signInOffered: false, fault: false, strays: [], ...extra });
const signedIn = (org: Membership | 'choose' | 'none' | 'loading', destination: string | null = null): AccountView => ({
	kind: 'signed-in', user, memberships: [orgA, orgB], refreshing: false, notice: null, orgNotice: null,
	org: typeof org === 'string' ? { kind: org } : { kind: 'chosen', membership: org },
	destination: typeof org === 'string' ? null : destination, ready: typeof org !== 'string',
	scope: typeof org === 'string' ? null : { epoch: `a1.${org.organisationId}`, userId: user.id, organisationId: org.organisationId },
	person: { epoch: 'a1', userId: user.id }
});
const wait = (until: number) => ({ until, about: '2030-01-01T12:05:00.000Z' });
const format = () => '12:05';
const page = (snapshot: AccountSnapshot, now = 0): Page => welcomePage(snapshot, { now, format });
const text = (p: Page) => JSON.stringify(p);

const everyState: AccountSnapshot[] = [
	outsideSnapshots.webOnly, outsideSnapshots.misconfigured, outsideSnapshots.starting, outsideSnapshots.startingSlow, outsideSnapshots.startupFailed,
	snap({ kind: 'storage-unavailable' }), snap({ kind: 'storage-unreadable', reading: false, slow: false }, { signInOffered: true }),
	snap({ kind: 'storage-unreadable', reading: true, slow: true }),
	snap({ kind: 'signed-out', notice: null, gate: 'idle' }, { signInOffered: true }), snap({ kind: 'signed-out', notice: null, gate: 'waiting' }),
	snap({ kind: 'signed-out', notice: null, gate: 'busy' }, { signInOffered: true }),
	...(['cancelled', 'callback-invalid', 'native-disabled', 'cannot-finish', 'start-again', 'uncertain', 'busy'] as const)
		.map((outcome) => snap({ kind: 'signed-out', notice: { kind: 'sign-in', outcome }, gate: 'idle' }, { signInOffered: true })),
	snap({ kind: 'signing-in', phase: 'browser', slow: false }), snap({ kind: 'signing-in', phase: 'closing', slow: true }), snap({ kind: 'signing-in', phase: 'saving', slow: true }),
	snap({ kind: 'checking' }), snap({ kind: 'unverified', retrying: false, wait: wait(5_000) }), snap({ kind: 'unverified', retrying: true, wait: null }),
	...(['sign-out', 'save-failed', 'save-stale', 'session-ended'] as const).flatMap((reason) =>
		(['removing', 'deleted', 'no-usable-copy', 'newer-kept', 'copy-may-remain'] as const).flatMap((local) =>
			(['revoking', 'pending', 'refused', 'ended', 'not-needed'] as const).map((server) => snap({
				kind: 'releasing', reason, local, server, wait: null, slow: false,
				closeAppWarning: local === 'copy-may-remain' && (server === 'pending' || server === 'refused'),
				canRetry: (server === 'pending' || server === 'refused') && local !== 'removing'
			}))))
];

test('equipment schedule: fixed wording has no digits and never calls time free or available', () => {
	for (const [key, text] of Object.entries(equipmentCopy)) {
		assert.doesNotMatch(text, /\d/, key);
		assert.doesNotMatch(text.replace('not confirmed free', ''), /\bfree\b|\bavailable\b|\bopen slot/i, key);
	}
	assert.equal(equipmentCopy.loading, 'Loading the schedule…');
	assert.equal(equipmentCopy.partial, 'Not every reservation is shown for these dates. Gaps are not confirmed free.');
	assert.equal(equipmentCopy.conflict, 'Captain received conflicting details for a reservation. Refresh to read it again.');
	assert.equal(equipmentCopy.zoneUnsupported, "Times can't be shown in the business time zone on this device.");
	assert.equal(equipmentTimesIn('Australia/Sydney'), 'Times in Australia/Sydney');
	assert.equal(equipmentWaitText(wait(5_000), format), 'Try again after about 12:05');
	// Every state has its line; failures pick access or "couldn't read"; a stale cell names its re-read failure.
	assert.equal(equipmentCellText('unread', null), 'Not loaded yet');
	assert.equal(equipmentCellText('loading', null), 'Loading…');
	assert.equal(equipmentCellText('failed', 'unavailable'), "Captain couldn't read these dates.");
	assert.equal(equipmentCellText('failed', 'unreadable'), "Captain couldn't read these dates.");
	assert.equal(equipmentCellText('failed', 'access'), equipmentCopy.access);
	assert.equal(equipmentCellText('partial', null), equipmentCopy.partial);
	assert.equal(equipmentCellText('conflict', null), equipmentCopy.conflict);
	assert.equal(equipmentCellText('complete', null), 'Every confirmed reservation for these dates is shown, as of when it was last read.');
	assert.match(equipmentCopy.complete, /when it was last read\.$/, 'a claim about the time of the read, like the legend');
	assert.equal(equipmentCellText('stale', null), 'May be out of date');
	assert.equal(equipmentCellText('stale', 'unavailable'), "May be out of date. Captain couldn't read these dates again.");
	assert.match(equipmentCellText('stale', 'access'), /^May be out of date\. Captain couldn't read this organisation's equipment/);
	for (const state of ['unread', 'loading', 'failed', 'partial', 'conflict', 'stale'] as const)
		assert.doesNotMatch(equipmentCellText(state, null), /no (confirmed )?reservations|nothing booked/i, `${state} never claims an empty period`);
	assert.equal(equipmentColumnSummary('Kettle', equipmentCopy.unread), 'Kettle: Not loaded yet');
});

test('equipment schedule: a bar label always starts with the equipment name, then title, kind, actual time and buffers', () => {
	const time = (instant: string) => `<${instant}>`;
	const r = { title: 'Brew day', kind: 'booking' as const, startsAt: 'S', endsAt: 'E', occupiedStartsAt: 'OS', occupiedEndsAt: 'OE', setupMinutes: 0, cleanupMinutes: 0 };
	assert.equal(reservationLabel('Kettle', r, time), 'Kettle · Brew day · Booking · <S>–<E>');
	assert.equal(reservationBuffersText(r), null);
	const buffered = { ...r, kind: 'maintenance' as const, setupMinutes: 30, cleanupMinutes: 15 };
	assert.equal(reservationLabel('Fermenter  2 ', buffered, time), 'Fermenter  2  · Brew day · Maintenance · <S>–<E> · includes setup 30 min, cleanup 15 min');
	assert.equal(reservationBuffersText({ ...r, cleanupMinutes: 5 }), 'includes cleanup 5 min');
	assert.equal(reservationBuffersText({ ...r, setupMinutes: 10080 }), 'includes setup 10080 min');
	assert.equal(reservationSpanText(r, time), '<S>–<E>');
	assert.equal(reservationOccupiedText(r, time), 'Occupied <OS>–<OE>');
});

test('sign out everywhere else: exact wording with grammatical plurals; a 429 says why, with or without a time; never "nothing changed"', () => {
	const after = revokeOthersCopy.afterEnded;
	assert.equal(after, 'Anything already open on another screen stays visible until that screen next checks with Captain. Sign-ins already in progress, and new sign-ins, can still start new sessions.');
	assert.equal(revokeOthersCopy.confirm, "Sign out of Captain everywhere else, including web browsers on computers? You'll stay signed in on this phone.");
	assert.equal(revokeOthersCopy.action, 'Sign out everywhere else');
	const lines = (result: Parameters<typeof settledRevocation>[0]) => revocationLines(settledRevocation(result));
	assert.deepEqual(revocationLines(idleRevocation), []);
	assert.deepEqual(revocationLines(sendingRevocation), ['Signing out everywhere else…']);
	assert.deepEqual(revocationLines(slowRevocation(sendingRevocation)), ['Signing out everywhere else…', 'Still waiting for Captain…']);
	assert.deepEqual(lines({ kind: 'ok', ended: 1 }), ['1 other active session ended.', after]);
	assert.deepEqual(lines({ kind: 'ok', ended: 2 }), ['2 other active sessions ended.', after]);
	assert.deepEqual(lines({ kind: 'ok', ended: 0 }), ['No other active sessions were ended.']);
	assert.deepEqual(lines({ kind: 'refused', status: 403 }), ["Captain couldn't sign out your other sessions."]);
	const unknown = "Captain couldn't confirm whether your other sessions were ended. It's safe to try again.";
	assert.deepEqual(lines(unknownResult), [unknown]);
	assert.deepEqual(lines({ kind: 'unknown', status: 503, wait: wait(5_000), seconds: 5 }), [unknown], 'a 5xx wait is not "too many attempts"');
	assert.deepEqual(lines({ kind: 'unknown', status: 429, wait: wait(1_000), seconds: 1 }), ['Too many attempts. Try again in 1 second.']);
	assert.deepEqual(lines({ kind: 'unknown', status: 429, wait: wait(20_000), seconds: 20 }), ['Too many attempts. Try again in 20 seconds.']);
	assert.deepEqual(lines({ kind: 'unknown', status: 429, wait: null, seconds: null }), ['Too many attempts. Try again later.'], 'no invented time');
	for (const result of [{ kind: 'refused', status: 403 } as const, unknownResult, { kind: 'unknown', status: 429, wait: null, seconds: null } as const]) {
		for (const line of lines(result)) assert.doesNotMatch(line, /nothing|no change/i, line);
	}
	assert.doesNotMatch(JSON.stringify(revokeOthersCopy), /\d|sess_/, 'no number or token in the fixed wording');
});

test('sign out everywhere else: disabled while in flight and until a wait ends (exactly at its end it is enabled)', () => {
	assert.equal(revocationDisabled(idleRevocation, 0), null);
	assert.equal(revocationDisabled(sendingRevocation, 0), revokeOthersCopy.sending);
	const limited = settledRevocation({ kind: 'unknown', status: 429, wait: wait(20_000), seconds: 20 });
	assert.equal(revocationDisabled(limited, 19_999), revokeOthersCopy.waiting);
	assert.equal(revocationDisabled(limited, 20_000), null);
	assert.equal(revocationDisabled(settledRevocation({ kind: 'ok', ended: 2 }), 0), null, 'a repeat is allowed');
});

test('copy: every state has a heading; no wording states an expiry date or infers from the phone clock', () => {
	for (const s of everyState) {
		const p = page(s);
		assert.ok(p.heading.length > 0, s.account.kind);
		assert.ok(!/expire|expiry|until \d|valid until/i.test(text(p).replace(copy.signInAgainNote, '')), `${s.account.kind}: ${text(p)}`);
		assert.ok(!/signed in\b/i.test(p.heading), 'never "signed in" before verification');
	}
});

test('copy: sign-in notices, the gate and busy', () => {
	for (const [outcome, wording] of Object.entries(signInNotices)) {
		const p = page(snap({ kind: 'signed-out', notice: { kind: 'sign-in', outcome: outcome as keyof typeof signInNotices }, gate: 'idle' }, { signInOffered: true }));
		assert.ok(p.notices.some((n) => n.text === wording), outcome);
	}
	const waiting = page(snap({ kind: 'signed-out', notice: null, gate: 'waiting' }));
	assert.equal(waiting.actions[0]!.kind === 'command' && waiting.actions[0]!.disabled, copy.gateWaiting, 'shown disabled with its reason');
	const busy = page(snap({ kind: 'signed-out', notice: null, gate: 'busy' }, { signInOffered: true }));
	assert.deepEqual(busy.actions.map((a) => a.kind === 'command' && a.command), [{ type: 'retry' }]);
	const withReturn = welcomePage(snap({ kind: 'signed-out', notice: null, gate: 'idle' }, { signInOffered: true }), { now: 0, returnTo: '/equipment' });
	assert.deepEqual(withReturn.actions[0]!.kind === 'command' && withReturn.actions[0]!.command, { type: 'sign-in', returnTo: '/equipment' });
});

test('copy: unverified Try again is disabled before the wait and enabled exactly at it; Sign out is always offered', () => {
	const s = snap({ kind: 'unverified', retrying: false, wait: wait(5_000) });
	const before = page(s, 4_999);
	assert.ok(before.body.includes('Try again after about 12:05.'));
	const retryBefore = before.actions.find((a) => a.id === 'retry')!;
	assert.ok(retryBefore.kind === 'command' && retryBefore.disabled !== null);
	const retryAt = page(s, 5_000).actions.find((a) => a.id === 'retry')!;
	assert.ok(retryAt.kind === 'command' && retryAt.disabled === null);
	assert.ok(before.actions.some((a) => a.kind === 'sign-out'));
	assert.ok(!text(before).includes('signed in'), 'never says signed in');
	assert.deepEqual(before.body, [copy.unverifiedWaiting, 'Try again after about 12:05.'], 'under a wait nothing was sent: no failure is claimed');
	assert.deepEqual(page(snap({ kind: 'unverified', retrying: false, wait: null })).body, [copy.unverified]);
	for (const s of everyState) assert.ok(!/couldn't reach/i.test(text(page(s))), s.account.kind);
});

test('releasing heading: "Ending the session…" only while a revocation is under way', () => {
	const releasing = (reason: 'sign-out' | 'session-ended', local: 'removing' | 'deleted', server: 'revoking' | 'not-needed' | 'pending') =>
		page(snap({ kind: 'releasing', reason, local, server, wait: null, slow: false, closeAppWarning: false, canRetry: server === 'pending' && local !== 'removing' })).heading;
	assert.equal(releasing('sign-out', 'removing', 'revoking'), copy.endingHeading);
	assert.equal(releasing('session-ended', 'removing', 'not-needed'), copy.removingHeading, 'a 401: nothing is being revoked');
	assert.equal(releasing('sign-out', 'deleted', 'pending'), copy.signingOutHeading);
	for (const s of everyState) {
		if (s.account.kind === 'releasing' && s.account.server !== 'revoking') assert.notEqual(page(s).heading, copy.endingHeading);
	}
});

test('copy: sign-out wording by result, with the close-app warning and reason prefixes', () => {
	assert.equal(releaseWording('deleted', 'ended'), 'Signed out.');
	assert.equal(releaseWording('no-usable-copy', 'pending'), "Signed out on this phone. Captain couldn't confirm that the session has ended.");
	assert.equal(releaseWording('copy-may-remain', 'not-needed'), 'Signed out. A saved copy may remain on this phone, but it no longer works.');
	assert.match(releaseWording('copy-may-remain', 'refused')!, /If you close Captain now, you may still be signed in/);
	assert.equal(releaseWording('removing', 'pending'), null);
	assert.equal(releaseWording('deleted', 'revoking'), null);
	const ended = page(snap({ kind: 'signed-out', notice: { kind: 'released', reason: 'session-ended', local: 'deleted', server: 'not-needed' }, gate: 'idle' }, { signInOffered: true }));
	assert.equal(ended.heading, copy.signedOutHeading);
	assert.ok(ended.notices.some((n) => n.text.startsWith(copy.sessionEnded)));
	const failed = page(snap({ kind: 'releasing', reason: 'save-failed', local: 'deleted', server: 'pending', wait: wait(5_000), slow: false, closeAppWarning: false, canRetry: true }), 4_999);
	assert.ok(failed.body[0]!.startsWith(copy.saveFailed));
	const retry = failed.actions.find((a) => a.id === 'retry')!;
	assert.ok(retry.kind === 'command' && retry.disabled !== null, "the release's Try again waits for the cleanup's server wait");
});

test('fault copy: never "ending" unless a revocation has begun', () => {
	const stray = (local: StrayView['local'], server: StrayView['server']): StrayView => ({ local, server, wait: null, closeAppWarning: false, canRetry: server === 'pending' || server === 'refused' });
	const signedOut = { kind: 'signed-out', notice: null, gate: 'idle' } as const;
	assert.deepEqual(faultLines(snap(signedOut, { fault: true })), [copy.fault], 'fault only: nothing more');
	assert.deepEqual(faultLines(snap(signedOut)), []);
	assert.deepEqual(faultLines(snap(signedOut, { strays: [stray('removing', 'revoking')] })), [copy.fault, copy.strayEnding]);
	const refused = faultLines(snap(signedOut, { strays: [stray('deleted', 'refused')] }));
	assert.ok(!refused.includes(copy.strayEnding), 'a refused revocation never began');
	assert.ok(refused.some((line) => line.includes("couldn't confirm")));
	const withRetry = page(snap(signedOut, { fault: true, strays: [stray('copy-may-remain', 'pending')] }));
	assert.ok(withRetry.actions.some((a) => a.id === 'retry-strays'));
});

test('wait timer: the remaining time on the monotonic deadline; nothing when no wait is in force', () => {
	const s = snap({ kind: 'unverified', retrying: false, wait: wait(5_000) }, { strays: [{ local: 'deleted', server: 'pending', wait: wait(3_000), closeAppWarning: false, canRetry: true }] });
	assert.deepEqual(snapshotWaits(s), [wait(5_000), wait(3_000)]);
	assert.equal(nextWake(snapshotWaits(s), 1_000), 2_000);
	assert.equal(nextWake(snapshotWaits(s), 3_000), 2_000);
	assert.equal(nextWake(snapshotWaits(s), 5_000), null);
	assert.equal(nextWake([], 0), null);
});

test('copy: web-only and misconfigured say so plainly, with no website link and no repeated value', () => {
	assert.deepEqual(page(outsideSnapshots.webOnly), { heading: copy.captain, body: [copy.webOnly], notices: [], actions: [] });
	assert.deepEqual(page(outsideSnapshots.misconfigured).body, [copy.misconfigured]);
	assert.deepEqual(page(outsideSnapshots.startupFailed).body, [copy.startupFailed]);
	assert.deepEqual(page(outsideSnapshots.startingSlow).body, [copy.openingSlow]);
	assert.ok(!JSON.stringify(copy).toLowerCase().includes('website'));
});

test('web welcome: checking, signed out (with a released notice), unavailable with the paced Try again, signing out and its failure', () => {
	const web = (account: AccountView, now = 0, error?: unknown) => webWelcomePage(snap(account), { now, error, format });
	assert.deepEqual(web({ kind: 'checking' }), { heading: copy.captain, body: [webCopy.checking], notices: [], signIn: false, retry: null });
	assert.deepEqual(web({ kind: 'signed-out', notice: null, gate: 'idle' }), { heading: webCopy.signInHeading, body: [webCopy.signIn], notices: [], signIn: true, retry: null });
	const released = web({ kind: 'signed-out', notice: { kind: 'released', reason: 'sign-out', local: 'deleted', server: 'ended' }, gate: 'idle' });
	assert.equal(released.heading, webCopy.signedOutHeading); assert.deepEqual(released.notices, [{ title: webCopy.signedOutHeading, text: webCopy.signedOut }]); assert.ok(released.signIn);
	const ended = web({ kind: 'signed-out', notice: { kind: 'released', reason: 'session-ended', local: 'deleted', server: 'not-needed' }, gate: 'idle' });
	assert.deepEqual(ended.notices, [{ title: webCopy.signedOutHeading, text: webCopy.sessionEnded }]);
	// Unavailable: never says signed out, never offers sign-in; Try again is disabled until the wait ends, and exactly at it enabled.
	const blocked = web({ kind: 'unverified', retrying: false, wait: wait(5_000) }, 0);
	assert.equal(blocked.heading, webCopy.unavailableHeading); assert.ok(!blocked.signIn);
	assert.deepEqual(blocked.retry, { disabled: 'Try again after about 12:05.' }); assert.ok(blocked.body.includes(webCopy.unavailable));
	assert.ok(!JSON.stringify(blocked).toLowerCase().includes('signed out'));
	assert.deepEqual(web({ kind: 'unverified', retrying: false, wait: wait(5_000) }, 5_000).retry, { disabled: null });
	assert.deepEqual(web({ kind: 'unverified', retrying: true, wait: null }).retry, { disabled: webCopy.unavailableRetrying });
	assert.deepEqual(web({ kind: 'releasing', reason: 'sign-out', local: 'deleted', server: 'revoking', wait: null, slow: false, closeAppWarning: false, canRetry: false }),
		{ heading: webCopy.signingOut, body: [], notices: [], signIn: false, retry: null });
	const failed = web({ kind: 'releasing', reason: 'sign-out', local: 'deleted', server: 'pending', wait: null, slow: false, closeAppWarning: false, canRetry: true });
	assert.equal(failed.heading, webCopy.signOutFailedHeading); assert.deepEqual(failed.retry, { disabled: null }); assert.ok(!failed.signIn);
	assert.ok(!JSON.stringify(failed).includes('ended'), 'a failed sign-out never says the session ended');
	assert.deepEqual(web({ kind: 'misconfigured' }).body, [webCopy.misconfigured]);
});

test('web welcome: the ?error= code picks its wording, an unknown code the fallback, and the code is never shown', () => {
	assert.equal(signInErrorText(undefined), null); assert.equal(signInErrorText(''), null);
	assert.equal(signInErrorText('google_failed'), 'Google did not complete the sign-in. Try again.');
	assert.equal(signInErrorText('request_invalid'), 'That sign-in link had expired. Start again.');
	for (const code of ['nope', 'canary-code-7f3a', ['google_failed'], 7]) {
		const text = signInErrorText(code);
		assert.equal(text, webCopy.errorFallback, String(code)); assert.ok(!String(text).includes('canary'));
	}
	const page = webWelcomePage(snap({ kind: 'signed-out', notice: null, gate: 'idle' }), { now: 0, error: 'passkey_failed' });
	assert.deepEqual(page.notices, [{ title: webCopy.errorTitle, text: 'The passkey could not be checked. Try again.' }]);
});

test('passkeys and invitations: a passkey line names its kind, when it was added and last used; refusals have their own lines', () => {
	const date = (iso: string) => `d(${iso})`;
	assert.equal(passkeyDetail({ backedUp: true, createdAt: 'a', lastUsedAt: 'b' }, date), 'synced passkey, added d(a), last used d(b)');
	assert.equal(passkeyDetail({ backedUp: false, createdAt: 'a', lastUsedAt: null }, date), 'this device only, added d(a), not used yet');
	assert.equal(invitationRefusalText('invitation_invalid'), 'This invitation is not open: it may have been used, withdrawn or expired.');
	assert.equal(invitationRefusalText('forbidden'), 'This invitation was sent to another address. Sign in with that address.');
	assert.equal(invitationRefusalText('canary_code'), 'Captain refused this invitation.');
});

test('threads shell: the filter row is All, Needs you, Tasks, Bookings, Stock, Records, Files, People; the empty state hides nothing', () => {
	assert.deepEqual([...threadsCopy.filters], ['All', 'Needs you', 'Tasks', 'Bookings', 'Stock', 'Records', 'Files', 'People']);
	assert.ok(/nothing is hidden/i.test(threadsCopy.emptyBody));
	assert.ok(!/\d/.test(JSON.stringify(threadsCopy)), 'no fixed wording contains a digit');
});
