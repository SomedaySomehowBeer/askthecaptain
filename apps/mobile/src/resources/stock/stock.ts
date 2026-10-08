/** Stock by people (docs/plans/stock-2026-10.md §2, §3; D15): the reads and writes behind Stocktake, "Add an item" and
 *  the stock card. Strict parsers: a row with an unknown key, a bad count or a mismatched id refuses the whole answer.
 *  Every write carries a client change set id and answers with it (versions contract §5). Shapes follow
 *  apps/api/src/stock/service.ts. Pure: no React Native import, so Node tests import it. */
import type { ReadScope } from '../../account/contracts.ts';
import { isCanonicalInstant, organisationPath } from '../../api/paths.ts';
import { queryPath } from '../../threads/api.ts';
import type { Write } from '../../threads/cards/records.ts';
import { array, integer, keys, object, text, uuid } from '../../threads/parse.ts';
import { firstName } from '../../threads/derive.ts';
import { wordInstant } from '../../threads/wording.ts';

const bad = (): never => { throw new TypeError('stock: unexpected response'); };
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();
const nullable = <T>(x: unknown, parse: (x: unknown) => T): T | null => x === null ? null : parse(x);
const decimal = (x: unknown): string => { const s = text(x, 100); return /^\d+(?:\.\d+)?$/.test(s) ? s : bad(); };
const words = (max: number) => (x: unknown) => { const s = text(x, max); if (!s.trim()) bad(); return s; };

/** The API's limit on one stocktake. */
export const stocktakeLimit = 200;

export type StockItem = {
	readonly id: string; readonly name: string; readonly location: string; readonly unitLabel: string;
	readonly currentCount: string | null; readonly countedAt: string | null; readonly countedBy: string | null; readonly countedByName: string | null;
	readonly reorderPoint: string | null; readonly notes: string; readonly archivedAt: string | null; readonly revision: number; readonly belowReorder: boolean | null;
};
const itemKeys = ['id', 'organisationId', 'name', 'location', 'unitLabel', 'currentCount', 'countedAt', 'countedBy', 'reorderPoint', 'preferredSupplierId', 'notes', 'archivedAt',
	'createdAt', 'updatedAt', 'revision'];
const listedKeys = ['countedByName', 'supplierName', 'belowReorder'];

/** One stock item: a list row (`listed`, with who counted it and whether it is below its reorder point) or a write's row. */
export function parseStockItem(raw: unknown, listed: boolean, extra: string[] = []): StockItem {
	const x = object(raw); keys(x, listed ? [...itemKeys, ...listedKeys] : itemKeys, extra);
	uuid(x.organisationId); nullable(x.preferredSupplierId, uuid); instant(x.createdAt); instant(x.updatedAt);
	if (listed) nullable(x.supplierName, (v) => text(v, 500));
	const item: StockItem = {
		id: uuid(x.id), name: words(200)(x.name), location: words(200)(x.location), unitLabel: words(80)(x.unitLabel),
		currentCount: nullable(x.currentCount, decimal), countedAt: nullable(x.countedAt, instant), countedBy: nullable(x.countedBy, uuid),
		countedByName: listed ? nullable(x.countedByName, (v) => text(v, 500)) : null,
		reorderPoint: nullable(x.reorderPoint, decimal), notes: text(x.notes, 5000), archivedAt: nullable(x.archivedAt, instant), revision: integer(x.revision, 1),
		belowReorder: listed ? (x.belowReorder === null || typeof x.belowReorder === 'boolean' ? x.belowReorder as boolean | null : bad()) : null
	};
	// A count, when and by whom are set together or not at all (0016's check).
	if ((item.currentCount === null) !== (item.countedAt === null) || (item.currentCount === null) !== (item.countedBy === null)) bad();
	return Object.freeze(item);
}
const uniqueIds = (rows: readonly { id: string }[]) => { if (new Set(rows.map((r) => r.id)).size !== rows.length) bad(); return rows; };
const locationsOf = (x: unknown) => { const rows = array(x, words(200), 1000); if (new Set(rows).size !== rows.length) bad(); return Object.freeze(rows); };

export type StockList = { readonly items: readonly StockItem[]; readonly locations: readonly string[]; readonly timezone: string; readonly archived: boolean };
/** `GET …/stock` (active items, or with `includeArchived=1` every item): unique rows, active ones first. */
export function parseStockList(raw: unknown, archived: boolean): StockList {
	const x = object(raw); keys(x, ['items', 'locations', 'suppliers', 'timezone']);
	const items = array(x.items, (r) => parseStockItem(r, true), 5000); uniqueIds(items);
	if (!archived && items.some((i) => i.archivedAt !== null)) bad();
	array(x.suppliers, (s) => { const r = object(s); keys(r, ['id', 'name']); uuid(r.id); text(r.name, 500); return null; }, 5000);
	return Object.freeze({ items: Object.freeze(items), locations: locationsOf(x.locations), timezone: text(x.timezone, 64), archived });
}
export const stockListPath = (scope: ReadScope, archived = false) => queryPath(organisationPath(scope.organisationId, 'stock'), { includeArchived: archived ? '1' : '0' });

export type StockCount = { readonly id: string; readonly count: string; readonly note: string; readonly countedAt: string; readonly countedBy: string; readonly countedByName: string | null };
export type StockCard = { readonly item: StockItem; readonly counts: readonly StockCount[]; readonly locations: readonly string[]; readonly timezone: string };
/** `GET …/stock/:itemId`: the item asked about, its latest three counts newest first, the active locations. */
export function parseStockCard(raw: unknown, itemId: string): StockCard {
	const x = object(raw); keys(x, ['item', 'counts', 'locations', 'timezone']);
	const item = parseStockItem(x.item, true); if (item.id !== itemId) bad();
	const counts = array(x.counts, (c) => {
		const r = object(c); keys(r, ['id', 'itemId', 'count', 'note', 'countedAt', 'countedBy', 'countedByName']);
		if (uuid(r.itemId) !== itemId) bad();
		return Object.freeze({ id: uuid(r.id), count: decimal(r.count), note: text(r.note, 1000), countedAt: instant(r.countedAt), countedBy: uuid(r.countedBy), countedByName: nullable(r.countedByName, (v) => text(v, 500)) });
	}, 3);
	uniqueIds(counts);
	if (counts.some((c, i) => i > 0 && Date.parse(c.countedAt) > Date.parse(counts[i - 1]!.countedAt))) bad();
	if ((item.currentCount === null) !== (counts.length === 0)) bad();
	return Object.freeze({ item, counts: Object.freeze(counts), locations: locationsOf(x.locations), timezone: text(x.timezone, 64) });
}
export const stockCardPath = (scope: ReadScope, itemId: string) => organisationPath(scope.organisationId, 'stock', uuid(itemId));

export type CountLine = { itemId: string; expectedRevision: number; count: string };
export type Taken = { readonly changeSetId: string; readonly items: readonly StockItem[] };
/** A stocktake's answer: exactly the items counted, each with the count that was sent (a retry answers them as they are
 *  now, so a later count by someone else is allowed through: the count then differs and the screen reloads anyway). */
export function parseStocktake(raw: unknown, expected: { changeSetId: string; itemIds: readonly string[] }): Taken {
	const x = object(raw); keys(x, ['changeSetId', 'items']);
	if (uuid(x.changeSetId) !== expected.changeSetId) bad();
	const items = array(x.items, (r) => parseStockItem(r, true), stocktakeLimit); uniqueIds(items);
	const asked = new Set(expected.itemIds);
	if (items.length !== asked.size || items.some((i) => !asked.has(i.id) || i.currentCount === null)) bad();
	return Object.freeze({ changeSetId: expected.changeSetId, items: Object.freeze(items) });
}
/** A write's answer: the item asked about (or made), with the change set that was sent. */
export function parseStockWrite(raw: unknown, expected: { id?: string; changeSetId: string; archived?: boolean }): StockItem & { changeSetId: string } {
	const x = object(raw); const item = parseStockItem(x, false, ['changeSetId']);
	if (uuid(x.changeSetId) !== expected.changeSetId || (expected.id && item.id !== expected.id)) bad();
	if (expected.archived !== undefined && (item.archivedAt !== null) !== expected.archived) bad();
	return { ...item, changeSetId: expected.changeSetId };
}

export type NewItem = { name: string; location: string; unitLabel: string; reorderPoint: string; notes: string };
export type ItemDetails = { name: string; location: string; unitLabel: string; reorderPoint: string; notes: string };
export const detailsForm = (i: StockItem): ItemDetails => ({ name: i.name, location: i.location, unitLabel: i.unitLabel, reorderPoint: i.reorderPoint ?? '', notes: i.notes });
export type DetailChanges = { name?: string; location?: string; unitLabel?: string; reorderPoint?: string | null; notes?: string };
/** Only what changed, so one save is one change set naming exactly the fields the person touched; null when nothing did. */
export function detailChanges(item: StockItem, form: ItemDetails): DetailChanges | null {
	const c: DetailChanges = {};
	if (form.name.trim() !== item.name) c.name = form.name.trim();
	if (form.location.trim() !== item.location) c.location = form.location.trim();
	if (form.unitLabel.trim() !== item.unitLabel) c.unitLabel = form.unitLabel.trim();
	const reorder = form.reorderPoint.trim() || null;
	if (reorder !== item.reorderPoint && !(reorder !== null && item.reorderPoint !== null && sameDecimal(reorder, item.reorderPoint))) c.reorderPoint = reorder;
	if (form.notes.trim() !== item.notes) c.notes = form.notes.trim();
	return Object.keys(c).length ? c : null;
}
const sameDecimal = (a: string, b: string) => /^\d+(?:\.\d+)?$/.test(a) && /^\d+(?:\.\d+)?$/.test(b) && normal(a) === normal(b);
const normal = (v: string) => { const [i, f = ''] = v.split('.'); return `${i!.replace(/^0+(?=\d)/, '')}.${f.replace(/0+$/, '')}`; };

/** A decimal of zero or more as the API takes it, or null when empty and allowed. Null when valid. */
export function countProblem(value: string, required = true): string | null {
	const v = value.trim();
	if (!v) return required ? 'Enter the count.' : null;
	if (v.length > 80 || !/^\d+(?:\.\d+)?$/.test(v)) return 'Use digits and an optional decimal point, zero or more.';
	return null;
}
/** What is wrong with an item's details (new or edited), in words; null when the API would take them. */
export function itemProblem(form: ItemDetails | NewItem): string | null {
	const n = form.name.trim(), l = form.location.trim(), u = form.unitLabel.trim();
	if (!n) return 'Enter the item’s name.';
	if ([...n].length > 200) return 'A name is at most 200 characters.';
	if (!l) return 'Enter where it is kept, or choose a location.';
	if ([...l].length > 200) return 'A location is at most 200 characters.';
	if (!u) return 'Enter the unit you count it in, such as bags or kg.';
	if ([...u].length > 80) return 'A unit is at most 80 characters.';
	if (countProblem(form.reorderPoint, false)) return 'Enter the reorder point as a number of zero or more, or leave it empty.';
	if ([...form.notes.trim()].length > 5000) return 'A note is at most 5,000 characters.';
	return null;
}

export const stockWrites = {
	stocktake: (scope: ReadScope, changeSetId: string, counts: readonly CountLine[]): Write<Taken> =>
		({ method: 'POST', path: organisationPath(scope.organisationId, 'stock', 'stocktake'), body: { changeSetId, counts: counts.map((c) => ({ itemId: uuid(c.itemId), expectedRevision: c.expectedRevision, count: c.count })) },
			parse: (v) => parseStocktake(v, { changeSetId, itemIds: counts.map((c) => c.itemId) }) }),
	add: (scope: ReadScope, changeSetId: string, form: NewItem): Write<StockItem & { changeSetId: string }> =>
		({ method: 'POST', path: organisationPath(scope.organisationId, 'stock'), body: { changeSetId, name: form.name.trim(), location: form.location.trim(), unitLabel: form.unitLabel.trim(),
			...(form.reorderPoint.trim() ? { reorderPoint: form.reorderPoint.trim() } : {}), ...(form.notes.trim() ? { notes: form.notes.trim() } : {}) },
			parse: (v) => parseStockWrite(v, { changeSetId, archived: false }) }),
	edit: (scope: ReadScope, item: StockItem, changeSetId: string, changes: DetailChanges): Write<StockItem & { changeSetId: string }> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'stock', uuid(item.id)), body: { changeSetId, expectedRevision: item.revision, ...changes },
			parse: (v) => parseStockWrite(v, { id: item.id, changeSetId }) }),
	archive: (scope: ReadScope, item: StockItem, changeSetId: string, archived: boolean): Write<StockItem & { changeSetId: string }> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'stock', uuid(item.id)), body: { changeSetId, expectedRevision: item.revision, archived },
			parse: (v) => parseStockWrite(v, { id: item.id, changeSetId, archived }) })
};

/** Refusals these writes document, in words (the saver's general copy covers the rest). */
export const stockRefusals: Readonly<Record<string, string>> = Object.freeze({
	stock_exists: 'An item with that name is already listed at that location. Check archived items too.',
	stock_unit_counted: 'This item has counts in its unit. Make a separate item to count in a different unit.',
	stock_archived: 'This item is archived. Restore it before changing or counting it.',
	stocktake_duplicate: 'An item was listed twice. Nothing was saved; save again.'
});

/** A count as the boards write it: digits grouped in threes ("4,200"), the decimals as typed. */
export function countWords(count: string): string {
	return count.replace(/^\d+/, (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}
/** Board 12's row detail: "11 bags · counted Mon 28 Sep by Tom", or "Not counted yet". */
export function lastCountWords(item: Pick<StockItem, 'currentCount' | 'countedAt' | 'countedByName' | 'unitLabel'>, zone?: string, year?: number): string {
	if (item.currentCount === null) return 'Not counted yet';
	const at = item.countedAt ? wordInstant(item.countedAt, zone, year) : null;
	return `${countWords(item.currentCount)} ${item.unitLabel}${at ? ` · counted ${at.day}` : ''}${item.countedByName ? ` by ${firstName(item.countedByName)}` : ''}`;
}

export type LocationGroup = { readonly location: string; readonly items: readonly StockItem[] };
/** Items grouped under their locations, locations and items in the list's order (location, then name), case and accents
 *  compared as people read them. */
const raw = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function groupByLocation(items: readonly StockItem[]): LocationGroup[] {
	const order = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
	const groups = new Map<string, StockItem[]>();
	for (const item of [...items].sort((a, b) => order.compare(a.location, b.location) || raw(a.location, b.location) || order.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))) {
		const rows = groups.get(item.location) ?? []; rows.push(item); groups.set(item.location, rows);
	}
	return [...groups].map(([location, rows]) => Object.freeze({ location, items: Object.freeze(rows) }));
}
