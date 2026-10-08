import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { changeSetHeader } from '../changes.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import { StockService, stocktakeLimit } from './service.ts';

// H3 S-A (docs/plans/stock-2026-10.md §2, §4; versions contract §3–§5; D15, D29): a stocktake counts many items as one
// change set, each count written as the per-item count route writes it. Real Postgres.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Item = { id: string; name: string; location: string; unitLabel: string; currentCount: string | null; countedAt: string | null; countedBy: string | null;
	countedByName: string | null; revision: number; archivedAt: string | null; belowReorder: boolean | null };
type Taken = { changeSetId: string; items: Item[] };
type Entry = { id: string; changeIds: string[]; field: string | null; before: unknown; after: unknown; state: string };
type History = { changeSets: { id: string; changes: Entry[] }[] };
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
const request = (method: string, path: string, person?: Person, data?: unknown) => app.request(path, { method,
	headers: { 'content-type': 'application/json', ...(person ? { authorization: `Bearer ${person.token}` } : {}) },
	body: data === undefined ? undefined : JSON.stringify(data) });
async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
	const value = await response; assert.equal(value.status, status, await value.clone().text()); return value.json() as Promise<T>;
}
async function signIn(subject: string, name: string): Promise<Person> {
	google.next = { subject, email: `${subject}@example.test`, name };
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
let people = 0;
async function business(name: string) {
	const n = ++people;
	const owner = await signIn(`take-owner-${n}`, `Maya ${n}`), member = await signIn(`take-member-${n}`, `Tom ${n}`), outsider = await signIn(`take-out-${n}`, `Jess ${n}`);
	const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name }), 201)).id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${member.user.id}, 'member')`;
	const base = `/v1/organisations/${org}`;
	const b = {
		org, owner, member, outsider, base,
		add: (body: Record<string, unknown>, person = owner) => json<Item>(request('POST', `${base}/stock`, person, { unitLabel: 'bags', ...body }), 201),
		take: (person: Person, body: unknown) => request('POST', `${base}/stock/stocktake`, person, body),
		list: (person: Person, query = '') => json<{ items: Item[]; locations: string[] }>(request('GET', `${base}/stock${query}`, person)),
		threadOf: async (id: string) => (await db.owner`select id from threads where stock_item_id = ${id}`)[0]!.id as string,
		lines: async (person: Person, thread: string, changeSetId: string) => (await json<{ messages: { kind: string; changeSetId?: string; change?: { changes: { field: string | null; before: unknown; after: unknown }[] } }[] }>(
			request('GET', `${base}/threads/${thread}/messages?latest=100`, person))).messages.filter(m => m.kind === 'change' && m.changeSetId === changeSetId),
		history: (person: Person, id: string) => json<History>(request('GET', `${base}/history/stock_item/${id}`, person)),
	};
	return b;
}
const n = async (query: Promise<{ n: number }[]>) => Number((await query)[0]!.n);

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	let clock = Date.now();
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
		organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (clock += 61_000)) });
});
after(async () => { await db?.close(); });

it('a stocktake is one change set: each counted item gets its observation, its count and one change line; skipped items are untouched', async () => {
	const b = await business('Stocktake');
	const pale = await b.add({ name: 'Pale malt', location: 'Cool room' }), wheat = await b.add({ name: 'Wheat malt', location: 'Cool room', reorderPoint: '5' });
	const hops = await b.add({ name: 'Citra hops', location: 'Cool room', unitLabel: 'kg' }), cans = await b.add({ name: '330 ml cans', location: 'Packaging store', unitLabel: 'cans' });
	const id = randomUUID();
	const response = await b.take(b.member, { changeSetId: id, counts: [
		{ itemId: pale.id, expectedRevision: pale.revision, count: '12', note: 'Top shelf' },
		{ itemId: wheat.id, expectedRevision: wheat.revision, count: 4 },
		{ itemId: cans.id, expectedRevision: cans.revision, count: '4200.5' }] });
	assert.equal(response.status, 201, await response.clone().text());
	assert.equal(response.headers.get(changeSetHeader), id);
	const taken = await response.json() as Taken;
	assert.equal(taken.changeSetId, id);
	// The counted items as the list returns them, in its order.
	const listed = (await b.list(b.member)).items;
	assert.deepEqual(taken.items.map(i => i.id), listed.filter(i => [pale.id, wheat.id, cans.id].includes(i.id)).map(i => i.id));
	assert.deepEqual(Object.keys(taken.items[0]!).sort(), Object.keys(listed[0]!).sort(), 'the same row shape as the list');
	assert.deepEqual(taken.items.map(i => [i.name, i.currentCount, i.countedByName, i.revision, i.belowReorder]),
		[['Pale malt', '12', `Tom ${people}`, 2, null], ['Wheat malt', '4', `Tom ${people}`, 2, true], ['330 ml cans', '4200.5', `Tom ${people}`, 2, null]]);
	// One change set, one observation per counted item, none for the skipped item.
	assert.equal(await n(db.owner`select count(*)::int as n from change_sets where id = ${id}`), 1);
	const observations = await db.owner<{ itemId: string; count: string; note: string; countedBy: string; countedAt: Date }[]>`select item_id, count::text, note, counted_by, counted_at from stock_counts
		where organisation_id = ${b.org} order by item_id`;
	assert.equal(observations.length, 3);
	assert.ok(observations.every(o => o.countedBy === b.member.user.id));
	assert.equal(observations.find(o => o.itemId === pale.id)!.note, 'Top shelf');
	const [current] = await db.owner<{ countedAt: Date }[]>`select counted_at from stock_items where id = ${pale.id}`;
	assert.equal(current!.countedAt.toISOString(), observations.find(o => o.itemId === pale.id)!.countedAt.toISOString(), 'the current count is the observation');
	assert.equal((await b.list(b.member)).items.find(i => i.id === hops.id)!.currentCount, null, 'a skipped item is left as it is');
	assert.equal((await b.list(b.member)).items.find(i => i.id === hops.id)!.revision, 1);
	// Each counted item's thread has exactly one change line for the stocktake, worded from its own count.
	for (const [item, count] of [[pale, '12'], [wheat, '4'], [cans, '4200.5']] as const) {
		const lines = await b.lines(b.owner, await b.threadOf(item.id), id);
		assert.equal(lines.length, 1, item.name);
		assert.equal(lines[0]!.change!.changes.find(c => c.field === 'currentCount')?.after, count);
	}
	assert.equal((await b.lines(b.owner, await b.threadOf(hops.id), id)).length, 0);
	// One entry in each item's History, the coupled count group.
	const history = await b.history(b.owner, pale.id);
	const entry = history.changeSets.find(s => s.id === id)!.changes;
	assert.deepEqual(entry.map(e => [e.field, e.state]), [['count', 'reversible']]);
	// Exactly one current count change per counted item in the journal.
	assert.equal(await n(db.owner`select count(*)::int as n from record_changes where change_set_id = ${id} and field = 'current_count'`), 3);
});

it('a stale item refuses the whole stocktake with its id and nothing is written; an archived item refuses it too', async () => {
	const b = await business('Stale stocktake');
	const a = await b.add({ name: 'Labels', location: 'Store' }), c = await b.add({ name: 'Caps', location: 'Store' }), d = await b.add({ name: 'Wrap', location: 'Store' });
	await json(request('POST', `${b.base}/stock/${c.id}/count`, b.owner, { count: '7' }), 201); // c is now revision 2
	const before = await n(db.owner`select count(*)::int as n from change_sets where organisation_id = ${b.org}`);
	const counts = [{ itemId: a.id, expectedRevision: 1, count: '1' }, { itemId: c.id, expectedRevision: 1, count: '2' }, { itemId: d.id, expectedRevision: 1, count: '3' }];
	const refused = await json<{ code: string; itemIds: string[] }>(b.take(b.member, { changeSetId: randomUUID(), counts }), 409);
	assert.deepEqual([refused.code, refused.itemIds], ['stale_revision', [c.id]]);
	assert.equal(await n(db.owner`select count(*)::int as n from change_sets where organisation_id = ${b.org}`), before, 'no change set');
	assert.equal(await n(db.owner`select count(*)::int as n from stock_counts where organisation_id = ${b.org}`), 1, 'no observation');
	assert.deepEqual((await b.list(b.owner)).items.map(i => [i.name, i.currentCount, i.revision]), [['Caps', '7', 2], ['Labels', null, 1], ['Wrap', null, 1]]);
	// An archived item, at its current revision, refuses it by id; nothing is written.
	const archived = await json<Item>(request('PATCH', `${b.base}/stock/${d.id}`, b.owner, { archived: true }));
	const no = await json<{ code: string; itemIds: string[] }>(b.take(b.member, { changeSetId: randomUUID(), counts: [
		{ itemId: a.id, expectedRevision: 1, count: '1' }, { itemId: d.id, expectedRevision: archived.revision, count: '3' }] }), 400);
	assert.deepEqual([no.code, no.itemIds], ['stock_archived', [d.id]]);
	assert.equal(await n(db.owner`select count(*)::int as n from stock_counts where organisation_id = ${b.org}`), 1);
	// Without the stale and archived items it saves.
	await json(b.take(b.member, { changeSetId: randomUUID(), counts: [{ itemId: a.id, expectedRevision: 1, count: '1' }, { itemId: c.id, expectedRevision: 2, count: '2' }] }), 201);
	assert.deepEqual((await b.list(b.owner)).items.map(i => [i.name, i.currentCount]), [['Caps', '2'], ['Labels', '1']]);
});

it('the retry rule: the same id and counts answer the first result and write nothing; the same id for anything else is refused', async () => {
	const b = await business('Retry stocktake');
	const a = await b.add({ name: 'Yeast', location: 'Fridge', unitLabel: 'packs' }), c = await b.add({ name: 'Finings', location: 'Fridge', unitLabel: 'litres' });
	const id = randomUUID(), body = { changeSetId: id, counts: [{ itemId: a.id, expectedRevision: 1, count: '3' }, { itemId: c.id, expectedRevision: 1, count: '0.75', note: 'Half open' }] };
	const first = await json<Taken>(b.take(b.member, body), 201);
	const again = await b.take(b.member, body);
	assert.equal(again.status, 201); assert.equal(again.headers.get(changeSetHeader), id);
	assert.deepEqual(await again.json(), first, 'the first result, read as it is now');
	assert.equal(await n(db.owner`select count(*)::int as n from stock_counts where organisation_id = ${b.org}`), 2, 'written once');
	assert.equal(await n(db.owner`select count(*)::int as n from thread_messages where change_set_id = ${id}`), 2, 'one line per item, once');
	for (const other of [{ ...body, counts: [body.counts[0]!] }, { ...body, counts: [{ ...body.counts[0]!, count: '4' }, body.counts[1]!] }]) {
		assert.equal((await json<{ code: string }>(b.take(b.member, other), 409)).code, 'change_set_id_unavailable');
	}
	assert.equal((await json<{ code: string }>(b.take(b.owner, body), 409)).code, 'change_set_id_unavailable', 'another person');
	// The per-item count route cannot reuse it either.
	assert.equal((await json<{ code: string }>(request('POST', `${b.base}/stock/${a.id}/count`, b.member, { changeSetId: id, count: '3' }), 409)).code, 'change_set_id_unavailable');
});

it('bounds and validation: 1 to 200 items, unique ids, counts as the count route takes them, a change set id required', async () => {
	const b = await business('Bounds');
	const service = new StockService(db.app);
	const made: { id: string; revision: number }[] = [];
	for (let i = 0; i < stocktakeLimit + 1; i++) made.push(await service.save({ userId: b.owner.user.id, requestId: 'bounds' }, b.org, { name: `Item ${String(i).padStart(3, '0')}`, location: 'Store', unitLabel: 'units' }) as unknown as { id: string; revision: number });
	const counts = made.map(m => ({ itemId: m.id, expectedRevision: m.revision, count: '1' }));
	for (const body of [{ changeSetId: randomUUID(), counts: counts }, { changeSetId: randomUUID(), counts: [] }, { counts: counts.slice(0, 1) },
		{ changeSetId: randomUUID(), counts: [{ ...counts[0]!, count: -1 }] }, { changeSetId: randomUUID(), counts: [{ ...counts[0]!, count: 'NaN' }] },
		{ changeSetId: randomUUID(), counts: [{ ...counts[0]!, count: '' }] }, { changeSetId: randomUUID(), counts: [{ ...counts[0]!, countedBy: b.owner.user.id }] },
		{ changeSetId: randomUUID(), counts: [{ ...counts[0]!, expectedRevision: 0 }] }, { changeSetId: randomUUID(), counts: counts.slice(0, 1), extra: true },
		{ changeSetId: randomUUID(), counts: [{ ...counts[0]!, note: 'x'.repeat(1001) }] }]) {
		assert.equal((await b.take(b.member, body)).status, 400, JSON.stringify(body).slice(0, 120));
	}
	assert.equal((await json<{ code: string }>(b.take(b.member, { changeSetId: randomUUID(), counts: [counts[0]!, { ...counts[0]!, count: '2' }] }), 400)).code, 'stocktake_duplicate');
	assert.equal(await n(db.owner`select count(*)::int as n from stock_counts where organisation_id = ${b.org}`), 0);
	const id = randomUUID();
	const taken = await json<Taken>(b.take(b.member, { changeSetId: id, counts: counts.slice(0, stocktakeLimit) }), 201);
	assert.equal(taken.items.length, stocktakeLimit);
	assert.equal(await n(db.owner`select count(*)::int as n from stock_counts where organisation_id = ${b.org}`), stocktakeLimit);
	assert.equal(await n(db.owner`select count(*)::int as n from thread_messages where change_set_id = ${id}`), stocktakeLimit, 'one change line per item thread');
});

it('a non-member, a stranger and a foreign item are refused; a removed member cannot take stock', async () => {
	const b = await business('Access'), other = await business('Other business');
	const mine = await b.add({ name: 'Malt', location: 'Store' }), theirs = await other.add({ name: 'Hidden', location: 'Store' });
	const body = () => ({ changeSetId: randomUUID(), counts: [{ itemId: mine.id, expectedRevision: 1, count: '1' }] });
	assert.equal((await b.take(undefined as unknown as Person, body())).status, 401);
	assert.equal((await json<{ code: string }>(b.take(b.outsider, body()), 404)).code, 'not_found');
	assert.equal((await json<{ code: string }>(b.take(b.member, { changeSetId: randomUUID(), counts: [{ itemId: mine.id, expectedRevision: 1, count: '1' }, { itemId: theirs.id, expectedRevision: 1, count: '1' }] }), 404)).code, 'not_found');
	await db.owner`update memberships set status = 'removed' where organisation_id = ${b.org} and user_id = ${b.member.user.id}`;
	assert.equal((await b.take(b.member, body())).status, 404);
	assert.equal(await n(db.owner`select count(*)::int as n from stock_counts where organisation_id in (${b.org}, ${other.org})`), 0);
});

it('undo of one item’s count from a stocktake leaves the other items’ counts (R3 rules)', async () => {
	const b = await business('Undo one');
	const a = await b.add({ name: 'Pale malt', location: 'Cool room' }), c = await b.add({ name: 'Wheat malt', location: 'Cool room' });
	await json(request('POST', `${b.base}/stock/${a.id}/count`, b.owner, { count: '11' }), 201);
	const id = randomUUID();
	await json(b.take(b.member, { changeSetId: id, counts: [{ itemId: a.id, expectedRevision: 2, count: '12' }, { itemId: c.id, expectedRevision: 1, count: '4' }] }), 201);
	const entry = (await b.history(b.owner, a.id)).changeSets.find(s => s.id === id)!.changes[0]!;
	assert.deepEqual([entry.field, entry.state, (entry.before as Record<string, unknown>).currentCount, (entry.after as Record<string, unknown>).currentCount], ['count', 'reversible', '11', '12']);
	const preview = await json<{ applicable: boolean; basis: unknown }>(request('POST', `${b.base}/reversals/preview`, b.owner, { changeIds: entry.changeIds }));
	assert.ok(preview.applicable);
	const undo = randomUUID();
	await json(request('POST', `${b.base}/reversals`, b.owner, { id: undo, changeIds: entry.changeIds, basis: preview.basis }), 201);
	const rows = (await b.list(b.owner)).items;
	assert.deepEqual(rows.map(i => [i.name, i.currentCount, i.countedByName]), [['Pale malt', '11', `Maya ${people}`], ['Wheat malt', '4', `Tom ${people}`]], 'only the selected item’s count went back');
	assert.equal(await n(db.owner`select count(*)::int as n from thread_messages where change_set_id = ${undo}`), 1, 'the undo is a line in that item’s thread only');
	assert.equal((await b.history(b.owner, c.id)).changeSets.find(s => s.id === id)!.changes[0]!.state, 'reversible', 'the other item’s count is still its own to undo');
});

it('the stock card read and revision-checked edits; archived items leave the Stock filter', async () => {
	const b = await business('Card');
	const item = await b.add({ name: 'Hops', location: 'Cool room', unitLabel: 'kg', reorderPoint: '2', notes: 'Keep cold' });
	for (const count of ['1', '2', '3', '4']) await json(request('POST', `${b.base}/stock/${item.id}/count`, b.member, { count, note: `Count ${count}` }), 201);
	const read = await json<{ item: Item; counts: { count: string; note: string; countedByName: string; countedAt: string }[]; locations: string[]; timezone: string }>(request('GET', `${b.base}/stock/${item.id}`, b.owner));
	assert.deepEqual([read.item.id, read.item.currentCount, read.item.revision], [item.id, '4', 5]);
	assert.deepEqual(read.counts.map(c => [c.count, c.note, c.countedByName]), [['4', 'Count 4', `Tom ${people}`], ['3', 'Count 3', `Tom ${people}`], ['2', 'Count 2', `Tom ${people}`]], 'the latest three');
	assert.deepEqual(read.locations, ['Cool room']);
	assert.equal((await request('GET', `${b.base}/stock/${item.id}`, b.outsider)).status, 404);
	assert.equal((await request('GET', `${b.base}/stock/${randomUUID()}`, b.owner)).status, 404);
	// Details with the item's revision: a moved item is stale and nothing is written.
	assert.equal((await json<{ code: string }>(request('PATCH', `${b.base}/stock/${item.id}`, b.owner, { expectedRevision: 4, notes: 'Old' }), 409)).code, 'stale_revision');
	const edited = await json<Item & { changeSetId: string }>(request('PATCH', `${b.base}/stock/${item.id}`, b.owner, { expectedRevision: 5, name: 'Citra hops', reorderPoint: null, changeSetId: randomUUID() }));
	assert.deepEqual([edited.name, edited.revision], ['Citra hops', 6]);
	// Archived: out of the Stock filter and Stocktake's list, still in All and with "Show archived".
	const thread = await b.threadOf(item.id);
	const threads = (filter: string) => json<{ threads: { id: string }[] }>(request('GET', `${b.base}/threads?filter=${filter}`, b.owner)).then(r => r.threads.map(t => t.id));
	assert.ok((await threads('stock')).includes(thread));
	await json(request('PATCH', `${b.base}/stock/${item.id}`, b.owner, { expectedRevision: 6, archived: true }));
	assert.equal((await threads('stock')).includes(thread), false);
	assert.ok((await threads('all')).includes(thread));
	assert.equal((await b.list(b.owner)).items.length, 0);
	assert.equal((await b.list(b.owner, '?includeArchived=1')).items.length, 1);
	assert.ok((await json<{ item: Item }>(request('GET', `${b.base}/stock/${item.id}`, b.owner))).item.archivedAt);
});
