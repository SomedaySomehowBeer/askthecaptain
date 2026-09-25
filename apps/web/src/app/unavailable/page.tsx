import type { Metadata } from 'next';
import Link from 'next/link';
import { Captain } from '../../components/Captain.tsx';
import { safeReturn } from '../../lib/session-state.ts';

export const metadata: Metadata = { title: 'Service unavailable', robots: { index: false } };

/** Shown when a page could not check the session because the API did not answer usefully (it was
 *  unreachable, rate limited or failing). It deliberately reads nothing: no session check, so it
 *  cannot redirect anywhere, and the session cookie is left exactly as it was. */
export default async function UnavailablePage({ searchParams }: { searchParams: Promise<{ return_to?: string | string[] }> }) {
	const { return_to } = await searchParams;
	const back = safeReturn(typeof return_to === 'string' ? return_to : null);
	return (
		<main className="page page--narrow">
			<header className="stack">
				<Captain size={48} />
				<h1>Captain can’t reach its service right now</h1>
				<p>Your saved sign-in has been kept, but Captain can’t check it right now. This is usually brief, for example after a burst of requests or while the service restarts.</p>
			</header>
			<div className="card notice notice--attention" role="status">
				<p className="secondary">Try again in a moment. If you had just saved something, reopen it to check whether the change was recorded. If this keeps happening, the service may be down.</p>
				<div className="row">
					<a className="button button--primary" href={back}>Try again</a>
					{back !== '/work' ? <Link className="button button--ghost" href="/work">Go to Work</Link> : null}
				</div>
			</div>
		</main>
	);
}
