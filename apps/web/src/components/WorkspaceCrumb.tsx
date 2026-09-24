'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tabs, workspaceSection } from '../lib/nav.ts';

export function WorkspaceCrumb() {
	const pathname = usePathname();
	const section = workspaceSection(pathname);
	const label = tabs.find(tab => tab.href === section)?.label;
	return <nav className="workspace-crumb" aria-label="Section navigation">
		{section ? <Link href={`${section}/views`} aria-label={`${label} views`}>
			{!pathname.endsWith('/views') ? <span aria-hidden="true">‹</span> : null}{label}
		</Link> : <Link href="/work/views">Work views</Link>}
	</nav>;
}
