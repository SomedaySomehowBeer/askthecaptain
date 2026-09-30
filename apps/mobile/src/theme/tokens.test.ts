import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colors, space, type } from './tokens.ts';

test('the palette is the reviewed green-grey set: background, surface, text, action and lines', () => {
	assert.equal(colors.page, '#f1f5ee'); assert.equal(colors.card, '#ffffff');
	assert.equal(colors.body, '#1f3a2c'); assert.equal(colors.heading, '#142619'); assert.equal(colors.muted, '#54655a');
	assert.equal(colors.action, '#276744'); assert.equal(colors.actionText, '#ffffff');
	assert.equal(colors.line, '#d8e0d3'); assert.equal(colors.rowLine, '#e6ece2');
	assert.equal(colors.sage, '#dbe6d4'); assert.equal(colors.sageText, '#2d4c36');
	for (const value of Object.values(colors)) assert.match(value, /^#[0-9a-f]{6}$/, 'every colour is a plain hex value');
});

test('headings are 26 pt, targets at least 44 pt, the gutter 16 pt, and wide screens keep a readable column', () => {
	assert.equal(type.heading, 26);
	assert.ok(space.minTarget >= 44);
	assert.equal(space.page, 16);
	assert.ok(space.maxContentWidth >= 600 && space.maxContentWidth <= 900);
});
