import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { badRequest, notFound } from '../errors.ts';
import { requireMember } from '../mail/store.ts';
import type { Actor } from '../tenant.ts';
type Emit = (tx: TransactionSql, organisationId: string, event: string, data: unknown) => Promise<unknown>;
const uuid = z.uuid().nullable().default(null);
export const noteInput = z.object({ title: z.string().trim().max(300).default(''), body: z.string().trim().min(1).max(20000),
 eventId: uuid, contactId: uuid, companyId: uuid, projectId: uuid, taskId: uuid }).strict();
export type NoteInput = z.infer<typeof noteInput>;
const links: [keyof NoteInput, string][] = [['eventId', 'calendar_events'], ['contactId', 'contacts'], ['companyId', 'companies'], ['projectId', 'projects'], ['taskId', 'tasks']];
/** Notes (D23): plain text a person writes, at most one link each to an event, a contact, a company, a project and a
 *  task. Saving emits note.saved so Inbox triage reads it like a mail thread; the author is the person, so nothing
 *  needs the owner and no reply is drafted. Not a document store: no formatting, files or comments. */
export class NotesService {
 readonly db: Sql; readonly emit: Emit | null;
 /** Embeds the saved note (D21) after the transaction; its failure never fails the save. */
 readonly afterSave: ((organisationId: string) => Promise<unknown>) | null;
 constructor(db: Sql, emit: Emit | null = null, afterSave: ((organisationId: string) => Promise<unknown>) | null = null) { this.db = db; this.emit = emit; this.afterSave = afterSave; }
 private async saved<T>(organisationId: string, work: Promise<T>): Promise<T> { const result = await work; await this.afterSave?.(organisationId).catch(() => undefined); return result; }
 private tx<T>(actor: Actor, organisationId: string, fn: (tx: TransactionSql) => Promise<T>) {
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => { await requireMember(tx, actor.userId, organisationId); return fn(tx); });
 }
 private static select(tx: TransactionSql, where: ReturnType<TransactionSql>, limit: number) {
  return tx`select n.*, u.name as author_name, c.name as contact_name, co.name as company_name, p.name as project_name, t.title as task_title,
   nt.category as triage_category, nt.summary as triage_summary
   from notes n join users u on u.id = n.author_id
   left join contacts c on c.organisation_id = n.organisation_id and c.id = n.contact_id left join companies co on co.organisation_id = n.organisation_id and co.id = n.company_id
   left join projects p on p.organisation_id = n.organisation_id and p.id = n.project_id left join tasks t on t.organisation_id = n.organisation_id and t.id = n.task_id
   left join note_triage nt on nt.organisation_id = n.organisation_id and nt.note_id = n.id
   where ${where} order by n.updated_at desc, n.id desc limit ${limit}`;
 }
 list(actor: Actor, organisationId: string, options: { limit?: number; archived?: boolean; taskId?: string; projectId?: string; contactId?: string } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  return this.tx(actor, organisationId, tx => NotesService.select(tx, tx`(${options.archived ? tx`true` : tx`n.archived_at is null`})
   and (${options.taskId ?? null}::uuid is null or n.task_id = ${options.taskId ?? null}::uuid) and (${options.projectId ?? null}::uuid is null or n.project_id = ${options.projectId ?? null}::uuid)
   and (${options.contactId ?? null}::uuid is null or n.contact_id = ${options.contactId ?? null}::uuid)`, limit));
 }
 async get(actor: Actor, organisationId: string, id: string) {
  const [row] = await this.tx(actor, organisationId, tx => NotesService.select(tx, tx`n.id = ${id}`, 1)); if (!row) throw notFound(); return row;
 }
 private static async checkLinks(tx: TransactionSql, input: NoteInput) {
  for (const [key, table] of links) {
   const id = input[key]; if (!id) continue;
   const [found] = await tx.unsafe(`select 1 from ${table} where id = $1`, [id]);
   if (!found) throw badRequest('link_missing', `The linked ${table.replace('calendar_events', 'event').replace(/s$/, '')} was not found.`);
  }
 }
 /** The note's project is the person's statement of where it belongs (D22): a chosen project replaces any link the rules
  *  or the model made and is recorded as theirs; no project withdraws only their own link, so triage's links stand. */
 private static async linkProject(tx: TransactionSql, organisationId: string, actor: Actor, noteId: string, projectId: string | null) {
  if (projectId) {
   await tx`delete from project_sources where source_kind = 'note' and source_id = ${noteId} and project_id <> ${projectId}`;
   await tx`insert into project_sources (organisation_id, project_id, source_kind, source_id, linked_by, linked_by_id, rule)
    values (${organisationId}, ${projectId}, 'note', ${noteId}, 'person', ${actor.userId}, 'person_link') on conflict do nothing`;
  } else await tx`delete from project_sources where source_kind = 'note' and source_id = ${noteId} and linked_by = 'person'`;
 }
 async create(actor: Actor, organisationId: string, value: unknown) {
  const input = noteInput.parse(value);
  return this.saved(organisationId, this.tx(actor, organisationId, async tx => {
   await NotesService.checkLinks(tx, input);
   const [row] = await tx`insert into notes (organisation_id, author_id, title, body, event_id, contact_id, company_id, project_id, task_id)
    values (${organisationId}, ${actor.userId}, ${input.title}, ${input.body}, ${input.eventId}, ${input.contactId}, ${input.companyId}, ${input.projectId}, ${input.taskId}) returning id`;
   await NotesService.linkProject(tx, organisationId, actor, String(row!.id), input.projectId ?? null);
   await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: 'note.created', subjectType: 'note', subjectId: String(row!.id) });
   await this.emit?.(tx, organisationId, 'note.saved', { noteId: String(row!.id) });
   return (await NotesService.select(tx, tx`n.id = ${row!.id}`, 1))[0]!;
  }));
 }
 async update(actor: Actor, organisationId: string, id: string, value: unknown) {
  const input = noteInput.parse(value);
  return this.saved(organisationId, this.tx(actor, organisationId, async tx => {
   const [existing] = await tx`select id from notes where id = ${id} and archived_at is null for update`; if (!existing) throw notFound();
   await NotesService.checkLinks(tx, input);
   await tx`update notes set title = ${input.title}, body = ${input.body}, event_id = ${input.eventId}, contact_id = ${input.contactId}, company_id = ${input.companyId}, project_id = ${input.projectId}, task_id = ${input.taskId}, updated_at = now() where id = ${id}`;
   await NotesService.linkProject(tx, organisationId, actor, id, input.projectId ?? null);
   await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: 'note.updated', subjectType: 'note', subjectId: id });
   await this.emit?.(tx, organisationId, 'note.saved', { noteId: id });
   return (await NotesService.select(tx, tx`n.id = ${id}`, 1))[0]!;
  }));
 }
 archive(actor: Actor, organisationId: string, id: string) {
  return this.tx(actor, organisationId, async tx => {
   const [row] = await tx`update notes set archived_at = coalesce(archived_at, now()), updated_at = now() where id = ${id} returning id`; if (!row) throw notFound();
   await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: 'note.archived', subjectType: 'note', subjectId: id });
   return (await NotesService.select(tx, tx`n.id = ${id}`, 1))[0]!;
  });
 }
}
