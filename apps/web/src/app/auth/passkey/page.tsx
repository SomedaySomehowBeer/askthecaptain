import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Captain } from '../../../components/Captain.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { current } from '../../../lib/session.ts';
import { StepUp } from './StepUp.tsx';

export const metadata: Metadata = { title: 'Your passkey' };

/** Between Google and the session: this account has a passkey, so it must be presented. */
export default async function PasskeyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
	if (await current()) redirect('/');
	const { token } = await searchParams;
	return (
		<main className="page page--narrow">
			<header className="stack"><Captain size={48} /><h1>One more step</h1><p>This account is protected by a passkey. Confirm it is you.</p></header>
			{token && /^pks_[A-Za-z0-9_-]+$/.test(token) ? <StepUp token={token} /> : <Notice tone="attention" title="This sign-in link is not complete.">Start again from the sign-in page.</Notice>}
			<p className="muted"><a href="/sign-in">Back to sign in</a></p>
		</main>
	);
}
