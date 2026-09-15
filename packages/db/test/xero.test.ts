import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
let a: { org: string; connection: string }; let b: typeof a;
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 async function seed(name: string) {
  const [o] = await db.owner`insert into organisations (name) values (${name}) returning id`;
  const [u] = await db.owner`insert into users (email) values (${`${name}@test.com`}) returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${o!.id}, ${u!.id}, 'owner')`;
  const [c] = await db.owner`insert into connections (organisation_id, provider, connected_by, provider_account_id, scopes, status) values (${o!.id}, 'xero', ${u!.id}, ${name}, '{}', 'connected') returning id`;
  await db.owner`insert into xero_contacts (organisation_id, connection_id, provider_id, name, is_customer, is_supplier, updated_at) values (${o!.id}, ${c!.id}, 'contact', ${name}, true, false, now())`;
  await db.owner`insert into xero_invoices (organisation_id, connection_id, provider_id, contact_provider_id, type, status, date, currency, total, amount_due, amount_paid, updated_at) values (${o!.id}, ${c!.id}, 'invoice', 'contact', 'ACCREC', 'AUTHORISED', current_date, 'AUD', 10, 10, 0, now())`;
  await db.owner`insert into xero_payments (organisation_id, connection_id, provider_id, invoice_provider_id, date, amount) values (${o!.id}, ${c!.id}, 'payment', 'invoice', current_date, 1)`;
  return { org: o!.id as string, connection: c!.id as string };
 } a = await seed('A'); b = await seed('B');
});
after(async () => { await db?.close(); });
it('all Xero caches force RLS and reject tenant changes, hidden reads/updates/deletes and foreign connection inserts', async () => {
 for (const table of ['xero_contacts', 'xero_invoices', 'xero_payments']) {
  const [flags] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`; assert.equal(flags!.relrowsecurity, true); assert.equal(flags!.relforcerowsecurity, true);
  assert.equal((await db.app`select id from ${db.app(table)}`).length, 0);
  await withTenant(db.app, { organisationId: a.org }, async (tx) => {
   assert.deepEqual((await tx`select organisation_id from ${tx(table)}`).map((r) => r.organisationId), [a.org]);
   assert.equal((await tx`update ${tx(table)} set provider_id = 'wrong' where organisation_id = ${b.org} returning id`).length, 0);
   assert.equal((await tx`delete from ${tx(table)} where organisation_id = ${b.org} returning id`).length, 0);
  });
  await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update ${tx(table)} set organisation_id = ${b.org}`), { code: '42501' });
  await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update ${tx(table)} set connection_id = ${b.connection}`), { code: '23503' });
 }
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into xero_contacts (organisation_id, connection_id, provider_id, name, is_customer, is_supplier, updated_at) values (${a.org}, ${b.connection}, 'hidden', 'Wrong', true, false, now())`), { code: '23503' });
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into xero_contacts (organisation_id, connection_id, provider_id, name, is_customer, is_supplier, updated_at) values (${b.org}, ${b.connection}, 'hidden', 'Wrong', true, false, now())`), { code: '42501' });
});
it('provider references cannot point at another connection’s contact or invoice; exact decimals survive', async () => {
 await db.owner`update xero_payments set invoice_provider_id = 'invoice' where organisation_id = ${b.org}`;
 await db.owner`insert into xero_contacts (organisation_id, connection_id, provider_id, name, is_customer, is_supplier, updated_at) values (${b.org}, ${b.connection}, 'hidden-contact', 'Hidden', false, true, now())`;
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update xero_invoices set contact_provider_id = 'hidden-contact'`), { code: '23503' });
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update xero_payments set invoice_provider_id = 'missing-invoice'`), { code: '23503' });
 await withTenant(db.app, { organisationId: a.org }, async (tx) => { await tx`update xero_invoices set total = '9999999999999999.99'`; const [r] = await tx`select total::text from xero_invoices`; assert.equal(r!.total, '9999999999999999.99'); });
});
