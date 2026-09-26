/** The conversation list's URL (web plan §1, handoff §9): `/chat?filter=all|unread|starred&linked=true|false&work=…&team=…`.
 *  **About the work** lists linked conversations and pages with `work`; **Team conversations** lists unlinked ones and
 *  pages with `team`. `linked` narrows the page to one group. "More" in one group keeps the other group's place. Pure. */
import type { ListFilter } from './types.ts';

export type ChatListUrl = { ok: true; filter: ListFilter; linked: boolean | null; cursors: { work: string | null; team: string | null } } | { ok: false; problem: string };
export type ChatList = Omit<Extract<ChatListUrl, { ok: true }>, 'ok'>;
type Change = Partial<{ filter: ListFilter; linked: boolean | null; work: string | null; team: string | null }>;

const filters: readonly ListFilter[] = ['all', 'unread', 'starred'];
const known = new Set(['filter', 'linked', 'work', 'team']);
const cursorShape = /^[A-Za-z0-9_-]{1,300}$/;

export const filterWords: Record<ListFilter, string> = { all: 'All', unread: 'Unread', starred: 'Starred' };
export const groups = [
	{ key: 'work', linked: true, title: 'About the work' },
	{ key: 'team', linked: false, title: 'Team conversations' }
] as const;

export function parseChatListUrl(search: Record<string, string | string[] | undefined>): ChatListUrl {
	const value: Record<string, string> = {};
	for (const [key, raw] of Object.entries(search)) {
		if (raw === undefined) continue;
		if (!known.has(key)) return { ok: false, problem: `This link has a setting Chat does not use (“${key}”).` };
		if (Array.isArray(raw)) return { ok: false, problem: `This link sets “${key}” more than once.` };
		value[key] = raw;
	}
	const filter = value.filter ?? 'all';
	if (!filters.includes(filter as ListFilter)) return { ok: false, problem: 'This link asks for a list Chat does not have. Choose All, Unread or Starred.' };
	let linked: boolean | null = null;
	if (value.linked !== undefined) {
		if (value.linked !== 'true' && value.linked !== 'false') return { ok: false, problem: 'This link’s “linked” setting is not true or false.' };
		linked = value.linked === 'true';
	}
	const cursors = { work: value.work ?? null, team: value.team ?? null };
	for (const [key, cursor] of Object.entries(cursors)) if (cursor !== null && !cursorShape.test(cursor)) return { ok: false, problem: `This link’s “${key}” page could not be read.` };
	if (linked === true && cursors.team !== null) return { ok: false, problem: 'This link pages team conversations in a view that lists only conversations about the work.' };
	if (linked === false && cursors.work !== null) return { ok: false, problem: 'This link pages conversations about the work in a view that lists only team conversations.' };
	return { ok: true, filter: filter as ListFilter, linked, cursors };
}

/** A list link. Changing the filter or the linked view starts both groups from their first page. */
export function chatListHref(u: ChatList, change: Change = {}): string {
	const filter = change.filter ?? u.filter;
	const linked = change.linked !== undefined ? change.linked : u.linked;
	const reset = filter !== u.filter || linked !== u.linked;
	let work = change.work !== undefined ? change.work : reset ? null : u.cursors.work;
	let team = change.team !== undefined ? change.team : reset ? null : u.cursors.team;
	if (linked === true) team = null;
	if (linked === false) work = null;
	const query = new URLSearchParams();
	if (filter !== 'all') query.set('filter', filter);
	if (linked !== null) query.set('linked', String(linked));
	if (work) query.set('work', work);
	if (team) query.set('team', team);
	const text = query.toString();
	return text ? `/chat?${text}` : '/chat';
}

/** The groups a list shows: both, or only the one a linked view asks for. */
export const shownGroups = (u: ChatList) => groups.filter((g) => u.linked === null || g.linked === u.linked);

/** Chat views (`/chat/views`): each is a `(filter, linked)` pair; never a count. */
export const chatViewLinks: { label: string; detail: string; href: string; group: 'Conversations' | 'Linked to work' }[] = [
	{ group: 'Conversations', label: 'All conversations', detail: 'Every conversation you are in, newest activity first', href: '/chat' },
	{ group: 'Conversations', label: 'Unread', detail: 'Conversations with new messages', href: '/chat?filter=unread' },
	{ group: 'Conversations', label: 'Starred', detail: 'Your personal conversation bookmarks', href: '/chat?filter=starred' },
	{ group: 'Linked to work', label: 'Linked', detail: 'Conversations about a task or project', href: '/chat?linked=true' },
	{ group: 'Linked to work', label: 'Not linked', detail: 'Conversations with your teammates', href: '/chat?linked=false' }
];
