import { randomUUID } from 'node:crypto';
import { queries, ShopifyError } from '@captain/connectors/shopify';
import { withTenant, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { HttpError } from '../errors.ts';
import { shopifyState, type ShopifyConnections } from './connections.ts';
import { gid, pageSchema, productSchema, saveProduct, saveLevel, saveOrder, orderSchema } from './store.ts';
const busy = () => new HttpError(409, 'shopify_sync_running', 'Shopify sync is already running or the connection changed. Check again shortly.');
const failure = 'Shopify sync did not finish. Cached shop data may be incomplete. Try Sync now again; reconnect Shopify if access has expired.';
/** Fenced, paged housekeeping. No provider call holds a tenant transaction open. */
export class ShopifySync {
 readonly connections: ShopifyConnections; readonly now: () => number; readonly sleep: (ms: number) => Promise<void>;
 constructor(connections: ShopifyConnections, now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) { this.connections = connections; this.now = now; this.sleep = sleep; }
 async organisations(): Promise<string[]> { return (await this.connections.db`select organisation_id from shopify_sync_organisations()`).map((r) => r.organisationId); }
 async run(org: string) {
  const { db, client } = this.connections; const run = randomUUID(); let conn: { id: string; providerAccountId: string } | undefined; let acquired = false;
  const counts = { products: 0, levels: 0, orders: 0 }; const started = new Date(this.now()).toISOString(); const cutoff = new Date(this.now() - 60 * 86_400_000).toISOString();
  const batch = <T>(work: (tx: TransactionSql) => Promise<T>) => withTenant(db, { organisationId: org }, async (tx) => {
   const [current] = await tx`select status, provider_account_id from connections where id = ${conn!.id} for update`;
   if (current?.status !== 'connected' || current.providerAccountId !== conn!.providerAccountId) throw busy();
   const rows = await tx`update sync_cursors set updated_at = clock_timestamp() where connection_id = ${conn!.id} and resource = 'shopify.sync-lock' and cursor = ${run} and updated_at > clock_timestamp() - interval '2 minutes' returning id`;
   if (!rows.length) throw busy(); return work(tx);
  });
  const cursor = async (tx: TransactionSql, resource: string, value: string) => { await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org}, ${conn!.id}, ${resource}, ${value}) on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = clock_timestamp()`; };
  const journal = (tx: TransactionSql, action: string, detail: Record<string, unknown>) => audit(tx, { organisationId: org, actor: { kind: 'system' }, action, subjectType: 'connection', subjectId: conn!.id, detail });
  const state = async (tx: TransactionSql, complete: boolean, error: string | null) => {
   const old = await shopifyState(tx);
   await cursor(tx, 'shopify.state', JSON.stringify({ complete, error, lastSyncedAt: complete ? started : old.lastSyncedAt, coverageSince: complete ? cutoff : old.coverageSince }));
  };
  const request = async (query: string, variables: Record<string, unknown> = {}) => {
   const rateKey = `shopify.rate:${conn!.providerAccountId}`;
   for (let attempt = 0; attempt < 3; attempt++) {
    const delay = await batch(async (tx) => { const [row] = await tx`select cursor from sync_cursors where connection_id = ${conn!.id} and resource = ${rateKey}`; return row ? Math.max(0, z.number().finite().parse(Number(row.cursor)) - this.now()) : 0; });
    if (delay > 60_000) throw new ShopifyError(429, Math.ceil(delay / 1000));
    for (let left = delay; left > 0; left -= 30_000) { await this.sleep(Math.min(left, 30_000)); await batch(async () => {}); }
    const token = await this.connections.accessToken(org, conn!.id, conn!.providerAccountId);
    try {
     const reply = await client!.graphql(conn!.providerAccountId, token, query, variables);
     await batch((tx) => cursor(tx, rateKey, String(this.now() + reply.delayMs))); return reply.data;
    } catch (e) {
     if (!(e instanceof ShopifyError) || e.status !== 429) throw e;
     await batch((tx) => cursor(tx, rateKey, String(this.now() + e.retryAfter * 1000)));
     if (attempt === 2 || e.retryAfter > 60) throw e;
    }
   } throw new ShopifyError(429);
  };
  const pages = async (query: string, variables: Record<string, unknown>, extract: (data: Record<string, unknown>) => unknown, visit: (nodes: unknown[]) => Promise<void>) => {
   let after: string | null = null; const seen = new Set<string>();
   for (let n = 0; n < 5000; n++) {
    const page = pageSchema.parse(extract(await request(query, { ...variables, after }))); await visit(page.nodes);
    if (!page.pageInfo.hasNextPage) return;
    const next = page.pageInfo.endCursor; if (!next || seen.has(next) || !page.nodes.length) throw new ShopifyError(); seen.add(next); after = next;
   } throw new ShopifyError();
  };
  try {
   conn = await withTenant(db, { organisationId: org }, async (tx) => { const [row] = await tx<{ id: string; providerAccountId: string }[]>`select id, provider_account_id from connections where provider = 'shopify' and status = 'connected' and provider_account_id is not null`; return row; });
   if (!conn || !client) throw new ShopifyError();
   acquired = await withTenant(db, { organisationId: org }, async (tx) => (await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org}, ${conn!.id}, 'shopify.sync-lock', ${run})
    on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = clock_timestamp() where sync_cursors.updated_at < clock_timestamp() - interval '2 minutes' returning id`).length > 0);
   if (!acquired) throw busy();
   await batch(async (tx) => { await state(tx, false, 'Shopify sync is running. Cached shop data may be incomplete.'); await journal(tx, 'shopify.sync_started', {}); });
   await pages(queries.products, {}, (d) => d.productVariants, async (nodes) => {
    const products = nodes.map((p) => productSchema.parse(p));
    await batch(async (tx) => { for (const p of products) await saveProduct(tx, org, conn!.id, run, p); await journal(tx, 'shopify.page_synced', { resource: 'products', count: products.length }); }); counts.products += products.length;
    for (const p of products) if (p.inventoryItem.tracked) await pages(queries.levels, { id: p.inventoryItem.id }, (d) => z.object({ inventoryLevels: z.unknown() }).parse(d.inventoryItem).inventoryLevels, async (levels) => {
     await batch(async (tx) => { for (const l of levels) await saveLevel(tx, org, conn!.id, p.inventoryItem.id, run, l); await journal(tx, 'shopify.page_synced', { resource: 'levels', count: levels.length }); }); counts.levels += levels.length;
    });
   });
   // Only a fully traversed snapshot can remove missing variants and locations.
   await batch(async (tx) => { await tx`delete from shopify_inventory_levels where connection_id = ${conn!.id} and seen_run <> ${run}`; await tx`delete from shopify_products where connection_id = ${conn!.id} and seen_run <> ${run}`; });
   const previous = await batch(async (tx) => { const [row] = await tx`select cursor from sync_cursors where connection_id = ${conn!.id} and resource = 'shopify.orders'`; return row?.cursor as string | undefined; });
   const window = `created_at:>='${cutoff}'`;
   await pages(queries.orders, { query: `${window}${previous ? ` AND updated_at:>='${previous}'` : ''}` }, (d) => d.orders, async (orders) => {
    await batch(async (tx) => { for (const o of orders) await saveOrder(tx, org, conn!.id, o); await journal(tx, 'shopify.page_synced', { resource: 'orders', count: orders.length }); }); counts.orders += orders.length;
   });
   // Cheap identity sweep removes deletions without re-downloading unchanged customer/order fields.
   await pages(queries.orderIds, { query: window }, (d) => d.orders, async (nodes) => {
    for (const node of nodes) {
     const { id } = z.object({ id: gid('Order') }).parse(node);
     const found = await batch(async (tx) => (await tx`update shopify_orders set seen_run = ${run} where connection_id = ${conn!.id} and provider_id = ${id} returning id`).length);
     if (!found) { const data = await request(queries.order, { id }); const order = orderSchema.nullable().parse(data.order); if (order && order.id !== id) throw new ShopifyError(); if (order) await batch(async (tx) => { await saveOrder(tx, org, conn!.id, order); await tx`update shopify_orders set seen_run = ${run} where connection_id = ${conn!.id} and provider_id = ${id}`; await journal(tx, 'shopify.page_synced', { resource: 'order_backfill', count: 1 }); }); }
    }
   });
   await batch(async (tx) => {
    await tx`delete from shopify_orders where connection_id = ${conn!.id} and (seen_run is distinct from ${run}::uuid or created_at < ${cutoff}::timestamptz)`;
    await cursor(tx, 'shopify.orders', new Date(Date.parse(started) - 60_000).toISOString()); await state(tx, true, null); await journal(tx, 'shopify.synced', counts);
   }); return counts;
  } catch (e) {
   if (e instanceof HttpError && e.code === 'shopify_sync_running') throw e;
   const message = e instanceof ShopifyError && e.status === 429 ? `Shopify’s rate limit paused sync. Try after ${new Date(this.now() + e.retryAfter * 1000).toISOString()}. Cached shop data may be incomplete.` : failure;
   if (acquired) await batch(async (tx) => {
    await state(tx, false, message); await journal(tx, 'shopify.sync_failed', { error: message });
    if (e instanceof ShopifyError && [401, 403].includes(e.status)) await tx`update connections set status = 'revoked', error = 'Shopify access was refused. Reconnect in Settings and check the app’s data permissions.', updated_at = now() where id = ${conn!.id}`;
   }).catch(() => undefined);
   throw new HttpError(503, 'shopify_sync_failed', message);
  } finally { if (acquired) await withTenant(db, { organisationId: org }, async (tx) => { await tx`delete from sync_cursors where connection_id = ${conn!.id} and resource = 'shopify.sync-lock' and cursor = ${run}`; }); }
 }
}
export function startShopifySchedule(sync: Pick<ShopifySync, 'organisations' | 'run'>, disabled = false, intervalMs = 900_000) {
 if (disabled) return async () => {}; let active: Promise<void> | undefined;
 const tick = () => { if (active) return; active = (async () => { for (const org of await sync.organisations()) await sync.run(org).catch(() => undefined); })().catch(() => { console.error('[shopify] Scheduled sync could not reach its database.'); }).finally(() => { active = undefined; }); };
 const timer = setInterval(tick, intervalMs); timer.unref(); tick(); return async () => { clearInterval(timer); await active; };
}
