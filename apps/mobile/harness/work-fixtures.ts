/** Synthetic My work answers for the test harness (docs/plans/expo-mobile-my-work-read-2026-09.md §3.7). Not a route.
 *  Each is a raw body in the API's own shape (with unknown fields, so the real parser's filtering runs in the browser),
 *  passed through the screen's own `parse`. Titles and tag names are synthetic, contain no digits, and are outside the
 *  fictional mockup names the browser check forbids. Only due dates contain digits.
 *
 *  Task at global index n (page offset + position): id `00000000-0000-4000-8000-{n, 12 digits}`, title
 *  `Sample task {code}` where code is two capital letters (AA, AB, … AZ, BA, …), except:
 *  - index 0: title `Sample task AA`, due `2026-10-03`, five tags (Alpha, Bravo, Charlie, Delta, Echo);
 *  - index 1: a title of 423 characters (`Sample long title ` then `word ` × 81), shown trimmed and cut to 299 characters
 *    plus `…` (`expectedRows.long`);
 *  - index 2: a blank stored title, shown as `Untitled task`.
 *  Every other task has no due date and no tags. */

export const fixtureTags = Object.freeze(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((name, i) =>
	Object.freeze({ id: `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`, name })));

export const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const taskCode = (n: number) => `${String.fromCharCode(65 + Math.floor(n / 26) % 26)}${String.fromCharCode(65 + (n % 26))}`;
export const longTitle = `Sample long title ${'word '.repeat(81)}`;

/** What the screen shows for the three special rows (for the browser check). */
export const expectedRows = Object.freeze({
	first: Object.freeze({ title: 'Sample task AA', detail: 'Open · Alpha · Bravo · Charlie · +2 more', due: 'Due 3 Oct 2026' }),
	long: Object.freeze({ title: `${Array.from(longTitle.trim()).slice(0, 299).join('')}…`, detail: 'Open', due: 'No due date' }),
	blank: Object.freeze({ title: 'Untitled task', detail: 'Open', due: 'No due date' })
});

function task(n: number, ownerId: string) {
	const title = n === 0 ? 'Sample task AA' : n === 1 ? longTitle : n === 2 ? '   ' : `Sample task ${taskCode(n)}`;
	return {
		id: taskId(n), projectId: null, seriesId: null, revision: 1, title, ownerId, status: 'open',
		due: n === 0 ? '2026-10-03' : null, tags: n === 0 ? fixtureTags.map((t) => ({ ...t })) : [], unexpected: 'ignored'
	};
}

/** The resolutions a pending read can be given (harness controls `harness-read-{name}`). */
export const readControls = ['ok-page', 'ok-last', 'ok-overlap', 'empty', 'unavailable', 'unavailable-wait', 'refused-404', 'refused-400', 'unauthorised', 'client-bug'] as const;
export type ReadControl = (typeof readControls)[number];

/** The raw body for a body-carrying control, for a read at `offset` by `ownerId`:
 *  - `ok-page`: 50 tasks from index `offset`, `nextOffset` = offset + 50;
 *  - `ok-last`: 3 tasks from index `offset`, `nextOffset` null;
 *  - `ok-overlap`: 50 tasks from index `offset − 25` (0 at the first page), `nextOffset` = offset + 50, so 25 of them
 *    repeat the previous page and are dropped;
 *  - `empty`: no tasks, `nextOffset` null. */
export function fixtureBody(control: 'ok-page' | 'ok-last' | 'ok-overlap' | 'empty', offset: number, ownerId: string): unknown {
	const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => task(from + i, ownerId));
	if (control === 'empty') return { tasks: [], nextOffset: null, unexpected: 'ignored' };
	if (control === 'ok-last') return { tasks: range(offset, 3), nextOffset: null };
	if (control === 'ok-overlap') return { tasks: range(Math.max(0, offset - 25), 50), nextOffset: offset + 50 };
	return { tasks: range(offset, 50), nextOffset: offset + 50 };
}
