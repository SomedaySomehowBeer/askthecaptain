import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type Commitments } from '../../../lib/api.ts';
import { NoteForm } from '../NoteForm.tsx';
import { RequestDiscovery } from '../../../components/RequestDiscovery.tsx';
import { linksInWords, type Note } from '../notes.ts';
export const metadata: Metadata = { title: 'Note' };
export default async function NotePage({ params }: { params: Promise<{ noteId: string }> }) {
 const { noteId } = await params; const me = await requireCurrent(`/notes/${noteId}`);
 return <Page title="Note"><Link href="/notes" className="button button--ghost">Back to Notes</Link>
  <Suspense fallback={<div role="status"><Notice>Reading this note…</Notice></div>}><One me={me} id={noteId} /></Suspense>
 </Page>;
}
async function One({ me, id }: { me: Awaited<ReturnType<typeof requireCurrent>>; id: string }) {
 const org = me.organisation.organisationId;
 const [note, commitments] = await Promise.all([load(() => api<Note>(`/v1/organisations/${org}/notes/${encodeURIComponent(id)}`, { token: me.token })), load(() => api<Commitments>(`/v1/organisations/${org}/commitments`, { token: me.token }))]);
 if (!note.ok) return <Notice tone="failed" action={{ href: '/notes', label: 'Return to Notes' }}>{note.error.message}</Notice>;
 const value = note.value;
 return <>
  {value.archivedAt ? <Notice>This note is archived. It stays readable and citable; it is no longer triaged.</Notice> : null}
  {value.triageSummary ? <section className="card stack"><h2>What Captain read</h2><p><span className="chip">{value.triageCategory}</span> {value.triageSummary}</p><p className="muted">Suggested tasks from this note appear in Commitments.</p></section> : <Notice>Captain has not read this note yet. Notes under a few sentences are not read; longer ones are read within a minute of saving.</Notice>}
  {linksInWords(value).length ? <p className="muted">Linked to: {linksInWords(value).join(' · ')}</p> : null}
  {value.archivedAt || value.projectId ? null : <section className="card stack"><h2>Project</h2><p className="muted">Not linked to a project. Choose one in the form below, or ask Captain what this note is part of.</p><RequestDiscovery kind="note" id={value.id} /></section>}
  <section className="card stack">{value.archivedAt ? <><h2>{value.title || 'Note'}</h2><div className="mail-body">{value.body}</div></> : <NoteForm note={value} projects={commitments.ok ? commitments.value.projects.filter(p => p.state === 'active') : []} tasks={commitments.ok ? commitments.value.tasks : []} />}</section>
 </>;
}
