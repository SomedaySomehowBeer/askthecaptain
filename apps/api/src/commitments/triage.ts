import { journal, type Context, type Thread, type Triage } from '../triage/data.ts';
/** Transactional step service: the journal and these writes commit together. */
export async function suggest(context: Context, thread: Thread, tasks: Triage['tasks']) {
 const { tx, organisationId, userId } = context;
 await tx`select pg_advisory_xact_lock(hashtextextended(${organisationId + ':triage-tasks'}, 0))`;
 const added = await tx`insert into projects (organisation_id, name, system_kind, created_by) values (${organisationId}, 'Obligations', 'obligations', ${userId}) on conflict do nothing returning id`;
 if (added[0]) await journal(context, 'project.created', 'project', added[0].id);
 let count = 0;
 const [project] = await tx`select id from projects where system_kind = 'obligations'`;
 for (const task of tasks) {
  const [existing] = await tx`select id from tasks where source_kind = 'mail' and source_id = ${thread.id} and title = ${task.title} and body = ${task.reference}`;
  if (existing) continue;
  const [row] = await tx`insert into tasks (organisation_id, project_id, title, body, due, status, source_kind, source_id, created_by)
   values (${organisationId}, ${project!.id}, ${task.title}, ${task.reference}, ${task.due}::date, 'suggested', 'mail', ${thread.id}, ${userId}) returning id`;
  await journal(context, 'task.suggested', 'task', row!.id); count++;
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
  if (matches.length !== 1) { await suggest(context, thread, [{ ...confirmation, due: null }]); continue; }
  const id = matches[0]!.id;
  await tx`insert into evidence (organisation_id, task_id, kind, reference, label, attached_by)
   values (${organisationId}, ${id}, 'mail', ${thread.id}, ${confirmation.reference}, ${userId})`;
  await tx`update tasks set status = 'done', completed_by = ${userId}, completed_at = now(), updated_at = now() where id = ${id}`;
  await journal(context, 'task.completed', 'task', id, { threadId: thread.id }); completed++;
 }
 return { completed };
}
