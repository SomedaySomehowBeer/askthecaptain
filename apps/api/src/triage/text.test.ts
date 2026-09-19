import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownText, trimmedMessages } from './text.ts';

test('own text drops quoted blocks, forwarded headers and signatures, and keeps the rest', () => {
	assert.equal(ownText('Sounds good, go for it.\n\nOn Tue, 3 Sep 2026 at 10:12, Jo <jo@x.test> wrote:\n> Should I destroy everything?\n> Yes or no'), 'Sounds good, go for it.');
	assert.equal(ownText('Yes.\r\n\r\n-----Original Message-----\r\nFrom: A\r\nSent: today\r\nEverything below is quoted'), 'Yes.');
	assert.equal(ownText('Please send the invoice.\n\nKind regards,\nJo Bloggs\nSomeday Somehow\n0400 000 000'), 'Please send the invoice.');
	assert.equal(ownText('Please send the invoice.\n-- \nJo\n'), 'Please send the invoice.');
	assert.equal(ownText('Forwarding this for you.\n\nFrom: Supplier <s@x.test>\nSent: Monday\nTo: me\nSubject: Prices\n\nOld body'), 'Forwarding this for you.');
	// "From:" as prose, and a sign-off word as the whole message, are kept.
	assert.equal(ownText('From: the cellar, we counted 40 kegs.\nThat is all.'), 'From: the cellar, we counted 40 kegs.\nThat is all.');
	assert.equal(ownText('Thanks'), 'Thanks');
	assert.equal(ownText('> only a quote\n> and more'), '');
});

test('the latest message keeps its full own text and earlier ones are cut to 500 characters', () => {
	const long = 'a'.repeat(700);
	const out = trimmedMessages([{ body: long + '\n> quoted' }, { body: long }]);
	assert.equal(out[0]!.body.length, 500); assert.equal(out[1]!.body.length, 700);
});
