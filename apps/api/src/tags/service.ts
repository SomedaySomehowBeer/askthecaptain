import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { HttpError, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
export type Tag = { id: string; name: string; createdAt: Date; updatedAt: Date };
export const tagInput = z.object({ name: z.string().trim().min(1).max(60) }).strict();
export const workQuery = z.object({
 tagIds: z.array(z.string().uuid()).max(20).default([]), ownerId: z.string().uuid().optional(), projectId: z.string().uuid().optional(),
 status: z.enum(['suggested', 'open', 'in_progress', 'done', 'cancelled']).optional(),
 offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type WorkQuery = z.infer<typeof workQuery>;
export type WorkTask = { id: string; projectId: string; title: string; ownerId: string | null; status: string; due: string | null; tags: { id: string; name: string }[] };
const tagColumns = 'id, name, created_at, updated_at';
/** Person-scoped labels and task links. The existing task/project remains the only work record. */
export class TagsService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }
 private async tx<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  return withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
   // Lock membership through the write so removal cannot race a person-scoped operation.
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
 /** A bounded catalogue for one task; never infer its assignments from a filtered Work page. */
 options(actor: Actor, organisationId: string, taskId: string, offset: number, limit: number) {
  return this.tx(actor, organisationId, async tx => {
   const [task] = await tx<{ id: string; title: string }[]>`select t.id, t.title from tasks t
    join projects p on p.id = t.project_id and p.organisation_id = t.organisation_id
    where t.id = ${taskId} and t.parent_id is null and p.archived_at is null and p.state = 'active'
    for share of t, p`;
   if (!task) throw notFound();
   const rows = await tx<{ id: string; name: string; attached: boolean }[]>`select tag.id, tag.name,
    exists (select 1 from task_tags link where link.organisation_id = tag.organisation_id
     and link.tag_id = tag.id and link.task_id = ${taskId}) as attached
    from tags tag order by lower(tag.name), tag.id limit ${limit + 1} offset ${offset}`;
   return { task, tags: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  });
 }
 async save(actor: Actor, organisationId: string, raw: unknown, id?: string) {
  const input = tagInput.parse(raw);
  try {
   return await this.tx(actor, organisationId, async tx => {
    const previous = id ? (await tx<Tag[]>`select ${tx.unsafe(tagColumns)} from tags where id = ${id} for update`)[0] : undefined;
    if (id && !previous) throw notFound();
    const [tag] = id
     ? await tx<Tag[]>`update tags set name = ${input.name}, updated_at = now() where id = ${id} returning ${tx.unsafe(tagColumns)}`
     : await tx<Tag[]>`insert into tags (organisation_id, name) values (${organisationId}, ${input.name}) returning ${tx.unsafe(tagColumns)}`;
    if (!tag) throw notFound();
    await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId,
     action: id ? 'tag.renamed' : 'tag.created', subjectType: 'tag', subjectId: tag.id, detail: { name: tag.name, ...(previous ? { before: { name: previous.name }, after: { name: tag.name } } : {}) } });
    return tag;
   });
  } catch (error) {
   if (error instanceof Error && 'code' in error && error.code === '23505')
    throw new HttpError(409, 'tag_name_exists', 'A tag with that name already exists. Choose it or use another name.');
   throw error;
  }
 }
 private async task(tx: TransactionSql, taskId: string) {
  const [task] = await tx`select t.id from tasks t join projects p on p.id = t.project_id and p.organisation_id = t.organisation_id
   where t.id = ${taskId} and t.parent_id is null and p.archived_at is null and p.state = 'active' for update of t for share of p`;
  if (!task) throw notFound();
 }
 setLink(actor: Actor, organisationId: string, taskId: string, tagId: string, attached: boolean) {
  return this.tx(actor, organisationId, async tx => {
   await this.task(tx, taskId);
   const [tag] = await tx`select id from tags where id = ${tagId} for share`;
   if (!tag) throw notFound();
   const changed = attached
    ? await tx`insert into task_tags (organisation_id, task_id, tag_id, attached_by)
       values (${organisationId}, ${taskId}, ${tagId}, ${actor.userId}) on conflict do nothing returning tag_id`
    : await tx`delete from task_tags where task_id = ${taskId} and tag_id = ${tagId} returning tag_id`;
   if (changed.length) await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId,
    action: attached ? 'task.tag_added' : 'task.tag_removed', subjectType: 'task', subjectId: taskId, detail: { tagId } });
   return { taskId, tagId, attached };
  });
 }
 work(actor: Actor, organisationId: string, raw: unknown) {
  const query = workQuery.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const conditions = [tx`t.organisation_id = ${organisationId}`, tx`t.parent_id is null`, tx`p.archived_at is null`, tx`p.state = 'active'`];
   if (query.ownerId) conditions.push(tx`t.owner_id = ${query.ownerId}`);
   if (query.projectId) conditions.push(tx`t.project_id = ${query.projectId}`);
   conditions.push(query.status ? tx`t.status = ${query.status}` : tx`t.status <> 'cancelled'`);
   // Match any selected tag, AND with other filter kinds; EXISTS returns each task only once.
   const tagIds = [...new Set(query.tagIds)];
   if (tagIds.length) conditions.push(tx`exists (select 1 from task_tags tt
    where tt.organisation_id = t.organisation_id and tt.task_id = t.id and tt.tag_id in ${tx(tagIds)})`);
   const where = conditions.reduce((a, b) => tx`${a} and ${b}`);
   const rows = await tx<Omit<WorkTask, 'tags'>[]>`select t.id, t.project_id, t.title, t.owner_id, t.status, t.due::text
    from tasks t join projects p on p.organisation_id = t.organisation_id and p.id = t.project_id
    where ${where} order by t.due nulls last, t.id limit ${query.limit + 1} offset ${query.offset}`;
   const page = rows.slice(0, query.limit);
   const links = page.length ? await tx<{ taskId: string; id: string; name: string }[]>`select tt.task_id, tag.id, tag.name
    from task_tags tt join tags tag on tag.organisation_id = tt.organisation_id and tag.id = tt.tag_id
    where tt.task_id in ${tx(page.map(t => t.id))} order by lower(tag.name), tag.id` : [];
   return { tasks: page.map(t => ({ ...t, tags: links.filter(l => l.taskId === t.id).map(({ id, name }) => ({ id, name })) })),
    nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  });
 }
}
