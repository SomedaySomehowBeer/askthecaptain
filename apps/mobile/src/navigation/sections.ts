/** The three workspace sections and their grouped view lists (plan D11; contract §6; mockup README "Three sections
 *  and their view lists"). Pure data: no React Native import, so the node tests read it directly.
 *
 *  Only views this build can show have a route. The rest are listed, marked unavailable and cannot be opened: only implemented reads are available, and no fictional records appear. */
export type SectionKey = 'work' | 'chat' | 'resources';
export type ViewRow = { label: string; detail: string; href: string | null };
export type ViewGroup = { title: string; rows: ViewRow[] };
export type Section = {
	key: SectionKey; label: string; href: string; viewsHref: string;
	/** The accessible name of the untitled view list; the page shows no visible title. */
	viewsLabel: string; groups: ViewGroup[];
};

const soon = 'Not available in this build yet';

export const sections: readonly Section[] = [
	{
		key: 'work', label: 'Work', href: '/work', viewsHref: '/work/views', viewsLabel: 'Work views',
		groups: [
			{ title: 'For you', rows: [
				{ label: 'My work', detail: 'Assigned to you, across all tags', href: '/work' },
				{ label: 'All tasks', detail: 'Open tasks assigned to anyone', href: '/work/all' }
			] },
			{ title: 'Across the business', rows: [{ label: 'By tag', detail: soon, href: null }] },
			{ title: 'Saved views', rows: [{ label: 'Your saved views', detail: `${soon}. Save views on the web.`, href: null }] }
		]
	},
	{
		key: 'chat', label: 'Chat', href: '/chat', viewsHref: '/chat/views', viewsLabel: 'Chat views',
		groups: [
			{ title: 'Conversations', rows: [
				{ label: 'All conversations', detail: 'Every conversation you take part in', href: '/chat' },
				{ label: 'Unread', detail: soon, href: null },
				{ label: 'Starred', detail: soon, href: null }
			] }
		]
	},
	{
		key: 'resources', label: 'Resources', href: '/resources', viewsHref: '/resources/views', viewsLabel: 'Resources views',
		groups: [
			{ title: 'Planning', rows: [{ label: 'Equipment schedule', detail: 'Bookings and maintenance', href: '/resources' }] },
			{ title: 'Libraries', rows: [
				{ label: 'Inventory', detail: 'Counted stock', href: '/resources/inventory' },
				{ label: 'Files & assets', detail: 'Not available yet', href: null }
			] }
		]
	}
];

export const sectionOf = (key: SectionKey): Section => sections.find((s) => s.key === key)!;
