import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
let a: { org: string; user: string; conn: string }; let b: typeof a;
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 async function seed(name: string) {
  const [o] = await db.owner`insert into organisations (name) values (${name}) returning id`; const [u] = await db.owner`insert into users (email) values (${`${name}@test.com`}) returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${o!.id}, ${u!.id}, 'member')`;
  const [c] = await db.owner`insert into connections (organisation_id, provider, connected_by, scopes, status, provider_account_id) values (${o!.id}, 'shopify', ${u!.id}, '{}', 'connected', 'shop.myshopify.com') returning id`;
  await db.owner`insert into shopify_products (organisation_id, connection_id, provider_id, product_provider_id, title, variant_title, price, product_status, inventory_item_id, tracked, seen_run) values (${o!.id}, ${c!.id}, 'v1', 'p1', 'Beer', 'Can', 10, 'ACTIVE', 'i1', true, ${o!.id})`;
  await db.owner`insert into shopify_inventory_levels (organisation_id, connection_id, inventory_item_id, location_provider_id, location_name, available, updated_at, seen_run) values (${o!.id}, ${c!.id}, 'i1', 'l1', 'Shop', -1, now(), ${o!.id})`;
  await db.owner`insert into shopify_orders (organisation_id, connection_id, provider_id, number, fulfilment_status, total, currency, created_at, updated_at) values (${o!.id}, ${c!.id}, 'o1', '#1', 'UNFULFILLED', 10, 'AUD', now(), now())`;
  await db.owner`insert into shopify_reorder_points (organisation_id, connection_id, variant_provider_id, reorder_point) values (${o!.id}, ${c!.id}, 'v1', 5)`;
  return { org: o!.id as string, user: u!.id as string, conn: c!.id as string };
 } a = await seed('Shop A'); b = await seed('Shop B');
});
after(async () => { await db?.close(); });
it('all Shopify tables force RLS and hide other tenants on reads, updates and deletes', async () => {
 for (const table of ['shopify_products', 'shopify_inventory_levels', 'shopify_orders', 'shopify_reorder_points']) {
  const [flags] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`; assert.equal(flags!.relrowsecurity, true); assert.equal(flags!.relforcerowsecurity, true);
  assert.equal((await db.app`select * from ${db.app(table)}`).length, 0);
  await withTenant(db.app, { organisationId: a.org, userId: a.user }, async (tx) => {
   assert.deepEqual((await tx`select organisation_id from ${tx(table)}`).map((r) => r.organisationId), [a.org]);
   assert.equal((await tx`update ${tx(table)} set organisation_id = ${b.org} where organisation_id = ${b.org} returning id`).length, 0);
   assert.equal((await tx`delete from ${tx(table)} where organisation_id = ${b.org} returning id`).length, 0);
  });
  await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) => tx`update ${tx(table)} set organisation_id = ${b.org}`), { code: '42501' });
 }
});
it('composite connection and cache FKs prevent references to hidden tenants even during owner-run FK checks', async () => {
 const ctx = { organisationId: a.org, userId: a.user };
 for (const table of ['shopify_products', 'shopify_inventory_levels', 'shopify_orders', 'shopify_reorder_points']) await assert.rejects(withTenant(db.app, ctx, (tx) => tx`update ${tx(table)} set connection_id = ${b.conn}`), { code: '23503' });
 await assert.rejects(withTenant(db.app, ctx, (tx) => tx`insert into shopify_inventory_levels (organisation_id, connection_id, inventory_item_id, location_provider_id, location_name, available, updated_at, seen_run) values (${a.org}, ${b.conn}, 'i1', 'hidden', 'Hidden', 1, now(), ${a.org})`), { code: '23503' });
 await assert.rejects(withTenant(db.app, ctx, (tx) => tx`insert into shopify_reorder_points (organisation_id, connection_id, variant_provider_id, reorder_point) values (${a.org}, ${a.conn}, 'missing', 5)`), { code: '23503' });
});
it('systems can maintain provider caches; only active members can write reorder points', async () => {
 await withTenant(db.app, { organisationId: a.org }, (tx) => tx`update shopify_inventory_levels set available = -2`);
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into shopify_reorder_points (organisation_id, connection_id, variant_provider_id, reorder_point) values (${a.org}, ${a.conn}, 'v1', 3)`), { code: '42501' });
 await withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) => tx`update shopify_reorder_points set reorder_point = 0`);
 for (const value of ['-1', 'NaN', 'Infinity']) await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) => tx`update shopify_reorder_points set reorder_point = ${value}::numeric`), { code: '23514' });
 await db.owner`update memberships set status = 'removed' where organisation_id = ${a.org}`;
 assert.equal((await withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) => tx`update shopify_reorder_points set reorder_point = 4 returning id`)).length, 0);
});
