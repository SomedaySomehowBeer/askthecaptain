import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load } from '../../../../lib/api.ts';
import { ArchiveForm, ContactForm } from '../Forms.tsx';
import type { CompanyList, ContactDetail } from '../people.ts';

export const metadata: Metadata = { title: 'Contact' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One person the business works with: their details and company, editable by any member. The old
 *  "recent threads" panel read personal mail and is retired with the Inbox (#133). */
export default async function ContactPage({ params }: { params: Promise<{ contactId: string }> }) {
	const { contactId } = await params;
	const valid = uuid.test(contactId);
	const me = await requireCurrent(valid ? `/settings/contacts/${contactId}` : '/settings/contacts');
	return <Page title="Contact"><div className="row"><Link href="/settings/contacts">People and companies</Link></div>
		{valid ? <Suspense fallback={<Notice><span role="status">Reading this contact…</span></Notice>}><Contact me={me} id={contactId.toLowerCase()} /></Suspense>
			: <Notice tone="attention" action={{ href: '/settings/contacts', label: 'People and companies' }}>That link does not name a contact.</Notice>}
	</Page>;
}

async function Contact({ me, id }: { me: Awaited<ReturnType<typeof requireCurrent>>; id: string }) {
	const root = `/v1/organisations/${me.organisation.organisationId}`;
	const [result, companies] = await Promise.all([
		load(() => api<ContactDetail>(`${root}/contacts/${id}`, { token: me.token })),
		load(() => api<CompanyList>(`${root}/companies?limit=200`, { token: me.token }))
	]);
	if (!result.ok) return result.error.status === 404
		? <Notice action={{ href: '/settings/contacts', label: 'People and companies' }}>This contact is not available. It may belong to another organisation, or the link is wrong.</Notice>
		: <Notice tone="failed" action={{ href: `/settings/contacts/${id}`, label: 'Try again' }}>{result.error.message}</Notice>;
	const { contact } = result.value;
	return (
		<section className="card stack"><h2>{contact.name || contact.email}</h2>
			{contact.archivedAt ? <Notice>This contact is archived. Restore it to edit their details.</Notice> : null}
			{!companies.ok ? <Notice tone="failed" action={{ href: `/settings/contacts/${id}`, label: 'Try again' }}>Companies could not be loaded. {companies.error.message}</Notice>
				: <ContactForm contact={contact} companies={companies.value.companies} />}
			<ArchiveForm id={contact.id} archived={Boolean(contact.archivedAt)} />
		</section>
	);
}
