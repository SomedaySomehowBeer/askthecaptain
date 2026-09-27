import { moreTags, ownerLabels, workViewCopy } from '../account/copy.ts';
import type { WorkView } from '../api/paths.ts';
import type { WebPath } from '../config.ts';
import { formatDue, type WorkRow } from './my-work.ts';

/** How one Work list view presents its rows and links (docs/plans/expo-mobile-all-tasks-read-2026-09.md §4.3, §5).
 *  Pure, and always given the screen's **bound** view, so rows read for one view are never described with another
 *  view's owner display or link.
 *  - My work never shows an owner (every row is the person's own).
 *  - All tasks shows exactly one owner fact per row: "Assigned to you", "Assigned to someone else" or "No owner". */

/** The row's second line: "Open", then the owner (All tasks only), then up to three tags and "+N more". */
export function rowDetail(row: WorkRow, view: WorkView): string {
	return [workViewCopy(view).open, ...ownerPart(row, view), ...tagParts(row)].join(' · ');
}

/** The row's accessibility label: title, "Open", the owner (All tasks only), the tags and the due date. */
export function rowLabel(row: WorkRow, view: WorkView): string {
	return [row.displayTitle, workViewCopy(view).open, ...ownerPart(row, view), ...tagParts(row), formatDue(row.due)].join(', ');
}

/** The fixed website path for the cap notice's link. Constants only: never built from input. */
export const capLink = (view: WorkView): WebPath => (view === 'all' ? '/work?owner=all' : '/work');

/** Test IDs per view: My work keeps its existing `work-…` IDs, All tasks uses `all-work-…`. */
export const testIdPrefix = (view: WorkView): string => (view === 'all' ? 'all-work' : 'work');

const ownerPart = (row: WorkRow, view: WorkView): string[] => (view === 'all' ? [ownerLabels[row.owner]] : []);
function tagParts(row: WorkRow): string[] {
	const extra = moreTags(row.tagCount, row.tags.length);
	return [...row.tags.map((tag) => tag.name), ...(extra === null ? [] : [extra])];
}
