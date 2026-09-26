import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Captain } from '../../components/Captain.tsx';
import { Notice } from '../../components/Notice.tsx';
import { api, load } from '../../lib/api.ts';
import { apiUrl } from '../../lib/env.ts';
import { readSession } from '../../lib/session.ts';
import { safeReturn } from '../../lib/session-state.ts';

export const metadata: Metadata = { title: 'Sign in' };

const said: Record<string, string> = {
	request_invalid: 'That sign-in link had expired. Start again.',
	google_failed: 'Google did not complete the sign-in. Try again.',
	exchange_failed: 'The sign-in could not be finished. Try again.',
	passkey_failed: 'The passkey could not be checked. Try again.'
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ return_to?: string | string[]; error?: string | string[] }> }) {
	const params = await searchParams;
	const session = await readSession();
	// One checked destination for the redirect, the Google start and the "Try again" link. A repeated
	// `return_to` arrives as an array and is refused like any other unusable value.
	const returnTo = safeReturn(params.return_to, '/');
	if (session.state === 'signed-in') redirect(returnTo);
	const providers = await load(() => api<{ google: boolean }>('/auth/providers'));
	const start = new URL('/auth/google/start', apiUrl); start.searchParams.set('return_to', returnTo);
	return (
		<main className="page page--narrow">
			<header className="stack">
				<Captain size={48} />
				<h1>Ask The Captain</h1>
				<p>A shared workspace for your business.</p>
			</header>
			{session.state === 'unavailable' ? <Notice tone="attention" title="Captain can’t check your session right now.">
				If you were signed in, your saved sign-in has been kept; Captain’s service did not answer, so it can’t check it. Try again in a moment.{' '}<a href={returnTo}>Try again</a></Notice> : null}
			{params.error ? <Notice tone="attention">{(typeof params.error === 'string' ? said[params.error] : undefined) ?? 'Sign-in did not finish. Try again.'}</Notice> : null}
			{!providers.ok ? <Notice tone="failed" title="Captain cannot reach its API.">Sign-in is not possible just now. Try again in a minute.</Notice>
				: !providers.value.google ? <Notice tone="attention" title="Sign-in is not set up.">Google sign-in has not been configured for this installation yet.</Notice>
				: <a className="button button--primary" href={start.toString()}>Continue with Google</a>}
			<p className="muted">Access is invite-only while Captain is in its first voyage.</p>
		</main>
	);
}
