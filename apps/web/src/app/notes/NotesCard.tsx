import Link from 'next/link';
import { api, load } from '../../lib/api.ts';
import type { requireCurrent } from '../../components/Page.tsx';
import { firstLine, type Note } from './notes.ts';
/** The three latest notes and the way to write one; the front page stays about what needs the person. */
export async function NotesCard({ me }: { me: Awaited<ReturnType<typeof requireCurrent>> }) {
 const notes = await load(() => api<Note[]>(`/v1/organisations/${me.organisation.organisationId}/notes?limit=3`, { token: me.token }));
 return <section className="card stack"><div className="row row--between"><h2>Notes</h2><Link href="/notes" className="button button--secondary button--small">Write a note</Link></div>
  {!notes.ok || notes.value.length === 0 ? <p className="muted">Jot down a call, a meeting or an idea. Captain reads it like mail and suggests the tasks in it.</p>
   : <ul className="bare">{notes.value.map(note => <li key={note.id}><Link href={`/notes/${note.id}`}>{firstLine(note)}</Link>{note.triageSummary ? <p className="secondary">{note.triageSummary}</p> : null}</li>)}</ul>}
 </section>;
}
