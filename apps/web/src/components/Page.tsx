import { redirect } from 'next/navigation';
import { Shell } from './Shell.tsx';
import { current, type Current } from '../lib/session.ts';

/** A signed-in page inside the shell. Without a session it goes to sign-in and comes back; without
 *  an organisation it goes to welcome. */
export async function requireCurrent(returnTo: string): Promise<Current & { organisation: NonNullable<Current['organisation']> }> {
	const me = await current();
	if (!me) redirect(`/sign-in?return_to=${encodeURIComponent(returnTo)}`);
	if (!me.organisation) redirect('/welcome');
	return me as Current & { organisation: NonNullable<Current['organisation']> };
}

export function Page({ title, lede, children }: { title: string; lede?: React.ReactNode; children: React.ReactNode }) {
	return (
		<Shell>
			<main className="page">
				<header><h1>{title}</h1>{lede ? <p>{lede}</p> : null}</header>
				{children}
			</main>
		</Shell>
	);
}
