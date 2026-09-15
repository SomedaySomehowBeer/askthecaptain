import { z } from 'zod';
import type { TransactionSql } from '@captain/db';
export const gid = (kind: string) => z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));
const date = z.string().datetime({ offset: true });
const money = z.string().max(80).regex(/^\d+(?:\.\d+)?$/);
export const productSchema = z.object({ id: gid('ProductVariant'), title: z.string(), sku: z.string().nullable(), price: money,
 product: z.object({ id: gid('Product'), title: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']) }), inventoryItem: z.object({ id: gid('InventoryItem'), tracked: z.boolean() }) });
export const levelSchema = z.object({ updatedAt: date, location: z.object({ id: gid('Location'), name: z.string() }),
 quantities: z.array(z.object({ name: z.string(), quantity: z.number().int() })).refine((q) => q.filter((x) => x.name === 'available').length === 1) });
export const orderSchema = z.object({ id: gid('Order'), name: z.string(), email: z.string().nullable(), customer: z.object({ displayName: z.string(), email: z.string().nullable() }).nullable(),
 displayFinancialStatus: z.string().nullable(), displayFulfillmentStatus: z.enum(['FULFILLED', 'IN_PROGRESS', 'ON_HOLD', 'OPEN', 'PARTIALLY_FULFILLED', 'PENDING_FULFILLMENT', 'REQUEST_DECLINED', 'RESTOCKED', 'SCHEDULED', 'UNFULFILLED']), cancelledAt: date.nullable(), totalPriceSet: z.object({ shopMoney: z.object({ amount: money, currencyCode: z.string() }) }), createdAt: date, updatedAt: date });
export const pageSchema = z.object({ nodes: z.array(z.unknown()).max(100), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) });
export async function saveProduct(tx: TransactionSql, org: string, conn: string, run: string, raw: unknown) {
 const p = productSchema.parse(raw);
 const [old] = await tx`select inventory_item_id from shopify_products where connection_id = ${conn} and provider_id = ${p.id}`;
 if (old && old.inventoryItemId !== p.inventoryItem.id) await tx`delete from shopify_inventory_levels where connection_id = ${conn} and inventory_item_id = ${old.inventoryItemId}`;
 await tx`insert into shopify_products (organisation_id, connection_id, provider_id, product_provider_id, title, variant_title, sku, price, product_status, inventory_item_id, tracked, seen_run)
  values (${org}, ${conn}, ${p.id}, ${p.product.id}, ${p.product.title}, ${p.title}, ${p.sku}, ${p.price}, ${p.product.status}, ${p.inventoryItem.id}, ${p.inventoryItem.tracked}, ${run})
  on conflict (organisation_id, connection_id, provider_id) do update set product_provider_id = excluded.product_provider_id, title = excluded.title, variant_title = excluded.variant_title,
  sku = excluded.sku, price = excluded.price, product_status = excluded.product_status, inventory_item_id = excluded.inventory_item_id, tracked = excluded.tracked, seen_run = excluded.seen_run`;
 return p;
}
export async function saveLevel(tx: TransactionSql, org: string, conn: string, item: string, run: string, raw: unknown) {
 const l = levelSchema.parse(raw);
 await tx`insert into shopify_inventory_levels (organisation_id, connection_id, inventory_item_id, location_provider_id, location_name, available, updated_at, seen_run)
  values (${org}, ${conn}, ${item}, ${l.location.id}, ${l.location.name}, ${l.quantities.find((q) => q.name === 'available')!.quantity}, ${l.updatedAt}, ${run})
  on conflict (organisation_id, connection_id, inventory_item_id, location_provider_id) do update set location_name = excluded.location_name, available = excluded.available, updated_at = excluded.updated_at, seen_run = excluded.seen_run`;
}
export async function saveOrder(tx: TransactionSql, org: string, conn: string, raw: unknown) {
 const o = orderSchema.parse(raw);
 await tx`insert into shopify_orders (organisation_id, connection_id, provider_id, number, customer_name, customer_email, financial_status, fulfilment_status, cancelled_at, total, currency, created_at, updated_at)
  values (${org}, ${conn}, ${o.id}, ${o.name}, ${o.customer?.displayName ?? null}, ${o.customer?.email ?? o.email}, ${o.displayFinancialStatus}, ${o.displayFulfillmentStatus}, ${o.cancelledAt}, ${o.totalPriceSet.shopMoney.amount}, ${o.totalPriceSet.shopMoney.currencyCode}, ${o.createdAt}, ${o.updatedAt})
  on conflict (organisation_id, connection_id, provider_id) do update set number = excluded.number, customer_name = excluded.customer_name, customer_email = excluded.customer_email,
  financial_status = excluded.financial_status, fulfilment_status = excluded.fulfilment_status, cancelled_at = excluded.cancelled_at, total = excluded.total, currency = excluded.currency, updated_at = excluded.updated_at
  where shopify_orders.updated_at <= excluded.updated_at`;
}
