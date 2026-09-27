/** Display-only stock projection. The server owns counts and reorder comparisons; this parser
 * never converts decimals to numbers or retains supplier, note or person fields. */
export type StockRow = {
	readonly id: string;
	readonly name: string;
	readonly count: string | null;
	readonly unit: string;
	readonly reorderPoint: string | null;
	readonly below: boolean;
};
export type StockGroup = { readonly location: string; readonly items: readonly StockRow[] };
export type StockList = { readonly groups: readonly StockGroup[] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^\d+(?:\.\d+)?$/;
const invalid = (): never => { throw new TypeError('Stock response is not valid'); };
function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}
function label(value: unknown, max: number): string {
	if (typeof value !== 'string' || value.length > max || !value.trim()) return invalid();
	return value;
}
function count(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || value.length > 80 || !decimal.test(value)) return invalid();
	return value;
}

/** One invalid row rejects the whole answer, so a partial inventory never looks complete.
 * The transport bounds decoded bytes before this runs; the list itself is unpaginated. */
export function parseStockList(value: unknown): StockList {
	const body = object(value);
	if (!Array.isArray(body.items)) return invalid();
	const seen = new Set<string>();
	const groups = new Map<string, StockRow[]>();
	for (const value of body.items) {
		const item = object(value);
		if (typeof item.id !== 'string' || !uuid.test(item.id) || seen.has(item.id) || item.archivedAt !== null) return invalid();
		seen.add(item.id);
		const name = label(item.name, 200), location = label(item.location, 200), unit = label(item.unitLabel, 80);
		const current = count(item.currentCount), reorderPoint = count(item.reorderPoint);
		if (current === null || reorderPoint === null) {
			if (item.belowReorder !== null) return invalid();
		} else if (typeof item.belowReorder !== 'boolean') return invalid();
		const row: StockRow = Object.freeze({ id: item.id, name, count: current, unit, reorderPoint, below: item.belowReorder === true });
		const rows = groups.get(location);
		if (rows) rows.push(row);
		else groups.set(location, [row]);
	}
	return Object.freeze({ groups: Object.freeze([...groups].map(([location, items]) => Object.freeze({ location, items: Object.freeze(items) }))) });
}
