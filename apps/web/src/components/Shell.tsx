import Link from 'next/link';
import { Captain } from './Captain.tsx';
import { TabBar } from './TabBar.tsx';
import { initialsOf } from '../lib/nav.ts';
import { current } from '../lib/session.ts';

/** The frame around every signed-in page: wordmark, the five areas, the person; on a phone the
 *  areas move to a bar at the bottom of the screen. */
export async function Shell({ children }: { children: React.ReactNode }) {
	const me = await current();
	return (
		<div className="shell">
			<header className="topbar">
				<Link className="wordmark" href="/"><Captain size={26} /><span className="wordmark__text">Ask The Captain</span></Link>
				<TabBar variant="top" />
				{me ? <Link className="avatar" href="/settings" aria-label={`${me.me.user.name || me.me.user.email}, settings`} title={me.me.user.email}>{initialsOf(me.me.user.name, me.me.user.email)}</Link> : null}
			</header>
			{children}
			<TabBar variant="bottom" />
		</div>
	);
}
