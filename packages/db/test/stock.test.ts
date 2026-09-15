import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
let a: { org: string; user: string; company: string; item: string }; let b: typeof a;
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 async function seed(name: string) {
  const [o] = await db.owner`insert into organisations (name) values (${name}) returning id`;
  const [u] = await db.owner`insert into users (email) values (${`${name}@test.com`}) returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${o!.id}, ${u!.id}, 'member')`;
  const [c] = await db.owner`insert into companies (organisation_id, name) values (${o!.id}, 'Supplier') returning id`;
  const [i] = await db.owner`insert into stock_items (organisation_id, name, location, unit_label, preferred_supplier_id) values (${o!.id}, 'Malt', 'Store', 'bags', ${c!.id}) returning id`;
  await db.owner`insert into stock_counts (organisation_id, item_id, counted_by, count) values (${o!.id}, ${i!.id}, ${u!.id}, 10)`;
  return { org: o!.id as string, user: u!.id as string, company: c!.id as string, item: i!.id as string };
 } a = await seed('A'); b = await seed('B');
});
after(async () => { await db?.close(); });
const ctx = () => ({ organisationId: a.org, userId: a.user });
it('stock tables force RLS; reads and updates cannot see another tenant; tenant changes and hidden inserts fail', async () => {
 for (const table of ['stock_items', 'stock_counts']) {
  const [flags] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`; assert.equal(flags!.relrowsecurity, true); assert.equal(flags!.relforcerowsecurity, true);
  assert.equal((await db.app`select * from ${db.app(table)}`).length, 0);
  await withTenant(db.app, ctx(), async (tx) => { assert.deepEqual((await tx`select organisation_id from ${tx(table)}`).map((r) => r.organisationId), [a.org]); });
 }
 await withTenant(db.app, ctx(), async (tx) => { assert.equal((await tx`update stock_items set name = 'hidden' where id = ${b.item} returning id`).length, 0); });
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`update stock_items set organisation_id = ${b.org}`), { code: '42501' });
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`insert into stock_items (organisation_id, name, location, unit_label) values (${b.org}, 'Wrong', 'Store', 'bags')`), { code: '42501' });
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`insert into stock_counts (organisation_id, item_id, counted_by, count) values (${b.org}, ${b.item}, ${b.user}, 1)`), { code: '42501' });
});
it('composite supplier, item and member foreign keys reject hidden rows even when FK checks bypass RLS', async () => {
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`update stock_items set preferred_supplier_id = ${b.company} where id = ${a.item}`), { code: '23503' });
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`update stock_items set current_count = 1, counted_at = now(), counted_by = ${b.user} where id = ${a.item}`), { code: '23503' });
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`insert into stock_counts (organisation_id, item_id, counted_by, count) values (${a.org}, ${b.item}, ${a.user}, 1)`), { code: '23503' });
});
it('only an active member can write; counts cannot impersonate another member; history is append-only', async () => {
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update stock_items set notes = 'system'`), { code: '42501' });
 await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: b.user }, (tx) => tx`update stock_items set notes = 'outsider'`), { code: '42501' });
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${a.org}, ${b.user}, 'member')`;
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`insert into stock_counts (organisation_id, item_id, counted_by, count) values (${a.org}, ${a.item}, ${b.user}, 1)`), { code: '42501' });
 for (const command of ['update stock_counts set count = 1', 'delete from stock_counts', 'delete from stock_items']) await assert.rejects(withTenant(db.app, ctx(), (tx) => tx.unsafe(command)), { code: '42501' });
 await db.owner`update memberships set status = 'removed' where organisation_id = ${a.org} and user_id = ${b.user}`;
 await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: b.user }, (tx) => tx`update stock_items set notes = 'removed'`), { code: '42501' });
});
it('unknown counts stay null; uniqueness includes location and numeric checks reject negative or non-finite counts', async () => {
 const [item] = await withTenant(db.app, ctx(), (tx) => tx`select current_count, counted_at, counted_by from stock_items`); assert.equal(item!.currentCount, null); assert.equal(item!.countedBy, null);
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`insert into stock_items (organisation_id, name, location, unit_label) values (${a.org}, 'Malt', 'Store', 'bags')`), { code: '23505' });
 await withTenant(db.app, ctx(), (tx) => tx`insert into stock_items (organisation_id, name, location, unit_label) values (${a.org}, 'Malt', 'Cool room', 'bags')`);
 for (const n of ['-1', 'NaN', 'Infinity']) await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`insert into stock_counts (organisation_id, item_id, counted_by, count) values (${a.org}, ${a.item}, ${a.user}, ${n}::numeric)`), { code: '23514' });
 await assert.rejects(withTenant(db.app, ctx(), (tx) => tx`update stock_items set current_count = 1 where id = ${a.item}`), { code: '23514' });
});
