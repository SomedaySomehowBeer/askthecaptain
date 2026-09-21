import { journal, type Context, type Thread, type Triage } from '../triage/data.ts';
/** Transactional step service: the journal and these writes commit together. */
export function suggest(context: Context, thread: Thread, tasks: Triage['tasks'], projectId: string | null = null) { return suggestFrom(context, { kind: 'mail', id: thread.id }, tasks, projectId); }
/** Suggested tasks from a thread or a note (D23) land in Obligations; the source is kept so a repeat run adds nothing twice. */
export async function suggestFrom(context: Context, source: { kind: 'mail' | 'note'; id: string }, tasks: Triage['tasks'], projectId: string | null = null) {
 const { tx, organisationId, userId } = context;
 await tx`select pg_advisory_xact_lock(hashtextextended(${organisationId + ':triage-tasks'}, 0))`;
 const added = await tx`insert into projects (organisation_id, name, system_kind, created_by) values (${organisationId}, 'Obligations', 'obligations', ${userId}) on conflict do nothing returning id`;
 if (added[0]) await journal(context, 'project.created', 'project', added[0].id);
 let count = 0;
 // Tasks from a linked thread or note go to that project (D22); otherwise to Obligations as before.
 const [linked] = projectId ? await tx`select id from projects where id = ${projectId} and state = 'active'` : [];
 const [project] = linked ? [linked] : await tx`select id from projects where system_kind = 'obligations'`;
 for (const task of tasks) {
  const [existing] = await tx`select id, project_id from tasks where source_kind = ${source.kind} and source_id = ${source.id} and title = ${task.title} and body = ${task.reference} and parent_id is null`;
  const [row] = existing ? [existing] : await tx`insert into tasks (organisation_id, project_id, title, body, due, status, source_kind, source_id, created_by)
   values (${organisationId}, ${project!.id}, ${task.title}, ${task.reference}, ${task.due}::date, 'suggested', ${source.kind}, ${source.id}, ${userId}) returning id, project_id`;
  if (!existing) { await journal(context, 'task.suggested', 'task', row!.id); count++; }
  // Steps are the task's checklist (D7): suggested sub-tasks in its project, one level deep, never added twice.
  for (const step of task.steps) {
   const [have] = await tx`select id from tasks where parent_id = ${row!.id} and title = ${step}`; if (have) continue;
   const [sub] = await tx`insert into tasks (organisation_id, project_id, parent_id, title, body, status, source_kind, source_id, created_by)
    values (${organisationId}, ${row!.projectId}, ${row!.id}, ${step}, '', 'suggested', ${source.kind}, ${source.id}, ${userId}) returning id`;
   await journal(context, 'task.suggested', 'task', sub!.id, { parentId: row!.id }); count++;
  }
 }
 return { suggested: count };
}
export async function complete(context: Context, thread: Thread, triage: Triage) {
 const { tx, organisationId, userId } = context; let completed = 0;
 for (const confirmation of triage.confirmations) {
  // No fuzzy matching, model-selected IDs or unauthenticated senders can close a duty.
  const quoted = thread.knownSender && triage.facts.references.includes(confirmation.reference)
   && thread.messages.some(m => m.body.includes(confirmation.title) && m.body.includes(confirmation.reference));
  const matches = quoted ? await tx`select id from tasks where title = ${confirmation.title} and body = ${confirmation.reference}
   and status in ('open', 'in_progress') for update` : [];
  if (matches.length !== 1) { await suggest(context, thread, [{ ...confirmation, due: null, steps: [] }]); continue; }
  const id = matches[0]!.id;
  await tx`insert into evidence (organisation_id, task_id, kind, reference, label, attached_by)
   values (${organisationId}, ${id}, 'mail', ${thread.id}, ${confirmation.reference}, ${userId})`;
  await tx`update tasks set status = 'done', completed_by = ${userId}, completed_at = now(), updated_at = now() where id = ${id}`;
  await journal(context, 'task.completed', 'task', id, { threadId: thread.id }); completed++;
 }
 return { completed };
}
