import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Captain } from '../../../components/Captain.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, ApiError, type Membership } from '../../../lib/api.ts';
import { cookieOptions, current, organisationCookie } from '../../../lib/session.ts';

export const metadata: Metadata = { title: 'Invitation' };

/** The invitee arrives with a token. They sign in first (the API insists the signed-in email is the
 *  invited one), then the invitation is accepted on the server and they land on Work. */
export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
	const { token } = await searchParams;
	if (!token) return <Refusal>This link is missing its invitation.</Refusal>;
	const me = await current();
	if (!me) redirect(`/sign-in?return_to=${encodeURIComponent(`/invitations/accept?token=${token}`)}`);
	try {
		const membership = await api<Membership>('/v1/invitations/accept', { method: 'POST', token: me.token, body: { token } });
		(await cookies()).set(organisationCookie, membership.organisationId, cookieOptions(365 * 24 * 60 * 60));
	} catch (error) {
		return <Refusal>{error instanceof ApiError ? error.message : 'The invitation could not be accepted.'}</Refusal>;
	}
	redirect('/');
}

function Refusal({ children }: { children: React.ReactNode }) {
	return (
		<main className="page page--narrow">
			<header className="stack"><Captain size={48} /><h1>Invitation</h1></header>
			<Notice tone="attention" title="This invitation cannot be used." action={{ href: '/', label: 'Go to Work' }}>{children}</Notice>
		</main>
	);
}
