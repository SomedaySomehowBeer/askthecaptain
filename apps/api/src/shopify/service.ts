import { withTenant, type Sql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { badRequest, notFound } from '../errors.ts';
import { shopifyRole, shopifyState, type Actor } from './connections.ts';
export class ShopifyService {
 readonly db: Sql;
 constructor(db: Sql) { this.db = db; }
 async stock(actor: Actor, org: string, belowReorder = false, offset = 0) {
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await shopifyRole(tx, actor, org); const state = await shopifyState(tx);
   if (!state.connected) return { ...state, items: [], nextOffset: null };
   const items = await tx`select p.id, p.provider_id, p.title, p.variant_title, p.sku, p.price::text, p.tracked,
    l.location_provider_id, l.location_name, case when p.tracked then l.available else null end as available, l.updated_at,
    r.reorder_point::text, case when p.tracked and l.available is not null and r.reorder_point is not null then l.available < r.reorder_point else null end as below_reorder
    from shopify_products p left join shopify_inventory_levels l using (organisation_id, connection_id, inventory_item_id)
    left join shopify_reorder_points r on r.organisation_id = p.organisation_id and r.connection_id = p.connection_id and r.variant_provider_id = p.provider_id
    where p.connection_id = ${state.connection!.id} and p.product_status in ('ACTIVE', 'UNLISTED') and (not ${belowReorder} or (p.tracked and l.available < r.reorder_point))
    order by l.location_name nulls last, p.title, p.provider_id, l.location_provider_id limit 201 offset ${offset}`;
   return { ...state, items: items.slice(0, 200), nextOffset: items.length > 200 ? offset + 200 : null };
  });
 }
 async reorder(actor: Actor, org: string, id: string, raw: unknown) {
  const input = z.object({ reorderPoint: z.union([z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().trim().max(80)]).pipe(z.string().regex(/^\d+(?:\.\d+)?$/)).nullable() }).strict().parse(raw);
  await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await shopifyRole(tx, actor, org); const state = await shopifyState(tx); if (!state.connected) throw badRequest('shopify_disconnected', 'Connect Shopify before setting a reorder point.');
   const [product] = await tx`select connection_id, provider_id from shopify_products where id = ${id} and connection_id = ${state.connection!.id} for share`; if (!product) throw notFound();
   if (input.reorderPoint === null) await tx`delete from shopify_reorder_points where connection_id = ${product.connectionId} and variant_provider_id = ${product.providerId}`;
   else await tx`insert into shopify_reorder_points (organisation_id, connection_id, variant_provider_id, reorder_point) values (${org}, ${product.connectionId}, ${product.providerId}, ${input.reorderPoint})
    on conflict (organisation_id, connection_id, variant_provider_id) do update set reorder_point = excluded.reorder_point, updated_at = now()`;
   await audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: 'shopify.reorder_point_updated', subjectType: 'shopify_product', subjectId: id, detail: input });
  });
 }
 async summary(actor: Actor, org: string) {
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await shopifyRole(tx, actor, org); const state = await shopifyState(tx);
   if (!state.connected || !state.lastSyncedAt) return { ...state, totals: null, unfulfilled: null, ordersToday: null, ordersThisWeek: null };
   const [clock] = await tx`select (current_timestamp at time zone timezone)::date::text as today, timezone from organisations where id = ${org}`;
   const rows = await tx`select currency,
    count(*) filter (where (created_at at time zone ${clock!.timezone})::date = ${clock!.today}::date)::int as orders_today,
    count(*) filter (where (created_at at time zone ${clock!.timezone})::date >= date_trunc('week', ${clock!.today}::date) and (created_at at time zone ${clock!.timezone})::date <= ${clock!.today}::date)::int as orders_this_week,
    coalesce(sum(total) filter (where (created_at at time zone ${clock!.timezone})::date = ${clock!.today}::date), 0)::text as total_today,
    coalesce(sum(total) filter (where (created_at at time zone ${clock!.timezone})::date >= date_trunc('week', ${clock!.today}::date) and (created_at at time zone ${clock!.timezone})::date <= ${clock!.today}::date), 0)::text as total_this_week,
    count(*) filter (where fulfilment_status in ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'SCHEDULED', 'ON_HOLD', 'IN_PROGRESS', 'PENDING_FULFILLMENT', 'OPEN', 'REQUEST_DECLINED', 'RESTOCKED'))::int as unfulfilled
    from shopify_orders where connection_id = ${state.connection!.id} and cancelled_at is null and created_at >= current_timestamp - interval '60 days' group by currency order by currency`;
   return { ...state, asOfDate: clock!.today, totals: rows, ordersToday: rows.reduce((n, r) => n + r.ordersToday, 0), ordersThisWeek: rows.reduce((n, r) => n + r.ordersThisWeek, 0), unfulfilled: rows.reduce((n, r) => n + r.unfulfilled, 0),
    coverage: 'Orders accessible in the last 60 days; cancelled orders excluded. Unfulfilled includes partially fulfilled orders. Totals retain their currencies.' };
  });
 }
}
