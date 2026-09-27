import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holds, initial, personScope, reduce, view, type CredentialHandle, type Effect, type Event, type Machine } from './machine.ts';
import type { Me } from './me.ts';

const h = (n: number) => n as CredentialHandle;
const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const orgA = 'c0ffee00-1234-4abc-9def-0123456789ab';
const orgB = 'd00dfeed-5678-4def-8abc-ba9876543210';
const orgC = 'feedface-9999-4aaa-8bbb-cccccccccccc';
const me = (...organisations: string[]): Me => ({
	user: { id: userId, email: 'owner@example.test', name: 'Owner' }, passkeyVerified: true,
	memberships: organisations.map((organisationId) => ({ organisationId, organisationName: organisationId.slice(0, 4), role: 'owner' as const }))
});

/** Applies events in order; returns the final machine and every effect produced. */
function run(machine: Machine, ...events: Event[]): { machine: Machine; effects: Effect[] } {
	let current = machine; const effects: Effect[] = [];
	for (const event of events) {
		const step = reduce(current, event); current = step.machine; effects.push(...step.effects);
		// Every machine, effect and view in every scenario of this file is token-free.
		const text = JSON.stringify([step.machine, step.effects, view(step.machine)]);
		assert.ok(!text.includes('sess_'), 'a token reached the machine');
	}
	return { machine: current, effects };
}
/** A server wait of 60 s, measured from monotonic 0 (the wall-clock `about` is for wording only). */
const wait60 = { until: 60_000, about: '2030-01-01T00:01:00.000Z' };
const ofType =<T extends Effect['type']>(effects: readonly Effect[], type: T) => effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
const kind = (machine: Machine) => view(machine).account.kind;

/** Launch with a stored session (handle 1) whose /v1/me answers with these organisations. */
function launched(...organisations: string[]) {
	const read = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'session', handle: h(1), userId } });
	return run(read.machine, { type: 'me-finished', handle: h(1), membership: read.machine.generations.membership, outcome: { kind: 'ok', me: me(...organisations) } });
}
/** Signed in with organisation A chosen from the stored hint, among the given organisations. */
function chosenA(...organisations: string[]) {
	const signed = launched(...organisations);
	return run(signed.machine, { type: 'org-read', handle: h(1), organisation: signed.machine.generations.organisation, organisationId: orgA }).machine;
}

test('a saved session is only checking until /v1/me answers; unavailable is unverified, never signed in, and Try again respects Retry-After', () => {
	const read = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'session', handle: h(1), userId } });
	assert.equal(kind(read.machine), 'checking');
	assert.deepEqual(ofType(read.effects, 'load-me'), [{ type: 'load-me', handle: h(1), membership: 1 }]);
	const unverified = run(read.machine, { type: 'me-finished', handle: h(1), membership: 1, outcome: { kind: 'unavailable', wait: wait60 } }).machine;
	assert.deepEqual(view(unverified).account, { kind: 'unverified', retrying: false, wait: wait60 });
	assert.equal(view(unverified).signInOffered, false, 'sign-in waits: the saved session is still held');
	assert.deepEqual(run(unverified, { type: 'retry', now: 59_999 }).effects, [], 'no early Try again');
	const again = run(unverified, { type: 'retry', now: 60_000 });
	assert.deepEqual(ofType(again.effects, 'load-me'), [{ type: 'load-me', handle: h(1), membership: 2 }]);
	// The first answer arriving late changes nothing; the current one decides.
	assert.equal(run(again.machine, { type: 'me-finished', handle: h(1), membership: 1, outcome: { kind: 'ok', me: me(orgA) } }).machine, again.machine);
	assert.equal(kind(run(again.machine, { type: 'me-finished', handle: h(1), membership: 2, outcome: { kind: 'ok', me: me(orgA) } }).machine), 'signed-in');
	// Sign out is available from unverified.
	const out = run(unverified, { type: 'sign-out' });
	assert.equal(kind(out.machine), 'releasing');
	assert.deepEqual(out.effects.filter((e) => e.type === 'remove-if' || e.type === 'revoke').map((e) => e.type), ['remove-if', 'revoke']);
});

test('the destination waits for verified identity and a chosen organisation, and only an app route is kept', () => {
	const out = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'none' } });
	const started = run(out.machine, { type: 'sign-in', returnTo: '/chat' }, { type: 'gate-checked', result: 'settled' });
	assert.deepEqual(ofType(started.effects, 'start-attempt'), [{ type: 'start-attempt', returnTo: '/chat' }]);
	const signed = run(started.machine, { type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo: '/chat' } });
	const install = ofType(signed.effects, 'install')[0]!;
	assert.equal(install.generation.account, 1, 'the account changes before the save is queued');
	const written = run(signed.machine, { type: 'install-finished', handle: h(2), result: 'written', now: 0 });
	assert.equal(kind(written.machine), 'checking');
	const verified = run(written.machine, { type: 'me-finished', handle: h(2), membership: written.machine.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB) } });
	const loading = view(verified.machine).account;
	assert.ok(loading.kind === 'signed-in' && !loading.ready && loading.destination === null, 'no destination before a choice');
	const chosen = run(verified.machine, { type: 'org-read', handle: h(2), organisation: verified.machine.generations.organisation, organisationId: orgB }).machine;
	const ready = view(chosen).account;
	assert.ok(ready.kind === 'signed-in' && ready.ready && ready.destination === '/chat');
	const used = view(run(chosen, { type: 'destination-used' }).machine).account;
	assert.ok(used.kind === 'signed-in' && used.destination === null);
	// An unsafe or unknown destination is dropped.
	for (const returnTo of ['//evil.test', '/unknown', 'https://evil.test/work']) {
		const other = run(started.machine, { type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo } }).machine;
		assert.equal(other.returnTo, null, returnTo);
	}
});

test('a single membership is chosen and saved; none leaves no organisation; a stored choice that is not a membership is forgotten', () => {
	const one = launched(orgA);
	const single = run(one.machine, { type: 'org-read', handle: h(1), organisation: one.machine.generations.organisation, organisationId: null });
	assert.ok(ofType(single.effects, 'set-org').length === 1);
	const account = view(single.machine).account;
	assert.ok(account.kind === 'signed-in' && account.org.kind === 'chosen');
	const none = launched();
	const noneView = view(none.machine).account;
	assert.ok(noneView.kind === 'signed-in' && noneView.org.kind === 'none' && !noneView.ready);
	assert.deepEqual(ofType(none.effects, 'read-org'), [], 'nothing to choose from');
	const two = launched(orgA, orgB);
	const stale = run(two.machine, { type: 'org-read', handle: h(1), organisation: two.machine.generations.organisation, organisationId: orgC });
	assert.deepEqual(ofType(stale.effects, 'forget-org-if'), [{ type: 'forget-org-if', userId, organisationId: orgC }]);
	const chooser = view(stale.machine).account;
	assert.ok(chooser.kind === 'signed-in' && chooser.org.kind === 'choose' && !chooser.ready);
});

test('a 403/404 only asks for a fresh membership list; only that list removes the organisation', () => {
	const signed = chosenA(orgA, orgB, orgC);
	const organisation = signed.generations.organisation;
	// 30 s after the launch check (the refusal spacing, docs/plans/expo-mobile-my-work-read-2026-09.md §3.2).
	const refused = run(signed, { type: 'org-refused', handle: h(1), organisation, now: 30_000 });
	assert.deepEqual(refused.effects.map((e) => e.type), ['load-me'], 'nothing removed or forgotten on the refusal itself');
	assert.deepEqual(run(refused.machine, { type: 'org-refused', handle: h(1), organisation, now: 90_000 }).effects, [], 'a second refusal joins the refresh');
	const membership = refused.machine.generations.membership;
	const kept = run(refused.machine, { type: 'me-finished', handle: h(1), membership, outcome: { kind: 'ok', me: me(orgA, orgB) } });
	const keptView = view(kept.machine).account;
	assert.ok(keptView.kind === 'signed-in' && keptView.org.kind === 'chosen' && keptView.org.membership.organisationId === orgA);
	assert.deepEqual(ofType(kept.effects, 'forget-org-if'), []);
	// An unavailable refresh never removes it either.
	const quiet = run(refused.machine, { type: 'me-finished', handle: h(1), membership, outcome: { kind: 'unavailable', wait: null } });
	const quietView = view(quiet.machine).account;
	assert.ok(quietView.kind === 'signed-in' && quietView.org.kind === 'chosen' && !quietView.refreshing);
	// A fresh list without it does.
	const lost = run(refused.machine, { type: 'me-finished', handle: h(1), membership, outcome: { kind: 'ok', me: me(orgB, orgC) } });
	assert.deepEqual(ofType(lost.effects, 'forget-org-if'), [{ type: 'forget-org-if', userId, organisationId: orgA }]);
	const lostView = view(lost.machine).account;
	assert.ok(lostView.kind === 'signed-in' && lostView.org.kind === 'choose' && !lostView.ready);
	assert.equal(lost.machine.generations.organisation, organisation + 1);
	// A refusal from before an organisation change is ignored.
	assert.deepEqual(run(lost.machine, { type: 'org-refused', handle: h(1), organisation, now: 0 }).effects, []);
});

test('a slow save of an older organisation choice is stale; a failed current save is reported, not blocking', () => {
	const signed = chosenA(orgA, orgB);
	const first = run(signed, { type: 'choose-organisation', organisationId: orgB });
	const firstSave = ofType(first.effects, 'set-org')[0]!;
	const second = run(first.machine, { type: 'choose-organisation', organisationId: orgA });
	const secondSave = ofType(second.effects, 'set-org')[0]!;
	assert.ok(secondSave.generation.organisation > firstSave.generation.organisation);
	const late = run(second.machine, { type: 'org-saved', handle: h(1), organisation: firstSave.generation.organisation, result: 'failed' });
	assert.equal(late.machine, second.machine);
	const failed = view(run(second.machine, { type: 'org-saved', handle: h(1), organisation: secondSave.generation.organisation, result: 'failed' }).machine).account;
	assert.ok(failed.kind === 'signed-in' && failed.ready && failed.notice?.kind === 'organisation-not-remembered');
});

test('a 401 for the current session ends it without revocation; a late 401 for another handle changes nothing', () => {
	const signed = chosenA(orgA);
	assert.equal(run(signed, { type: 'unauthorised', handle: h(9) }).machine, signed);
	const ended = run(signed, { type: 'unauthorised', handle: h(1) });
	assert.deepEqual(ended.effects.filter((e) => e.type === 'remove-if' || e.type === 'revoke'), [{ type: 'remove-if', handle: h(1) }]);
	const done = run(ended.machine, { type: 'local-finished', handle: h(1), result: 'no-usable-copy' });
	assert.deepEqual(ofType(done.effects, 'release'), [{ type: 'release', handle: h(1) }]);
	assert.deepEqual(view(done.machine).account, {
		kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'session-ended', local: 'no-usable-copy', server: 'not-needed' }
	});
	assert.equal(view(done.machine).signInOffered, true);
});

test('a failed save is compare-deleted and revoked, and sign-in stays blocked until the handle is released', () => {
	const out = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'none' } });
	const saving = run(out.machine, { type: 'sign-in' }, { type: 'gate-checked', result: 'settled' },
		{ type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo: '/' } }).machine;
	const failed = run(saving, { type: 'install-finished', handle: h(2), result: 'failed', now: 0 });
	assert.deepEqual(failed.effects.filter((e) => e.type === 'remove-if' || e.type === 'revoke'), [{ type: 'remove-if', handle: h(2) }, { type: 'revoke', handle: h(2) }]);
	const pending = run(failed.machine, { type: 'local-finished', handle: h(2), result: 'deleted' },
		{ type: 'server-finished', handle: h(2), result: 'pending', wait: { until: 5_000, about: '2030-01-01T00:00:05.000Z' } }).machine;
	const pendingView = view(pending);
	assert.ok(pendingView.account.kind === 'releasing' && pendingView.account.canRetry && !pendingView.account.closeAppWarning);
	assert.equal(pendingView.signInOffered, false);
	assert.deepEqual(run(pending, { type: 'sign-in' }).effects, [], 'blocked until released');
	assert.deepEqual(run(pending, { type: 'retry', now: 4_999 }).effects, [], "no Try again before the revocation's server wait");
	const retried = run(pending, { type: 'retry', now: 5_000 });
	assert.deepEqual(retried.effects, [{ type: 'retry-release', handle: h(2), local: false, server: true }]);
	const released = run(retried.machine, { type: 'server-finished', handle: h(2), result: 'ended', wait: null });
	assert.deepEqual(ofType(released.effects, 'release'), [{ type: 'release', handle: h(2) }]);
	assert.deepEqual(view(released.machine).account, {
		kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'save-failed', local: 'deleted', server: 'ended' }
	});
	// A duplicate completion is ignored: no second release.
	assert.deepEqual(run(released.machine, { type: 'server-finished', handle: h(2), result: 'ended', wait: null }).effects, []);
	// A stale save is released the same way.
	assert.equal(kind(run(saving, { type: 'install-finished', handle: h(2), result: 'stale', now: 0 }).machine), 'releasing');
});

test('sign-out with a copy that may remain and a revocation pending warns about closing the app; Try again retries both', () => {
	const signed = chosenA(orgA);
	const out = run(signed, { type: 'sign-out' },
		{ type: 'local-finished', handle: h(1), result: 'copy-may-remain' },
		{ type: 'server-finished', handle: h(1), result: 'pending', wait: null });
	const warned = view(out.machine).account;
	assert.ok(warned.kind === 'releasing' && warned.closeAppWarning && warned.canRetry && warned.reason === 'sign-out');
	assert.ok(out.machine.generations.account > signed.generations.account);
	const retried = run(out.machine, { type: 'retry', now: 0 });
	assert.deepEqual(ofType(retried.effects, 'retry-release'), [{ type: 'retry-release', handle: h(1), local: true, server: true }]);
	assert.deepEqual(run(retried.machine, { type: 'retry', now: 0 }).effects, [], 'no second press while the first runs');
	const done = run(retried.machine, { type: 'local-finished', handle: h(1), result: 'deleted' }, { type: 'server-finished', handle: h(1), result: 'ended', wait: null });
	assert.deepEqual(view(done.machine).account, {
		kind: 'signed-out', gate: 'idle', notice: { kind: 'released', reason: 'sign-out', local: 'deleted', server: 'ended' }
	});
	// A session already ended with a copy that may remain is released at once (the copy no longer works).
	const endedCopy = run(signed, { type: 'sign-out' }, { type: 'server-finished', handle: h(1), result: 'ended', wait: null },
		{ type: 'local-finished', handle: h(1), result: 'copy-may-remain' });
	assert.deepEqual(ofType(endedCopy.effects, 'release'), [{ type: 'release', handle: h(1) }]);
});

test('unreadable storage offers Try reading again first; a deliberate sign-in may replace it; unavailable storage offers nothing', () => {
	const unreadable = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'unreadable' } }).machine;
	assert.equal(view(unreadable).signInOffered, true);
	const reread = run(unreadable, { type: 'retry', now: 0 });
	assert.deepEqual(ofType(reread.effects, 'read-stored'), [{ type: 'read-stored' }]);
	assert.equal(view(reread.machine).signInOffered, false, 'not while reading again');
	assert.deepEqual(ofType(run(unreadable, { type: 'sign-in' }).effects, 'wait-settled'), [{ type: 'wait-settled' }]);
	const unavailable = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'unavailable' } }).machine;
	assert.equal(view(unavailable).signInOffered, false);
	assert.deepEqual(run(unavailable, { type: 'sign-in' }).effects, []);
});

test('the gate: a blocked or slow settle leaves sign-in busy with Try again, and starts no attempt', () => {
	const out = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'none' } }).machine;
	for (const result of ['timed-out', 'blocked'] as const) {
		const busy = run(out, { type: 'sign-in' }, { type: 'gate-checked', result });
		assert.deepEqual(ofType(busy.effects, 'start-attempt'), []);
		assert.deepEqual(view(busy.machine).account, { kind: 'signed-out', notice: null, gate: 'busy' });
		assert.deepEqual(ofType(run(busy.machine, { type: 'retry', now: 0 }).effects, 'wait-settled'), [{ type: 'wait-settled' }]);
	}
	assert.deepEqual(run(out, { type: 'sign-in' }, { type: 'sign-in' }).effects.filter((e) => e.type === 'wait-settled').length, 1, 'one gate check at a time');
});

test('a second live credential (a sign-in result outside signing-in) is kept, released to the end, and reported as a fault', () => {
	const signed = chosenA(orgA);
	const second = run(signed, { type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo: '/' } });
	assert.deepEqual(second.effects, [{ type: 'remove-if', handle: h(2) }, { type: 'revoke', handle: h(2) }]);
	assert.equal(second.machine.fault, true);
	assert.ok(holds(second.machine, h(1)) && holds(second.machine, h(2)), 'both are kept');
	const current = view(second.machine);
	assert.ok(current.account.kind === 'signed-in' && current.account.ready, 'the current session is untouched');
	assert.equal(current.strays.length, 1);
	const pending = run(second.machine, { type: 'local-finished', handle: h(2), result: 'copy-may-remain' }, { type: 'server-finished', handle: h(2), result: 'pending', wait: null });
	assert.ok(view(pending.machine).strays[0]!.closeAppWarning && view(pending.machine).strays[0]!.canRetry);
	const retried = run(pending.machine, { type: 'retry', now: 0 });
	assert.deepEqual(ofType(retried.effects, 'retry-release'), [{ type: 'retry-release', handle: h(2), local: true, server: true }]);
	const done = run(retried.machine, { type: 'local-finished', handle: h(2), result: 'deleted' }, { type: 'server-finished', handle: h(2), result: 'ended', wait: null });
	assert.deepEqual(ofType(done.effects, 'release'), [{ type: 'release', handle: h(2) }]);
	assert.deepEqual(done.machine.strays, []);
	assert.ok(holds(done.machine, h(1)) && !holds(done.machine, h(2)));
	// A signed-out machine with a stray offers no sign-in until the stray is released.
	const out = run(signed, { type: 'unauthorised', handle: h(1) }, { type: 'local-finished', handle: h(1), result: 'deleted' }, { type: 'unclaimed', handle: h(3) });
	assert.equal(view(out.machine).signInOffered, false);
	assert.deepEqual(run(out.machine, { type: 'sign-in' }).effects, []);
	assert.deepEqual(run(out.machine, { type: 'unclaimed', handle: h(3) }).effects, [], 'already held: nothing twice');
});

test('a refused revocation (the cleanup slot held another session) is retried only deliberately and never counted as ended by accident', () => {
	const signed = chosenA(orgA);
	const refused = run(signed, { type: 'sign-out' }, { type: 'local-finished', handle: h(1), result: 'deleted' },
		{ type: 'server-finished', handle: h(1), result: 'refused', wait: null });
	const refusedView = view(refused.machine);
	assert.ok(refusedView.account.kind === 'releasing' && refusedView.account.server === 'refused' && refusedView.account.canRetry);
	assert.equal(refusedView.signInOffered, false, 'the handle is kept and the gate stays closed');
	const again = run(refused.machine, { type: 'retry', now: 0 });
	assert.deepEqual(again.effects, [{ type: 'retry-release', handle: h(1), local: false, server: true }]);
	const stillRefused = run(again.machine, { type: 'server-finished', handle: h(1), result: 'refused', wait: null });
	assert.equal(kind(stillRefused.machine), 'releasing');
	assert.deepEqual(ofType(stillRefused.effects, 'release'), []);
	const ended = run(run(stillRefused.machine, { type: 'retry', now: 0 }).machine, { type: 'server-finished', handle: h(1), result: 'ended', wait: null });
	assert.deepEqual(ofType(ended.effects, 'release'), [{ type: 'release', handle: h(1) }]);
});

test('pacing: a later, shorter server wait never moves the deadline earlier, even from an answer no longer current', () => {
	const signed = chosenA(orgA, orgB);
	const first = run(signed, { type: 'refresh', now: 30_000 });
	const membership = first.machine.generations.membership;
	const long = run(first.machine, { type: 'me-finished', handle: h(1), membership, outcome: { kind: 'unavailable', wait: { until: 120_000, about: 'x' } } }).machine;
	assert.equal(long.pacing.serverNotBefore?.until, 120_000);
	const shorter = run(long, { type: 'me-finished', handle: h(1), membership: membership - 1, outcome: { kind: 'unavailable', wait: { until: 40_000, about: 'y' } } }).machine;
	assert.equal(shorter.pacing.serverNotBefore?.until, 120_000, 'a shorter wait does not replace a longer one');
	const later = run(long, { type: 'me-finished', handle: h(1), membership: membership - 1, outcome: { kind: 'unavailable', wait: { until: 150_000, about: 'z' } } }).machine;
	assert.equal(later.pacing.serverNotBefore?.until, 150_000, 'a stale answer can still only lengthen the wait');
	for (const event of [{ type: 'refresh', now: 119_999 }, { type: 'org-refused', handle: h(1), organisation: long.generations.organisation, now: 119_999 }] as Event[]) {
		assert.deepEqual(ofType(run(long, event).effects, 'load-me'), [], event.type);
	}
	for (const event of [{ type: 'refresh', now: 120_000 }, { type: 'org-refused', handle: h(1), organisation: long.generations.organisation, now: 120_000 }] as Event[]) {
		assert.equal(ofType(run(long, event).effects, 'load-me').length, 1, event.type);
	}
});

test('pacing: a refusal waits 30 s after the latest /v1/me load of any kind (the launch check here), exactly at the boundary, and is coalesced', () => {
	const signed = chosenA(orgA, orgB);
	const organisation = signed.generations.organisation;
	for (const now of [0, 1, 29_999]) {
		const early = run(signed, { type: 'org-refused', handle: h(1), organisation, now });
		assert.deepEqual(early.effects, [], `${now} ms after the launch check: nothing sent`);
		assert.equal(early.machine, signed, 'and nothing recorded to retry');
	}
	const refused = run(signed, { type: 'org-refused', handle: h(1), organisation, now: 30_000 });
	assert.equal(ofType(refused.effects, 'load-me').length, 1, 'at exactly 30 s: one load');
	assert.equal(refused.machine.pacing.lastLoadStarted, 30_000, 'the refusal load starts the spacing again');
	assert.deepEqual(run(refused.machine, { type: 'refresh', now: 90_000 }).effects, [], 'a refresh joins the refusal already in flight');
	assert.deepEqual(run(refused.machine, { type: 'org-refused', handle: h(1), organisation, now: 90_000 }).effects, [], 'so does another refusal');
	// After that load answers, the next refusal is spaced from it, not from the launch.
	const answered = run(refused.machine, { type: 'me-finished', handle: h(1), membership: refused.machine.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB) } }).machine;
	assert.deepEqual(run(answered, { type: 'org-refused', handle: h(1), organisation, now: 59_999 }).effects, []);
	assert.equal(ofType(run(answered, { type: 'org-refused', handle: h(1), organisation, now: 60_000 }).effects, 'load-me').length, 1);
});

test('pacing: a refusal within 30 s of a person\'s Try again sends nothing; Try again and the post-sign-in check are still not spaced', () => {
	// Launch unavailable with no server wait: Try again is allowed at once (not spaced), and it starts the spacing.
	const read = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'session', handle: h(1), userId } });
	const unverified = run(read.machine, { type: 'me-finished', handle: h(1), membership: 1, outcome: { kind: 'unavailable', wait: null } }).machine;
	const retried = run(unverified, { type: 'retry', now: 1 });
	assert.equal(ofType(retried.effects, 'load-me').length, 1, 'Try again 1 ms after the launch check is sent: explicit, not spaced');
	const verified = run(retried.machine, { type: 'me-finished', handle: h(1), membership: retried.machine.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB) } }).machine;
	const chosen = run(verified, { type: 'org-read', handle: h(1), organisation: verified.generations.organisation, organisationId: orgA }).machine;
	const organisation = chosen.generations.organisation;
	assert.deepEqual(run(chosen, { type: 'org-refused', handle: h(1), organisation, now: 10_001 }).effects, [], '10 s after Try again: nothing');
	assert.equal(ofType(run(chosen, { type: 'org-refused', handle: h(1), organisation, now: 30_001 }).effects, 'load-me').length, 1);
	// A sign-in's first check right after another load is not spaced either (only a server wait holds it).
	const out = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'none' } });
	const signing = run(out.machine, { type: 'sign-in' }, { type: 'gate-checked', result: 'settled' },
		{ type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo: '/' } });
	const withRecentLoad: Machine = { ...signing.machine, pacing: { ...signing.machine.pacing, lastLoadStarted: 5 } };
	const written = run(withRecentLoad, { type: 'install-finished', handle: h(2), result: 'written', now: 6 });
	assert.equal(ofType(written.effects, 'load-me').length, 1, 'the post-sign-in check 1 ms after another load is sent');
});

// ---------------------------------------------------------------------------------------------------------------
// Read scope (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1).

const scopeOf = (machine: Machine) => { const account = view(machine).account; return account.kind === 'signed-in' ? account.scope : null; };

test('read scope: present exactly when ready, token-free, from the verified user and the chosen organisation', () => {
	const read = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'session', handle: h(1), userId } });
	assert.equal(view(read.machine).account.kind, 'checking', 'checking: no scope in the view at all');
	const loading = launched(orgA, orgB).machine;
	assert.equal(scopeOf(loading), null, 'identity verified but no organisation chosen yet');
	assert.equal(scopeOf(launched().machine), null, 'no memberships: never ready');
	const chosen = chosenA(orgA, orgB);
	const scope = scopeOf(chosen)!;
	assert.equal(scope.userId, userId); assert.equal(scope.organisationId, orgA);
	assert.equal(typeof scope.epoch, 'string'); assert.ok(scope.epoch.length > 0);
	assert.deepEqual(Object.keys(scope).sort(), ['epoch', 'organisationId', 'userId'], 'nothing else: no handle, token or storage key');
	assert.ok(Object.isFrozen(scope));
	const out = run(chosen, { type: 'sign-out' }).machine;
	assert.equal(view(out).account.kind, 'releasing', 'releasing: no scope in the view');
});

test('read scope: the epoch survives a membership refresh that keeps the organisation, and other non-scope changes', () => {
	const chosen = chosenA(orgA, orgB);
	const epoch = scopeOf(chosen)!.epoch;
	const refreshing = run(chosen, { type: 'refresh', now: 30_000 }).machine;
	assert.equal(scopeOf(refreshing)!.epoch, epoch, 'refreshing: same epoch');
	const kept = run(refreshing, { type: 'me-finished', handle: h(1), membership: refreshing.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB, orgC) } }).machine;
	assert.equal(scopeOf(kept)!.epoch, epoch, 'a new membership list that keeps the organisation: same epoch');
	assert.notEqual(kept.generations.membership, chosen.generations.membership, 'even though the membership generation moved');
	const unavailable = run(run(kept, { type: 'refresh', now: 60_000 }).machine, { type: 'me-finished', handle: h(1), membership: kept.generations.membership + 1, outcome: { kind: 'unavailable', wait: null } }).machine;
	assert.equal(scopeOf(unavailable)!.epoch, epoch, 'an unavailable refresh: same epoch');
	const refused = run(kept, { type: 'org-refused', handle: h(1), organisation: kept.generations.organisation, now: 90_000 }).machine;
	assert.equal(scopeOf(refused)!.epoch, epoch, 'a refusal alone changes nothing about the scope');
});

test('read scope: a switch, a loss that auto-chooses, and a new session each give a new epoch; A → B → A never repeats one', () => {
	const chosen = chosenA(orgA, orgB);
	const a1 = scopeOf(chosen)!;
	const toB = run(chosen, { type: 'choose-organisation', organisationId: orgB }).machine;
	const b = scopeOf(toB)!;
	const backToA = run(toB, { type: 'choose-organisation', organisationId: orgA }).machine;
	const a2 = scopeOf(backToA)!;
	assert.equal(b.organisationId, orgB); assert.equal(a2.organisationId, orgA);
	assert.equal(new Set([a1.epoch, b.epoch, a2.epoch]).size, 3, 'three different epochs, so a late answer for A1 is never taken for A2');
	// Loss of A with B the only membership left: B is chosen at once, ready throughout, under a new epoch.
	const refreshed = run(chosen, { type: 'refresh', now: 30_000 }).machine;
	const lostSingle = run(refreshed, { type: 'me-finished', handle: h(1), membership: refreshed.generations.membership, outcome: { kind: 'ok', me: me(orgB) } }).machine;
	const auto = scopeOf(lostSingle)!;
	assert.equal(auto.organisationId, orgB);
	assert.notEqual(auto.epoch, a1.epoch);
	// Sign-out, then a new sign-in to the same organisation: a new epoch too.
	const out = run(chosen, { type: 'sign-out' }, { type: 'local-finished', handle: h(1), result: 'deleted' }, { type: 'server-finished', handle: h(1), result: 'ended', wait: null }).machine;
	assert.equal(kind(out), 'signed-out');
	const signed = run(out, { type: 'sign-in' }, { type: 'gate-checked', result: 'settled' },
		{ type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo: '/' } });
	const written = run(signed.machine, { type: 'install-finished', handle: h(2), result: 'written', now: 100_000 }).machine;
	const verified = run(written, { type: 'me-finished', handle: h(2), membership: written.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB) } }).machine;
	const again = run(verified, { type: 'org-read', handle: h(2), organisation: verified.generations.organisation, organisationId: orgA }).machine;
	const a3 = scopeOf(again)!;
	assert.equal(a3.organisationId, orgA);
	assert.ok(![a1.epoch, b.epoch, a2.epoch, auto.epoch].includes(a3.epoch), 'the same person and organisation in a new session is a new epoch');
});

// ---------------------------------------------------------------------------------------------------------------
// Person scope (docs/plans/mobile-session-revocation-2026-09.md §5a.3).

test('person scope: whenever signed in, token-free, and the same object as the view shows', () => {
	const read = run(initial(), { type: 'boot' }, { type: 'launch-read', now: 0, result: { kind: 'session', handle: h(1), userId } });
	assert.equal(personScope(read.machine), null, 'checking: no person yet');
	const loading = launched(orgA, orgB).machine;
	const person = personScope(loading)!;
	assert.equal(person.userId, userId);
	assert.deepEqual(Object.keys(person).sort(), ['epoch', 'userId'], 'nothing else: no handle, token or storage key');
	assert.ok(Object.isFrozen(person));
	const shownView = view(loading).account;
	assert.ok(shownView.kind === 'signed-in' && !shownView.ready);
	assert.deepEqual(shownView.person, person, 'present before an organisation is chosen: it is per person');
	assert.equal(personScope(run(chosenA(orgA, orgB), { type: 'sign-out' }).machine), null, 'releasing: no person');
});

test('person scope: a refresh and an organisation switch keep it; sign-out and a new sign-in as the same person change it (ABA)', () => {
	const chosen = chosenA(orgA, orgB);
	const first = personScope(chosen)!;
	const refreshed = run(chosen, { type: 'refresh', now: 30_000 }).machine;
	const kept = run(refreshed, { type: 'me-finished', handle: h(1), membership: refreshed.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB, orgC) } }).machine;
	assert.deepEqual(personScope(kept), first, 'a membership refresh keeps it');
	const toB = run(kept, { type: 'choose-organisation', organisationId: orgB }).machine;
	assert.notEqual(scopeOf(toB)!.epoch, scopeOf(kept)!.epoch, 'the read scope changes with the organisation');
	assert.deepEqual(personScope(toB), first, 'the person scope does not');
	const lostSingle = run(run(chosen, { type: 'refresh', now: 30_000 }).machine, { type: 'me-finished', handle: h(1), membership: refreshed.generations.membership, outcome: { kind: 'ok', me: me(orgB) } }).machine;
	assert.deepEqual(personScope(lostSingle), first, 'an organisation loss that auto-chooses keeps it');
	const out = run(chosen, { type: 'sign-out' }, { type: 'local-finished', handle: h(1), result: 'deleted' }, { type: 'server-finished', handle: h(1), result: 'ended', wait: null }).machine;
	const signed = run(out, { type: 'sign-in' }, { type: 'gate-checked', result: 'settled' },
		{ type: 'attempt-finished', outcome: { kind: 'signed-in', handle: h(2), userId, returnTo: '/' } });
	const written = run(signed.machine, { type: 'install-finished', handle: h(2), result: 'written', now: 100_000 }).machine;
	const verified = run(written, { type: 'me-finished', handle: h(2), membership: written.generations.membership, outcome: { kind: 'ok', me: me(orgA, orgB) } }).machine;
	const again = personScope(verified)!;
	assert.equal(again.userId, first.userId);
	assert.notEqual(again.epoch, first.epoch, 'the same person in a new session is a new person scope');
	const ended = run(verified, { type: 'unauthorised', handle: h(2) }).machine;
	assert.equal(personScope(ended), null, 'a session end: no person');
});

test('organisation loss: the chosen one is named; a person choosing clears it; the only remaining membership keeps it', () => {
	const signed = chosenA(orgA, orgB, orgC);
	const refreshed = run(signed, { type: 'refresh', now: 30_000 });
	const lost = run(refreshed.machine, { type: 'me-finished', handle: h(1), membership: refreshed.machine.generations.membership, outcome: { kind: 'ok', me: me(orgB, orgC) } }).machine;
	const lostView = view(lost).account;
	assert.ok(lostView.kind === 'signed-in' && !lostView.ready);
	assert.deepEqual(lostView.orgNotice, { kind: 'lost', name: orgA.slice(0, 4) });
	const chose = view(run(lost, { type: 'choose-organisation', organisationId: orgB }).machine).account;
	assert.ok(chose.kind === 'signed-in' && chose.ready && chose.orgNotice === null);
	const onlyOne = run(refreshed.machine, { type: 'me-finished', handle: h(1), membership: refreshed.machine.generations.membership, outcome: { kind: 'ok', me: me(orgB) } }).machine;
	const onlyView = view(onlyOne).account;
	assert.ok(onlyView.kind === 'signed-in' && onlyView.ready && onlyView.orgNotice?.kind === 'lost');
});

test('boot reads the saved sign-in once', () => {
	const booted = run(initial(), { type: 'boot' });
	assert.deepEqual(run(booted.machine, { type: 'boot' }).effects, []);
});

test('slow operations change wording only; cancel waits for the browser call to settle', () => {
	const booted = run(initial(), { type: 'boot' });
	const timer = ofType(booted.effects, 'start-timer')[0]!;
	assert.deepEqual(run(booted.machine, { type: 'slow', id: timer.id + 7 }).machine, booted.machine, 'another timer changes nothing');
	assert.deepEqual(view(run(booted.machine, { type: 'slow', id: timer.id }).machine).account, { kind: 'starting', slow: true });
	const out = run(booted.machine, { type: 'launch-read', now: 0, result: { kind: 'none' } });
	assert.deepEqual(ofType(out.effects, 'stop-timer'), [{ type: 'stop-timer', id: timer.id }]);
	const browsing = run(out.machine, { type: 'sign-in' }, { type: 'gate-checked', result: 'settled' }).machine;
	assert.deepEqual(run(browsing, { type: 'cancel' }).effects, [{ type: 'cancel-attempt' }]);
	const closing = run(browsing, { type: 'attempt-state', state: 'closing' });
	const closingTimer = ofType(closing.effects, 'start-timer')[0]!;
	assert.deepEqual(view(run(closing.machine, { type: 'slow', id: closingTimer.id }).machine).account, { kind: 'signing-in', phase: 'closing', slow: true });
	const cancelled = run(closing.machine, { type: 'attempt-finished', outcome: { kind: 'cancelled' } });
	assert.deepEqual(view(cancelled.machine).account, { kind: 'signed-out', notice: { kind: 'sign-in', outcome: 'cancelled' }, gate: 'idle' });
});
