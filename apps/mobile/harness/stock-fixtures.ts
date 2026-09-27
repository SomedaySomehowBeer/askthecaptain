/** Raw synthetic stock answers, consumed by the production parser only in the separate harness. */
export const stockId = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const item = (n: number, name: string, location: string, count: string | null, unit: string, reorder: string | null, below: boolean | null) => ({
	id: stockId(n), name, location, currentCount: count, unitLabel: unit, reorderPoint: reorder, belowReorder: below, archivedAt: null,
	notes: 'Synthetic note must not enter list state', countedByName: 'Synthetic person', supplierName: 'Synthetic supplier'
});

export function stockFixture(answer: string): unknown {
	if (answer === 'empty') return { items: [], locations: [], suppliers: [], timezone: 'UTC' };
	if (answer === 'stock-uncounted') return { items: [item(4, 'Sample consumable', 'Store', null, 'bags', null, null)] };
	if (answer === 'stock-unusual') return { items: [
		item(5, 'Sample fractional stock', 'Cellar', '0.125', 'kg', '1.000', true),
		item(6, 'Sample exact stock', 'Cellar', '12.50', 'kegs', null, null),
		item(7, 'Sample long name '.repeat(11), 'Packing', '9'.repeat(80), 'long unit '.repeat(8), null, null)
	] };
	if (['ok-page', 'ok-last', 'ok-overlap'].includes(answer)) return {
		items: [
			item(1, 'Sample malt', 'Store', '12.50', 'bags', '15.000', true),
			item(2, 'Sample labels', 'Packing', null, 'rolls', '5', null),
			item(3, 'Sample finished stock', 'Cellar', '24', 'kegs', '10', false)
		], locations: ['Ignored ordering'], suppliers: [], timezone: 'UTC'
	};
	return { items: [{ invalid: 'Synthetic malformed response' }] };
}
