import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip; let db: Harness; let a: { org: string; connection: string; calendar: string }; let b: typeof a;
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 async function seed(name: string) {
  const [org] = await db.owner`insert into organisations (name) values (${name}) returning id`;
  const [user] = await db.owner`insert into users (email) values (${`${name}@test.com`}) returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
  const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status) values (${org!.id}, 'google', ${user!.id}, ${`${name}@test.com`}, '{}', 'connected') returning id`;
  const [cal] = await db.owner`insert into calendars (organisation_id, connection_id, account_email, provider_id, name, timezone, access_role) values (${org!.id}, ${conn!.id}, ${`${name}@test.com`}, 'primary', 'Work', 'Australia/Perth', 'owner') returning id`;
  await db.owner`insert into calendar_events (organisation_id, calendar_id, provider_id, status, summary, description, location, starts_at, ends_at, all_day, timezone, organiser, attendees, html_link, updated_at)
   values (${org!.id}, ${cal!.id}, 'event', 'confirmed', 'Meeting', '', '', now(), now() + interval '1 hour', false, 'Australia/Perth', '{}', '[]', '', now())`;
  return { org: org!.id, connection: conn!.id, calendar: cal!.id };
 }
 a = await seed('A'); b = await seed('B');
});
after(async () => { await db?.close(); });
it('calendar tables force tenant isolation on reads, updates, inserts and deletes', async () => {
 for (const table of ['calendars', 'calendar_events']) {
  const [flags] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`; assert.equal(flags!.relrowsecurity, true); assert.equal(flags!.relforcerowsecurity, true);
  assert.equal((await db.app`select id from ${db.app(table)}`).length, 0);
  await withTenant(db.app, { organisationId: a.org }, async (tx) => {
   assert.deepEqual((await tx`select organisation_id from ${tx(table)}`).map((r) => r.organisationId), [a.org]);
   assert.equal((await tx`delete from ${tx(table)} where organisation_id = ${b.org} returning id`).length, 0);
  });
  await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update ${tx(table)} set organisation_id = ${b.org}`), { code: '42501' });
 }
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into calendars (organisation_id, connection_id, account_email, provider_id, name, timezone, access_role)
  values (${b.org}, ${b.connection}, 'x', 'wrong', '', 'UTC', 'owner')`), { code: '42501' });
});
it('a tenant cannot insert a calendar referencing another tenant connection, or an event referencing its calendar', async () => {
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into calendars (organisation_id, connection_id, account_email, provider_id, name, timezone, access_role)
  values (${a.org}, ${b.connection}, 'x', 'cross', '', 'UTC', 'owner')`), { code: '23503' });
 await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into calendar_events (organisation_id, calendar_id, provider_id, status, summary, description, location, starts_at, ends_at, all_day, timezone, organiser, attendees, html_link, updated_at)
  values (${a.org}, ${b.calendar}, 'cross', 'confirmed', '', '', '', now(), now() + interval '1 hour', false, 'UTC', '{}', '[]', '', now())`), { code: '23503' });
 assert.deepEqual((await db.app`select * from calendar_sync_organisations()`).map((r) => Object.keys(r)), [['organisationId'], ['organisationId']]);
});
