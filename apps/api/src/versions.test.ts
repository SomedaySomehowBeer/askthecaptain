import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import { AuthService } from './auth/service.ts';
import type { IdentityProvider } from './auth/google.ts';
import { changeSetHeader } from './changes.ts';
import { CommitmentsService } from './commitments/service.ts';
import { OrganisationService } from './organisations/service.ts';
import { RateLimiter } from './ratelimit.ts';

// R3 V-B through the API (versions contract §2, §3, §5; D29): every business write opens a change set the database
// journals, answers with it, and honours its retry id; a record's thread gets one change line per change set.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Change = { recordKind: string; recordId: string; operation: string; field: string | null; itemKind: string | null; itemId: string | null; before: unknown; after: unknown };
type Message = { id: string; kind: string; seq: number; revision: number; authorId: string | null; body: string | null; changeSetId?: string;
	change?: { actorKind: string; actorId: string | null; actorName: string | null; causeKind: string; changes: Change[]; truncated: boolean } };
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
	const owner = await signIn(`versions-owner-${n}`, `Olive ${n}`), member = await signIn(`versions-member-${n}`, `Mia ${n}`);
	const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name }), 201)).id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${member.user.id}, 'member')`;
	const base = `/v1/organisations/${org}`;
	return { org, owner, member, base,
		threadOf: async (column: 'task_id' | 'reservation_id' | 'stock_item_id', id: string) => (await db.owner.unsafe(`select id from threads where ${column} = $1`, [id]))[0]!.id as string,
		messages: (person: Person, thread: string) => json<{ messages: Message[] }>(request('GET', `${base}/threads/${thread}/messages?latest=50`, person)).then((r) => r.messages) };
}
/** What a change set did, as owner-side rows: operation, field, item kind, in the order made. */
const journal = (changeSetId: string) => db.owner<{ recordKind: string; operation: string; field: string | null; itemKind: string | null }[]>`select record_kind, operation, field, item_kind
	from record_changes where change_set_id = ${changeSetId} order by id`.then((rows) => rows.map((r) => [r.recordKind, r.operation, r.field, r.itemKind]));

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	let clock = Date.now();
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
		organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (clock += 61_000)) });
});
after(async () => { await db?.close(); });

it('a write answers with its change set; the same id and request again return the first result, anything else is 409', async () => {
	const b = await business('Retries');
	const changeSetId = randomUUID();
	const first = await request('POST', `${b.base}/tasks`, b.owner, { changeSetId, title: 'Mash in' });
	const task = await json<{ id: string; changeSetId: string; revision: number }>(first, 201);
	assert.equal(task.changeSetId, changeSetId); assert.equal(first.headers.get(changeSetHeader), changeSetId);
	// A retry after a lost response: the same task, no second one, no second change set.
	const again = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks`, b.owner, { changeSetId, title: 'Mash in' }), 201);
	assert.deepEqual([again.id, again.changeSetId], [task.id, changeSetId]);
	assert.equal((await db.owner`select count(*)::int as n from tasks where organisation_id = ${b.org}`)[0]!.n, 1);
	assert.equal((await db.owner`select count(*)::int as n from change_sets where id = ${changeSetId}`)[0]!.n, 1);
	// The same id with other content, from another person, or for another write: refused, nothing written.
	for (const [person, path, method, body] of [[b.owner, `${b.base}/tasks`, 'POST', { changeSetId, title: 'Mash out' }], [b.member, `${b.base}/tasks`, 'POST', { changeSetId, title: 'Mash in' }],
		[b.owner, `${b.base}/tags`, 'POST', { changeSetId, name: 'Brewing' }]] as const)
		assert.equal((await json<{ code: string }>(request(method, path, person, body), 409)).code, 'change_set_id_unavailable');
	assert.equal((await db.owner`select count(*)::int as n from tasks where organisation_id = ${b.org}`)[0]!.n, 1);
	assert.equal((await db.owner`select count(*)::int as n from tags where organisation_id = ${b.org}`)[0]!.n, 0);
	// An edit retried after it committed answers with the task, where a fresh request at the old revision is stale.
	const edit = randomUUID();
	const edited = await json<{ revision: number; changeSetId: string }>(request('PATCH', `${b.base}/tasks/${task.id}`, b.owner, { changeSetId: edit, expectedRevision: 1, title: 'Mash in at 67' }));
	const retried = await json<{ revision: number; title: string; changeSetId: string }>(request('PATCH', `${b.base}/tasks/${task.id}`, b.owner, { changeSetId: edit, expectedRevision: 1, title: 'Mash in at 67' }));
	assert.deepEqual([retried.revision, retried.title, retried.changeSetId], [edited.revision, 'Mash in at 67', edit]);
	assert.equal((await json<{ code: string }>(request('PATCH', `${b.base}/tasks/${task.id}`, b.owner, { expectedRevision: 1, title: 'Mash in at 67' }), 409)).code, 'stale_revision');
	assert.equal((await json<{ code: string }>(request('PATCH', `${b.base}/tasks/${task.id}`, b.owner, { changeSetId: 'not-a-uuid', expectedRevision: 2, title: 'x' }), 400)).code, 'invalid_request');
	// Without an id the server makes one: each request is its own change set.
	const a = await json<{ changeSetId: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Brewing' }), 201);
	assert.match(a.changeSetId, /^[0-9a-f-]{36}$/);
	assert.deepEqual(await journal(a.changeSetId), [['tag', 'create', null, null]]);
});

it('every write path journals what it changed, under the person’s change set, and no business audit row', async () => {
	const b = await business('Write paths');
	const task = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks`, b.owner, { title: 'Brew batch 42', due: '2031-05-01' }), 201);
	assert.deepEqual(await journal(task.changeSetId), [['task', 'create', null, null]]);
	const step = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks`, b.owner, { title: 'Weigh the malt', parentId: task.id, expectedParentRevision: 1 }), 201);
	assert.deepEqual(await journal(step.changeSetId), [['task', 'create', null, 'step']], 'a step is an item of its task');
	const evidence = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks/${task.id}/evidence`, b.owner, { expectedRevision: 2, kind: 'url', reference: 'https://example.test/recipe' }), 201);
	assert.deepEqual(await journal(evidence.changeSetId), [['task', 'create', null, 'evidence']]);
	const done = await json<{ changeSetId: string }>(request('PATCH', `${b.base}/tasks/${task.id}`, b.owner, { expectedRevision: 3, status: 'done', ownerId: b.member.user.id }));
	assert.deepEqual((await journal(done.changeSetId)).map((c) => c.slice(1).join(':')).sort(),
		['update:completed_at:', 'update:completed_by:', 'update:owner_id:', 'update:status:', 'update:completed_at:step', 'update:completed_by:step', 'update:status:step'].sort(),
		'the step follows its task in the same change set');
	const removed = await json<{ changeSetId: string }>(request('DELETE', `${b.base}/evidence/${evidence.id}?expectedRevision=4`, b.owner));
	assert.deepEqual(await journal(removed.changeSetId), [['task', 'remove', null, 'evidence']]);
	// Tags on the task's thread: the change set comes back in the header only (the detail keeps its shape).
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Production' }), 201);
	const thread = await b.threadOf('task_id', task.id);
	const revision = (await json<{ thread: { revision: number } }>(request('GET', `${b.base}/threads/${thread}`, b.owner))).thread.revision;
	const attached = await request('POST', `${b.base}/threads/${thread}/tags/${tag.id}`, b.owner, { expectedRevision: revision });
	const detail = await json<Record<string, unknown>>(attached);
	assert.ok(!('changeSetId' in detail));
	assert.deepEqual(await journal(attached.headers.get(changeSetHeader)!), [['task', 'attach', null, 'tag']]);
	const detached = await request('DELETE', `${b.base}/threads/${thread}/tags/${tag.id}?expectedRevision=${revision + 1}`, b.owner);
	assert.equal(detached.status, 200);
	assert.deepEqual(await journal(detached.headers.get(changeSetHeader)!), [['task', 'detach', null, 'tag']]);
	// A series with tags, and the occurrence it makes in the same change set.
	const series = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/series`, b.owner, { title: 'Excise', recurrence: 'monthly', anchor: '2026-01-01', tagIds: [tag.id] }), 201);
	assert.deepEqual((await journal(series.changeSetId)).map((c) => `${c[0]}:${c[1]}:${c[3] ?? ''}`), ['series:create:', 'series:attach:tag', 'task:create:', 'task:attach:tag']);
	// Equipment, a booking, a move and a cancel.
	const tank = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Tank 3' }), 201);
	assert.deepEqual(await journal(tank.changeSetId), [['equipment', 'create', null, null]]);
	const booking = await json<{ id: string; changeSetId: string; revision: number }>(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.owner,
		{ id: randomUUID(), title: 'Ferment', startsAt: '2031-05-01T08:00:00Z', endsAt: '2031-05-02T08:00:00Z', tagIds: [tag.id] }), 201);
	assert.deepEqual(await journal(booking.changeSetId), [['reservation', 'create', null, null], ['reservation', 'attach', null, 'tag']]);
	const moved = await json<{ changeSetId: string }>(request('PATCH', `${b.base}/equipment/${tank.id}/reservations/${booking.id}`, b.owner,
		{ expectedRevision: 1, title: 'Ferment', kind: 'booking', startsAt: '2031-05-03T08:00:00Z', endsAt: '2031-05-04T08:00:00Z', setupMinutes: 30, cleanupMinutes: 0, taskId: null, ownerId: null }));
	assert.deepEqual((await journal(moved.changeSetId)).map((c) => c[2]).sort(), ['ends_at', 'setup_minutes', 'starts_at']);
	const cancelled = await json<{ changeSetId: string }>(request('POST', `${b.base}/equipment/${tank.id}/reservations/${booking.id}/cancel`, b.owner, { expectedRevision: 2 }));
	assert.deepEqual(await journal(cancelled.changeSetId), [['reservation', 'update', 'status', null]]);
	// Stock: an item and a count.
	const item = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Hops', location: 'Store', unitLabel: 'kg' }), 201);
	assert.deepEqual(await journal(item.changeSetId), [['stock_item', 'create', null, null]]);
	const countId = randomUUID();
	const count = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/stock/${item.id}/count`, b.member, { changeSetId: countId, count: '4.5' }), 201);
	assert.deepEqual((await journal(count.changeSetId)).map((c) => c[2]).sort(), ['counted_at', 'counted_by', 'current_count']);
	const recount = await json<{ id: string }>(request('POST', `${b.base}/stock/${item.id}/count`, b.member, { changeSetId: countId, count: '4.5' }), 201);
	assert.equal(recount.id, count.id, 'a retried count answers with the observation it recorded');
	assert.equal((await db.owner`select count(*)::int as n from stock_counts where item_id = ${item.id}`)[0]!.n, 1);
	// None of these wrote a business audit row: the change set is the record.
	assert.equal((await db.owner`select count(*)::int as n from audit_events where organisation_id = ${b.org} and action !~ '^(organisation|membership)\\.'`)[0]!.n, 0);
	const sets = await db.owner<{ actorId: string; actorKind: string; causeKind: string; requestId: string | null }[]>`select actor_id, actor_kind, cause_kind, request_id from change_sets where organisation_id = ${b.org}`;
	assert.ok(sets.every((s) => s.actorKind === 'person' && s.causeKind === 'request' && s.requestId && [b.owner.user.id, b.member.user.id].includes(s.actorId)));
});

it('a record’s thread gets one change line per change set, worded from its changes, unread for others and fixed', async () => {
	const b = await business('Change lines');
	const task = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks`, b.owner, { title: 'Order cans', due: '2031-10-02' }), 201);
	const thread = await b.threadOf('task_id', task.id);
	const moved = await json<{ changeSetId: string }>(request('PATCH', `${b.base}/tasks/${task.id}`, b.owner, { expectedRevision: 1, due: '2031-10-06', ownerId: b.member.user.id }));
	await json(request('POST', `${b.base}/threads/${thread}/messages`, b.member, { id: randomUUID(), body: 'On it' }), 201);
	const messages = await b.messages(b.member, thread);
	assert.deepEqual(messages.map((m) => m.kind), ['change', 'change', 'message']);
	const [created, line, said] = messages as [Message, Message, Message];
	assert.equal(created.changeSetId, task.changeSetId);
	assert.deepEqual([line.changeSetId, line.body, line.authorId, line.change!.actorKind, line.change!.actorName, line.change!.causeKind, line.change!.truncated],
		[moved.changeSetId, null, b.owner.user.id, 'person', `Olive ${people}`, 'request', false]);
	assert.deepEqual(line.change!.changes.map((c) => [c.recordKind, c.recordId, c.operation, c.field, c.before, c.after]).sort(),
		[['task', task.id, 'update', 'due', '2031-10-02', '2031-10-06'], ['task', task.id, 'update', 'ownerId', null, b.member.user.id]], 'field names as the API spells them');
	assert.equal((created.change!.changes[0]!.after as Record<string, unknown>).title, 'Order cans', 'a creation carries the row');
	assert.ok(!('changeSetId' in said) && !('change' in said), 'a plain message is unchanged');
	// The change feed carries the same lines.
	const feed = await json<{ changes: { kind: string; message?: Message }[] }>(request('GET', `${b.base}/threads/${thread}/changes?after=0`, b.member));
	assert.deepEqual(feed.changes.filter((c) => c.message?.kind === 'change').map((c) => c.message!.changeSetId), [task.changeSetId, moved.changeSetId]);
	// Unread for the member (both lines are the owner's), not for the owner.
	assert.equal((await json<{ thread: { unread: number } }>(request('GET', `${b.base}/threads/${thread}`, b.member))).thread.unread, 2);
	assert.equal((await json<{ thread: { unread: number } }>(request('GET', `${b.base}/threads/${thread}`, b.owner))).thread.unread, 1, 'only the member’s message');
	// Fixed: no edit, delete or pin, by its author or an owner.
	for (const [method, path, body] of [['PATCH', `${b.base}/threads/${thread}/messages/${line.id}`, { expectedRevision: 1, body: 'Rewritten' }],
		['DELETE', `${b.base}/threads/${thread}/messages/${line.id}?expectedRevision=1`, undefined], ['POST', `${b.base}/threads/${thread}/pin`, { messageId: line.id }]] as const)
		assert.equal((await json<{ code: string }>(request(method, path, b.owner, body), 409)).code, 'change_line_immutable', `${method} ${path}`);
	// The list's excerpt is the latest message, never a line.
	const rows = await json<{ threads: { id: string; lastMessage: { excerpt: string } | null }[] }>(request('GET', `${b.base}/threads`, b.owner));
	assert.equal(rows.threads.find((t) => t.id === thread)!.lastMessage!.excerpt, 'On it');
	// A change set that touches two records adds a line to each of their threads, and only there.
	const other = await json<{ id: string }>(request('POST', `${b.base}/tasks`, b.owner, { title: 'Clean the line' }), 201);
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Packaging' }), 201);
	const series = await json<{ changeSetId: string }>(request('POST', `${b.base}/series`, b.owner, { title: 'Monthly clean', recurrence: 'monthly', anchor: '2026-01-01', tagIds: [tag.id] }), 201);
	const linesOf = await db.owner<{ threadId: string }[]>`select thread_id from thread_messages where change_set_id = ${series.changeSetId}`;
	const occurrence = (await db.owner<{ id: string }[]>`select t.id from tasks t join task_series s on s.id = t.series_id where s.organisation_id = ${b.org}`)[0]!.id;
	assert.deepEqual(linesOf.map((l) => l.threadId), [await b.threadOf('task_id', occurrence)], 'the series has no thread; its occurrence does');
	assert.equal((await b.messages(b.owner, await b.threadOf('task_id', other.id))).length, 1);
});

it('a private thread’s tag history stays with its participants, and a removed member reads none', async () => {
	const b = await business('Private history');
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Pricing' }), 201);
	const secret = (await json<{ thread: { id: string } }>(request('POST', `${b.base}/threads`, b.owner, { id: randomUUID(), kind: 'private', title: 'Margins', participantIds: [] }), 201)).thread.id;
	const tagged = await request('POST', `${b.base}/threads/${secret}/tags/${tag.id}`, b.owner, { expectedRevision: 1 });
	const changeSetId = tagged.headers.get(changeSetHeader)!;
	assert.deepEqual(await journal(changeSetId), [['thread', 'attach', null, 'tag']]);
	const line = (await b.messages(b.owner, secret)).find((m) => m.kind === 'change')!;
	assert.equal(line.changeSetId, changeSetId);
	assert.equal((await request('GET', `${b.base}/threads/${secret}/messages?latest=5`, b.member)).status, 404);
	const asMember = (sql: string) => db.app.begin(async (tx) => {
		await tx`select set_config('app.organisation_id', ${b.org}, true)`; await tx`select set_config('app.user_id', ${b.member.user.id}, true)`;
		return (await tx.unsafe(sql, [changeSetId])).length;
	});
	for (const table of ['change_sets where id = $1', 'record_changes where change_set_id = $1', 'record_versions where change_set_id = $1', 'thread_messages where change_set_id = $1'])
		assert.equal(await asMember(`select 1 from ${table}`), 0, table);
	// A task's history is every member's; once removed, nobody's history is theirs.
	const task = await json<{ changeSetId: string }>(request('POST', `${b.base}/tasks`, b.owner, { title: 'Quote the distributor' }), 201);
	const readTask = () => db.app.begin(async (tx) => {
		await tx`select set_config('app.organisation_id', ${b.org}, true)`; await tx`select set_config('app.user_id', ${b.member.user.id}, true)`;
		return (await tx`select 1 from record_changes where change_set_id = ${task.changeSetId}`).length;
	});
	assert.equal(await readTask(), 1);
	await json(request('DELETE', `${b.base}/members/${b.member.user.id}`, b.owner));
	assert.equal(await readTask(), 0);
});
