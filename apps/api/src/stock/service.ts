import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
type Actor = { userId: string; requestId: string };
const text = (max: number) => z.string().trim().max(max);
// Decimal strings preserve the count exactly; ordinary JSON numbers remain convenient for callers.
const quantity = z.union([z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String), text(80)])
 .pipe(z.string().regex(/^\d+(?:\.\d+)?$/, 'Enter a count of zero or more.'));
const itemSchema = z.object({ name: text(200).min(1), location: text(200).min(1), unitLabel: text(80).min(1),
 reorderPoint: quantity.nullable().optional(), preferredSupplierId: z.string().uuid().nullable().optional(), notes: text(5000).optional() }).strict();
const editSchema = itemSchema.partial().extend({ archived: z.boolean().optional() });
const countSchema = z.object({ count: quantity, note: text(1000).optional() }).strict();
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
   const items = await tx`select s.*, s.current_count::text, s.reorder_point::text,
    coalesce(nullif(u.name, ''), u.email) as counted_by_name, c.name as supplier_name,
    case when s.current_count is null or s.reorder_point is null then null else s.current_count < s.reorder_point end as below_reorder
    from stock_items s left join users u on u.id = s.counted_by left join companies c on c.organisation_id = s.organisation_id and c.id = s.preferred_supplier_id
    where (${includeArchived} or s.archived_at is null) and (${location ?? null}::text is null or s.location = ${location ?? null})
    order by s.archived_at nulls first, s.location, s.name, s.id`;
   const locations = await tx`select distinct location from stock_items where archived_at is null order by location`;
   const suppliers = await tx`select id, name from companies where archived_at is null order by name, id`;
   const [organisation] = await tx`select timezone from organisations where id = ${org}`;
   return { items, locations: locations.map((r) => r.location as string), suppliers, timezone: organisation!.timezone as string };
  });
 }
 async save(actor: Actor, org: string, raw: unknown, id?: string) {
  const input = id ? editSchema.parse(raw) : itemSchema.parse(raw);
  return this.tenant(actor, org, async (tx) => {
   const [old] = id ? await tx`select * from stock_items where id = ${id} for update` : [];
   if (id && !old) throw notFound('That stock item is not available.');
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
   await audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, action: id ? archived === true ? 'stock.archived' : archived === false ? 'stock.restored' : 'stock.updated' : 'stock.created',
    subjectType: 'stock_item', subjectId: item!.id, requestId: actor.requestId, detail: { fields: Object.keys(clean) } }); return item!;
  });
 }
 async count(actor: Actor, org: string, id: string, raw: unknown) {
  const input = countSchema.parse(raw);
  return this.tenant(actor, org, async (tx) => {
   // Serialise observations; obtain the timestamp after the row lock so a delayed writer cannot
   // replace the current count with an observation timestamp from before the preceding writer.
   const [item] = await tx`select archived_at from stock_items where id = ${id} for update`;
   if (!item) throw notFound('That stock item is not available.');
   if (item.archivedAt) throw badRequest('stock_archived', 'Restore this item before counting it.');
   const [observation] = await tx`insert into stock_counts (organisation_id, item_id, counted_by, count, note)
    values (${org}, ${id}, ${actor.userId}, ${input.count}, ${input.note ?? ''}) returning *`;
   await tx`update stock_items s set current_count = c.count, counted_at = c.counted_at, counted_by = c.counted_by, updated_at = clock_timestamp()
    from stock_counts c where s.id = ${id} and c.id = ${observation!.id} and c.organisation_id = s.organisation_id and c.item_id = s.id`;
   await audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, action: 'stock.counted', subjectType: 'stock_item', subjectId: id, requestId: actor.requestId, detail: { countId: observation!.id, count: input.count } });
   await this.emit(tx, org, 'stock.counted', { itemId: id, countId: observation!.id }, `stock:${id}`);
   return observation!;
  });
 }
}
