import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Page, requireCurrent } from '../../../../components/Page.tsx';
import { Notice } from '../../../../components/Notice.tsx';
import { api, load } from '../../../../lib/api.ts';
import { ArchiveForm, ContactForm } from '../../../settings/contacts/Forms.tsx';
import type { CompanyList, ContactDetail } from '../../../settings/contacts/people.ts';
export const metadata: Metadata = { title: 'Contact' };
export default async function ContactPage({ params }: { params: Promise<{ contactId: string }> }) {
 const { contactId } = await params; const me = await requireCurrent(`/inbox/contacts/${contactId}`);
 return <Page title="Contact"><div className="row"><Link href="/settings/contacts">People and companies</Link><Link href="/inbox">Back to Inbox</Link></div>
  <Suspense fallback={<Notice><span role="status">Reading this contact…</span></Notice>}><Contact me={me} id={contactId} /></Suspense>
 </Page>;
}
async function Contact({ me, id }: { me: Awaited<ReturnType<typeof requireCurrent>>; id: string }) {
 const root = `/v1/organisations/${me.organisation.organisationId}`;
 const [result, companies] = await Promise.all([
  load(() => api<ContactDetail>(`${root}/contacts/${encodeURIComponent(id)}`, { token: me.token })),
  load(() => api<CompanyList>(`${root}/companies?limit=200`, { token: me.token }))
 ]);
 if (!result.ok) return <Notice tone="failed" action={{ href: '/settings/contacts', label: 'Return to contacts' }}>{result.error.message}</Notice>;
 const { contact, threads } = result.value;
 return <>
  <section className="card stack"><h2>{contact.name || contact.email}</h2>
   {contact.archivedAt ? <Notice>This contact is archived. Restore it to edit their details.</Notice> : null}
   {!companies.ok ? <Notice tone="failed" action={{ href: `/inbox/contacts/${id}`, label: 'Try again' }}>Companies could not be loaded. {companies.error.message}</Notice>
    : <ContactForm contact={contact} companies={companies.value.companies} />}
   <ArchiveForm id={contact.id} archived={Boolean(contact.archivedAt)} />
  </section>
  <section className="card stack"><h2>Recent threads</h2><p className="muted">Up to 20 threads from the mail currently saved in Captain.</p>
   {!threads.length ? <Notice>No saved threads for this email address. Sync mail in Inbox to collect recent correspondence.</Notice> : <ul className="bare stack">{threads.map((t) => <li key={t.id}><Link href={`/inbox/${t.id}`}>{t.subject || '(No subject)'}</Link></li>)}</ul>}
  </section>
 </>;
}
