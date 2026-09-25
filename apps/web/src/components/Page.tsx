import { redirect } from 'next/navigation';
import { Shell } from './Shell.tsx';
import { readSession, type Current } from '../lib/session.ts';
import { unavailableHref } from '../lib/session-state.ts';

/** A signed-in person, or a redirect: to sign-in (and back) only when there is no session, and to
 *  the unavailable page when the API cannot say, so an outage never looks like a sign-out. */
export async function requireSignedIn(returnTo: string): Promise<Current> {
	const session = await readSession();
	if (session.state === 'unavailable') redirect(unavailableHref(returnTo));
	if (session.state === 'signed-out') redirect(`/sign-in?return_to=${encodeURIComponent(returnTo)}`);
	return session.current;
}

/** A signed-in page inside the shell. Without a session it goes to sign-in and comes back; without
 *  an organisation it goes to welcome; when the session cannot be checked, to the unavailable page. */
export async function requireCurrent(returnTo: string): Promise<Current & { organisation: NonNullable<Current['organisation']> }> {
	const me = await requireSignedIn(returnTo);
	if (!me.organisation) redirect('/welcome');
	return me as Current & { organisation: NonNullable<Current['organisation']> };
}

export function Page({ title, lede, children, hideTitle = false, parent, eyebrow }: { title: string; lede?: React.ReactNode; children: React.ReactNode; hideTitle?: boolean; eyebrow?: React.ReactNode; parent?: { href: string; label: string } }) {
	return (
		<Shell parent={parent}>
			<main className="page">
				<header className={hideTitle ? 'visually-hidden' : undefined}>{eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}<h1>{title}</h1>{lede ? <p>{lede}</p> : null}</header>
				{children}
			</main>
		</Shell>
	);
}
