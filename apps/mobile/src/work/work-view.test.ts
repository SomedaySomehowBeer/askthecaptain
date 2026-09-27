import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedAllRows, expectedRows, fixtureBody, otherOwnerId, viewOfPath } from '../../harness/work-fixtures.ts';
import { allWorkCopy, ownerLabels, requestedDestination, workCopy, workProblemText, workViewCopy, workViewProblemText } from '../account/copy.ts';
import { workListPath } from '../api/paths.ts';
import { webLink } from '../config.ts';
import { formatDue, parseWorkPage, type WorkRow } from './my-work.ts';
import { capLink, rowDetail, rowLabel, testIdPrefix } from './work-view.ts';

const scope = { epoch: 'a1.o1', userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', organisationId: 'c0ffee00-1234-4abc-9def-0123456789ab' };
const row = (owner: WorkRow['owner'], tagCount = 0): WorkRow => Object.freeze({
	id: '00000000-0000-4000-8000-000000000001', displayTitle: 'Sample task AB', owner, status: 'open', due: null,
	tags: Object.freeze(['Alpha', 'Bravo', 'Charlie'].slice(0, Math.min(3, tagCount)).map((name, i) => Object.freeze({ id: `00000000-0000-4000-9000-00000000000${i + 1}`, name }))),
	tagCount
});

test('the per-view wording matches the adopted table exactly (§5)', () => {
	assert.deepEqual({ ...workViewCopy('mine') }, {
		heading: 'My work', subtitle: 'Open tasks assigned to you', loading: 'Loading your work…',
		emptyTitle: 'Nothing open is assigned to you', emptyBody: 'Tasks you own appear here while they are open.',
		failedFirst: "Couldn't load your work", failedRefresh: "Couldn't refresh. This list may be out of date.", failedMore: "Couldn't load more",
		access: "Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks.",
		list: "Captain couldn't read this list.", open: 'Open', refresh: 'Refresh', more: 'More', tryAgain: 'Try again', busy: 'Loading…',
		capNotice: 'Some more open tasks may be available on the Captain website.', openWebWork: 'Open My work on the web'
	});
	assert.deepEqual({ ...workViewCopy('all') }, {
		heading: 'All tasks', subtitle: 'Open tasks assigned to anyone', loading: 'Loading open tasks…',
		emptyTitle: 'No open tasks in this organisation', emptyBody: 'Tasks appear here while they are open, whoever they are assigned to.',
		failedFirst: "Couldn't load open tasks", failedRefresh: "Couldn't refresh. This list may be out of date.", failedMore: "Couldn't load more",
		access: "Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks.",
		list: "Captain couldn't read this list.", open: 'Open', refresh: 'Refresh', more: 'More', tryAgain: 'Try again', busy: 'Loading…',
		capNotice: 'Some more open tasks may be available on the Captain website.', openWebWork: 'Open All tasks on the Captain website'
	});
	assert.equal(workViewCopy('mine'), workCopy, 'My work is exactly the existing table');
	assert.equal(workViewCopy('all'), allWorkCopy);
	assert.deepEqual({ ...ownerLabels }, { you: 'Assigned to you', 'someone-else': 'Assigned to someone else', none: 'No owner' });
});

test('wording honesty: open only, no totals, no access check claimed, nothing about a person beyond the owner facts', () => {
	for (const view of ['mine', 'all'] as const) {
		const copy = workViewCopy(view);
		for (const text of Object.values(copy)) {
			assert.ok(!/in progress|everything|being checked|checking your access|no longer have access/i.test(text), `${view}: ${text}`);
		}
		assert.ok(!/\d/.test(copy.capNotice), 'no number in the cap notice');
	}
	for (const text of Object.values(ownerLabels)) assert.ok(!/\d|@/.test(text), 'no name, email or number');
});

test('failure wording by view: the operation decides unavailable; refusals are the same for both', () => {
	const all = workViewCopy('all');
	assert.equal(workViewProblemText(all, { op: 'first', kind: 'unavailable' }), "Couldn't load open tasks");
	assert.equal(workViewProblemText(all, { op: 'refresh', kind: 'unavailable' }), "Couldn't refresh. This list may be out of date.");
	assert.equal(workViewProblemText(all, { op: 'more', kind: 'unavailable' }), "Couldn't load more");
	for (const op of ['first', 'refresh', 'more'] as const) {
		assert.equal(workViewProblemText(all, { op, kind: 'access' }), workProblemText({ op, kind: 'access' }));
		assert.equal(workViewProblemText(all, { op, kind: 'list' }), "Captain couldn't read this list.");
	}
	assert.equal(workProblemText({ op: 'first', kind: 'unavailable' }), "Couldn't load your work", 'My work unchanged');
});

test('row detail and label: My work never shows an owner; All tasks always shows exactly one owner fact', () => {
	for (const owner of ['you', 'someone-else', 'none'] as const) {
		const r = row(owner, 5);
		assert.equal(rowDetail(r, 'mine'), 'Open · Alpha · Bravo · Charlie · +2 more');
		assert.equal(rowLabel(r, 'mine'), 'Sample task AB, Open, Alpha, Bravo, Charlie, +2 more, No due date');
		assert.equal(rowDetail(r, 'all'), `Open · ${ownerLabels[owner]} · Alpha · Bravo · Charlie · +2 more`);
		assert.equal(rowLabel(r, 'all'), `Sample task AB, Open, ${ownerLabels[owner]}, Alpha, Bravo, Charlie, +2 more, No due date`);
		for (const text of [rowDetail(r, 'mine'), rowLabel(r, 'mine')]) {
			for (const label of Object.values(ownerLabels)) assert.ok(!text.includes(label), 'no owner in My work');
		}
		const shownAll = Object.values(ownerLabels).filter((label) => rowDetail(r, 'all').includes(label));
		assert.deepEqual(shownAll, [ownerLabels[owner]], 'exactly one owner fact');
	}
	assert.equal(rowDetail(row('none'), 'all'), 'Open · No owner', 'no tags');
	assert.equal(rowDetail(row('you'), 'mine'), 'Open');
});

test('cap links and test IDs are fixed per view; the links are allow-listed constants', () => {
	assert.equal(capLink('mine'), '/work'); assert.equal(capLink('all'), '/work?owner=all');
	assert.equal(webLink('https://app.example.invalid', capLink('all')), 'https://app.example.invalid/work?owner=all');
	assert.equal(webLink('https://app.example.invalid', capLink('mine')), 'https://app.example.invalid/work');
	assert.equal(testIdPrefix('mine'), 'work', 'My work keeps its existing test IDs');
	assert.equal(testIdPrefix('all'), 'all-work');
});

test('requested destination: /work/all is a linkable tab route, captured for sign-in and a cold restore', () => {
	assert.equal(requestedDestination('/work/all'), '/work/all');
	assert.equal(requestedDestination('/work'), '/work');
});

test('harness fixtures: the view comes from the requested path, and each view parses to its exported expected rows', () => {
	const mine = workListPath(scope, 'mine', 0); const all = workListPath(scope, 'all', 0);
	assert.equal(viewOfPath(mine), 'mine'); assert.equal(viewOfPath(all), 'all');
	const minePage = parseWorkPage(fixtureBody('ok-page', mine, scope.userId), { scope, offset: 0, view: 'mine' });
	const allPage = parseWorkPage(fixtureBody('ok-page', all, scope.userId), { scope, offset: 0, view: 'all' });
	assert.ok(minePage.rows.every((r) => r.owner === 'you'), 'My work fixtures are all the person\'s own');
	assert.deepEqual(allPage.rows.slice(0, 6).map((r) => r.owner), ['you', 'someone-else', 'none', 'you', 'someone-else', 'none']);
	const shown = (r: WorkRow, view: 'mine' | 'all') => ({ title: r.displayTitle, detail: rowDetail(r, view), due: formatDue(r.due) });
	assert.deepEqual(minePage.rows.slice(0, 3).map((r) => shown(r, 'mine')), [expectedRows.first, expectedRows.long, expectedRows.blank]);
	assert.deepEqual(allPage.rows.slice(0, 3).map((r) => shown(r, 'all')), [expectedAllRows.first, expectedAllRows.long, expectedAllRows.blank]);
	// The other owner is never the person, and an All tasks body would fail the My work parser (wrong owner).
	assert.notEqual(otherOwnerId, scope.userId);
	assert.throws(() => parseWorkPage(fixtureBody('ok-page', all, scope.userId), { scope, offset: 0, view: 'mine' }), TypeError);
	// Offsets come from the path too.
	const later = parseWorkPage(fixtureBody('ok-last', workListPath(scope, 'all', 100), scope.userId), { scope, offset: 100, view: 'all' });
	assert.deepEqual(later.rows.map((r) => r.owner), ['someone-else', 'none', 'you'], 'indices 100, 101, 102');
});
