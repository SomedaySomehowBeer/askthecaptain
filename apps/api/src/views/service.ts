import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';

/** At most this many live views per person per organisation (D26). */
export const viewLimit = 50;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
/** Version 1 of the Work filter: exactly today's Work controls, all four keys required, nothing else. The stored form
 *  is normalised: lower-cased, de-duplicated and sorted tag IDs (at most 20) and a lower-cased project ID or null. */
export const workFilterV1 = z.object({
 owner: z.enum(['me', 'all']),
 status: z.enum(['open', 'in_progress', 'suggested', 'done', 'cancelled', 'all']),
 tagIds: z.array(uuid).max(100).transform(ids => [...new Set(ids)].sort()).pipe(z.array(z.string()).max(20)),
 projectId: uuid.nullable(),
}).strict();
export type WorkFilter = z.output<typeof workFilterV1>;
const name = z.string().trim().min(1).max(60);
const revision = z.number().int().min(1).max(2_147_483_646);
// `filter` is checked separately so that a malformed filter is `invalid_filter`, not a generic `invalid_request`.
export const createView = z.object({ id: uuid, name, filter: z.unknown() }).strict();
export const updateView = z.object({ expectedRevision: revision, name: name.optional(), filter: z.unknown().optional() }).strict()
 .refine(value => value.name !== undefined || value.filter !== undefined, 'Supply a name or a filter.');
export const deleteView = z.object({ expectedRevision: z.coerce.number().int().min(1).max(2_147_483_646) }).strict();
export const listViews = z.object({
 offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(viewLimit).default(viewLimit),
}).strict();

type Stored = { id: string; name: string; filterVersion: number; filter: unknown; revision: number; createdAt: Date; updatedAt: Date };
/** A view this server can apply, or one it must not guess at: a newer filter version, or a stored filter that is not a
 *  valid version 1. An inapplicable filter is returned as stored, never cast into the version-1 shape. */
export type SavedView = { id: string; name: string } & (
 | { filterVersion: 1; filter: WorkFilter; applicable: true; reason: null }
 | { filterVersion: number; filter: unknown; applicable: false; reason: string }
) & { revision: number; createdAt: Date; updatedAt: Date };
export type TagReference = { id: string; state: 'available'; name: string } | { id: string; state: 'missing' | 'unavailable' };
export type ProjectReference = { id: string; state: 'available'; name: string; projectState: 'active' | 'proposed' | 'archived' }
 | { id: string; state: 'missing' | 'unavailable' };
export type References = { tags: TagReference[]; project: ProjectReference | null };
/** `references` is null when the view is not applicable: its stored IDs are not trusted as version 1. */
export type SavedViewDetail = SavedView & { references: References | null };

const columns = 'id, name, filter_version, filter, revision, created_at, updated_at';
const conflict = (code: string, message: string) => new HttpError(409, code, message);
// One message for every id conflict: the body says nothing about another person's row, not even whether it is live.
const idUnavailable = () => conflict('view_id_unavailable', 'That saved view id cannot be used for this save. Nothing was changed; save it as a new view to keep these filters.');
const nameExists = () => conflict('view_name_exists', 'You already have a saved view with that name. Choose another name.');
const stale = () => conflict('stale_revision', 'This saved view changed since you opened it. Reload it before saving again.');
const invalidFilter = () => badRequest('invalid_filter', 'A saved filter needs exactly owner, status, tagIds (at most 20) and projectId.');

export function parseFilter(raw: unknown): WorkFilter {
 const parsed = workFilterV1.safeParse(raw);
 if (!parsed.success) throw invalidFilter();
 return parsed.data;
}
const sameFilter = (a: WorkFilter, b: WorkFilter) => a.owner === b.owner && a.status === b.status && a.projectId === b.projectId
 && a.tagIds.length === b.tagIds.length && a.tagIds.every((id, index) => id === b.tagIds[index]);

/** Classifies a stored row. Only version 1 is understood here; a later version is reported, not guessed. */
export function present(row: Stored): SavedView {
 const head = { id: row.id, name: row.name };
 const tail = { revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
 if (row.filterVersion === 1) {
  const parsed = workFilterV1.safeParse(row.filter);
  if (parsed.success) return { ...head, filterVersion: 1, filter: parsed.data, applicable: true, reason: null, ...tail };
  return { ...head, filterVersion: 1, filter: row.filter, applicable: false, reason: 'This view’s saved filter could not be read, so it is not applied.', ...tail };
 }
 return { ...head, filterVersion: row.filterVersion, filter: row.filter, applicable: false,
  reason: row.filterVersion > 1 ? 'This view was saved by a newer version of Captain and cannot be applied here.' : 'This view’s saved filter could not be read, so it is not applied.', ...tail };
}

/** Private saved Work views (D26). Row security is the authority for who sees a row; the service adds the owner and
 *  live predicates explicitly, locks the actor's membership through every write, and audits identity only. */
export class SavedViewsService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }

 /** `update` serialises this person's creates, so two concurrent creates at the limit cannot both pass; `share` holds
  *  the membership against removal for the length of an edit. A read takes no lock. */
 private async tx<T>(actor: Actor, organisationId: string, lock: 'update' | 'share' | null, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  try {
   return await withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
    const [member] = await tx`select user_id from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId}
     and status = 'active' ${lock === 'update' ? tx`for update` : lock === 'share' ? tx`for share` : tx``}`;
    if (!member) throw notFound();
    return work(tx);
   });
  } catch (error) {
   if (error instanceof Error && 'code' in error && error.code === '23505' && 'constraint_name' in error) {
    if (error.constraint_name === 'saved_views_name') throw nameExists();
    if (error.constraint_name === 'saved_views_pkey' || error.constraint_name === 'saved_views_organisation_id_id_key') throw idUnavailable();
   }
   throw error;
  }
 }

 /** The actor's live view, or 404 whether it is unknown, another person's, another tenant's or deleted. */
 private async live(tx: TransactionSql, actor: Actor, organisationId: string, viewId: string, lock = false): Promise<Stored> {
  const [row] = await tx<Stored[]>`select ${tx.unsafe(columns)} from saved_views where id = ${viewId} and organisation_id = ${organisationId}
   and owner_id = ${actor.userId} and deleted_at is null ${lock ? tx`for update` : tx``}`;
  if (!row) throw notFound();
  return row;
 }

 /** At save time every referenced tag and project must exist in this organisation. A project may be archived or
  *  proposed: naming a project in Work is an explicit request for its tasks. */
 private async checkReferences(tx: TransactionSql, filter: WorkFilter) {
  if (filter.tagIds.length) {
   const found = await tx<{ id: string }[]>`select id from tags where id in ${tx(filter.tagIds)}`;
   if (found.length !== filter.tagIds.length)
    throw new HttpError(400, 'filter_reference_unavailable', 'A tag in this filter does not exist in this organisation. Remove it and save again.', 'tagIds');
  }
  if (filter.projectId) {
   const [project] = await tx`select id from projects where id = ${filter.projectId}`;
   if (!project) throw new HttpError(400, 'filter_reference_unavailable', 'The project in this filter does not exist in this organisation. Choose another project and save again.', 'projectId');
  }
 }

 /** Personal views: organisation audit readers see that a member created, changed or deleted a view and its id,
  *  never its name or what it filters. */
 private record(tx: TransactionSql, actor: Actor, organisationId: string, action: string, detail: { viewId: string; filterVersion: number | null; revision: number }) {
  return audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId,
   action, subjectType: 'saved_view', subjectId: detail.viewId, detail });
 }

 list(actor: Actor, organisationId: string, raw: unknown) {
  const query = listViews.parse(raw);
  return this.tx(actor, organisationId, null, async tx => {
   const rows = await tx<Stored[]>`select ${tx.unsafe(columns)} from saved_views where organisation_id = ${organisationId}
    and owner_id = ${actor.userId} and deleted_at is null order by lower(name), id limit ${query.limit + 1} offset ${query.offset}`;
   return { views: rows.slice(0, query.limit).map(present), nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  });
 }

 /** The record is read and committed first; names are then resolved separately, so a failed name lookup never
  *  discards or changes the filter. */
 async get(actor: Actor, organisationId: string, viewId: string): Promise<SavedViewDetail> {
  const view = await this.tx(actor, organisationId, null, async tx => present(await this.live(tx, actor, organisationId, viewId)));
  if (!view.applicable) return { ...view, references: null };
  return { ...view, references: { tags: await this.tagReferences(actor, organisationId, view.filter.tagIds),
   project: view.filter.projectId ? await this.projectReference(actor, organisationId, view.filter.projectId) : null } };
 }

 /** One bounded read per reference kind in the owner's own tenant context. "Missing" only ever means the ID was
  *  looked up directly and did not resolve; any failure, including a membership change mid-read, is "unavailable". */
 private referenceRead<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
   const [member] = await tx`select user_id from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId} and status = 'active'`;
   if (!member) throw new Error('membership is no longer active');
   return work(tx);
  });
 }
 private async tagReferences(actor: Actor, organisationId: string, tagIds: string[]): Promise<TagReference[]> {
  if (!tagIds.length) return [];
  try {
   const found = await this.referenceRead(actor, organisationId, tx => tx<{ id: string; name: string }[]>`select id, name from tags where id in ${tx(tagIds)}`);
   const names = new Map(found.map(tag => [tag.id, tag.name]));
   return tagIds.map(id => { const tagName = names.get(id); return tagName === undefined ? { id, state: 'missing' as const } : { id, state: 'available' as const, name: tagName }; });
  } catch (error) {
   console.error(`[${actor.requestId}] saved view tag names could not be read`, error instanceof Error ? error.message : error);
   return tagIds.map(id => ({ id, state: 'unavailable' as const }));
  }
 }
 private async projectReference(actor: Actor, organisationId: string, projectId: string): Promise<ProjectReference> {
  try {
   const [project] = await this.referenceRead(actor, organisationId, tx => tx<{ id: string; name: string; state: 'active' | 'proposed' | 'archived' }[]>`
    select id, name, state from projects where id = ${projectId}`);
   return project ? { id: projectId, state: 'available', name: project.name, projectState: project.state } : { id: projectId, state: 'missing' };
  } catch (error) {
   console.error(`[${actor.requestId}] saved view project name could not be read`, error instanceof Error ? error.message : error);
   return { id: projectId, state: 'unavailable' };
  }
 }

 /** The client generates the id. A matching retry by the same owner returns the stored live view; anything else
  *  under that id — a changed view, a tombstone, or a row hidden by row security — is the same generic 409. */
 create(actor: Actor, organisationId: string, raw: unknown): Promise<{ view: SavedView; created: boolean }> {
  const input = createView.parse(raw);
  const filter = parseFilter(input.filter);
  return this.tx(actor, organisationId, 'update', async tx => {
   // Includes this person's tombstones: a deleted view's id stays reserved.
   const [existing] = await tx<(Omit<Stored, 'name' | 'filterVersion'> & { name: string | null; filterVersion: number | null; deletedAt: Date | null })[]>`
    select ${tx.unsafe(columns)}, deleted_at from saved_views where id = ${input.id} and organisation_id = ${organisationId} and owner_id = ${actor.userId}`;
   if (existing) {
    if (existing.deletedAt || existing.name !== input.name || existing.filterVersion !== 1) throw idUnavailable();
    const stored = present({ id: existing.id, name: input.name, filterVersion: 1, filter: existing.filter, revision: existing.revision,
     createdAt: existing.createdAt, updatedAt: existing.updatedAt });
    if (!stored.applicable || !sameFilter(stored.filter, filter)) throw idUnavailable();
    return { view: stored, created: false };
   }
   await this.checkReferences(tx, filter);
   const [live] = await tx<{ count: number }[]>`select count(*)::int as count from saved_views
    where organisation_id = ${organisationId} and owner_id = ${actor.userId} and deleted_at is null`;
   if ((live?.count ?? 0) >= viewLimit) throw conflict('view_limit', `You can keep up to ${viewLimit} saved views. Delete one before saving another.`);
   // A conflicting id here can only be a row row security hides from this person: their own rows were read above
   // while holding the membership lock that every one of their creates takes.
   const [row] = await tx<Stored[]>`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
    values (${input.id}, ${organisationId}, ${actor.userId}, ${input.name}, 1, ${tx.json(filter as never)})
    on conflict (id) do nothing returning ${tx.unsafe(columns)}`;
   if (!row) throw idUnavailable();
   await this.record(tx, actor, organisationId, 'saved_view.created', { viewId: row.id, filterVersion: row.filterVersion, revision: row.revision });
   return { view: present(row), created: true };
  });
 }

 /** Rename, replace the filter, or both, from the revision the edit was based on. References are checked only when
  *  a filter is supplied; a name-only change leaves the stored filter and its version untouched. */
 update(actor: Actor, organisationId: string, viewId: string, raw: unknown): Promise<SavedView> {
  const input = updateView.parse(raw);
  const filter = input.filter === undefined ? undefined : parseFilter(input.filter);
  return this.tx(actor, organisationId, 'share', async tx => {
   const before = await this.live(tx, actor, organisationId, viewId, true);
   if (before.revision !== input.expectedRevision) throw stale();
   if (filter) await this.checkReferences(tx, filter);
   const newName = input.name ?? before.name;
   const [row] = filter
    ? await tx<Stored[]>`update saved_views set name = ${newName}, filter_version = 1, filter = ${tx.json(filter as never)}, updated_at = now()
       where id = ${viewId} and deleted_at is null returning ${tx.unsafe(columns)}`
    : await tx<Stored[]>`update saved_views set name = ${newName}, updated_at = now()
       where id = ${viewId} and deleted_at is null returning ${tx.unsafe(columns)}`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'saved_view.updated', { viewId, filterVersion: row.filterVersion, revision: row.revision });
   return present(row);
  });
 }

 /** A tombstone: the name, filter and version are cleared and the revision moves on. The id stays reserved, so a
  *  retried create can never bring the view back. A second delete is 404. */
 remove(actor: Actor, organisationId: string, viewId: string, raw: unknown): Promise<{ ok: true }> {
  const input = deleteView.parse(raw);
  return this.tx(actor, organisationId, 'share', async tx => {
   const before = await this.live(tx, actor, organisationId, viewId, true);
   if (before.revision !== input.expectedRevision) throw stale();
   const [row] = await tx<{ revision: number }[]>`update saved_views set deleted_at = now(), name = null, filter = null, filter_version = null, updated_at = now()
    where id = ${viewId} and deleted_at is null returning revision`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'saved_view.deleted', { viewId, filterVersion: before.filterVersion, revision: row.revision });
   return { ok: true as const };
  });
 }
}
