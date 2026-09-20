import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunk, messageUnit, noteUnit, quotedText, weightedMean, threadWeight, toSql, parseVector, cosine } from '../src/index.ts';
test('a message unit is subject, parent context to 200 tokens, then own text; short replies inherit', () => {
	const parent = 'p'.repeat(2000);
	const unit = messageUnit({ subject: 'Keg order', ownText: 'Yes please, 12 kegs.', parentText: parent });
	assert.ok(unit.inherit); assert.equal(unit.ownTokens, 5);
	assert.equal(unit.text.split('\n\n')[0], 'Keg order'); assert.ok(unit.text.split('\n\n')[1]!.length <= 800);
	const long = messageUnit({ subject: 'Keg order', ownText: 'word '.repeat(60), parentText: parent });
	assert.equal(long.inherit, false); assert.equal(long.ownTokens, 75);
	// Without a stored parent the quoted block stands in, and nothing is inherited.
	const quoted = messageUnit({ subject: 'Re: cans', ownText: 'ok', quotedText: 'Can you confirm the can order for October?' });
	assert.equal(quoted.inherit, false); assert.match(quoted.text, /confirm the can order/);
});
test('a note unit is title or first line, linked names, then body', () => {
	assert.equal(noteUnit({ title: '', body: 'Call with supplier\nAgreed 2,000 cans.', linked: ['Cans', ''] }).text, 'Call with supplier\n\nCans\n\nCall with supplier\nAgreed 2,000 cans.');
	assert.equal(noteUnit({ title: 'Plan', body: 'x' }).tokens, 1);
});
test('chunking splits at about 256 tokens on paragraphs, sentences, then words', () => {
	assert.deepEqual(chunk('short'), ['short']); assert.deepEqual(chunk('   '), []);
	const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'text '.repeat(80)}`.trim()).join('\n\n');
	const pieces = chunk(paragraphs); assert.ok(pieces.length >= 3, String(pieces.length)); assert.ok(pieces.every((p) => p.length <= 1024));
	assert.equal(pieces.join('\n').replace(/\s+/g, ' '), paragraphs.replace(/\s+/g, ' '));
	const sentences = chunk(('A sentence of some words here. ').repeat(80)); assert.ok(sentences.length >= 3); assert.ok(sentences.every((p) => p.length <= 1024 && /\.$/.test(p)));
	const wall = chunk('x'.repeat(3000)); assert.equal(wall.length, 3); assert.equal(wall.join('').length, 3000);
});
test('quotedText returns the quoted block without markers', () => {
	assert.equal(quotedText('Thanks!\n\nOn Tue, Jo wrote:\n> Can you confirm?\n> The order.'), 'Can you confirm?\nThe order.');
	assert.equal(quotedText('No quote here'), '');
});
test('vector maths: weighted mean is normalised, thread weight caps at 300 tokens, sql round-trips', () => {
	const mean = weightedMean([{ vector: [1, 0], weight: 1 }, { vector: [0, 1], weight: 1 }])!;
	assert.ok(Math.abs(Math.hypot(...mean) - 1) < 1e-9); assert.ok(Math.abs(mean[0]! - mean[1]!) < 1e-9);
	assert.equal(weightedMean([]), null);
	assert.equal(threadWeight(30), 0.1); assert.equal(threadWeight(900), 1); assert.equal(threadWeight(0), 1 / 300);
	assert.deepEqual(parseVector(toSql([0.5, -0.25, 1e-9, 0])), [0.5, -0.25, 0, 0]);
	assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
});
