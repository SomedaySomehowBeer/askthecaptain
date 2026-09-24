'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { rememberedView, tabs, workspaceSection } from '../lib/nav.ts';

/* Rounded, repository-native workspace marks, following the reviewed mobile mockups. */
const marks: Record<string, React.ReactNode> = {
	Work: <><rect x="3" y="7" width="18" height="14" rx="4" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a22 22 0 0 0 18 0M10 13v2h4v-2" /></>,
	Chat: <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 2 1.6-5.3A8.5 8.5 0 1 1 20.5 11.5Z" />,
	Resources: <path d="M3 8V6a3 3 0 0 1 3-3h3l3 3h6a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8h18" />
};

/** Only route/filter state is retained, scoped to person and organisation. No business cache. */
export function TabBar({ variant, scope }: { variant: 'bottom' | 'top'; scope: string }) {
	const pathname = usePathname();
	const query = useSearchParams().toString();
	const section = workspaceSection(pathname);
	const [destinations, setDestinations] = useState<Record<string, string>>({});
	useEffect(() => {
		try {
			const key = `captain.views:${scope}:`;
			if (section && !pathname.endsWith('/views') && !pathname.endsWith('/new'))
				sessionStorage.setItem(key + section, pathname + (query ? `?${query}` : '') + window.location.hash);
			setDestinations(Object.fromEntries(tabs.map(tab => [tab.href, rememberedView(sessionStorage.getItem(key + tab.href), tab.href)])));
		} catch { setDestinations({}); }
	}, [pathname, query, scope, section]);
	return <nav className={variant === 'bottom' ? 'tabbar' : 'topnav'} aria-label="Workspace">
		{tabs.map(tab => <Link key={tab.href} href={destinations[tab.href] ?? tab.href}
			className={variant === 'bottom' ? 'tabbar__tab' : 'topnav__link'} aria-current={section === tab.href ? 'page' : undefined}>
			<svg className="tabbar__mark" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{marks[tab.label]}</svg>
			<span className="tabbar__label">{tab.label}</span>
		</Link>)}
	</nav>;
}
