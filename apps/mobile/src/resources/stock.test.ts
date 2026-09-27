import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStockList } from './stock.ts';

const row = (n = 1) => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, name: 'Pale malt', location: ' Cellar', unitLabel: ' bags ', currentCount: '12.50', reorderPoint: '15.000', belowReorder: true, archivedAt: null });
const parse = (change: Record<string, unknown> = {}) => parseStockList({ items: [{ ...row(), ...change }] });

test('stock keeps exact decimal and raw location identity, API ordering and only display fields', () => {
	const answer = parseStockList({ items: [
		{ ...row(), notes: 'private'.repeat(800), countedByName: 'Person', supplierName: 'Supplier' },
		{ ...row(2), location: 'Cellar', currentCount: null, belowReorder: null },
		{ ...row(3), location: ' Cellar', currentCount: '0012.500', unitLabel: 'kg' }
	], locations: ['Wrong order'], suppliers: ['unused'], timezone: 'unused' });
	assert.deepEqual(answer.groups.map(g => [g.location, g.items.map(r => r.id)]), [[' Cellar', [row(1).id, row(3).id]], ['Cellar', [row(2).id]]]);
	assert.deepEqual(answer.groups[0]!.items[0], { id: row().id, name: 'Pale malt', count: '12.50', unit: ' bags ', reorderPoint: '15.000', below: true });
	assert.equal(answer.groups[0]!.items[1]!.count, '0012.500'); // Synthetic parser fidelity, not Postgres output.
	assert.equal(answer.groups[1]!.items[0]!.count, null);
	assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.groups) && Object.isFrozen(answer.groups[0]) && Object.isFrozen(answer.groups[0]!.items) && Object.isFrozen(answer.groups[0]!.items[0]));
});

test('stock preserves API-sized decimal precision and refuses numeric, exponent or malformed values', () => {
	for (const value of ['0', '0.001', '9'.repeat(80), `${'9'.repeat(78)}.1`]) assert.equal(parse({ currentCount: value }).groups[0]!.items[0]!.count, value);
	for (const value of [12.5, -1, '-1', '1e3', '.5', '5.', ' 5', '5,0', 'NaN', '+5', '', '9'.repeat(81), undefined]) {
		for (const key of ['currentCount', 'reorderPoint']) assert.throws(() => parse({ [key]: value }), { name: 'TypeError', message: 'Stock response is not valid' });
	}
});

test('stock trusts server comparison only when its nullable shape is consistent', () => {
	assert.equal(parse({ currentCount: null, reorderPoint: null, belowReorder: null }).groups[0]!.items[0]!.below, false);
	assert.equal(parse({ currentCount: '0', reorderPoint: '100', belowReorder: false }).groups[0]!.items[0]!.below, false); // No client recomputation.
	for (const patch of [{ belowReorder: null }, { belowReorder: 1 }, { currentCount: null }, { reorderPoint: null }, { currentCount: null, belowReorder: false }]) assert.throws(() => parse(patch), TypeError);
});

test('stock fails the whole response for duplicates, archived rows or invalid display identities', () => {
	assert.deepEqual(parseStockList({ items: [] }), { groups: [] });
	for (const value of [null, [], {}, { items: null }, { items: [row(), row()] }, { items: [row(), null] }]) assert.throws(() => parseStockList(value), TypeError);
	for (const patch of [{ id: 'not-an-id' }, { id: 'ABCDEF00-0000-0000-0000-000000000001' }, { archivedAt: '2026-09-27' }, { name: ' ' }, { location: '  ' }, { unitLabel: '\t' }, { location: 'x'.repeat(201) }, { unitLabel: 'x'.repeat(81) }]) assert.throws(() => parse(patch), TypeError);
	assert.equal(parse({ name: '😀'.repeat(100), unitLabel: '😀'.repeat(40) }).groups[0]!.items[0]!.name.length, 200);
	assert.throws(() => parse({ name: '😀'.repeat(101) }), TypeError);
});

test('stock grouping follows first appearance rather than alphabetical order', () => {
	const list = parseStockList({ items: [{ ...row(1), location: 'Taproom' }, { ...row(2), location: 'Cellar' }, { ...row(3), location: 'Taproom' }] });
	assert.deepEqual(list.groups.map(g => [g.location, g.items.map(r => r.id)]), [['Taproom', [row(1).id, row(3).id]], ['Cellar', [row(2).id]]]);
});
