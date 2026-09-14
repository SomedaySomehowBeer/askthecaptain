import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type Invitation, type Member } from '../../../lib/api.ts';
import { removeMember, revokeInvitation, setRole } from '../actions.ts';
import { InviteForm } from './InviteForm.tsx';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage() {
	const me = await requireCurrent('/settings/members');
	const org = me.organisation.organisationId; const canManage = me.organisation.role !== 'member';
	const [members, invitations] = await Promise.all([
		load(() => api<{ members: Member[] }>(`/v1/organisations/${org}/members`, { token: me.token })),
		canManage ? load(() => api<{ invitations: Invitation[] }>(`/v1/organisations/${org}/invitations`, { token: me.token })) : Promise.resolve(null)
	]);
	return (
		<Page title="Members" lede={me.organisation.organisationName}>
			<section className="card">
				<h2>Crew</h2>
				{!members.ok ? <Notice tone="failed">{members.error.message}</Notice> : (
					<ul className="bare">{members.value.members.map((member) => (
						<li key={member.userId} className="line">
							<span><strong>{member.name || member.email}</strong><br /><span className="muted">{member.email}</span></span>
							{canManage && member.userId !== me.me.user.id ? (
								<span className="row">
									<form action={setRole} className="row"><input type="hidden" name="userId" value={member.userId} />
										<select name="role" defaultValue={member.role} aria-label={`Role for ${member.email}`}>
											{me.organisation.role === 'owner' ? <option value="owner">owner</option> : null}<option value="admin">admin</option><option value="member">member</option>
										</select><button className="button button--ghost" type="submit">Set</button></form>
									<form action={removeMember}><input type="hidden" name="userId" value={member.userId} /><button className="button button--ghost" type="submit">Remove</button></form>
								</span>
							) : <span className="chip">{member.role}</span>}
						</li>))}</ul>
				)}
			</section>
			{canManage ? (
				<section className="card">
					<h2>Invite someone</h2>
					<p className="secondary">They sign in with Google using the invited address and open the link. Links last seven days and work once.</p>
					<InviteForm />
					{invitations && invitations.ok && invitations.value.invitations.length > 0 ? (
						<ul className="bare">{invitations.value.invitations.map((inv) => (
							<li key={inv.id} className="line"><span>{inv.email} <span className="chip">{inv.role}</span></span>
								<form action={revokeInvitation}><input type="hidden" name="id" value={inv.id} /><button className="button button--ghost" type="submit">Revoke</button></form></li>))}</ul>
					) : invitations && !invitations.ok ? <Notice tone="failed">{invitations.error.message}</Notice> : <p className="muted">No open invitations.</p>}
				</section>
			) : <Notice>Owners and admins invite people and set roles.</Notice>}
		</Page>
	);
}
