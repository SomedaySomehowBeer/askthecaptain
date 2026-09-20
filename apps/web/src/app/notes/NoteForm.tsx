'use client';
import { useActionState } from 'react';
import type { Project, Task } from '../../lib/api.ts';
import { archiveNote, createNote, updateNote, type Result } from './actions.ts';
import type { Note } from './notes.ts';
/** Plain text and at most one link each (D23). No formatting, files or comments: Captain is not a document store. */
export function NoteForm({ note, projects, tasks, defaults }: { note?: Note; projects: Project[]; tasks: Task[]; defaults?: { projectId?: string; taskId?: string; contactId?: string; companyId?: string; eventId?: string } }) {
 const [state, submit, pending] = useActionState<Result, FormData>(note ? updateNote : createNote, undefined);
 const [archiveState, archive, archiving] = useActionState<Result, FormData>(archiveNote, undefined);
 const projectId = note?.projectId ?? defaults?.projectId ?? ''; const taskId = note?.taskId ?? defaults?.taskId ?? '';
 const open = tasks.filter(t => ['suggested', 'open', 'in_progress'].includes(t.status) || t.id === taskId);
 return <div className="stack">
  <form action={submit} className="form stack">
   {note ? <input type="hidden" name="id" value={note.id} /> : null}
   {['contactId', 'companyId', 'eventId'].map(key => { const value = (note?.[key as 'contactId' | 'companyId' | 'eventId'] ?? defaults?.[key as 'contactId' | 'companyId' | 'eventId']) ?? ''; return value ? <input key={key} type="hidden" name={key} value={value} /> : null; })}
   <div className="field"><label htmlFor="note-title">Title (optional)</label><input id="note-title" name="title" type="text" maxLength={300} defaultValue={note?.title ?? ''} placeholder="Call with the can supplier" /></div>
   <div className="field"><label htmlFor="note-body">Note</label><textarea id="note-body" name="body" required maxLength={20000} rows={10} defaultValue={note?.body ?? ''} placeholder="What was said, decided or still open." /></div>
   <div className="row">
    <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="note-project">Project</label><select id="note-project" name="projectId" defaultValue={projectId}><option value="">None</option>{projects.filter(p => !p.archivedAt || p.id === projectId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="note-task">Task</label><select id="note-task" name="taskId" defaultValue={taskId}><option value="">None</option>{open.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>
   </div>
   {note?.contactName || note?.companyName || note?.eventId ? <p className="muted">Linked to {[note.contactName && `contact ${note.contactName}`, note.companyName && `company ${note.companyName}`, note.eventId && 'an event'].filter(Boolean).join(', ')}.</p> : null}
   {state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
   <div className="row"><button className="button button--primary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Saving…' : note ? 'Save note' : 'Save note'}</button></div>
  </form>
  {note ? <form action={archive}><input type="hidden" name="id" value={note.id} /><button className="button button--ghost" disabled={archiving}>{archiving ? 'Working…' : 'Archive this note'}</button>{archiveState?.error ? <p className="form__error" role="alert">{archiveState.error}</p> : null}</form> : null}
 </div>;
}
