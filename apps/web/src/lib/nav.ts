/** Workspace sections; existing record URLs keep their identity during migration (D11). The retired
 *  assistant pages (Today, Inbox, Calendar, Notes) belong to no section, so a tab never remembers them. */
export type Tab = { href: string; label: string };
export const tabs: Tab[] = [
	{ href: '/work', label: 'Work' },
	{ href: '/chat', label: 'Chat' },
	{ href: '/resources', label: 'Resources' }
];
export const here = (pathname: string, href: string) => href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
export function workspaceSection(pathname: string): string | null {
	if (here(pathname, '/chat')) return '/chat';
	if (here(pathname, '/resources') || here(pathname, '/settings/connections') || here(pathname, '/settings/contacts')) return '/resources';
	if (['/work', '/commitments'].some(path => here(pathname, path)) || pathname === '/') return '/work';
	return null;
}
/** Session storage is optional and untrusted: never turn a stored route into an external link. */
export function rememberedView(value: string | null, section: string): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return section;
	try {
		const url = new URL(value, 'https://captain.invalid');
		if (url.origin !== 'https://captain.invalid' || workspaceSection(url.pathname) !== section || url.pathname.endsWith('/views')) return section;
		return url.pathname + url.search + url.hash;
	} catch { return section; }
}
export function initialsOf(name: string, email: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return (email[0] ?? '?').toUpperCase();
	return ((words[0]![0] ?? '') + (words.length > 1 ? words[words.length - 1]![0] ?? '' : '')).toUpperCase();
}
