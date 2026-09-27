import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colors, tabBar, tabBarWidth, type } from './tokens.ts';

test('the tab bar keeps the approved geometry: about 290 × 54 on a 390 pt phone, 22 pt icons, 11 pt labels, 44 pt targets', () => {
	assert.ok(Math.abs(tabBarWidth(390) - 290) < 1, String(tabBarWidth(390)));
	assert.equal(tabBar.height, 54); assert.equal(tabBar.icon, 22); assert.equal(tabBar.label, 11);
	assert.ok(tabBar.minTarget >= 44);
	assert.equal(tabBarWidth(320), 240, 'small phones keep three reachable tabs');
	assert.equal(tabBarWidth(1024), 360, 'tablets keep a compact bar');
	assert.ok(tabBarWidth(390) / 3 >= tabBar.minTarget);
});

test('the selected tab is the darker grey-green at 50% with green text; headings are 26 pt; the palette is paper and forest', () => {
	assert.equal(colors.selectedPill, 'rgba(217, 222, 214, 0.5)');
	assert.equal(colors.selectedText, '#197334');
	assert.equal(type.heading, 26);
	assert.equal(colors.page, '#f3ecdf'); assert.equal(colors.heading, '#142619'); assert.equal(colors.mint, '#90e8a8');
});
