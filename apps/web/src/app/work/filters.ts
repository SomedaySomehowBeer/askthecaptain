/** The Work list's URL is its state (plan §10: meaningful URLs and browser history). Defaults are left
 *  out of the URL, so `/work` is My work: open tasks assigned to the person looking.
 *
 *    owner=me|all          whose tasks; `me` by default
 *    status=open|in_progress|suggested|done|cancelled|all
 *                          `open` by default; `all` is every status except cancelled
 *    tagId=<uuid>          repeatable; a task carrying any selected tag matches
 *    projectId=<uuid>      one project
 *    offset=<n>            where the page starts, in steps of the page size
 *
 *  Different filters combine with AND. */
export const pageSize = 50;
export const statuses = ['open', 'in_progress', 'suggested', 'done', 'cancelled', 'all'] as const;
export type StatusFilter = (typeof statuses)[number];
export const statusWords: Record<StatusFilter, string> = {
	open: 'Open', in_progress: 'In progress', suggested: 'Suggested', done: 'Done', cancelled: 'Cancelled', all: 'Any status but cancelled'
};
export type WorkFilters = { owner: 'me' | 'all'; status: StatusFilter; tagIds: string[]; projectId: string | null; offset: number };
export const defaultFilters: WorkFilters = { owner: 'me', status: 'open', tagIds: [], projectId: null, offset: 0 };
/** The API accepts at most this many tag ids in one query, and no offset beyond this. */
export const maxTags = 20;
export const maxOffset = 1_000_000;

export type Search = Record<string, string | string[] | undefined>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const list = (value: string | string[] | undefined): string[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Read the URL, or say in words what about it could not be read. Nothing is guessed. */
export function parseFilters(search: Search): { ok: true; filters: WorkFilters } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const single = (name: string): string | undefined => {
		// An empty field from the filter form (for example "Any project") means no filter.
		const values = list(search[name]).filter((value) => value !== '');
		if (values.length > 1) problems.push(`Choose one ${name}, not ${values.length}.`);
		return values[0];
	};
	const owner = single('owner') ?? 'me';
	if (owner !== 'me' && owner !== 'all') problems.push('Owner must be "me" or "all".');
	const status = single('status') ?? 'open';
	if (!(statuses as readonly string[]).includes(status)) problems.push(`"${status.slice(0, 40)}" is not a task status.`);
	const projectId = single('projectId') ?? null;
	if (projectId !== null && !uuid.test(projectId)) problems.push('That project reference is not valid.');
	const tagIds = [...new Set(list(search.tagId))];
	if (tagIds.some((id) => !uuid.test(id))) problems.push('A tag reference is not valid.');
	if (tagIds.length > maxTags) problems.push(`Choose at most ${maxTags} tags.`);
	const offsetText = single('offset') ?? '0';
	const offset = Number(offsetText);
	if (!/^\d{1,7}$/.test(offsetText) || offset % pageSize !== 0 || offset > maxOffset) problems.push('That page does not exist.');
	if (problems.length) return { ok: false, problems };
	return { ok: true, filters: { owner: owner as WorkFilters['owner'], status: status as StatusFilter, tagIds, projectId, offset } };
}

/** The `/work` URL for these filters; defaults are omitted so the plain URL stays My work. */
export function workHref(filters: WorkFilters, change: Partial<WorkFilters> = {}): string {
	const next = { ...filters, offset: 0, ...change };
	const query = new URLSearchParams();
	if (next.owner !== defaultFilters.owner) query.set('owner', next.owner);
	if (next.status !== defaultFilters.status) query.set('status', next.status);
	for (const id of next.tagIds) query.append('tagId', id);
	if (next.projectId) query.set('projectId', next.projectId);
	if (next.offset) query.set('offset', String(next.offset));
	const text = query.toString();
	return text ? `/work?${text}` : '/work';
}

/** The same filters as the API's work query (`GET /v1/organisations/:id/tasks`). */
export function apiQuery(filters: WorkFilters, userId: string): string {
	const query = new URLSearchParams();
	if (filters.owner === 'me') query.set('ownerId', userId);
	if (filters.status !== 'all') query.set('status', filters.status);
	for (const id of filters.tagIds) query.append('tagId', id);
	if (filters.projectId) query.set('projectId', filters.projectId);
	query.set('offset', String(filters.offset));
	query.set('limit', String(pageSize));
	return query.toString();
}

/** Selected tags the loaded tag list does not show (beyond its first page, renamed away, deleted,
 *  or the list failed to load). They stay selected, and visible, until a person removes them. */
export const unlistedTags = (selected: string[], listed: { id: string }[] | null): string[] =>
	selected.filter((id) => !listed?.some((tag) => tag.id === id));

type NamedProject = { name: string; state: 'proposed' | 'active' | 'archived' };
/** What a selected project is called in the filter, saying so when it cannot be offered as a choice. */
export function projectLabel(project: NamedProject | undefined): string {
	if (!project) return 'Unknown project';
	const name = project.name;
	return project.state === 'active' ? name : `${name} (${project.state})`;
}

/** The next page's link, unless the API could not serve it. */
export const nextHref = (filters: WorkFilters, nextOffset: number | null): string | null =>
	nextOffset === null || nextOffset > maxOffset ? null : workHref(filters, { offset: nextOffset });

export const isDefault = (filters: WorkFilters) =>
	filters.owner === 'me' && filters.status === 'open' && filters.tagIds.length === 0 && !filters.projectId;
