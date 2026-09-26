/** "By tag" Work navigation (contract `docs/plans/default-business-views-2026-09.md`, adopted in #158). Every
 *  organisation tag is a plain Work link by ID to Everyone · that tag · Open. Nothing is stored, seeded or matched
 *  by name: a row shows the tag's current name and links to its ID, so renames need nothing. */
import { isDefault, type WorkFilters } from './filters.ts';
import type { Tag } from './types.ts';

/** What every By tag row says under the tag's name. */
export const tagRowDetail = 'Everyone · Open';

/** The plain Work URL for one tag: owner all, the default status (Open), no project. By ID, never by name. */
export const tagViewHref = (tagId: string): string => `/work?owner=all&tagId=${encodeURIComponent(tagId)}`;

/** The tag whose name may title a plain Work page, or null. Only Everyone · Open · exactly one tag · no project
 *  qualifies (the task-result offset does not matter), and only when that exact ID is in the tag data the page
 *  actually loaded. A failed tag read (`loaded` null), a tag beyond the loaded page or an ID that does not resolve
 *  gives null: the page keeps "All tasks" and the selected-tag chip. The name is never found by matching names. */
export function tagHeading(filters: WorkFilters, loaded: readonly Tag[] | null): string | null {
	if (!loaded) return null;
	if (filters.owner !== 'all' || filters.status !== 'open' || filters.projectId !== null || filters.tagIds.length !== 1) return null;
	const id = filters.tagIds[0]!;
	return loaded.find((tag) => tag.id === id)?.name ?? null;
}

export type WorkHeading = { title: string; eyebrow?: string };
/** The Work page's title. A saved view or its draft is always titled by the view, never reinterpreted as a tag
 *  view; only a plain filter URL can take a tag's name, under `tagHeading`'s rule. */
export function workHeading(input:
	| { mode: 'plain'; filters: WorkFilters; loadedTags: readonly Tag[] | null }
	| { mode: 'saved' | 'draft'; viewName: string }): WorkHeading {
	if (input.mode !== 'plain') return { title: input.viewName, eyebrow: input.mode === 'saved' ? 'Saved view' : 'Saved view · unsaved changes' };
	const tag = tagHeading(input.filters, input.loadedTags);
	if (tag !== null) return { title: tag, eyebrow: 'Tag' };
	if (isDefault(input.filters)) return { title: 'My work' };
	return { title: input.filters.owner === 'me' ? 'Assigned to you' : 'All tasks' };
}
