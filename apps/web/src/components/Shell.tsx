import Link from 'next/link';
import { Suspense } from 'react';
import { WorkspaceCrumb } from './WorkspaceCrumb.tsx';
import { TabBar } from './TabBar.tsx';
import { initialsOf } from '../lib/nav.ts';
import { current } from '../lib/session.ts';

/** Three shared workspace sections, with account controls outside the primary navigation. */
export async function Shell({ children }: { children: React.ReactNode }) {
	const me = await current();
	const scope = `${me?.me.user.id ?? 'signed-out'}:${me?.organisation?.organisationId ?? 'no-organisation'}`;
	return (
		<div className="shell">
			<header className="topbar">
				<WorkspaceCrumb />
				<Suspense><TabBar variant="top" scope={scope} /></Suspense>
				{me ? <Link className="avatar" href="/settings" aria-label={`${me.me.user.name || me.me.user.email}, settings`} title={me.me.user.email}>{initialsOf(me.me.user.name, me.me.user.email)}</Link> : null}
			</header>
			{children}
			<Suspense><TabBar variant="bottom" scope={scope} /></Suspense>
		</div>
	);
}
