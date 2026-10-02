import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { changeSetId, createdRecord, personChangeSet } from '../changes.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { tagsOfRecords } from '../threads/tags.ts';

/** A tag (D7, amended; threads contract §3): a name, and optionally an owner and dates. That is the whole difference
 *  between "Production" and "Summer lager launch". It has no kind, no thread of its own and no planning task. */
export type Tag = { id: string; name: string; ownerId: string | null; startsOn: string | null; endsOn: string | null; archivedAt: Date | null;
 revision: number; createdBy: string | null; createdAt: Date; updatedAt: Date };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
 && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'A real calendar date.');
const name = z.string().trim().min(1).max(120);
export const tagInput = z.object({ changeSetId: changeSetId.optional(), name, ownerId: uuid.nullable().optional(), startsOn: date.nullable().optional(), endsOn: date.nullable().optional() }).strict();
export const tagPatch = z.object({ changeSetId: changeSetId.optional(), expectedRevision: z.number().int().min(1).max(2_147_483_646), name: name.optional(), ownerId: uuid.nullable().optional(),
 startsOn: date.nullable().optional(), endsOn: date.nullable().optional(), archived: z.boolean().optional() }).strict()
 .refine(value => Object.keys(value).filter(key => key !== 'changeSetId').length > 1, 'Supply at least one change.');
export const workQuery = z.object({
 tagIds: z.array(z.string().uuid()).max(20).default([]), ownerId: z.string().uuid().optional(), seriesId: z.string().uuid().optional(),
 status: z.enum(['suggested', 'open', 'in_progress', 'done', 'cancelled']).optional(),
 offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type WorkQuery = z.infer<typeof workQuery>;
export type WorkTask = { id: string; seriesId: string | null; title: string; ownerId: string | null; status: string; due: string | null; revision: number; tags: { id: string; name: string }[] };
const tagColumns = 'id, name, owner_id, starts_on::text as starts_on, ends_on::text as ends_on, archived_at, revision, created_by, created_at, updated_at';
const stale = () => new HttpError(409, 'stale_revision', 'This tag changed since you opened it. Reload it before saving again.');
const datesInvalid = () => badRequest('tag_dates_invalid', 'The end date cannot be before the start date.');

/** Shared organisation labels. A tag is attached to threads (a task's tags are its thread's), never to records directly;
 *  attaching is a thread write in `threads/`. Tag creation and edits are journalled (0047): their change set is their
 *  audit record. */
export class TagsService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }
 private async tx<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  return withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
   // Lock membership through the write so removal cannot race an operation by that person.
   const [member] = await tx`select user_id from memberships where organisation_id = ${organisationId}
    and user_id = ${actor.userId} and status = 'active' for share`;
   if (!member) throw notFound();
   return work(tx);
  });
 }
 list(actor: Actor, organisationId: string, offset: number, limit: number) {
  return this.tx(actor, organisationId, async tx => {
   const rows = await tx<Tag[]>`select ${tx.unsafe(tagColumns)} from tags order by lower(name), id limit ${limit + 1} offset ${offset}`;
   return { tags: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  });
 }
 /** A bounded catalogue for one task's thread; never infer its assignments from a filtered Work page. */
 options(actor: Actor, organisationId: string, taskId: string, offset: number, limit: number) {
  return this.tx(actor, organisationId, async tx => {
   const [task] = await tx<{ id: string; title: string; threadId: string }[]>`select t.id, t.title, th.id as thread_id from tasks t
    join threads th on th.organisation_id = t.organisation_id and th.task_id = t.id where t.id = ${taskId} and t.parent_id is null`;
   if (!task) throw notFound();
   const rows = await tx<{ id: string; name: string; attached: boolean }[]>`select tag.id, tag.name,
    exists (select 1 from thread_tags link where link.thread_id = ${task.threadId} and link.tag_id = tag.id) as attached
    from tags tag order by lower(tag.name), tag.id limit ${limit + 1} offset ${offset}`;
   return { task: { id: task.id, title: task.title }, tags: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  });
 }
 private async requireOwner(tx: TransactionSql, organisationId: string, ownerId: string) {
  const [owner] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${ownerId} and status = 'active' for share`;
  if (!owner) throw badRequest('owner_invalid', 'The owner must be an active member of the organisation.');
 }
 private async guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
   if (error instanceof Error && 'code' in error && error.code === '23505')
    throw new HttpError(409, 'tag_name_exists', 'A tag with that name already exists. Choose it or use another name.');
   if (error instanceof Error && 'constraint_name' in error && error.constraint_name === 'tags_dates_check') throw datesInvalid();
   throw error;
  }
 }
 create(actor: Actor, organisationId: string, raw: unknown): Promise<Tag & { changeSetId: string }> {
  const { changeSetId: wanted, ...input } = tagInput.parse(raw);
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw datesInvalid();
  return this.guarded(() => this.tx(actor, organisationId, async tx => {
   const changeSet = await personChangeSet(tx, actor, 'tag.create', input, wanted);
   if (changeSet.matched) {
    const id = await createdRecord(tx, changeSet.id, 'tag');
    const [tag] = id ? await tx<Tag[]>`select ${tx.unsafe(tagColumns)} from tags where id = ${id}` : [];
    if (!tag) throw notFound();
    return { ...tag, changeSetId: changeSet.id };
   }
   if (input.ownerId) await this.requireOwner(tx, organisationId, input.ownerId);
   const [tag] = await tx<Tag[]>`insert into tags (organisation_id, name, owner_id, starts_on, ends_on, created_by)
    values (${organisationId}, ${input.name}, ${input.ownerId ?? null}, ${input.startsOn ?? null}::date, ${input.endsOn ?? null}::date, ${actor.userId})
    returning ${tx.unsafe(tagColumns)}`;
   return { ...tag!, changeSetId: changeSet.id };
  }));
 }
 /** Name, owner, dates and archive, with `expectedRevision`. Archiving keeps every attachment (§3). */
 update(actor: Actor, organisationId: string, tagId: string, raw: unknown): Promise<Tag & { changeSetId: string }> {
  const { changeSetId: wanted, ...input } = tagPatch.parse(raw);
  return this.guarded(() => this.tx(actor, organisationId, async tx => {
   const changeSet = await personChangeSet(tx, actor, 'tag.update', { tagId, ...input }, wanted);
   if (changeSet.matched) {
    const [tag] = await tx<Tag[]>`select ${tx.unsafe(tagColumns)} from tags where id = ${tagId}`;
    if (!tag) throw notFound();
    return { ...tag, changeSetId: changeSet.id };
   }
   const [before] = await tx<Tag[]>`select ${tx.unsafe(tagColumns)} from tags where id = ${tagId} for update`;
   if (!before) throw notFound();
   if (before.revision !== input.expectedRevision) throw stale();
   if (input.ownerId && input.ownerId !== before.ownerId) await this.requireOwner(tx, organisationId, input.ownerId);
   const after = { name: input.name ?? before.name, ownerId: input.ownerId === undefined ? before.ownerId : input.ownerId,
    startsOn: input.startsOn === undefined ? before.startsOn : input.startsOn, endsOn: input.endsOn === undefined ? before.endsOn : input.endsOn };
   if (after.startsOn && after.endsOn && after.endsOn < after.startsOn) throw datesInvalid();
   const archivedAt = input.archived === undefined ? before.archivedAt : input.archived ? before.archivedAt ?? new Date() : null;
   const [tag] = await tx<Tag[]>`update tags set name = ${after.name}, owner_id = ${after.ownerId}, starts_on = ${after.startsOn}::date, ends_on = ${after.endsOn}::date,
    archived_at = ${archivedAt}, updated_at = now() where id = ${tagId} returning ${tx.unsafe(tagColumns)}`;
   return { ...tag!, changeSetId: changeSet.id };
  }));
 }
 work(actor: Actor, organisationId: string, raw: unknown) {
  const query = workQuery.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const conditions = [tx`t.organisation_id = ${organisationId}`, tx`t.parent_id is null`];
   if (query.ownerId) conditions.push(tx`t.owner_id = ${query.ownerId}`);
   if (query.seriesId) conditions.push(tx`t.series_id = ${query.seriesId}`);
   conditions.push(query.status ? tx`t.status = ${query.status}` : tx`t.status <> 'cancelled'`);
   // Match any selected tag on the task's thread, AND with other filter kinds; EXISTS returns each task only once.
   const tagIds = [...new Set(query.tagIds)];
   if (tagIds.length) conditions.push(tx`exists (select 1 from threads th join thread_tags tt on tt.thread_id = th.id
    where th.organisation_id = t.organisation_id and th.task_id = t.id and tt.tag_id in ${tx(tagIds)})`);
   const where = conditions.reduce((a, b) => tx`${a} and ${b}`);
   const rows = await tx<Omit<WorkTask, 'tags'>[]>`select t.id, t.series_id, t.title, t.owner_id, t.status, t.due::text, t.revision
    from tasks t where ${where} order by t.due nulls last, t.id limit ${query.limit + 1} offset ${query.offset}`;
   const page = rows.slice(0, query.limit);
   const tags = await tagsOfRecords(tx, 'task', page.map(t => t.id));
   return { tasks: page.map(t => ({ ...t, tags: tags.get(t.id) ?? [] })), nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  });
 }
}
