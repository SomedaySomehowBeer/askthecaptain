import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gate, localPart, ruleWords, type Signals } from './gate.ts';

const plain: Signals = { labelIds: ['INBOX'], listUnsubscribe: false, listId: '', precedence: '', autoSubmitted: '', sender: 'jo@supplier.test', knownSender: false, starred: false };
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
