import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { changeSetId, createdRecord, personChangeSet } from '../changes.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
type Actor = { userId: string; requestId: string };
const text = (max: number) => z.string().trim().max(max);
// Decimal strings preserve the count exactly; ordinary JSON numbers remain convenient for callers.
const quantity = z.union([z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String), text(80)])
 .pipe(z.string().regex(/^\d+(?:\.\d+)?$/, 'Enter a count of zero or more.'));
const itemSchema = z.object({ changeSetId: changeSetId.optional(), name: text(200).min(1), location: text(200).min(1), unitLabel: text(80).min(1),
 reorderPoint: quantity.nullable().optional(), preferredSupplierId: z.string().uuid().nullable().optional(), notes: text(5000).optional() }).strict();
const revision = z.number().int().min(1).max(2_147_483_646);
// `expectedRevision` is optional so existing callers keep working; when it is sent a moved item is `409 stale_revision`.
const editSchema = itemSchema.partial().extend({ archived: z.boolean().optional(), expectedRevision: revision.optional() });
const countSchema = z.object({ changeSetId: changeSetId.optional(), count: quantity, note: text(1000).optional() }).strict();
/** A stocktake (stock contract §2): many counts as one change set. The ids are unique; each count is the per-item count. */
export const stocktakeLimit = 200;
const stocktakeSchema = z.object({ changeSetId, counts: z.array(z.object({ itemId: z.string().uuid().transform((v) => v.toLowerCase()), expectedRevision: revision, count: quantity,
 note: text(1000).optional() }).strict()).min(1).max(stocktakeLimit) }).strict();
const stale = (itemIds: string[]) => new HttpError(409, 'stale_revision', 'Some items changed since you opened them. Nothing was saved; check them and save again.', undefined, { itemIds });
const archivedItems = (itemIds: string[]) => new HttpError(400, 'stock_archived', 'Some items are archived. Nothing was saved; restore them or leave them out.', undefined, { itemIds });
/** A list row (as `GET …/stock` returns it), for the items `where` selects. */
const rows = (tx: TransactionSql, where: ReturnType<TransactionSql>) => tx`select s.*, s.current_count::text, s.reorder_point::text,
 coalesce(nullif(u.name, ''), u.email) as counted_by_name, c.name as supplier_name,
 case when s.current_count is null or s.reorder_point is null then null else s.current_count < s.reorder_point end as below_reorder
 from stock_items s left join users u on u.id = s.counted_by left join companies c on c.organisation_id = s.organisation_id and c.id = s.preferred_supplier_id
 ${where} order by s.archived_at nulls first, s.location, s.name, s.id`;
export class StockService {
 readonly db: Sql;
 readonly emit: (tx: TransactionSql, org: string, event: string, data: unknown, waitKey: string) => Promise<unknown>;
 constructor(db: Sql, emit: StockService['emit'] = async () => {}) { this.db = db; this.emit = emit; }
 private async tenant<T>(actor: Actor, org: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  try { return await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   const [member] = await tx`select role from memberships where organisation_id = ${org} and user_id = ${actor.userId} and status = 'active' for share`;
   if (!member) throw notFound(); return work(tx);
  }); } catch (e) {
   if (e && typeof e === 'object' && 'code' in e && e.code === '23505') throw new HttpError(409, 'stock_exists', 'That item is already listed at this location. Check archived items too.');
   throw e;
  }
 }
 async list(actor: Actor, org: string, location?: string, includeArchived = false) {
  return this.tenant(actor, org, async (tx) => {
   const items = await rows(tx, tx`where (${includeArchived} or s.archived_at is null) and (${location ?? null}::text is null or s.location = ${location ?? null})`);
   const locations = await tx`select distinct location from stock_items where archived_at is null order by location`;
   const suppliers = await tx`select id, name from companies where archived_at is null order by name, id`;
   const [organisation] = await tx`select timezone from organisations where id = ${org}`;
   return { items, locations: locations.map((r) => r.location as string), suppliers, timezone: organisation!.timezone as string };
  });
 }
 /** One item as the list returns it, archived or not, with its latest three counts (who, when, what, the note), the active
  *  locations and the organisation's zone: what the stock card shows and edits. */
 async item(actor: Actor, org: string, id: string) {
  return this.tenant(actor, org, async (tx) => {
   const [item] = await rows(tx, tx`where s.id = ${id}`);
   if (!item) throw notFound('That stock item is not available.');
   const counts = await tx`select k.id, k.item_id, k.count::text, k.note, k.counted_at, k.counted_by, coalesce(nullif(u.name, ''), u.email) as counted_by_name
    from stock_counts k left join users u on u.id = k.counted_by where k.item_id = ${id} order by k.counted_at desc, k.id desc limit 3`;
   const locations = await tx`select distinct location from stock_items where archived_at is null order by location`;
   const [organisation] = await tx`select timezone from organisations where id = ${org}`;
   return { item, counts, locations: locations.map((r) => r.location as string), timezone: organisation!.timezone as string };
  });
 }
 async save(actor: Actor, org: string, raw: unknown, id?: string) {
  const { changeSetId: wanted, ...input } = id ? editSchema.parse(raw) : itemSchema.parse(raw);
  return this.tenant(actor, org, async (tx) => {
   const changeSet = await personChangeSet(tx, actor, id ? 'stock.update' : 'stock.create', { id: id ?? null, ...input }, wanted);
   if (changeSet.matched) {
    const made = id ?? await createdRecord(tx, changeSet.id, 'stock_item');
    const [item] = made ? await tx`select * from stock_items where id = ${made}` : [];
    if (!item) throw notFound('That stock item is not available.');
    return Object.assign(item, { changeSetId: changeSet.id });
   }
   const [old] = id ? await tx`select * from stock_items where id = ${id} for update` : [];
   if (id && !old) throw notFound('That stock item is not available.');
   const expected = 'expectedRevision' in input ? input.expectedRevision : undefined;
   if (old && expected !== undefined && old.revision !== expected) throw new HttpError(409, 'stale_revision', 'This item changed since you opened it. Reload it before saving again.');
   const archived = 'archived' in input ? input.archived : undefined;
   if (old?.archivedAt && archived !== false) throw badRequest('stock_archived', 'Restore this item before editing or counting it.');
   if (old?.currentCount !== null && old?.currentCount !== undefined && input.unitLabel !== undefined && input.unitLabel !== old.unitLabel)
    throw badRequest('stock_unit_counted', 'This item has count history. Create a separate item to count in a different unit.');
   if (input.preferredSupplierId) {
    const [supplier] = await tx`select id from companies where id = ${input.preferredSupplierId} and (archived_at is null or id = ${old?.preferredSupplierId ?? null}::uuid) for share`;
    if (!supplier) throw badRequest('supplier_unavailable', 'Choose an active supplier company in this organisation.');
   }
   const values = { name: input.name, location: input.location, unitLabel: input.unitLabel, reorderPoint: input.reorderPoint, preferredSupplierId: input.preferredSupplierId, notes: input.notes,
    ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }), updatedAt: new Date() };
   const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
   const [item] = id ? await tx`update stock_items set ${tx(clean)} where id = ${id} returning *`
    : await tx`insert into stock_items ${tx({ ...clean, organisationId: org })} returning *`;
   return Object.assign(item!, { changeSetId: changeSet.id });
  });
 }
 async count(actor: Actor, org: string, id: string, raw: unknown) {
  const { changeSetId: wanted, ...input } = countSchema.parse(raw);
  return this.tenant(actor, org, async (tx) => {
   const changeSet = await personChangeSet(tx, actor, 'stock.count', { id, ...input }, wanted);
   if (changeSet.matched) {
    // The observation this change set recorded: the count it set on the item names it by item and time.
    const [observation] = await tx`select c.* from record_changes rc join stock_counts c on c.item_id = rc.record_id and c.counted_at = (rc.after #>> '{}')::timestamptz
     where rc.change_set_id = ${changeSet.id} and rc.record_kind = 'stock_item' and rc.record_id = ${id} and rc.field = 'counted_at'`;
    if (!observation) throw notFound('That stock item is not available.');
    return Object.assign(observation, { changeSetId: changeSet.id });
   }
   // Serialise observations; obtain the timestamp after the row lock so a delayed writer cannot
   // replace the current count with an observation timestamp from before the preceding writer.
   const [item] = await tx`select archived_at from stock_items where id = ${id} for update`;
   if (!item) throw notFound('That stock item is not available.');
   if (item.archivedAt) throw badRequest('stock_archived', 'Restore this item before counting it.');
   const observation = await this.observe(tx, actor, org, id, input.count, input.note);
   return Object.assign(observation, { changeSetId: changeSet.id });
  });
 }
 /** A stocktake (stock contract §2): every count in one transaction and one change set, each written as `count` writes
  *  it. Items are locked in id order; an unknown or foreign item is 404, any item whose revision moved refuses the whole
  *  stocktake (`409 stale_revision { itemIds }`), any archived one too (`stock_archived { itemIds }`), with nothing
  *  written. A retry with the same id and counts answers the counted items as they are now. */
 async stocktake(actor: Actor, org: string, raw: unknown) {
  const { changeSetId: wanted, counts } = stocktakeSchema.parse(raw);
  const ids = counts.map((c) => c.itemId);
  if (new Set(ids).size !== ids.length) throw badRequest('stocktake_duplicate', 'Each item can be counted once in a stocktake.');
  return this.tenant(actor, org, async (tx) => {
   const changeSet = await personChangeSet(tx, actor, 'stock.stocktake', { counts }, wanted);
   const answer = async () => ({ changeSetId: changeSet.id, items: await rows(tx, tx`where s.id = any(${ids}::uuid[])`) });
   if (changeSet.matched) return answer();
   const locked = await tx<{ id: string; revision: number; archivedAt: Date | null }[]>`select id, revision, archived_at from stock_items where id = any(${ids}::uuid[]) order by id for update`;
   if (locked.length !== ids.length) throw notFound('That stock item is not available.');
   const byId = new Map(locked.map((r) => [r.id, r]));
   const moved = counts.filter((c) => byId.get(c.itemId)!.revision !== c.expectedRevision).map((c) => c.itemId);
   if (moved.length) throw stale(moved);
   const archived = counts.filter((c) => byId.get(c.itemId)!.archivedAt).map((c) => c.itemId);
   if (archived.length) throw archivedItems(archived);
   for (const c of [...counts].sort((a, b) => a.itemId < b.itemId ? -1 : 1)) await this.observe(tx, actor, org, c.itemId, c.count, c.note);
   return answer();
  });
 }
 /** One observation on a locked, active item: the count row, then the item's current count from it, then the event. */
 private async observe(tx: TransactionSql, actor: Actor, org: string, id: string, count: string, note: string | undefined) {
  const [observation] = await tx`insert into stock_counts (organisation_id, item_id, counted_by, count, note)
   values (${org}, ${id}, ${actor.userId}, ${count}, ${note ?? ''}) returning *`;
  await tx`update stock_items s set current_count = c.count, counted_at = c.counted_at, counted_by = c.counted_by, updated_at = clock_timestamp()
   from stock_counts c where s.id = ${id} and c.id = ${observation!.id} and c.organisation_id = s.organisation_id and c.item_id = s.id`;
  await this.emit(tx, org, 'stock.counted', { itemId: id, countId: observation!.id }, `stock:${id}`);
  return observation!;
 }
}
