import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Captain } from '../../../components/Captain.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, ApiError, type Membership } from '../../../lib/api.ts';
import { cookieOptions, organisationCookie, readSession } from '../../../lib/session.ts';

export const metadata: Metadata = { title: 'Invitation' };

/** The invitee arrives with a token. They sign in first (the API insists the signed-in email is the
 *  invited one), then the invitation is accepted on the server and they land on Work. */
export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
	const { token } = await searchParams;
	if (!token) return <Refusal>This link is missing its invitation.</Refusal>;
	const here = `/invitations/accept?token=${encodeURIComponent(token)}`;
	const session = await readSession();
	// An unanswered session check keeps the invitation link on screen to retry, not a sign-in loop.
	if (session.state === 'unavailable') return <Refusal retry={here}>Captain could not reach its service to check your session. Your saved sign-in has been kept; try again in a moment.</Refusal>;
	if (session.state === 'signed-out') redirect(`/sign-in?return_to=${encodeURIComponent(here)}`);
	const me = session.current;
	try {
		const membership = await api<Membership>('/v1/invitations/accept', { method: 'POST', token: me.token, body: { token } });
		(await cookies()).set(organisationCookie, membership.organisationId, cookieOptions(365 * 24 * 60 * 60));
	} catch (error) {
		// Only an API refusal is definitive. No answer may mean it was accepted, and an invitation is
		// single-use, so do not suggest opening the link again: check the membership instead.
		if (!(error instanceof ApiError) || error.status === 0 || error.status === 429 || error.status >= 500)
			return <Refusal check>Captain could not confirm whether the invitation was accepted. Open Settings to see whether the organisation is now listed for you. If it is not, ask for a new invitation link.</Refusal>;
		return <Refusal>{error.message}</Refusal>;
	}
	redirect('/');
}

function Refusal({ children, retry, check }: { children: React.ReactNode; retry?: string; check?: boolean }) {
	return (
		<main className="page page--narrow">
			<header className="stack"><Captain size={48} /><h1>Invitation</h1></header>
			<Notice tone="attention" title={retry ? 'The invitation could not be checked just now.' : check ? 'The invitation’s result is not confirmed.' : 'This invitation cannot be used.'}
				action={retry ? { href: retry, label: 'Try again' } : check ? { href: '/settings', label: 'Open Settings' } : { href: '/', label: 'Go to Work' }}>{children}</Notice>
		</main>
	);
}
