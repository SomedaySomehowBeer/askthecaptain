import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outsideSnapshots } from './account-source.ts';
import { captureRequested, consumeRequested, requested, requestedConsumed, resetRequestedForTests } from './requested.ts';
import {
	copy, destinationStep, faultLines, findAccountStack, firstVisitParams, resetToFreshTabs, navigationStep, navMount, navStart, nextWake, releaseWording, requestedDestination, routeFor, routeHolds,
	signInNotices, snapshotWaits, tabEntryAction, tabsKey, welcomePage, moreTags, workCopy, workProblemText, type NavMemory, type Page
} from './copy.ts';
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
	scope: typeof org === 'string' ? null : { epoch: `a1.${org.organisationId}`, userId: user.id, organisationId: org.organisationId }
});
const wait = (until: number) => ({ until, about: '2030-01-01T12:05:00.000Z' });
const format = () => '12:05';
const page = (snapshot: AccountSnapshot, now = 0, webAvailable = true): Page => welcomePage(snapshot, { now, webAvailable, format });
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

test('routeFor: welcome unless signed in; the chooser until an organisation is chosen; Work when ready (also for the index)', () => {
	for (const s of everyState) assert.equal(routeFor(s.account), '/welcome', s.account.kind);
	for (const org of ['choose', 'none', 'loading'] as const) assert.equal(routeFor(signedIn(org)), '/organisation');
	assert.equal(routeFor(signedIn(orgA)), '/work');
});

test('routeHolds: the refusal page always holds; the chooser and index do not satisfy Work', () => {
	assert.ok(routeHolds('/welcome', '/link-not-allowed') && routeHolds('/work', '/link-not-allowed'));
	assert.ok(routeHolds('/work', '/chat/views') && routeHolds('/work', '/settings'));
	assert.ok(!routeHolds('/work', '/organisation') && !routeHolds('/work', '/welcome') && !routeHolds('/work', '/'));
	assert.ok(!routeHolds('/welcome', '/work') && !routeHolds('/organisation', '/work'));
});

test('tabs key and destination: keyed by person and organisation; the destination only when ready, once', () => {
	assert.equal(tabsKey(signedIn(orgA)), `${user.id}:${orgA.organisationId}`);
	assert.equal(tabsKey(signedIn('choose')), null);
	assert.equal(destinationStep(signedIn('choose'), null), null);
	const step = destinationStep(signedIn(orgA, '/chat/views'), null)!;
	assert.equal(step.href, '/chat/views');
	assert.equal(destinationStep(signedIn(orgA, '/chat/views'), step.key), null, 'applied once');
	assert.equal(requestedDestination('/work/views'), '/work/views');
	for (const path of ['/', '/welcome', '/settings', '/link-not-allowed', '/unknown', null]) assert.equal(requestedDestination(path), null, String(path));
});

function walk(steps: [AccountView, string][], requested: string | null = null, start: NavMemory = navStart): string[] {
	let memory: NavMemory = start; const actions: string[] = [];
	for (const [account, pathname] of steps) {
		const step = navigationStep(memory, account, pathname, requested); memory = step.memory;
		const action = step.action;
		actions.push('href' in action ? `${action.kind} ${action.href}` : action.kind);
	}
	return actions;
}

test('navigation: replace only when the answer changes; a deliberate chooser visit while ready stays put', () => {
	const signedOut = snap({ kind: 'signed-out', notice: null, gate: 'idle' }).account;
	assert.deepEqual(walk([
		[signedOut, '/welcome'], [signedIn('choose'), '/welcome'], [signedIn(orgA), '/organisation'],
		[signedIn(orgA), '/settings'], [signedIn(orgA), '/organisation'], [signedIn(orgA), '/organisation']
	]), ['none', 'replace /organisation', 'replace /work', 'none', 'none', 'none']);
	// The index route redirects itself; the stack does not replace `/` a second time.
	assert.deepEqual(walk([[signedOut, '/']]), ['none']);
	// A tab route reached while not ready goes to welcome.
	assert.deepEqual(walk([[signedOut, '/work']]), ['replace /welcome']);
});

test('navigation: a new organisation while ready resets the tabs (a switch, or a loss that auto-chose the one left); loss to the chooser replaces', () => {
	assert.deepEqual(walk([[signedIn(orgA), '/work'], [signedIn(orgB), '/organisation']]), ['none', 'reset-tabs'], 'switch from Account');
	assert.deepEqual(walk([[signedIn(orgA), '/chat/views'], [signedIn(orgB), '/chat/views']]), ['none', 'reset-tabs'], 'loss with one membership left: ready throughout');
	assert.deepEqual(walk([[signedIn(orgA), '/work'], [signedIn('choose'), '/work']]), ['none', 'replace /organisation']);
});

test('requested: captured once, only a linkable tab route; later captures change nothing', () => {
	resetRequestedForTests();
	captureRequested('/work/views'); captureRequested('/chat');
	assert.equal(requested(), '/work/views');
	resetRequestedForTests();
	captureRequested('/settings'); captureRequested('/chat');
	assert.equal(requested(), null, 'the first capture decides, even when it is not a tab route');
	assert.equal(requestedConsumed(), false);
	consumeRequested(); consumeRequested();
	assert.equal(requestedConsumed(), true);
	resetRequestedForTests();
	assert.equal(requestedConsumed(), false, 'reset for the next test');
});

/** One mount of AccountStack, as it runs: memory seeded from the process flag, the flag set once from each result. */
function mount(steps: [AccountView, string][]): string[] {
	let memory = navMount(requestedConsumed()); const actions: string[] = [];
	for (const [account, pathname] of steps) {
		const step = navigationStep(memory, account, pathname, requested()); memory = step.memory;
		if (step.memory.requestedUsed && !requestedConsumed()) consumeRequested();
		const action = step.action;
		actions.push('href' in action ? `${action.kind} ${action.href}` : action.kind);
	}
	return actions;
}

test('requested destination: one chance per process, not again after the stack remounts', () => {
	resetRequestedForTests();
	try {
		captureRequested('/work/views');
		const checking = snap({ kind: 'checking' }).account;
		assert.deepEqual(mount([[checking, '/welcome'], [signedIn(orgA), '/welcome']]), ['none', 'open-requested /work/views']);
		assert.equal(requestedConsumed(), true, 'the first ready consumed it');
		// The root layout remounts while ready (for example after history reaches a route the guards no longer allow).
		assert.deepEqual(mount([[signedIn(orgA), '/work']]), ['none'], 'a remount does not open it again');
		// A remount before ready, then ready: still not again.
		assert.deepEqual(mount([[checking, '/welcome'], [signedIn(orgA), '/welcome']]), ['none', 'replace /work']);
	} finally { resetRequestedForTests(); }
});

test('requested destination: consumed at the first ready even when a sign-in destination wins', () => {
	resetRequestedForTests();
	try {
		captureRequested('/work/views');
		const signedOut = snap({ kind: 'signed-out', notice: null, gate: 'idle' }).account;
		assert.deepEqual(mount([[signedOut, '/welcome'], [signedIn(orgA, '/chat'), '/welcome']]), ['none', 'destination /chat']);
		assert.equal(requestedConsumed(), true);
		assert.deepEqual(mount([[signedIn(orgA), '/chat']]), ['none'], 'no second cold-restore route after a remount');
		assert.deepEqual(walk([[signedIn(orgA), '/chat']], '/work/views', navMount(true)), ['none'], 'the pure step with the flag injected');
		assert.deepEqual(walk([[signedIn(orgA), '/chat']], '/work/views', navMount(false)), ['open-requested /work/views'], 'and without it');
	} finally { resetRequestedForTests(); }
});

test('findAccountStack: the account stack by its allowed (tabs) screen, using the real route names', () => {
	// As installed expo-router builds them: declared screens with guarded-off ones removed, then other route files.
	const readyNames = ['organisation', '(tabs)', 'settings', 'index', 'link-not-allowed', '+not-found'];
	const tabs = { key: 'tab-3', routeNames: ['work', 'chat', 'resources'], routes: [{ state: { key: 'work-stack', routeNames: ['index', 'views'], routes: [] } }] };
	const root = (names: string[]) => ({ key: 'root-1', routeNames: ['__root'], routes: [{ state: { key: 'stack-7', routeNames: names, routes: [{ state: tabs }] } }] });
	assert.equal(findAccountStack(root(readyNames)), 'stack-7');
	// Not ready: `(tabs)` is not allowed, and no other navigator (root slot, tabs, section stacks) is ever chosen.
	assert.equal(findAccountStack(root(['organisation', 'index', 'link-not-allowed', '+not-found'])), null);
	assert.equal(findAccountStack(root(['welcome', 'index', 'link-not-allowed', '+not-found'])), null);
	assert.equal(findAccountStack(undefined), null);
	assert.deepEqual(resetToFreshTabs('stack-7', false), { type: 'RESET', payload: { index: 0, routes: [{ name: '(tabs)' }] }, target: 'stack-7' }, 'web: unchanged');
});

/** Every `key` anywhere in a value, and every route `name`, walking objects and arrays. */
function collect(value: unknown, found: { keys: number; names: Set<string> } = { keys: 0, names: new Set() }) {
	if (Array.isArray(value)) { for (const item of value) collect(item, found); return found; }
	if (typeof value !== 'object' || value === null) return found;
	for (const [field, inner] of Object.entries(value)) {
		if (field === 'key') found.keys += 1;
		if (field === 'name' && typeof inner === 'string') found.names.add(inner);
		collect(inner, found);
	}
	return found;
}

test('native navigation: the seeded tabs reset gives Work [views, index] with My work focused, and no key at any depth', () => {
	const seeded = resetToFreshTabs('stack-7', true);
	assert.deepEqual(seeded, {
		type: 'RESET', target: 'stack-7',
		payload: { index: 0, routes: [{ name: '(tabs)', state: { index: 0, routes: [{ name: 'work', state: { index: 1, routes: [{ name: 'views' }, { name: 'index' }] } }] } }] }
	});
	const { keys, names } = collect(seeded.payload);
	assert.equal(keys, 0, 'no key: rehydration gives every route a fresh one, so nothing from the old tabs survives');
	assert.deepEqual([...names].sort(), ['(tabs)', 'index', 'views', 'work'], 'only declared route names');
	assert.equal(collect(resetToFreshTabs('stack-7', false).payload).keys, 0);
});

test('native navigation: a first tab visit names its default view; anchored stacks build [views, index] in one render, the web opens it alone', () => {
	assert.deepEqual(firstVisitParams(true), { screen: 'index', initial: false });
	assert.deepEqual(firstVisitParams(false), { screen: 'index' });
	assert.ok(!('initial' in firstVisitParams(false)), 'the web call is exactly the previous one');
});

test('native navigation: every app-initiated tab entry has one call; the web keeps exactly its previous calls', () => {
	// Arriving (becoming ready, a destination, the requested route, the fail-closed reopen, the index redirect).
	for (const href of ['/work', '/work/all', '/work/views', '/chat', '/resources/inventory']) {
		assert.deepEqual(tabEntryAction(true, { intent: 'arrive', href }), { method: 'replace', href, options: { withAnchor: true } }, href);
		assert.deepEqual(tabEntryAction(false, { intent: 'arrive', href }), { method: 'replace', href, options: {} }, href);
	}
	// The account's other routes are never anchored: they are not section stacks.
	for (const href of ['/welcome', '/organisation', '/settings', '/link-not-allowed', '/workshop', '/']) {
		assert.deepEqual(tabEntryAction(true, { intent: 'arrive', href }), { method: 'replace', href, options: {} }, href);
	}
	// "Go to My work" and Back fallbacks: always /work, never back(); native returns to the existing tabs.
	assert.deepEqual(tabEntryAction(true, { intent: 'return-to-my-work' }), { method: 'dismissTo', href: '/work', options: { withAnchor: true } });
	assert.deepEqual(tabEntryAction(false, { intent: 'return-to-my-work' }), { method: 'replace', href: '/work', options: {} });
});

test('native navigation pin: within a mount started at process boot, route changes happen only on the first ready or after a not-ready snapshot', () => {
	resetRequestedForTests();
	try {
		captureRequested('/work/all');
		const checking = snap({ kind: 'checking' }).account;
		const signedOut = snap({ kind: 'signed-out', notice: null, gate: 'idle' }).account;
		const sequence: [AccountView, string][] = [
			[checking, '/welcome'], [signedIn('choose'), '/welcome'], [signedIn(orgA), '/organisation'], [signedIn(orgA), '/work/all'],
			[signedIn(orgA), '/settings'], [signedIn(orgA), '/organisation'], [signedIn(orgB), '/organisation'], [signedIn(orgB), '/work'],
			[signedIn('choose'), '/work'], [signedIn(orgA), '/organisation'], [signedOut, '/work'], [signedIn(orgB, '/chat'), '/welcome'],
			[signedIn(orgB, '/chat'), '/chat']
		];
		let memory = navMount(requestedConsumed()); let previousReady = false; let firstReadySeen = false;
		for (const [account, pathname] of sequence) {
			const step = navigationStep(memory, account, pathname, requested()); memory = step.memory;
			if (step.memory.requestedUsed && !requestedConsumed()) consumeRequested();
			const ready = routeFor(account) === '/work';
			const changesRoute = step.action.kind === 'replace' || step.action.kind === 'destination' || step.action.kind === 'open-requested';
			if (changesRoute && ready) assert.ok(!previousReady || !firstReadySeen, `${step.action.kind} at ${pathname} follows a not-ready snapshot or is this mount's first ready`);
			if (ready) firstReadySeen = true;
			previousReady = ready;
		}
	} finally { resetRequestedForTests(); }
});

test('native navigation pin: a mount started while ready changes nothing except on the organisation page (L2, unchanged)', () => {
	resetRequestedForTests();
	try {
		captureRequested('/work/all'); consumeRequested();
		for (const pathname of ['/work', '/work/all', '/work/views', '/chat', '/resources/inventory', '/settings', '/', '/link-not-allowed']) {
			assert.deepEqual(mount([[signedIn(orgA), pathname]]), ['none'], pathname);
		}
		// The recorded limitation: a remount while ready on Switch organisation replaces it with Work (a second tabs route
		// when the navigation state was retained). Pinned so that any change to it is deliberate.
		assert.deepEqual(mount([[signedIn(orgA), '/organisation']]), ['replace /work']);
	} finally { resetRequestedForTests(); }
});

test('navigation: a tabs reset is only ever issued while ready (a reset while not ready would be silently ignored)', () => {
	const views: AccountView[] = [signedIn(orgA), signedIn(orgB), signedIn('choose'), signedIn(orgA), snap({ kind: 'checking' }).account, signedIn(orgB)];
	let memory: NavMemory = navStart; let resets = 0;
	for (const account of views) {
		const step = navigationStep(memory, account, '/work'); memory = step.memory;
		if (step.action.kind === 'reset-tabs') { resets += 1; assert.equal(routeFor(account), '/work', 'ready'); }
	}
	assert.equal(resets, 1, 'only the in-place change A → B; passing through a not-ready state lets the guard drop the tabs');
});

test('navigation: the tab route the app was opened at is opened once when a saved session becomes ready', () => {
	const checking = snap({ kind: 'checking' }).account;
	const signedOut = snap({ kind: 'signed-out', notice: null, gate: 'idle' }).account;
	assert.deepEqual(walk([[checking, '/welcome'], [signedIn(orgA), '/welcome'], [signedIn(orgA), '/work/views']], '/work/views'),
		['none', 'open-requested /work/views', 'none']);
	assert.deepEqual(walk([[checking, '/welcome'], [signedIn('choose'), '/welcome'], [signedIn(orgA), '/organisation']], '/work/views'),
		['none', 'replace /organisation', 'open-requested /work/views'], 'also after the chooser');
	assert.deepEqual(walk([[signedIn(orgA), '/work/views']], '/work/views'), ['none'], 'already there');
	assert.deepEqual(walk([[signedIn(orgA), '/work'], [signedOut, '/work'], [signedIn(orgA), '/welcome']], '/work/views'),
		['open-requested /work/views', 'replace /welcome', 'replace /work'], 'once per process: not again after a later sign-in');
	assert.deepEqual(walk([[checking, '/welcome'], [signedIn(orgA, '/chat'), '/welcome']], '/work/views'),
		['none', 'destination /chat'], "a sign-in destination wins and consumes the request");
});

test('navigation: the destination is applied once, and anew after leaving ready (same person, organisation and destination)', () => {
	const signedOut = snap({ kind: 'signed-out', notice: null, gate: 'idle' }).account;
	assert.deepEqual(walk([
		[signedIn(orgA, '/chat/views'), '/organisation'], [signedIn(orgA, '/chat/views'), '/chat/views'], [signedIn(orgA), '/chat/views'],
		[signedOut, '/chat/views'], [signedIn(orgA, '/chat/views'), '/welcome']
	]), ['destination /chat/views', 'none', 'none', 'replace /welcome', 'destination /chat/views']);
});

test('copy: every state has a heading; no wording states an expiry date or infers from the phone clock', () => {
	for (const s of everyState) {
		const p = page(s);
		assert.ok(p.heading.length > 0, s.account.kind);
		assert.ok(!/expire|expiry|until \d|valid until/i.test(text(p).replace(copy.signInAgainNote, '')), `${s.account.kind}: ${text(p)}`);
		assert.ok(!/signed in\b/i.test(p.heading), 'never "signed in" before verification');
	}
});

test('copy: web-only offers the website only when its address is valid; misconfigured repeats no value', () => {
	assert.deepEqual(page(outsideSnapshots.webOnly).actions, [{ kind: 'web', id: 'web', label: copy.openWeb, path: '/' }]);
	const missing = page(outsideSnapshots.webOnly, 0, false);
	assert.deepEqual(missing.actions, []);
	assert.ok(missing.body.includes(copy.webMissing));
	assert.deepEqual(page(outsideSnapshots.misconfigured).body, [copy.misconfigured]);
	assert.deepEqual(page(outsideSnapshots.startupFailed).body, [copy.startupFailed]);
	assert.deepEqual(page(outsideSnapshots.startingSlow).body, [copy.openingSlow]);
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
	const withReturn = welcomePage(snap({ kind: 'signed-out', notice: null, gate: 'idle' }, { signInOffered: true }), { now: 0, webAvailable: true, returnTo: '/chat' });
	assert.deepEqual(withReturn.actions[0]!.kind === 'command' && withReturn.actions[0]!.command, { type: 'sign-in', returnTo: '/chat' });
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

test('My work wording: failures by operation, refusals by kind, no access check claimed, no empty claim', () => {
	assert.equal(workProblemText({ op: 'first', kind: 'unavailable' }), "Couldn't load your work");
	assert.equal(workProblemText({ op: 'refresh', kind: 'unavailable' }), "Couldn't refresh. This list may be out of date.");
	assert.equal(workProblemText({ op: 'more', kind: 'unavailable' }), "Couldn't load more");
	for (const op of ['first', 'refresh', 'more'] as const) {
		assert.equal(workProblemText({ op, kind: 'access' }), workCopy.access);
		assert.equal(workProblemText({ op, kind: 'list' }), "Captain couldn't read this list.");
	}
	for (const text of Object.values(workCopy)) assert.ok(!/being checked|checking your access|no longer have access/i.test(text), text);
	assert.equal(workCopy.subtitle, 'Open tasks assigned to you');
	assert.ok(!/\d/.test(workCopy.capNotice), 'the cap notice names no number');
	assert.equal(moreTags(5, 3), '+2 more'); assert.equal(moreTags(3, 3), null); assert.equal(moreTags(0, 0), null);
});
