import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { StockService } from './service.ts';
const it = databaseUrl ? test : test.skip; let db: Harness; let app: ReturnType<typeof createApp>; let service: StockService;
let org: string; let otherOrg: string; let member: string; let user: string; let outsider: string; let otherItem: string; let supplier: string; let sequence = 0;
const actor = () => ({ userId: user, requestId: 'stock-test' });
const request = (method: string, path: string, body?: unknown, token = member) => app.request(`/v1/organisations/${org}/stock${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const add = (input = {}) => service.save(actor(), org, { name: `Malt ${++sequence}`, location: 'Store', unitLabel: 'bags', reorderPoint: '5', ...input });
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase(); service = new StockService(db.app);
 const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 }); const organisations = new OrganisationService(db.app);
 const users = await db.owner`insert into users (email, name) values ('owner@test.com', 'Owner'), ('member@test.com', 'Counter'), ('outsider@test.com', 'Outsider') returning id`;
 org = (await organisations.create({ userId: users[0]!.id, requestId: 'seed' }, { name: 'Stock A' })).id;
 user = users[1]!.id; await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${user}, 'member')`;
 member = (await auth.issueSessionFor(user)).token; outsider = (await auth.issueSessionFor(users[2]!.id)).token;
 otherOrg = (await organisations.create({ userId: users[2]!.id, requestId: 'seed' }, { name: 'Stock B' })).id;
 otherItem = (await service.save({ userId: users[2]!.id, requestId: 'seed' }, otherOrg, { name: 'Hidden', location: 'Store', unitLabel: 'bags' })).id;
 const [company] = await db.owner`insert into companies (organisation_id, name) values (${org}, 'Preferred Supplier') returning id`; supplier = company!.id;
 app = createApp({ db: db.app, auth, organisations, commitments: new CommitmentsService(db.app) });
});
after(async () => { await db?.close(); });
it('members can create/edit/read/count/archive; sessions and tenant membership protect every route', async () => {
 assert.equal((await request('GET', '', undefined, '')).status, 401); assert.equal((await request('GET', '', undefined, outsider)).status, 404);
 const created = await request('POST', '', { name: 'API item', location: 'Packing', unitLabel: 'boxes', preferredSupplierId: supplier }); assert.equal(created.status, 201);
 const item = await created.json() as { id: string }; assert.equal((await request('PATCH', `/${item.id}`, { notes: 'Keep dry' })).status, 200);
 assert.equal((await request('POST', `/${item.id}/count`, { count: '2.50', note: 'Counted the shelf' })).status, 201);
 const listed = await (await request('GET', '?location=Packing')).json() as { items: { countedByName: string; currentCount: string }[] }; assert.equal(listed.items[0]!.countedByName, 'Counter'); assert.equal(listed.items[0]!.currentCount, '2.50');
 assert.equal((await request('PATCH', `/${item.id}`, { archived: true })).status, 200);
 assert.equal((await request('POST', `/${otherItem}/count`, { count: 1 })).status, 404); assert.equal((await request('PATCH', `/${otherItem}`, { name: 'hidden' })).status, 404);
 for (const body of [{ count: -1 }, { count: '' }, { count: 'NaN' }, { count: 'Infinity' }, { count: 1, countedBy: user }]) assert.equal((await request('POST', `/${item.id}/count`, body)).status, 400);
 assert.equal((await request('POST', '', { name: 'Bad', location: 'Store', unitLabel: 'bags', currentCount: 20 })).status, 400);
 assert.equal((await request('PATCH', `/${item.id}`, { currentCount: 20 })).status, 400);
});
it('null is unknown; exact counts compare strictly below reorder points, including zero; history and current value agree', async () => {
 const item = await add({ reorderPoint: '2.50' });
 let row = (await service.list(actor(), org)).items.find((r) => r.id === item.id)!; assert.equal(row.currentCount, null); assert.equal(row.belowReorder, null);
 await service.count(actor(), org, item.id, { count: '2.50' }); row = (await service.list(actor(), org)).items.find((r) => r.id === item.id)!; assert.equal(row.belowReorder, false);
 await service.count(actor(), org, item.id, { count: '0', note: 'Empty' }); row = (await service.list(actor(), org)).items.find((r) => r.id === item.id)!; assert.equal(row.currentCount, '0'); assert.equal(row.belowReorder, true);
 await service.count(actor(), org, item.id, { count: '999999999999999999.123456789' }); row = (await service.list(actor(), org)).items.find((r) => r.id === item.id)!; assert.equal(row.currentCount, '999999999999999999.123456789');
 const history = await db.owner`select * from stock_counts where item_id = ${item.id} order by counted_at desc, id desc`; assert.equal(history.length, 3); assert.equal(history[0]!.count, row.currentCount); assert.equal(history[0]!.countedAt.toISOString(), row.countedAt.toISOString());
 const [same] = await db.owner`select s.counted_at = c.counted_at as exact from stock_items s join stock_counts c on c.id = ${history[0]!.id} where s.id = ${item.id}`; assert.equal(same!.exact, true);
 const events = await db.owner`select * from audit_events where action = 'stock.counted' and subject_id = ${item.id}`; assert.equal(events.length, 3); assert.ok(events.every((e) => e.actorKind === 'person' && e.actorId === user));
});
it('a failed audit rolls back history and the current count together; concurrent counts serialize', async () => {
 const item = await add(); await service.count(actor(), org, item.id, { count: '1' });
 await db.owner`alter table audit_events add constraint stock_test_atomic check (action <> 'stock.counted') not valid`;
 try { await assert.rejects(service.count(actor(), org, item.id, { count: '99' }), { code: '23514' }); }
 finally { await db.owner`alter table audit_events drop constraint stock_test_atomic`; }
 assert.equal((await db.owner`select * from stock_counts where item_id = ${item.id}`).length, 1);
 assert.equal((await db.owner`select current_count from stock_items where id = ${item.id}`)[0]!.currentCount, '1');
 await Promise.all([service.count(actor(), org, item.id, { count: '2' }), service.count(actor(), org, item.id, { count: '3' })]);
 const [latest] = await db.owner`select count, counted_at from stock_counts where item_id = ${item.id} order by counted_at desc, id desc limit 1`;
 const [current] = await db.owner`select current_count, counted_at from stock_items where id = ${item.id}`; assert.equal(current!.currentCount, latest!.count); assert.equal(current!.countedAt.toISOString(), latest!.countedAt.toISOString());
});
it('location reads exclude archived stock by default; restore preserves history; unit changes cannot reinterpret counts', async () => {
 const item = await add({ location: 'Cold room' }); await service.count(actor(), org, item.id, { count: '4' });
 await assert.rejects(service.save(actor(), org, { unitLabel: 'litres' }, item.id), { code: 'stock_unit_counted' });
 await service.save(actor(), org, { archived: true }, item.id);
 assert.equal((await service.list(actor(), org, 'Cold room')).items.length, 0); assert.equal((await service.list(actor(), org)).locations.includes('Cold room'), false);
 assert.equal((await service.list(actor(), org, 'Cold room', true)).items.length, 1);
 await assert.rejects(service.count(actor(), org, item.id, { count: '3' }), { code: 'stock_archived' });
 await assert.rejects(service.save(actor(), org, { name: 'Change' }, item.id), { code: 'stock_archived' });
 await service.save(actor(), org, { archived: false }, item.id); assert.equal((await service.list(actor(), org, 'Cold room')).items[0]!.currentCount, '4');
});
it('names are unique at a location; suppliers must be local and active; removed members cannot count', async () => {
 const item = await add({ name: 'Unique', preferredSupplierId: supplier });
 await assert.rejects(add({ name: 'Unique' }), { code: 'stock_exists' }); await add({ name: 'Unique', location: 'Other' });
 const [foreign] = await db.owner`insert into companies (organisation_id, name) values (${otherOrg}, 'Hidden supplier') returning id`;
 await assert.rejects(service.save(actor(), org, { preferredSupplierId: foreign!.id }, item.id), { code: 'supplier_unavailable' });
 await db.owner`update companies set archived_at = now() where id = ${supplier}`;
 await assert.rejects(add({ preferredSupplierId: supplier }), { code: 'supplier_unavailable' });
 await service.save(actor(), org, { preferredSupplierId: supplier, notes: 'Keep the existing supplier' }, item.id);
 await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${user}`;
 await assert.rejects(service.count(actor(), org, item.id, { count: '2' }), { code: 'not_found' });
});
