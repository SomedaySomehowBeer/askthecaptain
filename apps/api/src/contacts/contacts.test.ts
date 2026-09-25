import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { addresses, isCounterparty, publicDomains } from './addresses.ts';
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
 return { org: org.id, request, outsider };
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
