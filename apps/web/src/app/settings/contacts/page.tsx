import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { api, load } from '../../../lib/api.ts';
import { ArchiveForm, CompanyForm, ContactForm } from './Forms.tsx';
import type { CompanyList, ContactList } from './people.ts';
export const metadata: Metadata = { title: 'People and companies' };
export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
 const me = await requireCurrent('/settings/contacts'); const { q = '' } = await searchParams;
 return <Page title="People and companies" lede="The people and companies the business works with."><Link href="/settings">Back to Settings</Link>
  <form className="form" action="/settings/contacts"><div className="field"><label htmlFor="people-search">Search name, email or company</label><input id="people-search" name="q" type="text" defaultValue={q} maxLength={200} /></div><div><button className="button button--secondary">Search</button></div></form>
  <Suspense key={q} fallback={<Notice><span role="status">Reading people and companies…</span></Notice>}><People me={me} q={q} /></Suspense>
 </Page>;
}
async function People({ me, q }: { me: Awaited<ReturnType<typeof requireCurrent>>; q: string }) {
 const root = `/v1/organisations/${me.organisation.organisationId}`;
 const [people, companies] = await Promise.all([
  load(() => api<ContactList>(`${root}/contacts?q=${encodeURIComponent(q)}&limit=100`, { token: me.token })),
  load(() => api<CompanyList>(`${root}/companies?limit=200`, { token: me.token }))
 ]);
 return <>
  <section className="card stack"><h2>Contacts</h2>
   {!people.ok ? <Notice tone="failed" action={{ href: '/settings/contacts', label: 'Try again' }}>{people.error.message}</Notice> : <>
    {!people.value.contacts.length ? <Notice>{q ? 'No contacts match this search. Try a name, email or company.' : 'No contacts yet. Add someone below.'}</Notice> : <ul className="bare stack">{people.value.contacts.map((c) => <li className="line people-row" key={c.id}>
     <div><Link href={`/settings/contacts/${c.id}`}>{c.name || c.email}</Link><p className="muted">{c.name ? c.email : ''}{c.companyName ? ` · ${c.companyName}` : ''}</p>{c.archivedAt ? <span className="chip">Archived</span> : null}</div>
     <ArchiveForm id={c.id} archived={Boolean(c.archivedAt)} />
    </li>)}</ul>}
    {people.value.hasMore ? <Notice>Showing the first 100 matches. Narrow your search to find someone else.</Notice> : null}
   </>}
  </section>
  {!companies.ok ? <Notice tone="failed" action={{ href: '/settings/contacts', label: 'Try again' }}>Companies could not be loaded. {companies.error.message}</Notice> : <>
   {companies.value.hasMore ? <Notice>Showing the first 200 companies.</Notice> : null}
   <section className="card stack"><h2>Add a contact</h2><ContactForm companies={companies.value.companies} /></section>
   <section className="card stack"><h2>Companies</h2>{!companies.value.companies.length ? <p className="muted">No companies yet. Add one below.</p> : companies.value.companies.map((c) => <details key={c.id}><summary>{c.name}{c.archivedAt ? ' · Archived' : ''}</summary><div className="stack"><CompanyForm company={c} /><ArchiveForm id={c.id} archived={Boolean(c.archivedAt)} company /></div></details>)}
    <details><summary>Add a company</summary><CompanyForm /></details>
   </section>
  </>}
 </>;
}
