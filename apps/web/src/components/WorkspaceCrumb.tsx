'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tabs, workspaceSection, routeParent } from '../lib/nav.ts';

export function WorkspaceCrumb({ parent }: { parent?: { href: string; label: string } }) {
	const pathname = usePathname();
	const section = workspaceSection(pathname);
	const label = tabs.find(tab => tab.href === section)?.label;
	const up = parent ?? routeParent(pathname);
	return <nav className="workspace-crumb" aria-label="Section navigation">
		{up ? <Link href={up.href} aria-label={`Back to ${up.label}`}><span aria-hidden="true">‹</span><span className="workspace-crumb__label">{up.label}</span></Link> : section ? <Link href={`${section}/views`} aria-label={`${label} views`}>
			{!pathname.endsWith('/views') ? <span aria-hidden="true">‹</span> : null}{label}
		</Link> : <Link href="/work/views">Work views</Link>}
	</nav>;
}
