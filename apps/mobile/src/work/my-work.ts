import { myWorkPath, workPageSize, type ScopeIds } from '../api/paths.ts';

export type WorkTag = { readonly id: string; readonly name: string };
export type DueDate = { readonly year: number; readonly month: number; readonly day: number };
export type WorkRow = {
	readonly id: string; readonly displayTitle: string; readonly status: 'open'; readonly due: DueDate | null;
	readonly tags: readonly WorkTag[]; readonly tagCount: number;
};
export type WorkPage = { readonly rows: readonly WorkRow[]; readonly nextOffset: number | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (): never => { throw new TypeError('The work page could not be read.'); };
function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
	if (typeof value !== 'string' || !uuid.test(value)) return invalid();
	return value;
}

/** Keep only the displayed title. Count at most 301 code points; never split an emoji or copy an unbounded array. */
export function displayTitle(title: string): string {
	const trimmed = title.trim();
	if (!trimmed) return 'Untitled task';
	const kept: string[] = [];
	for (const character of trimmed) {
		if (kept.length === 300) return `${kept.slice(0, 299).join('')}…`;
		kept.push(character);
	}
	return kept.join('');
}

function parseDue(value: unknown): DueDate | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
	const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return invalid();
	return Object.freeze({ year, month, day });
}

/** Plain calendar components: no phone timezone, clock, Date or Intl. Inputs come from parseMyWorkPage. */
export function formatDue(due: DueDate | null): string {
	if (due === null) return 'No due date';
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `Due ${due.day} ${months[due.month - 1]} ${due.year}`;
}

/** Parse the existing tasks API, retaining only display data. Unknown fields are ignored. Every tag is validated,
 * including those beyond the three shown; neither the raw title nor the full tag array enters screen state.
 * Row and request counts are bounded; the transport's whole-response byte budget remains a separate readiness gate. */
export function parseMyWorkPage(value: unknown, request: { scope: ScopeIds; offset: number }): WorkPage {
	myWorkPath(request.scope, request.offset); // Validate the expected query, including the page cap.
	const page = record(value);
	if (!Array.isArray(page.tasks) || page.tasks.length > workPageSize) return invalid();
	if (page.nextOffset !== null && (page.nextOffset !== request.offset + workPageSize || page.tasks.length !== workPageSize)) return invalid();
	const ids = new Set<string>();
	const rows = Array.from(page.tasks, (value): WorkRow => {
		const task = record(value); const id = identifier(task.id);
		if (ids.has(id)) return invalid();
		ids.add(id);
		if (typeof task.title !== 'string' || task.status !== 'open' || task.ownerId !== request.scope.userId || !Array.isArray(task.tags)) return invalid();
		const tags: WorkTag[] = [];
		for (const value of task.tags) {
			const tag = record(value); const tagId = identifier(tag.id);
			if (typeof tag.name !== 'string' || tag.name.trim() !== tag.name || tag.name.length === 0) return invalid();
			let characters = 0;
			for (const _ of tag.name) { if (++characters > 60) return invalid(); }
			if (tags.length < 3) tags.push(Object.freeze({ id: tagId, name: tag.name }));
		}
		return Object.freeze({ id, displayTitle: displayTitle(task.title), status: 'open', due: parseDue(task.due), tags: Object.freeze(tags), tagCount: task.tags.length });
	});
	return Object.freeze({ rows: Object.freeze(rows), nextOffset: page.nextOffset as number | null });
}
