/** The five tabs, named once: the tab label, the page title and the URL are the same word. */
export type Tab = { href: string; label: string };
export const tabs: Tab[] = [
	{ href: '/', label: 'Today' },
	{ href: '/inbox', label: 'Inbox' },
	{ href: '/commitments', label: 'Commitments' },
	{ href: '/calendar', label: 'Calendar' },
	{ href: '/settings', label: 'Settings' }
];
export const here = (pathname: string, href: string) => href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
export function initialsOf(name: string, email: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return (email[0] ?? '?').toUpperCase();
	return ((words[0]![0] ?? '') + (words.length > 1 ? words[words.length - 1]![0] ?? '' : '')).toUpperCase();
}
