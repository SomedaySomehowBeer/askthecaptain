/** Personal saved Work views (D26; contract `docs/plans/saved-work-views-2026-09.md` §7). A saved
 *  view is a name plus a version-1 Work filter, evaluated for its owner when opened. Its URLs:
 *
 *    /work?view=<id>[&offset=<n>]
 *        the view unmodified: the server reads its current revision and applies exactly the stored
 *        filter. No filter parameter may appear beside it; if one does, the link is inconsistent.
 *    /work?view=<id>&base=<revision>&draft=1&owner=…&status=…&tagId=…&projectId=…[&offset=<n>]
 *        a draft changed from the view. Every filter key is written, normalised, with `tagId=none`
 *        and `projectId=none` for explicit clears; nothing is inherited from the stored view. `base`
 *        is the revision the draft began from and never moves while the person keeps editing.
 *    …&edit=1
 *        only ever produced by the no-JS filter form; the page redirects it to the complete draft URL.
 *
 *  Nothing here is guessed: what cannot be read is said, and never replaced with My work. */
import { maxOffset, maxTags, pageSize, statuses, statusWords, type Search, type StatusFilter, type WorkFilters } from './filters.ts';

export const filterVersion = 1;
export const maxViewName = 60;
export const viewPageSize = 50;
export const maxViewOffset = 1_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
/** The API's id check (zod 4 `uuid()`): an RFC 9562 version 1–8 and variant, or the nil/max UUIDs. View ids in
 *  links and client-made create ids use this, so a hand-made id the API would refuse reads as an invalid link. */
const rfcUuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
export const isViewId = (value: unknown): value is string => typeof value === 'string' && rfcUuid.test(value);

/** The stored version-1 filter: exactly these four keys, all required (§2). */
export type SavedFilter = { owner: 'me' | 'all'; status: StatusFilter; tagIds: string[]; projectId: string | null };
export type TagReference = { id: string; state: 'available'; name: string } | { id: string; state: 'missing' } | { id: string; state: 'unavailable' };
export type ProjectReference = null | { id: string; state: 'available'; name: string; projectState: 'proposed' | 'active' | 'archived' } | { id: string; state: 'missing' } | { id: string; state: 'unavailable' };
export type ViewReferences = { tags: TagReference[]; project: ProjectReference };
/** The API's `SavedView`. `filter` stays `unknown` until it has been read as version 1: a newer
 *  version is never cast into this client's shape. List rows carry no `references`; an inapplicable
 *  view's detail has `references: null`, and neither is inspected before `readView` says it applies. */
export type SavedView = { id: string; name: string; filterVersion: number; filter: unknown; applicable: boolean; reason: string | null; revision: number; createdAt: string; updatedAt: string; references?: ViewReferences | null };
export type SavedViewPage = { views: SavedView[]; nextOffset: number | null };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The normalised form the server stores: lower-cased UUIDs, tags unique and sorted. */
export function normaliseFilter(filter: { owner: SavedFilter['owner']; status: StatusFilter; tagIds: readonly string[]; projectId: string | null }): SavedFilter {
	return { owner: filter.owner, status: filter.status, tagIds: [...new Set(filter.tagIds.map((id) => id.toLowerCase()))].sort(byText), projectId: filter.projectId ? filter.projectId.toLowerCase() : null };
}
export const sameFilter = (a: SavedFilter, b: SavedFilter): boolean => {
	const x = normaliseFilter(a), y = normaliseFilter(b);
	return x.owner === y.owner && x.status === y.status && x.projectId === y.projectId && x.tagIds.length === y.tagIds.length && x.tagIds.every((id, i) => id === y.tagIds[i]);
};
export const filtersFor = (filter: SavedFilter, offset = 0): WorkFilters => ({ ...normaliseFilter(filter), offset });
export const savedFilterOf = (filters: WorkFilters): SavedFilter => normaliseFilter(filters);

/** A value as a version-1 filter, or why it is not one. Strict: four keys, no extras. */
export function readFilter(value: unknown): { ok: true; filter: SavedFilter } | { ok: false; problem: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'The saved filter is not an object.' };
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort(byText).join(',');
	if (keys !== 'owner,projectId,status,tagIds') return { ok: false, problem: 'The saved filter does not have the four version-1 keys.' };
	if (record.owner !== 'me' && record.owner !== 'all') return { ok: false, problem: 'The saved owner is not one Captain knows.' };
	if (!(statuses as readonly unknown[]).includes(record.status)) return { ok: false, problem: 'The saved status is not one Captain knows.' };
	if (!Array.isArray(record.tagIds) || !record.tagIds.every(isUuid) || record.tagIds.length > maxTags) return { ok: false, problem: 'The saved tags cannot be read.' };
	if (record.projectId !== null && !isUuid(record.projectId)) return { ok: false, problem: 'The saved project cannot be read.' };
	return { ok: true, filter: normaliseFilter({ owner: record.owner as SavedFilter['owner'], status: record.status as StatusFilter, tagIds: record.tagIds as string[], projectId: record.projectId as string | null }) };
}

/** What this client can do with a view it read. Only an applicable version-1 view is opened. */
export type ViewReading = { ok: true; filter: SavedFilter } | { ok: false; state: 'newer'; reason: string } | { ok: false; state: 'unreadable'; reason: string };
export function readView(view: SavedView): ViewReading {
	// Only a later filter version "needs a newer Captain"; an inapplicable version-1 (or odd) filter could not be read.
	const newer = Number.isInteger(view.filterVersion) && view.filterVersion > filterVersion;
	if (!view.applicable) return newer
		? { ok: false, state: 'newer', reason: view.reason ?? 'This view was saved by a newer version of Captain.' }
		: { ok: false, state: 'unreadable', reason: view.reason ?? 'This view’s saved filter could not be read.' };
	if (newer) return { ok: false, state: 'newer', reason: `This view uses filter version ${view.filterVersion}; this version of Captain reads version ${filterVersion}.` };
	if (view.filterVersion !== filterVersion) return { ok: false, state: 'unreadable', reason: 'This view’s saved filter version cannot be read.' };
	const filter = readFilter(view.filter);
	return filter.ok ? filter : { ok: false, state: 'unreadable', reason: filter.problem };
}

/** A view name as the API accepts it: trimmed, 1 to 60 characters. */
export function viewName(value: unknown): string | { error: string } {
	const name = String(value ?? '').trim();
	if (!name) return { error: 'Give the view a name.' };
	if (name.length > maxViewName) return { error: `Keep the view name to ${maxViewName} characters.` };
	return name;
}

/** Who a page was rendered for. Client components carry it (never a token) and every saved-view action checks it
 *  against the session it is about to use, so a tab opened for one person or organisation never writes into another
 *  after the shared organisation cookie changes. */
export type ViewScope = { userId: string; organisationId: string };
export const sameScope = (expected: unknown, actual: ViewScope): boolean => {
	if (!expected || typeof expected !== 'object') return false;
	const { userId, organisationId } = expected as Record<string, unknown>;
	return typeof userId === 'string' && typeof organisationId === 'string'
		&& userId.toLowerCase() === actual.userId.toLowerCase() && organisationId.toLowerCase() === actual.organisationId.toLowerCase();
};
export const scopeKey = (scope: ViewScope): string => `${scope.userId.toLowerCase()}:${scope.organisationId.toLowerCase()}`;

/** After an uncertain filter save sent with `expectedRevision = sent` (the draft's base, or the revision an explicit
 *  Replace was sent against), what a fresh read of the view says about it. */
export function reconcileFilterSave(sent: number, draft: SavedFilter, view: SavedView): 'saved' | 'not-saved' | 'changed' {
	const stored = readView(view);
	if (view.revision > sent && stored.ok && sameFilter(stored.filter, draft)) return 'saved';
	if (view.revision === sent) return 'not-saved';
	return 'changed';
}
/** After an uncertain rename sent against `sent`: a later revision carrying the sent name means it landed. */
export function reconcileRename(sent: number, name: string, view: SavedView | null): 'saved' | 'not-saved' | 'changed' {
	if (!view) return 'changed';
	if (view.revision > sent && view.name === name) return 'saved';
	if (view.revision === sent) return 'not-saved';
	return 'changed';
}

// URLs

export const savedHref = (viewId: string, offset = 0): string => `/work?view=${viewId}${offset ? `&offset=${offset}` : ''}`;
/** The complete draft URL. Every key is explicit so a cleared value cannot read as "keep the saved one". */
export function draftHref(viewId: string, base: number, filter: SavedFilter, offset = 0): string {
	const next = normaliseFilter(filter);
	const query = new URLSearchParams({ view: viewId, base: String(base), draft: '1', owner: next.owner, status: next.status });
	if (next.tagIds.length) for (const id of next.tagIds) query.append('tagId', id); else query.set('tagId', 'none');
	query.set('projectId', next.projectId ?? 'none');
	if (offset) query.set('offset', String(offset));
	return `/work?${query}`;
}
/** A change to a draft keeps its view and `base`, and goes back to the first page unless paging. */
export const draftChange = (viewId: string, base: number, filter: SavedFilter, change: Partial<SavedFilter> & { offset?: number } = {}): string => {
	const { offset = 0, ...rest } = change;
	return draftHref(viewId, base, { ...filter, ...rest }, offset);
};

export type WorkUrl =
	| { mode: 'plain' }
	| { mode: 'saved'; viewId: string; offset: number }
	| { mode: 'draft'; viewId: string; base: number; filter: SavedFilter; offset: number }
	| { mode: 'edit'; viewId: string; href: string }
	| { mode: 'inconsistent'; viewId: string }
	| { mode: 'invalid'; viewId: string | null; problems: string[] };

const all = (value: string | string[] | undefined): string[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const filterKeys = ['owner', 'status', 'tagId', 'projectId'] as const;
const has = (search: Search, key: string) => all(search[key]).length > 0;

function readOffset(search: Search, problems: string[]): number {
	const values = all(search.offset);
	if (values.length > 1) { problems.push('Choose one page, not several.'); return 0; }
	const text = values[0] ?? '0';
	const offset = Number(text);
	if (!/^\d{1,7}$/.test(text) || offset % pageSize !== 0 || offset > maxOffset) { problems.push('That page does not exist.'); return 0; }
	return offset;
}
function readBase(search: Search, problems: string[]): number {
	const values = all(search.base);
	const text = values.length === 1 ? values[0]! : '';
	const base = Number(text);
	if (!/^[1-9]\d{0,9}$/.test(text) || base > 2_147_483_647) { problems.push('The draft does not say which saved version it began from.'); return 0; }
	return base;
}
function one(search: Search, key: string, problems: string[], words: string): string | undefined {
	const values = all(search[key]);
	if (values.length !== 1) { problems.push(values.length ? `Choose one ${words}, not ${values.length}.` : `The draft does not say which ${words} it uses.`); return undefined; }
	return values[0];
}

/** Which kind of Work URL this is. `plain` is the ordinary filter URL, read by `parseFilters`. */
export function parseWorkUrl(search: Search): WorkUrl {
	const views = all(search.view);
	if (views.length === 0) {
		if (has(search, 'base') || has(search, 'draft') || has(search, 'edit'))
			return { mode: 'invalid', viewId: null, problems: ['This link describes a change to a saved view but does not name the view.'] };
		return { mode: 'plain' };
	}
	const named = views[0];
	if (views.length > 1 || !isViewId(named)) return { mode: 'invalid', viewId: null, problems: ['That saved view reference is not valid.'] };
	const viewId = named.toLowerCase();
	const problems: string[] = [];

	if (has(search, 'edit')) {
		// The filter form: absent tags mean none, "Any project" means none. Only a complete draft URL leaves here.
		const base = readBase(search, problems);
		const owner = one(search, 'owner', problems, 'owner');
		const status = one(search, 'status', problems, 'status');
		const tagIds = all(search.tagId).filter((id) => id !== '' && id !== 'none');
		const projectValues = all(search.projectId).filter((id) => id !== '' && id !== 'none');
		if (owner !== undefined && owner !== 'me' && owner !== 'all') problems.push('Owner must be "me" or "all".');
		if (status !== undefined && !(statuses as readonly string[]).includes(status)) problems.push(`"${status.slice(0, 40)}" is not a task status.`);
		if (!tagIds.every(isUuid)) problems.push('A tag reference is not valid.');
		if (new Set(tagIds.map((id) => id.toLowerCase())).size > maxTags) problems.push(`Choose at most ${maxTags} tags.`);
		if (projectValues.length > 1) problems.push('Choose one project.');
		if (projectValues.some((id) => !isUuid(id))) problems.push('That project reference is not valid.');
		if (problems.length) return { mode: 'invalid', viewId, problems };
		const filter = normaliseFilter({ owner: owner as SavedFilter['owner'], status: status as StatusFilter, tagIds, projectId: projectValues[0] ?? null });
		return { mode: 'edit', viewId, href: draftHref(viewId, base, filter) };
	}

	if (has(search, 'draft')) {
		if (all(search.draft).join() !== '1') problems.push('That draft marker is not one Captain writes.');
		const base = readBase(search, problems);
		const owner = one(search, 'owner', problems, 'owner');
		const status = one(search, 'status', problems, 'status');
		const project = one(search, 'projectId', problems, 'project');
		const tagValues = all(search.tagId);
		if (owner !== undefined && owner !== 'me' && owner !== 'all') problems.push('Owner must be "me" or "all".');
		if (status !== undefined && !(statuses as readonly string[]).includes(status)) problems.push(`"${status.slice(0, 40)}" is not a task status.`);
		if (project !== undefined && project !== 'none' && !isUuid(project)) problems.push('That project reference is not valid.');
		let tagIds: string[] = [];
		if (tagValues.length === 0) problems.push('The draft does not say which tags it uses.');
		else if (tagValues.includes('none')) { if (tagValues.length > 1) problems.push('The draft both clears its tags and names some.'); }
		else if (!tagValues.every(isUuid)) problems.push('A tag reference is not valid.');
		else tagIds = tagValues;
		if (new Set(tagIds.map((id) => id.toLowerCase())).size > maxTags) problems.push(`Choose at most ${maxTags} tags.`);
		const offset = readOffset(search, problems);
		if (problems.length) return { mode: 'invalid', viewId, problems };
		const filter = normaliseFilter({ owner: owner as SavedFilter['owner'], status: status as StatusFilter, tagIds, projectId: project === 'none' ? null : project! });
		return { mode: 'draft', viewId, base, filter, offset };
	}

	// The unmodified view carries no filter: anything beside it would be quietly ignored or quietly mixed.
	if (filterKeys.some((key) => has(search, key)) || has(search, 'base')) return { mode: 'inconsistent', viewId };
	const offset = readOffset(search, problems);
	if (problems.length) return { mode: 'invalid', viewId, problems };
	return { mode: 'saved', viewId, offset };
}

// Words

export type Labels = { tag: (id: string) => string; project: (id: string) => string };
/** The filter in words, in the order owner · tags · status · project, e.g.
 *  "Assigned to you · Tag: Production · Open · Any project". Every term is said, including "Any tag". */
export function describeFilter(filter: SavedFilter, labels: Labels): string {
	const tags = filter.tagIds.map(labels.tag);
	return [
		filter.owner === 'me' ? 'Assigned to you' : 'Everyone',
		tags.length === 0 ? 'Any tag' : `${tags.length === 1 ? 'Tag' : 'Tags'}: ${tags.join(', ')}`,
		statusWords[filter.status],
		filter.projectId ? `Project: ${labels.project(filter.projectId)}` : 'Any project'
	].join(' · ');
}

/** Labels from the view's resolved references first. `missing` and `unavailable` are different
 *  things and read differently; a tag the references do not mention falls back to the loaded list. */
export function referenceLabels(references: ViewReferences | null | undefined, listed: { tags: Map<string, string>; projects: Map<string, string> }): Labels {
	const tags = new Map((references?.tags ?? []).map((ref) => [ref.id.toLowerCase(), ref]));
	const project = references?.project ?? null;
	return {
		tag: (id) => {
			const ref = tags.get(id.toLowerCase());
			if (ref?.state === 'available') return ref.name;
			if (ref?.state === 'missing') return 'Missing tag';
			return listed.tags.get(id) ?? listed.tags.get(id.toLowerCase()) ?? (ref?.state === 'unavailable' ? 'Tag name unavailable' : 'Selected tag');
		},
		project: (id) => {
			if (project && project.id.toLowerCase() === id.toLowerCase()) {
				if (project.state === 'available') return project.projectState === 'active' ? project.name : `${project.name} (${project.projectState})`;
				if (project.state === 'missing') return 'Missing project';
				return listed.projects.get(id) ?? 'Project name unavailable';
			}
			return listed.projects.get(id) ?? 'Selected project';
		}
	};
}

/** What the page says about references it could not name. Filters are never relaxed because of them. */
export function referenceNotes(references: ViewReferences | null | undefined): string[] {
	if (!references) return [];
	const notes: string[] = [];
	const missing = references.tags.filter((ref) => ref.state === 'missing').length;
	if (missing) notes.push(`${missing === 1 ? 'A tag' : `${missing} tags`} in this view no longer ${missing === 1 ? 'exists' : 'exist'}. The view still filters by ${missing === 1 ? 'it' : 'them'}, so it may show fewer tasks.`);
	if (references.tags.some((ref) => ref.state === 'unavailable')) notes.push('Tag names could not be read; the view still filters by them.');
	if (references.project?.state === 'missing') notes.push('The project in this view no longer exists. The view still filters by it, so it may show no tasks.');
	if (references.project?.state === 'unavailable') notes.push('The project name could not be read; the view still filters by it.');
	return notes;
}

/** List rows have no references: names come from whatever list page was loaded, otherwise a count.
 *  This is display only and never used to decide that something is missing. */
export function describeRow(view: SavedView, listed: { tags: Map<string, string>; projects: Map<string, string> }): string {
	const reading = readView(view);
	if (!reading.ok) return reading.state === 'newer' ? 'Needs a newer version of Captain' : 'This view cannot be read';
	const { filter } = reading;
	const known = filter.tagIds.map((id) => listed.tags.get(id)).filter((name): name is string => !!name);
	const tags = filter.tagIds.length === 0 ? 'Any tag' : known.length === filter.tagIds.length ? `${known.length === 1 ? 'Tag' : 'Tags'}: ${known.join(', ')}` : `${filter.tagIds.length} ${filter.tagIds.length === 1 ? 'tag' : 'tags'}`;
	const project = filter.projectId ? `Project: ${listed.projects.get(filter.projectId) ?? 'one project'}` : null;
	return [tags, filter.owner === 'me' ? 'Assigned to you' : 'Everyone', statusWords[filter.status], project].filter(Boolean).join(' · ');
}

/** The Work views page's own offset, or null when it is not a page the list can have. */
export function parseViewOffset(value: string | string[] | undefined): number | null {
	if (value === undefined || value === '') return 0;
	if (Array.isArray(value) || !/^\d{1,7}$/.test(value)) return null;
	const offset = Number(value);
	return offset <= maxViewOffset && offset % viewPageSize === 0 ? offset : null;
}
const viewCursorOk = (value: number) => Number.isInteger(value) && value >= 0 && value <= maxViewOffset && value % viewPageSize === 0;
/** The Work views page with both of its independent group cursors: `offset` (private Saved views) and `tagOffset`
 *  (By tag). Every link one group writes carries the other group's current cursor, so paging one never resets the
 *  other. A cursor passed as null is left out (that group shows its first page); one outside the bounds a list can
 *  have makes the whole link null, so no page writes a link to a page that cannot exist. */
export function viewsHref(offset: number | null, tagOffset: number | null): string | null {
	if ((offset !== null && !viewCursorOk(offset)) || (tagOffset !== null && !viewCursorOk(tagOffset))) return null;
	const query = new URLSearchParams();
	if (offset) query.set('offset', String(offset));
	if (tagOffset) query.set('tagOffset', String(tagOffset));
	const text = query.toString();
	return text ? `/work/views?${text}` : '/work/views';
}
/** A Saved views page link; kept for existing callers. Pass the By tag cursor to preserve it. */
export const viewPageHref = (offset: number | null, tagOffset: number | null = null): string | null =>
	offset === null ? null : viewsHref(offset, tagOffset);
