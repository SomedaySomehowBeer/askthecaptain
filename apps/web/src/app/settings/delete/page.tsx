import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { DeleteForm } from './DeleteForm.tsx';

export const metadata: Metadata = { title: 'Delete organisation' };

export default async function DeletePage() {
	const me = await requireCurrent('/settings/delete');
	const owner = me.organisation.role === 'owner';
	return (
		<Page title="Delete this organisation" lede={me.organisation.organisationName}>
			<section className="card">
				<h2>What happens</h2>
				<p className="secondary">Everything Captain holds for {me.organisation.organisationName} is deleted: mail and calendar copies, contacts, projects, tasks and duties, connections, workflow journals, usage records and the audit log. Connected Google, Xero and inference sign-ins are revoked where the provider allows. People keep their own accounts. A one-line record of the deletion, with the name, who did it and how many rows went, stays on the platform.</p>
				<p className="secondary">Export first if you want a copy: <Link href="/settings/export">download everything</Link> as newline-delimited JSON.</p>
			</section>
			<section className="card">
				<h2>Confirm</h2>
				{owner ? <DeleteForm name={me.organisation.organisationName} /> : <Notice>Only an owner can delete the organisation.</Notice>}
			</section>
		</Page>
	);
}
