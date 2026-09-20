import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drafting, draftingWords, draftScore, gate, localPart, ruleWords, type Signals } from './gate.ts';

const plain: Signals = { labelIds: ['INBOX'], listUnsubscribe: false, listId: '', precedence: '', autoSubmitted: '', sender: 'jo@supplier.test', knownSender: false, starred: false, latestAt: '2026-09-20T02:00:00.000Z', repliedByOwner: false };
const quiet = { threadsSeen: 3, informationVerdicts: 3, needsOwnerCount: 0, replies: 0, stars: 0 };

test('bulk and automated mail is filed by the first rule that holds, with a reason in words', () => {
	assert.deepEqual(gate(plain, null), { passes: true, rule: null });
	assert.equal(gate({ ...plain, labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }, null).rule, 'category_promotions');
	assert.equal(gate({ ...plain, labelIds: ['CATEGORY_SOCIAL'] }, null).rule, 'category_social');
	assert.equal(gate({ ...plain, labelIds: ['CATEGORY_FORUMS'] }, null).rule, 'category_forums');
	assert.equal(gate({ ...plain, listUnsubscribe: true }, null).rule, 'list_header');
	assert.equal(gate({ ...plain, listId: '<news.example.test>' }, null).rule, 'list_header');
	assert.equal(gate({ ...plain, precedence: 'bulk' }, null).rule, 'precedence_bulk');
	assert.equal(gate({ ...plain, autoSubmitted: 'auto-generated' }, null).rule, 'auto_submitted');
	assert.equal(gate({ ...plain, autoSubmitted: 'no' }, null).passes, true);
	assert.equal(gate({ ...plain, sender: 'no-reply@shop.test' }, null).rule, 'automated_sender');
	assert.equal(gate({ ...plain, sender: 'Notifications+abc@github.test' }, null).rule, 'automated_sender');
	assert.equal(gate({ ...plain, sender: 'mailer-daemon@googlemail.com' }, null).rule, 'automated_sender');
	for (const rule of Object.keys(ruleWords)) assert.ok(ruleWords[rule as keyof typeof ruleWords].length > 10);
});

test('a sender prior files after three quiet information verdicts, and a reply or star resets it', () => {
	assert.equal(gate(plain, quiet).rule, 'sender_prior');
	assert.equal(gate(plain, { ...quiet, informationVerdicts: 2 }).passes, true);
	assert.equal(gate(plain, { ...quiet, needsOwnerCount: 1 }).passes, true);
	assert.equal(gate(plain, { ...quiet, replies: 1 }).passes, true);
	assert.equal(gate(plain, { ...quiet, stars: 1 }).passes, true);
	assert.equal(gate({ ...plain, starred: true }, quiet).passes, true);
});

test('Updates goes to the model only for a known sender', () => {
	assert.equal(gate({ ...plain, labelIds: ['CATEGORY_UPDATES'] }, null).rule, 'category_updates_unknown');
	assert.equal(gate({ ...plain, labelIds: ['CATEGORY_UPDATES'], knownSender: true }, null).passes, true);
	assert.equal(localPart('Do.Not-Reply+x@a.test'), 'donotreply');
});

test('a reply is drafted for a fresh, unanswered thread whose score reaches the threshold, with the reason in words', () => {
	const now = Date.parse('2026-09-20T12:00:00.000Z'); const request = { needsOwner: true, category: 'request' }; const other = { needsOwner: true, category: 'other' };
	assert.deepEqual(drafting(plain, request, null, 3, 0, now), { drafts: true, reason: null, score: 3, threshold: 3 });
	assert.equal(drafting({ ...plain, repliedByOwner: true }, request, null, 3, 0, now).reason, 'already_replied');
	assert.equal(drafting({ ...plain, latestAt: '2026-09-19T11:59:00.000Z' }, request, null, 3, 0, now).reason, 'older_than_a_day');
	assert.equal(drafting({ ...plain, latestAt: '2026-09-19T12:01:00.000Z' }, request, null, 3, 0, now).drafts, true);
	assert.equal(drafting({ ...plain, latestAt: 'not a date' }, request, null, 3, 0, now).reason, 'older_than_a_day');
	assert.equal(drafting(plain, { needsOwner: false, category: 'request' }, null, 3, 0, now).reason, 'needs_owner_off');
	// The initial rule before any outcomes: needs owner and (known sender or request).
	assert.equal(drafting(plain, other, null, 3, 0, now).reason, 'below_threshold');
	assert.equal(drafting({ ...plain, knownSender: true }, other, null, 3, 0, now).drafts, true);
	const quietPrior = { replies: 0, draftsSent: 0, draftsEdited: 0, draftsDiscarded: 0, draftsNotNeeded: 0, draftsRequested: 0 };
	assert.equal(drafting(plain, other, { ...quietPrior, replies: 1 }, 3, 0, now).drafts, true);
	assert.equal(drafting(plain, request, { ...quietPrior, draftsNotNeeded: 1 }, 3, 0, now).reason, 'below_threshold');
	assert.equal(drafting(plain, other, { ...quietPrior, draftsRequested: 1 }, 3, 0, now).drafts, true);
	assert.equal(draftScore(plain, request, { ...quietPrior, draftsSent: 5 }), 10);
	assert.equal(drafting(plain, request, null, 3, 20, now).reason, 'run_cap');
	for (const words of Object.values(draftingWords)) assert.match(words, /\.$/);
});
