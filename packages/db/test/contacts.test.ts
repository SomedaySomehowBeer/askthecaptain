import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
let a: { org: string; company: string; contact: string; thread: string }; let b: typeof a;
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 async function seed(name: string) {
  const [org] = await db.owner`insert into organisations (name) values (${name}) returning id`;
  const [user] = await db.owner`insert into users (email) values (${`${name}@example.test`}) returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
  const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status) values (${org!.id}, 'google', ${user!.id}, 'own@example.test', '{}', 'connected') returning id`;
  const [thread] = await db.owner`insert into mail_threads (organisation_id, connection_id, account_email, provider_id, last_message_at) values (${org!.id}, ${conn!.id}, 'own@example.test', 'thread', now()) returning id`;
  const [company] = await db.owner`insert into companies (organisation_id, name, domain) values (${org!.id}, ${name}, 'example.test') returning id`;
  const [contact] = await db.owner`insert into contacts (organisation_id, company_id, email, source, last_thread_id) values (${org!.id}, ${company!.id}, 'person@example.test', 'mail', ${thread!.id}) returning id`;
  return { org: org!.id, company: company!.id, contact: contact!.id, thread: thread!.id };
 }
 a = await seed('A'); b = await seed('B');
});
after(async () => { await db?.close(); });
it('companies and contacts force RLS on reads, writes, deletes, and organisation changes', async () => {
 for (const table of ['companies', 'contacts']) {
  const [flags] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`;
  assert.equal(flags!.relrowsecurity, true); assert.equal(flags!.relforcerowsecurity, true);
  assert.equal((await db.app`select id from ${db.app(table)}`).length, 0);
  await withTenant(db.app, { organisationId: a.org }, async (tx) => {
   assert.deepEqual((await tx`select organisation_id from ${tx(table)}`).map((r) => r.organisationId), [a.org]);
   assert.equal((await tx`update ${tx(table)} set name = 'hidden' where organisation_id = ${b.org} returning id`).length, 0);
   assert.equal((await tx`delete from ${tx(table)} where organisation_id = ${b.org} returning id`).length, 0);
  });
  await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update ${tx(table)} set organisation_id = ${b.org}`), { code: '42501' });
 }
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into companies (organisation_id, name) values (${b.org}, 'wrong')`), { code: '42501' });
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into contacts (organisation_id, email, source) values (${b.org}, 'wrong@example.test', 'hand')`), { code: '42501' });
});
it('tenant-qualified company and thread references reject hidden rows on inserts and updates', async () => {
 for (const [column, foreignId] of [['company_id', b.company], ['last_thread_id', b.thread]]) {
  await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into contacts (organisation_id, email, source, ${tx(column!)}) values (${a.org}, 'cross@example.test', 'hand', ${foreignId!})`), { code: '23503' });
  await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update contacts set ${tx(column!)} = ${foreignId!} where id = ${a.contact}`), { code: '23503' });
 }
});
it('emails are lowercase and unique per tenant; deleting a thread preserves its contact and tenant', async () => {
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into contacts (organisation_id, email, source) values (${a.org}, 'Person@example.test', 'hand')`), { code: '23514' });
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into contacts (organisation_id, email, source) values (${a.org}, 'person@example.test', 'hand')`), { code: '23505' });
 await withTenant(db.app, { organisationId: a.org }, async (tx) => {
  await tx`delete from mail_threads where id = ${a.thread}`;
  const [contact] = await tx`select organisation_id, last_thread_id from contacts where id = ${a.contact}`;
  assert.equal(contact!.organisationId, a.org); assert.equal(contact!.lastThreadId, null);
 });
});
