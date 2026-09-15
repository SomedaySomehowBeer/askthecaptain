import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load, type Organisation } from '../../lib/api.ts';
import { OrganisationForm } from './OrganisationForm.tsx';
import { switchOrganisation } from './actions.ts';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
	const me = await requireCurrent('/settings');
	const organisation = await load(() => api<Organisation>(`/v1/organisations/${me.organisation.organisationId}`, { token: me.token }));
	const canManage = me.organisation.role !== 'member';
	return (
		<Page title="Settings" lede={me.organisation.organisationName}>
			<section className="card">
				<h2>You</h2>
				<div className="line"><span>{me.me.user.name || me.me.user.email}</span><span className="chip">{me.organisation.role}</span></div>
				<p className="muted">{me.me.user.email}</p>
				<form action="/auth/sign-out" method="post" className="row"><button className="button button--ghost" type="submit">Sign out</button></form>
			</section>
			<section className="card">
				<h2>Organisation</h2>
				{!organisation.ok ? <Notice tone="failed">{organisation.error.message}</Notice>
					: canManage ? <OrganisationForm organisation={organisation.value} />
					: <div className="stack"><div className="line"><span>Name</span><span>{organisation.value.name}</span></div><div className="line"><span>Timezone</span><span className="mono">{organisation.value.timezone}</span></div></div>}
				<Link className="button button--secondary" href="/settings/members">Members and invitations</Link>
			</section>
			{me.me.memberships.length > 1 ? (
				<section className="card">
					<h2>Switch organisation</h2>
					<ul className="bare">{me.me.memberships.map((m) => (
						<li key={m.organisationId} className="line"><span>{m.organisationName}</span>
							{m.organisationId === me.organisation.organisationId ? <span className="chip">current</span>
								: <form action={switchOrganisation}><input type="hidden" name="organisationId" value={m.organisationId} /><button className="button button--ghost" type="submit">Switch</button></form>}
						</li>))}</ul>
				</section>
			) : null}
			<section className="card card--inset">
				<h2>People and companies</h2>
				<p className="secondary">Contacts from your mail and the people you add by hand.</p>
				<Link className="button button--secondary" href="/settings/contacts">Manage people and companies</Link>
			</section>
			<section className="card card--inset">
				<h2>Connections</h2>
				<p className="secondary">Connect the accounts Captain uses for your business.</p>
				<Link className="button button--secondary" href="/settings/connections">Manage connections</Link>
			</section>
			<section className="card card--inset">
				<h2>Workflows and inference</h2>
				<p className="secondary">Xero, the workflows and the inference key arrive in the next releases. This page will grow a section for each.</p>
			</section>
		</Page>
	);
}
