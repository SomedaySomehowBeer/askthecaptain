import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { addresses, isCounterparty, publicDomains } from './addresses.ts';
import { upkeepContacts } from './upkeep.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
async function setup() {
 const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 }); const organisations = new OrganisationService(db.app);
 const [owner, member, stranger] = await db.owner`insert into users (email) values (${`${randomUUID()}@test.com`}), (${`${randomUUID()}@test.com`}), (${`${randomUUID()}@test.com`}) returning id`;
 const org = await organisations.create({ userId: owner!.id, requestId: 'test' }, { name: 'People' });
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org.id}, ${member!.id}, 'member')`;
 const app = createApp({ db: db.app, auth, organisations, commitments: new CommitmentsService(db.app) });
 const token = (await auth.issueSessionFor(member!.id)).token; const outsider = (await auth.issueSessionFor(stranger!.id)).token;
 const request = (path: string, method = 'GET', body?: object, bearer = token) => app.request(`/v1/organisations/${org.id}/${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
 const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status) values (${org.id}, 'google', ${owner!.id}, 'own@example.test', '{}', 'connected') returning id`;
 async function mail(id: string, from: string, to: string, date = '2026-09-15T10:00:00Z') {
  const [thread] = await db.owner`insert into mail_threads (organisation_id, connection_id, account_email, provider_id, last_message_at) values (${org.id}, ${conn!.id}, 'own@example.test', ${id}, ${date}) returning id`;
  await db.owner`insert into mail_messages (organisation_id, connection_id, thread_id, provider_id, from_header, to_header, cc_header, subject, date_header, sent_at, snippet, in_reply_to, body, body_unavailable)
   values (${org.id}, ${conn!.id}, ${thread!.id}, ${id}, ${from}, ${to}, '', ${id}, '', ${date}, '', '', '', false)`;
  return thread!.id as string;
 }
 const upkeep = () => withTenant(db.app, { organisationId: org.id }, (tx) => upkeepContacts(tx, org.id, 'own@example.test'));
 return { org: org.id, request, outsider, mail, upkeep, conn: conn!.id };
}
test('mailbox parser handles quoted commas, groups, comments, duplicates and encoded display names', () => {
 assert.deepEqual(addresses('Team: "Smith, Jo" <JO@Acme.test>, =?UTF-8?B?Sm9zw6k=?= <jose@acme.test>; own@example.test (me), invalid, jo@acme.test'),
  [{ email: 'jo@acme.test', name: 'Smith, Jo' }, { email: 'jose@acme.test', name: 'José' }, { email: 'own@example.test', name: '' }]);
 for (const email of ['own@example.test', 'noreply@acme.test', 'no-reply@acme.test', 'donotreply@acme.test', 'notifications@acme.test', 'mailer-daemon@acme.test']) assert.equal(isCounterparty(email, 'OWN@example.test'), false);
 for (const domain of ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'live.com', 'me.com', 'bigpond.com', 'optusnet.com.au']) assert.ok(publicDomains.has(domain));
});
it('members create, search, edit and archive contacts and companies; outsiders and invalid references fail', async () => {
 const s = await setup(); const c = await s.request('companies', 'POST', { name: 'Acme', domain: 'Acme.test', notes: 'Supplier' }); assert.equal(c.status, 201); const company = await c.json();
 const r = await s.request('contacts', 'POST', { name: 'Jo', email: 'Jo@Acme.test', companyId: company.id }); assert.equal(r.status, 201); const contact = await r.json(); assert.equal(contact.email, 'jo@acme.test');
 assert.equal((await s.request('contacts', 'POST', { email: 'JO@acme.test' })).status, 409);
 assert.equal((await s.request('contacts', 'POST', { email: 'x@acme.test', companyId: randomUUID() })).status, 400);
 assert.equal((await s.request('contacts?limit=0')).status, 400); assert.equal((await s.request('contacts', 'POST', { email: 'bad' })).status, 400);
 for (const q of ['Jo', 'ACME', 'jo@']) assert.equal((await (await s.request(`contacts?q=${q}&limit=1`)).json()).contacts.length, 1);
 assert.equal((await (await s.request('contacts?q=%25')).json()).contacts.length, 0);
 assert.equal((await s.request(`contacts/${contact.id}`, 'PATCH', { role: 'Buyer', notes: 'Call mornings' })).status, 200);
 assert.equal((await (await s.request(`contacts/${contact.id}`)).json()).contact.source, 'hand');
 for (const path of ['contacts', `contacts/${contact.id}`, 'companies']) assert.equal((await s.request(path, 'GET', undefined, s.outsider)).status, 404);
 for (const path of [`contacts/${contact.id}`, `companies/${company.id}`]) assert.equal((await s.request(path, 'PATCH', { name: 'No' }, s.outsider)).status, 404);
 assert.equal((await s.request(`companies/${company.id}`, 'PATCH', { name: 'Acme Ltd' })).status, 200);
 assert.equal((await (await s.request('companies?q=Ltd')).json()).companies[0].name, 'Acme Ltd');
 assert.equal((await s.request(`contacts/${contact.id}`, 'PATCH', { archived: true })).status, 200);
 assert.equal((await s.request(`contacts/${contact.id}`, 'PATCH', { name: 'No' })).status, 400);
 assert.equal((await s.request(`contacts/${contact.id}`, 'PATCH', { archived: false })).status, 200);
 assert.equal((await s.request(`companies/${company.id}`, 'PATCH', { archived: true })).status, 200);
 assert.equal((await s.request(`companies/${company.id}`, 'PATCH', { notes: 'No' })).status, 400);
 assert.equal((await s.request(`contacts/${contact.id}`, 'PATCH', { companyId: company.id, notes: 'Keep the existing company' })).status, 200);
 assert.equal((await s.request('contacts', 'POST', { email: 'new@acme.test', companyId: company.id })).status, 400);
 const events = await db.owner`select actor_kind from audit_events where organisation_id = ${s.org} and subject_type in ('contact', 'company')`;
 assert.ok(events.length >= 6); assert.ok(events.every((e) => e.actorKind === 'person'));
});
it('backfill is idempotent, excludes own/no-reply, groups domains, preserves edits and returns exact recent threads', async () => {
 const s = await setup(); const first = await s.mail('first', 'Ann <ann@acme.test>', 'own@example.test, Friend <friend@gmail.com>, noreply@robot.test, notifications@acme.test, Bob <bob@acme.test>');
 await s.mail('unrelated', 'Joann <joann@acme.test>', 'own@example.test');
 await db.owner`update mail_messages set bcc_header = 'Hidden <hidden@acme.test>' where thread_id = ${first}`;
 await s.upkeep(); await s.upkeep();
 const contacts = (await (await s.request('contacts')).json()).contacts; assert.equal(contacts.length, 5);
 assert.equal((await (await s.request('companies')).json()).companies.length, 1);
 const hidden = contacts.find((c: any) => c.email === 'hidden@acme.test');
 assert.deepEqual((await (await s.request(`contacts/${hidden.id}`)).json()).threads.map((t: any) => t.id), [first]);
 const ann = contacts.find((c: any) => c.email === 'ann@acme.test'); assert.equal(ann.lastThreadId, first);
 assert.deepEqual((await (await s.request(`contacts/${ann.id}`)).json()).threads.map((t: any) => t.id), [first]);
 const detail = await (await s.request(`mail/threads/${first}`)).json(); assert.equal(detail.messages[0].senderContact.id, ann.id);
 await s.request(`contacts/${ann.id}`, 'PATCH', { name: 'Ann by hand', role: 'Buyer', notes: 'Keep me', companyId: null });
 const last = await s.mail('last', 'New Name <ann@acme.test>', 'own@example.test', '2026-09-16T10:00:00Z'); await s.upkeep();
 const saved = (await (await s.request(`contacts/${ann.id}`)).json()).contact;
 assert.equal(saved.name, 'Ann by hand'); assert.equal(saved.role, 'Buyer'); assert.equal(saved.notes, 'Keep me'); assert.equal(saved.companyId, null); assert.equal(saved.lastThreadId, last);
 await s.request(`contacts/${ann.id}`, 'PATCH', { archived: true }); await s.upkeep();
 assert.ok((await (await s.request(`contacts/${ann.id}`)).json()).contact.archivedAt);
 const events = await db.owner`select actor_kind, detail from audit_events where organisation_id = ${s.org} and action = 'contacts.synced' order by created_at, id`;
 assert.equal(events[0]!.detail.created, 5); assert.equal(events[1]!.detail.created, 0); assert.ok(events.every((e) => e.actorKind === 'system')); assert.ok(!JSON.stringify(events).includes('ann@'));
 await db.owner`update connections set status = 'disconnected' where id = ${s.conn}`;
 assert.deepEqual((await (await s.request(`contacts/${ann.id}`)).json()).threads, []);
});
