import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load, type Commitments } from '../../lib/api.ts';
import { NoteForm } from './NoteForm.tsx';
import { firstLine, linksInWords, type Note } from './notes.ts';
export const metadata: Metadata = { title: 'Notes' };
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ projectId?: string; taskId?: string; contactId?: string; companyId?: string; eventId?: string }> }) {
 const me = await requireCurrent('/notes'); const defaults = await searchParams;
 return <Page title="Notes" lede="Plain text you write here. Captain reads a note like a mail thread: it is triaged, remembered and used as evidence, and nothing in it needs you.">
  <Suspense fallback={<div role="status"><Notice>Reading your notes…</Notice></div>}><Notes me={me} defaults={defaults} /></Suspense>
 </Page>;
}
async function Notes({ me, defaults }: { me: Awaited<ReturnType<typeof requireCurrent>>; defaults: { projectId?: string; taskId?: string; contactId?: string; companyId?: string; eventId?: string } }) {
 const org = me.organisation.organisationId;
 const [notes, commitments] = await Promise.all([load(() => api<Note[]>(`/v1/organisations/${org}/notes?limit=100`, { token: me.token })), load(() => api<Commitments>(`/v1/organisations/${org}/commitments`, { token: me.token }))]);
 if (!notes.ok) return <Notice tone="failed" action={{ href: '/notes', label: 'Try again' }}>{notes.error.message}</Notice>;
 const projects = commitments.ok ? commitments.value.projects : []; const tasks = commitments.ok ? commitments.value.tasks : [];
 const when = (iso: string) => new Intl.DateTimeFormat('en-AU', { timeZone: commitments.ok ? commitments.value.timezone : undefined, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
 return <>
  <section className="card stack"><h2>Write a note</h2><NoteForm projects={projects} tasks={tasks} defaults={defaults} /></section>
  <section className="card"><h2>Recent notes</h2>
   {notes.value.length === 0 ? <p className="muted">No notes yet. A quick note, meeting notes, anything between.</p> : <ul className="bare">{notes.value.map(note => <li className="mail-row" key={note.id}><Link className="mail-link" href={`/notes/${note.id}`}>
    <div className="line"><strong>{firstLine(note)}</strong><time dateTime={note.updatedAt}>{when(note.updatedAt)}</time></div>
    {note.triageSummary ? <p className="secondary">{note.triageSummary}</p> : <p className="secondary">{note.body.slice(0, 160)}</p>}
    <div className="row muted">{note.triageCategory ? <span className="chip">{note.triageCategory}</span> : null}{linksInWords(note).map(words => <span className="chip" key={words}>{words}</span>)}</div>
   </Link></li>)}</ul>}
  </section>
 </>;
}
