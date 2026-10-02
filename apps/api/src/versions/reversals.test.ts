import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { applyMigrations } from '@captain/db/migrate';
import { databaseUrl, freshDatabase, journalled, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { changeSetHeader } from '../changes.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import { VersionsService } from './service.ts';

// R3 V-C through the API (versions contract §4, §5, §6; amendment §3–§5; D29): a record's history with each change's
// state, the version snapshot, the read-only preview, the all-or-nothing reversal, and topic to task. Real Postgres.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Later = { id: string; changeSetId: string; actor: { name: string | null }; field: string | null; before: unknown; after: unknown };
type Entry = { id: string; changeIds: string[]; recordKind: string; recordId: string; operation: string; field: string | null; fields: string[]; itemKind: string | null;
	itemId: string | null; before: unknown; after: unknown; reverses: string[]; state: string; later?: Later[]; needs?: string[]; reason?: string;
	reversedBy?: { changeId: string; changeSetId: string; actor: { id: string | null; name: string | null } }; detail?: Record<string, unknown>; now?: unknown; proposed?: unknown };
type ChangeSet = { id: string; actor: { kind: string; id: string | null; name: string | null }; causeKind: string; reversesChangeSetId: string | null; changes: Entry[] };
type History = { record: { kind: string; id: string; revision: number | null; exists: boolean }; changeSets: ChangeSet[]; nextCursor: string | null;
	start: { kind: string; changeSetId: string; revision: number } | null; names: { people: Record<string, string | null>; tags: Record<string, string | null> } };
type Preview = { changes: Entry[]; basis: { recordKind: string; recordId: string; revision: number | null }[]; applicable: boolean };
type Message = { kind: string; changeSetId?: string; body: string | null; change?: { causeKind: string; changes: { field: string | null; before: unknown; after: unknown }[] } };
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
	const owner = await signIn(`rev-owner-${n}`, `Maya ${n}`), member = await signIn(`rev-member-${n}`, `Tom ${n}`), third = await signIn(`rev-third-${n}`, `Jess ${n}`);
	const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name }), 201)).id;
	for (const person of [member, third]) await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${person.user.id}, 'member')`;
	const base = `/v1/organisations/${org}`;
	const b = {
		org, owner, member, third, base,
		history: (person: Person, kind: string, id: string, query = '') => json<History>(request('GET', `${base}/history/${kind}/${id}${query}`, person)),
		preview: (person: Person, changeIds: string[]) => json<Preview>(request('POST', `${base}/reversals/preview`, person, { changeIds })),
		apply: (person: Person, changeIds: string[], basis: Preview['basis'], id = randomUUID()) => request('POST', `${base}/reversals`, person, { id, changeIds, basis }),
		/** Preview then apply, asserting it applies. */
		undo: async (person: Person, changeIds: string[]) => {
			const preview = await b.preview(person, changeIds);
			assert.ok(preview.applicable, JSON.stringify(preview.changes.map(c => [c.state, c.reason, c.later?.length, c.needs])));
			return json<{ changeSet: ChangeSet; reversed: string[] }>(b.apply(person, changeIds, preview.basis), 201);
		},
		task: (person: Person, body: Record<string, unknown>) => json<{ id: string; revision: number; changeSetId: string }>(request('POST', `${base}/tasks`, person, body), 201),
		edit: (person: Person, id: string, body: Record<string, unknown>) => json<{ revision: number; changeSetId: string; due: string | null; ownerId: string | null; status: string }>(
			request('PATCH', `${base}/tasks/${id}`, person, body)),
		taskRow: async (id: string) => (await db.owner<{ due: string | null; ownerId: string | null; status: string; title: string; completedBy: string | null; completedAt: Date | null; revision: number }[]>`
			select due::text, owner_id, status, title, completed_by, completed_at, revision from tasks where id = ${id}`)[0]!,
		threadOf: async (column: 'task_id' | 'reservation_id' | 'stock_item_id', id: string) => (await db.owner.unsafe(`select id from threads where ${column} = $1`, [id]))[0]!.id as string,
		messages: (person: Person, thread: string) => json<{ messages: Message[] }>(request('GET', `${base}/threads/${thread}/messages?latest=100`, person)).then(r => r.messages),
		threadRevision: async (thread: string) => Number((await db.owner`select revision from threads where id = ${thread}`)[0]!.revision),
	};
	return b;
}
const entries = (history: History) => history.changeSets.flatMap(set => set.changes.map(change => ({ ...change, set })));
const entryOf = (history: History, changeSetId: string, field: string | null) => {
	const found = entries(history).find(entry => entry.set.id === changeSetId && entry.field === field);
	assert.ok(found, `no ${field} entry in ${changeSetId}`); return found;
};
const count = async (sql: string, ...params: unknown[]) => Number((await db.owner.unsafe(sql, params as never[]))[0]!.n);

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	let clock = Date.now();
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
		organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (clock += 61_000)) });
});
after(async () => { await db?.close(); });

it('an independent field is reversed and a later change of another field stays, as a new change set with one change line', async () => {
	const b = await business('Independent fields');
	const task = await b.task(b.owner, { title: 'Package summer lager', due: '2031-10-02' });
	const moved = await b.edit(b.owner, task.id, { expectedRevision: 1, due: '2031-10-06' });
	const owned = await b.edit(b.member, task.id, { expectedRevision: 2, ownerId: b.member.user.id });
	const history = await b.history(b.owner, 'task', task.id);
	assert.deepEqual(history.changeSets.map(set => set.id), [owned.changeSetId, moved.changeSetId, task.changeSetId], 'newest first');
	const due = entryOf(history, moved.changeSetId, 'due');
	assert.deepEqual([due.state, due.before, due.after, due.operation], ['reversible', '2031-10-02', '2031-10-06', 'update']);
	assert.deepEqual([entryOf(history, owned.changeSetId, 'ownerId').state, entryOf(history, task.changeSetId, null).state, entryOf(history, task.changeSetId, null).reason],
		['reversible', 'irreversible', 'record_created']);
	assert.equal(history.names.people[b.member.user.id], `Tom ${people}`, 'names to word the owner change');

	const preview = await b.preview(b.owner, [due.id]);
	assert.deepEqual(preview.changes.map(c => [c.state, c.now, c.proposed]), [['reversible', '2031-10-06', '2031-10-02']]);
	assert.deepEqual(preview.basis, [{ recordKind: 'task', recordId: task.id, revision: 3 }]);
	const id = randomUUID();
	const applied = await b.apply(b.owner, [due.id], preview.basis, id);
	assert.equal(applied.status, 201);
	assert.equal(applied.headers.get(changeSetHeader), id);
	const result = await applied.json() as { changeSet: ChangeSet; reversed: string[] };
	assert.deepEqual([result.changeSet.id, result.changeSet.causeKind, result.changeSet.reversesChangeSetId, result.changeSet.actor.id], [id, 'reversal', moved.changeSetId, b.owner.user.id]);
	assert.deepEqual(result.changeSet.changes.map(c => [c.field, c.before, c.after, c.reverses, c.state]), [['due', '2031-10-06', '2031-10-02', [due.id], 'reversible']]);
	assert.deepEqual(result.reversed, [due.id]);
	const row = await b.taskRow(task.id);
	assert.deepEqual([row.due, row.ownerId], ['2031-10-02', b.member.user.id], 'the later owner change is untouched');
	const [link] = await db.owner<{ reversesChangeId: string }[]>`select reverses_change_id from record_changes where change_set_id = ${id}`;
	assert.equal(link!.reversesChangeId, due.id);
	// History marks the original "undone" by whom; the reversal is at the top, tickable like any other change.
	const again = await b.history(b.member, 'task', task.id);
	assert.equal(again.changeSets[0]!.id, id);
	const undone = entryOf(again, moved.changeSetId, 'due');
	assert.deepEqual([undone.state, undone.reversedBy?.changeSetId, undone.reversedBy?.actor.id], ['reversed', id, b.owner.user.id]);
	assert.equal(entryOf(again, id, 'due').state, 'reversible');
	// The reversal is a change line in the task's thread, once.
	const thread = await b.threadOf('task_id', task.id);
	const lines = (await b.messages(b.member, thread)).filter(m => m.changeSetId === id);
	assert.equal(lines.length, 1);
	assert.deepEqual([lines[0]!.change!.causeKind, lines[0]!.change!.changes.map(c => [c.field, c.before, c.after])], ['reversal', [['due', '2031-10-06', '2031-10-02']]]);
});

it('a later change to the same field is a conflict even when the value came back; including it gives the earliest before', async () => {
	const b = await business('Same field');
	const task = await b.task(b.owner, { title: 'Order cans', due: '2031-10-02' });
	const away = await b.edit(b.owner, task.id, { expectedRevision: 1, due: '2031-10-06' });
	const back = await b.edit(b.member, task.id, { expectedRevision: 2, due: '2031-10-02' });
	let history = await b.history(b.owner, 'task', task.id);
	const first = entryOf(history, away.changeSetId, 'due'), second = entryOf(history, back.changeSetId, 'due');
	assert.equal(first.state, 'conflict', 'equal values are not provenance');
	assert.deepEqual(first.later!.map(l => [l.id, l.changeSetId, l.actor.name, l.before, l.after]), [[second.id, back.changeSetId, `Tom ${people}`, '2031-10-06', '2031-10-02']]);
	assert.equal(second.state, 'reversible');
	// Alone, the first is blocked by the conflict and nothing is proposed; applying it is refused and writes nothing.
	const alone = await b.preview(b.owner, [first.id]);
	assert.deepEqual([alone.applicable, alone.changes[0]!.state, alone.changes[0]!.proposed, alone.changes[0]!.now], [false, 'conflict', null, '2031-10-02']);
	const refused = await json<{ code: string; preview: Preview }>(b.apply(b.owner, [first.id], alone.basis), 409);
	assert.equal(refused.code, 'stale_preview');
	assert.equal(refused.preview.changes[0]!.state, 'conflict');
	assert.equal(await count(`select count(*) as n from change_sets where organisation_id = $1 and cause_kind = 'reversal'`, b.org), 0);
	// Both: the result is the earliest selected before, which is today's value, so there is nothing to undo.
	const both = await b.preview(b.owner, [first.id, second.id]);
	assert.deepEqual(both.changes.map(c => [c.state, c.reason]), [['blocked', 'already_current'], ['blocked', 'already_current']]);
	// A third change: now the pair has an effect and applies as one change to the earliest before.
	const third = await b.edit(b.owner, task.id, { expectedRevision: 3, due: '2031-10-09' });
	history = await b.history(b.owner, 'task', task.id);
	const latest = entryOf(history, third.changeSetId, 'due');
	assert.deepEqual(entryOf(history, back.changeSetId, 'due').later!.map(l => l.id), [latest.id]);
	const result = await b.undo(b.owner, [second.id, latest.id]);
	assert.deepEqual(result.changeSet.changes.map(c => [c.field, c.after, c.reverses]), [['due', '2031-10-06', [second.id]]]);
	assert.equal((await b.taskRow(task.id)).due, '2031-10-06');
	history = await b.history(b.owner, 'task', task.id);
	for (const set of [back.changeSetId, third.changeSetId]) assert.equal(entryOf(history, set, 'due').reversedBy?.changeSetId, result.changeSet.id, set);
	assert.deepEqual(entryOf(history, away.changeSetId, 'due').later!.map(l => l.changeSetId), [result.changeSet.id], 'the reversal is now the later change to add');
});

it('several changes across records and items reverse as one change set, with one change line in each affected thread', async () => {
	const b = await business('Several');
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Production' }), 201);
	const one = await b.task(b.owner, { title: 'Brew batch 42', due: '2031-05-01' });
	const two = await b.task(b.owner, { title: 'Clean the line' });
	const moved = await b.edit(b.owner, one.id, { expectedRevision: 1, due: '2031-05-03', title: 'Brew batch 43' });
	const thread = await b.threadOf('task_id', two.id);
	const tagged = await request('POST', `${b.base}/threads/${thread}/tags/${tag.id}`, b.member, { expectedRevision: await b.threadRevision(thread) });
	const tagSet = tagged.headers.get(changeSetHeader)!;
	const step = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks`, b.member, { title: 'Weigh the malt', parentId: one.id, expectedParentRevision: 2 }), 201);
	const h1 = await b.history(b.owner, 'task', one.id), h2 = await b.history(b.owner, 'task', two.id);
	const due = entryOf(h1, moved.changeSetId, 'due'), title = entryOf(h1, moved.changeSetId, 'title');
	const attach = entryOf(h2, tagSet, null), stepEntry = entryOf(h1, step.changeSetId, null);
	assert.deepEqual([attach.operation, attach.itemKind, attach.itemId, attach.state], ['attach', 'tag', tag.id, 'reversible']);
	assert.deepEqual([stepEntry.operation, stepEntry.itemKind, stepEntry.state], ['create', 'step', 'reversible']);
	assert.equal(h2.names.tags[tag.id], 'Production');
	const preview = await b.preview(b.member, [due.id, attach.id, stepEntry.id]);
	assert.equal(preview.basis.length, 2);
	assert.deepEqual(preview.changes.find(c => c.id === attach.id)!.proposed, null, 'the tag would be gone');
	const result = await b.undo(b.member, [due.id, attach.id, stepEntry.id]);
	assert.deepEqual(result.changeSet.changes.map(c => [c.recordId, c.operation, c.field ?? c.itemKind]).sort(),
		[[one.id, 'remove', 'step'], [one.id, 'update', 'due'], [two.id, 'detach', 'tag']].sort());
	const row = await b.taskRow(one.id);
	assert.deepEqual([row.due, row.title], ['2031-05-01', 'Brew batch 43'], 'the title, changed in the same change set, stays');
	assert.equal(await count('select count(*) as n from tasks where id = $1', step.id), 0, 'the step is removed');
	assert.equal(await count('select count(*) as n from thread_tags where thread_id = $1', thread), 0);
	assert.deepEqual((await db.owner<{ threadId: string }[]>`select thread_id from thread_messages where change_set_id = ${result.changeSet.id} order by thread_id`).map(r => r.threadId),
		[await b.threadOf('task_id', one.id), thread].sort(), 'one line in each thread');
	// The removed step's creation is "undone"; reversing the reversal restores it, by the same rules.
	const after = await b.history(b.owner, 'task', one.id);
	assert.equal(entryOf(after, step.changeSetId, null).state, 'reversed');
	const removal = entries(after).find(e => e.set.id === result.changeSet.id && e.itemKind === 'step')!;
	const restored = await b.undo(b.owner, [removal.id]);
	assert.deepEqual(restored.changeSet.changes.map(c => [c.operation, c.itemId]), [['create', step.id]]);
	assert.equal((await db.owner<{ title: string }[]>`select title from tasks where id = ${step.id}`)[0]!.title, 'Weigh the malt');
});

it('coupled fields show as one change and reverse together: a booking’s time, a task’s status with its completion', async () => {
	const b = await business('Coupled');
	const tank = await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Canning line' }), 201);
	const booking = await json<{ id: string; revision: number }>(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.owner,
		{ id: randomUUID(), title: 'Can the lager', startsAt: '2031-10-08T08:00:00Z', endsAt: '2031-10-08T12:00:00Z' }), 201);
	const moved = await json<{ changeSetId: string }>(request('PATCH', `${b.base}/equipment/${tank.id}/reservations/${booking.id}`, b.member,
		{ expectedRevision: 1, title: 'Can the lager', kind: 'booking', startsAt: '2031-10-09T13:00:00Z', endsAt: '2031-10-09T17:00:00Z', setupMinutes: 30, cleanupMinutes: 0, taskId: null, ownerId: null }));
	const history = await b.history(b.owner, 'reservation', booking.id);
	const time = entryOf(history, moved.changeSetId, 'time');
	assert.equal(time.changeIds.length, 3);
	assert.deepEqual(time.fields.sort(), ['endsAt', 'setupMinutes', 'startsAt']);
	assert.deepEqual(time.before, { startsAt: '2031-10-08T08:00:00+00:00', endsAt: '2031-10-08T12:00:00+00:00', setupMinutes: 0 });
	assert.equal(entries(history).filter(e => e.set.id === moved.changeSetId).length, 1, 'one entry for the move');
	// Ticking part of the group names the rest; nothing applies.
	const part = await b.preview(b.owner, [time.changeIds[0]!]);
	assert.deepEqual([part.applicable, part.changes[0]!.state, part.changes[0]!.needs], [false, 'needs', time.changeIds.slice(1)]);
	const whole = await b.preview(b.owner, time.changeIds);
	assert.deepEqual(whole.changes[0]!.proposed, { startsAt: '2031-10-08T08:00:00+00:00', endsAt: '2031-10-08T12:00:00+00:00', setupMinutes: 0 });
	await b.undo(b.owner, time.changeIds);
	const [row] = await db.owner<{ startsAt: Date; occupiedStartsAt: Date; revision: number }[]>`select starts_at, occupied_starts_at, revision from equipment_reservations where id = ${booking.id}`;
	assert.deepEqual([row!.startsAt.toISOString(), row!.occupiedStartsAt.toISOString(), row!.revision], ['2031-10-08T08:00:00.000Z', '2031-10-08T08:00:00.000Z', 3]);
	// A task's completion: status, by whom and when are one entry; undoing it reopens with no completion.
	const task = await b.task(b.owner, { title: 'Excise return' });
	const done = await b.edit(b.member, task.id, { expectedRevision: 1, status: 'done' });
	const status = entryOf(await b.history(b.owner, 'task', task.id), done.changeSetId, 'status');
	assert.deepEqual([status.fields.sort(), (status.after as Record<string, unknown>).status], [['completedAt', 'completedBy', 'status'], 'done']);
	await b.undo(b.owner, status.changeIds);
	const reopened = await b.taskRow(task.id);
	assert.deepEqual([reopened.status, reopened.completedBy, reopened.completedAt], ['open', null, null]);
});

it('one blocked change stops the whole reversal: a booking slot taken since, and nothing is written', async () => {
	const b = await business('Atomic');
	const tank = await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Canning line' }), 201);
	const booking = await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.owner,
		{ id: randomUUID(), title: 'Can the lager', startsAt: '2031-10-08T08:00:00Z', endsAt: '2031-10-08T12:00:00Z' }), 201);
	const moved = await json<{ changeSetId: string }>(request('PATCH', `${b.base}/equipment/${tank.id}/reservations/${booking.id}`, b.owner,
		{ expectedRevision: 1, title: 'Can the lager', kind: 'booking', startsAt: '2031-10-09T13:00:00Z', endsAt: '2031-10-09T17:00:00Z', setupMinutes: 0, cleanupMinutes: 0, taskId: null, ownerId: null }));
	// Someone takes the old slot, with setup and cleanup around it.
	const keg = await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.member,
		{ id: randomUUID(), title: 'Keg wash', startsAt: '2031-10-08T08:00:00Z', endsAt: '2031-10-08T12:00:00Z', setupMinutes: 30, cleanupMinutes: 30, ownerId: b.member.user.id }), 201);
	const task = await b.task(b.owner, { title: 'Label run', due: '2031-10-02' });
	const edited = await b.edit(b.owner, task.id, { expectedRevision: 1, due: '2031-10-05' });
	const time = entryOf(await b.history(b.owner, 'reservation', booking.id), moved.changeSetId, 'time');
	const due = entryOf(await b.history(b.owner, 'task', task.id), edited.changeSetId, 'due');
	const preview = await b.preview(b.owner, [...time.changeIds, due.id]);
	const blocked = preview.changes.find(c => c.field === 'time')!;
	assert.deepEqual([preview.applicable, blocked.state, blocked.reason], [false, 'blocked', 'slot_taken']);
	assert.deepEqual([blocked.detail!.reservationId, blocked.detail!.title, blocked.detail!.ownerName], [keg.id, 'Keg wash', `Tom ${people}`]);
	assert.deepEqual((blocked.proposed as Record<string, unknown>).startsAt, '2031-10-08T08:00:00+00:00', 'a blocked change still shows what it would be');
	assert.equal(preview.changes.find(c => c.field === 'due')!.state, 'reversible');
	const refused = await json<{ code: string; preview: Preview; moved: unknown[] }>(b.apply(b.owner, [...time.changeIds, due.id], preview.basis), 409);
	assert.deepEqual([refused.code, refused.moved], ['stale_preview', []]);
	assert.equal((await b.taskRow(task.id)).due, '2031-10-05', 'the independent change was not applied either');
	assert.equal(await count(`select count(*) as n from change_sets where organisation_id = $1 and cause_kind = 'reversal'`, b.org), 0);
	// Cancelling and then undoing the cancel checks the slot the same way.
	const freed = await json<{ revision: number }>(request('POST', `${b.base}/equipment/${tank.id}/reservations/${booking.id}/cancel`, b.owner, { expectedRevision: 2 }));
	assert.equal(freed.revision, 3);
	await json(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.member,
		{ id: randomUUID(), title: 'Tank clean', startsAt: '2031-10-09T12:00:00Z', endsAt: '2031-10-09T14:00:00Z' }), 201);
	const history = await b.history(b.owner, 'reservation', booking.id);
	const cancel = entries(history).find(e => e.field === 'status')!;
	const again = await b.preview(b.owner, [cancel.id]);
	assert.deepEqual([again.changes[0]!.state, again.changes[0]!.reason], ['blocked', 'slot_taken']);
	assert.deepEqual(entries(history).find(e => e.field === null && e.operation === 'create')!.reason, 'record_created', 'a booking is cancelled, not un-made');
});

it('a stale preview applies nothing and returns the fresh preview; a lost response is retried to the same change set', async () => {
	const b = await business('Stale and retry');
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Production' }), 201);
	const task = await b.task(b.owner, { title: 'Package summer lager', due: '2031-10-06' });
	const moved = await b.edit(b.owner, task.id, { expectedRevision: 1, due: '2031-10-08' });
	const thread = await b.threadOf('task_id', task.id);
	const tagged = (await request('POST', `${b.base}/threads/${thread}/tags/${tag.id}`, b.owner, { expectedRevision: await b.threadRevision(thread) })).headers.get(changeSetHeader)!;
	const history = await b.history(b.owner, 'task', task.id);
	const due = entryOf(history, moved.changeSetId, 'due'), attach = entryOf(history, tagged, null);
	const preview = await b.preview(b.owner, [due.id, attach.id]);
	assert.ok(preview.applicable);
	// Tom changes the due date a moment later: the preview is out of date.
	const tom = await b.edit(b.member, task.id, { expectedRevision: 2, due: '2031-10-09' });
	const stale = await json<{ code: string; preview: Preview; moved: { revision: number }[] }>(b.apply(b.owner, [due.id, attach.id], preview.basis), 409);
	assert.equal(stale.code, 'stale_preview');
	assert.deepEqual(stale.moved.map(m => m.revision), [3]);
	const fresh = stale.preview.changes.find(c => c.field === 'due')!;
	assert.deepEqual([fresh.state, fresh.proposed, fresh.now, fresh.later!.map(l => l.changeSetId)], ['conflict', null, '2031-10-09', [tom.changeSetId]]);
	assert.equal(stale.preview.changes.find(c => c.itemKind === 'tag')!.state, 'reversible');
	assert.equal((await b.taskRow(task.id)).due, '2031-10-09');
	assert.equal(await count('select count(*) as n from thread_tags where thread_id = $1', thread), 1, 'the tag stayed too');
	// "Undo the tag only", with the fresh basis. The response is lost; the retry returns the same change set.
	const tagOnly = await b.preview(b.owner, [attach.id]);
	const id = randomUUID();
	const first = await json<{ changeSet: ChangeSet }>(b.apply(b.owner, [attach.id], tagOnly.basis, id), 201);
	const retried = await json<{ changeSet: ChangeSet }>(b.apply(b.owner, [attach.id], tagOnly.basis, id), 201);
	assert.deepEqual(retried, first);
	assert.equal(await count(`select count(*) as n from change_sets where organisation_id = $1 and cause_kind = 'reversal'`, b.org), 1);
	assert.equal(await count('select count(*) as n from thread_messages where change_set_id = $1', id), 1);
	// The same id for something else, or by someone else, is refused.
	assert.equal((await json<{ code: string }>(b.apply(b.owner, [due.id], tagOnly.basis, id), 409)).code, 'change_set_id_unavailable');
	assert.equal((await json<{ code: string }>(b.apply(b.member, [attach.id], tagOnly.basis, id), 409)).code, 'change_set_id_unavailable');
	// Once undone, the attach shows as such; a second reversal of it is refused as stale, nothing written.
	const done = await b.preview(b.owner, [attach.id]);
	assert.deepEqual([done.changes[0]!.state, done.changes[0]!.reversedBy?.changeSetId], ['reversed', id]);
	assert.equal((await json<{ code: string }>(b.apply(b.owner, [attach.id], done.basis), 409)).code, 'stale_preview');
});

it('undo, then undo of the undo, repeated, by the same rules each time', async () => {
	const b = await business('Undo redo');
	const task = await b.task(b.owner, { title: 'Order pallet wrap', due: '2031-10-02' });
	const moved = await b.edit(b.owner, task.id, { expectedRevision: 1, due: '2031-10-06' });
	let target = entryOf(await b.history(b.owner, 'task', task.id), moved.changeSetId, 'due').id;
	const values: (string | null)[] = [];
	const sets: string[] = [moved.changeSetId];
	for (let round = 0; round < 4; round++) {
		const result = await b.undo(round % 2 ? b.member : b.owner, [target]);
		values.push((await b.taskRow(task.id)).due);
		sets.push(result.changeSet.id);
		target = result.changeSet.changes[0]!.id;
	}
	assert.deepEqual(values, ['2031-10-02', '2031-10-06', '2031-10-02', '2031-10-06']);
	const history = await b.history(b.owner, 'task', task.id);
	for (let i = 0; i < 4; i++) assert.equal(entryOf(history, sets[i]!, 'due').reversedBy?.changeSetId, sets[i + 1], `round ${i}`);
	assert.equal(entryOf(history, sets[4]!, 'due').state, 'reversible');
});

it('history pages newest first to where it starts, and a version is the record as it was', async () => {
	const b = await business('Paging');
	const task = await b.task(b.owner, { title: 'Brew day', due: '2031-01-01' });
	const sets = [task.changeSetId];
	for (let i = 2; i <= 6; i++) sets.push((await b.edit(b.owner, task.id, { expectedRevision: i - 1, due: `2031-01-0${i}` })).changeSetId);
	const seen: string[] = [];
	let cursor: string | null = null, pages = 0, start: History['start'] = null;
	do {
		const page: History = await b.history(b.member, 'task', task.id, `?limit=2${cursor ? `&before=${cursor}` : ''}`);
		seen.push(...page.changeSets.map(set => set.id));
		assert.equal(page.start === null, page.nextCursor !== null, 'the start marker comes with the last page');
		cursor = page.nextCursor; start = page.start; pages++;
	} while (cursor);
	assert.deepEqual([seen, pages], [[...sets].reverse(), 3]);
	assert.deepEqual([start!.kind, start!.changeSetId, start!.revision], ['created', task.changeSetId, 1]);
	const history = await b.history(b.owner, 'task', task.id);
	assert.deepEqual(history.changeSets.slice(1, 5).map(set => set.changes[0]!.state), ['conflict', 'conflict', 'conflict', 'conflict']);
	assert.equal(history.changeSets[0]!.changes[0]!.state, 'reversible');
	const version = await json<{ revision: number; changeSetId: string; removed: boolean; snapshot: { row: { due: string; title: string }; steps: unknown[]; tags: unknown[] } }>(
		request('GET', `${b.base}/history/task/${task.id}/versions/3`, b.member));
	assert.deepEqual([version.revision, version.changeSetId, version.removed, version.snapshot.row.due, version.snapshot.row.title], [3, sets[2], false, '2031-01-03', 'Brew day']);
	assert.equal((await request('GET', `${b.base}/history/task/${task.id}/versions/99`, b.member)).status, 404);
	assert.equal((await request('GET', `${b.base}/history/task/${task.id}?before=nonsense`, b.member)).status, 400);
	assert.equal((await request('GET', `${b.base}/history/task/${task.id}?limit=51`, b.member)).status, 400);
	assert.equal((await request('GET', `${b.base}/history/shopify_inventory_level/${task.id}`, b.member)).status, 400, 'provider quantities are not journalled records');
	assert.equal((await request('POST', `${b.base}/reversals/preview`, b.member, { changeIds: Array.from({ length: 51 }, () => randomUUID()) })).status, 400);
});

it('history is as private as its record: another tenant, a non-participant and a removed member learn nothing and reverse nothing', async () => {
	const b = await business('Isolation'), other = await business('Elsewhere');
	const task = await b.task(b.owner, { title: 'Quote the distributor', due: '2031-10-02' });
	const moved = await b.edit(b.owner, task.id, { expectedRevision: 1, due: '2031-10-03' });
	const due = entryOf(await b.history(b.owner, 'task', task.id), moved.changeSetId, 'due');
	// Another organisation: its own id or the right organisation with a stranger, both the generic 404.
	assert.equal((await request('GET', `${b.base}/history/task/${task.id}`, other.owner)).status, 404);
	assert.equal((await request('GET', `${other.base}/history/task/${task.id}`, other.owner)).status, 404);
	assert.equal((await request('POST', `${other.base}/reversals/preview`, other.owner, { changeIds: [due.id] })).status, 404);
	assert.equal((await request('POST', `${other.base}/reversals`, other.owner, { id: randomUUID(), changeIds: [due.id], basis: [] })).status, 404);
	// A private thread's tag history: its participants', invisible to everyone else, even its existence.
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Pricing' }), 201);
	const secret = (await json<{ thread: { id: string } }>(request('POST', `${b.base}/threads`, b.owner,
		{ id: randomUUID(), kind: 'private', title: 'Margins', participantIds: [b.third.user.id] }), 201)).thread.id;
	const tagged = (await request('POST', `${b.base}/threads/${secret}/tags/${tag.id}`, b.third, { expectedRevision: 1 })).headers.get(changeSetHeader)!;
	const attach = entryOf(await b.history(b.owner, 'thread', secret), tagged, null);
	const missing = randomUUID();
	for (const [kind, id] of [['thread', secret], ['thread', missing]] as const)
		assert.deepEqual(await json(request('GET', `${b.base}/history/${kind}/${id}`, b.member), 404), { ok: false, code: 'not_found', error: 'not found' }, 'the same answer');
	assert.equal((await request('GET', `${b.base}/history/thread/${secret}/versions/2`, b.member)).status, 404);
	assert.deepEqual(await json(request('POST', `${b.base}/reversals/preview`, b.member, { changeIds: [attach.id] }), 404),
		await json(request('POST', `${b.base}/reversals/preview`, b.member, { changeIds: [missing] }), 404));
	assert.equal((await request('POST', `${b.base}/reversals`, b.member, { id: randomUUID(), changeIds: [attach.id], basis: [] })).status, 404);
	assert.equal(await count('select count(*) as n from thread_tags where thread_id = $1', secret), 1);
	// Its participants see it. Historical authorship grants nothing: once the author leaves, they cannot undo it.
	const preview = await b.preview(b.third, [attach.id]);
	assert.ok(preview.applicable);
	await json(request('DELETE', `${b.base}/threads/${secret}/participants/${b.third.user.id}?expectedRevision=${await b.threadRevision(secret)}`, b.third));
	assert.equal((await request('POST', `${b.base}/reversals`, b.third, { id: randomUUID(), changeIds: [attach.id], basis: preview.basis })).status, 404);
	assert.equal((await request('GET', `${b.base}/history/thread/${secret}`, b.third)).status, 404);
	// A removed member: previewed while a member, refused once removed; a remaining member may undo it.
	const own = await b.preview(b.member, [due.id]);
	await json(request('DELETE', `${b.base}/members/${b.member.user.id}`, b.owner));
	assert.equal((await request('POST', `${b.base}/reversals`, b.member, { id: randomUUID(), changeIds: [due.id], basis: own.basis })).status, 404);
	assert.equal((await request('GET', `${b.base}/history/task/${task.id}`, b.member)).status, 404);
	assert.equal((await b.taskRow(task.id)).due, '2031-10-03');
	await b.undo(b.owner, [due.id]);
});

it('stock: a later count conflicts with undoing an earlier one, and the previous count comes back with when and by whom', async () => {
	const b = await business('Stock');
	const item = await json<{ id: string }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Hops', location: 'Cool room', unitLabel: 'kg' }), 201);
	const first = await json<{ changeSetId: string; countedAt: string }>(request('POST', `${b.base}/stock/${item.id}/count`, b.member, { count: '4.5' }), 201);
	const second = await json<{ changeSetId: string }>(request('POST', `${b.base}/stock/${item.id}/count`, b.owner, { count: '2' }), 201);
	const history = await b.history(b.owner, 'stock_item', item.id);
	const one = entryOf(history, first.changeSetId, 'count'), two = entryOf(history, second.changeSetId, 'count');
	assert.deepEqual([one.state, one.later!.length, two.state], ['conflict', 3, 'reversible']);
	assert.deepEqual((two.before as Record<string, unknown>).currentCount, '4.5', 'counts are exact decimal strings');
	await b.undo(b.owner, two.changeIds);
	const [row] = await db.owner<{ currentCount: string; countedBy: string; countedAt: Date }[]>`select current_count::text, counted_by, counted_at from stock_items where id = ${item.id}`;
	assert.deepEqual([row!.currentCount, row!.countedBy, row!.countedAt.toISOString()], ['4.5', b.member.user.id, new Date(first.countedAt).toISOString()]);
	assert.equal(await count('select count(*) as n from stock_counts where item_id = $1', item.id), 2, 'observations are never removed');
	// The first count is still blocked by the second (now undone) only through the undo, which is the change to add.
	const after = await b.history(b.owner, 'stock_item', item.id);
	assert.equal(entryOf(after, first.changeSetId, 'count').state, 'conflict');
	assert.equal(entryOf(after, second.changeSetId, 'count').state, 'reversed');
	// The item's creation is not reversible; an item archived since blocks restoring a count.
	assert.equal(entries(after).find(e => e.operation === 'create')!.reason, 'record_created');
	const undo = entries(after)[0]!;
	await json(request('PATCH', `${b.base}/stock/${item.id}`, b.owner, { archived: true }));
	const blocked = await b.preview(b.owner, undo.changeIds);
	assert.deepEqual([blocked.changes[0]!.state, blocked.changes[0]!.reason], ['blocked', 'stock_archived']);
});

it('items: a tag or record gone since cannot be restored, and evidence on a done duty is kept', async () => {
	const b = await business('Items');
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Autumn range' }), 201);
	const task = await b.task(b.owner, { title: 'Monthly excise' });
	const thread = await b.threadOf('task_id', task.id);
	const tagged = (await request('POST', `${b.base}/threads/${thread}/tags/${tag.id}`, b.owner, { expectedRevision: await b.threadRevision(thread) })).headers.get(changeSetHeader)!;
	const removed = (await request('DELETE', `${b.base}/threads/${thread}/tags/${tag.id}?expectedRevision=${await b.threadRevision(thread)}`, b.owner)).headers.get(changeSetHeader)!;
	let history = await b.history(b.owner, 'task', task.id);
	const detach = entryOf(history, removed, null);
	assert.deepEqual([entryOf(history, tagged, null).state, detach.state], ['conflict', 'reversible']);
	await journalled(db.owner, { organisationId: b.org }, tx => tx`delete from tags where id = ${tag.id}`);
	history = await b.history(b.owner, 'task', task.id);
	assert.deepEqual([entryOf(history, removed, null).state, entryOf(history, removed, null).reason], ['irreversible', 'tag_gone']);
	assert.equal(history.names.tags[tag.id], 'Autumn range', 'a deleted tag keeps its last name');
	// Evidence on a duty that needs it: removing the last piece by undoing its attachment is blocked while the task is done.
	await journalled(db.owner, { organisationId: b.org }, tx => tx`update tasks set evidence_required = true where id = ${task.id}`);
	const evidence = await json<{ id: string; changeSetId: string }>(request('POST', `${b.base}/tasks/${task.id}/evidence`, b.owner,
		{ expectedRevision: (await b.taskRow(task.id)).revision, kind: 'url', reference: 'https://example.test/return' }), 201);
	await b.edit(b.owner, task.id, { expectedRevision: (await b.taskRow(task.id)).revision, status: 'done' });
	const attached = entryOf(await b.history(b.owner, 'task', task.id), evidence.changeSetId, null);
	const preview = await b.preview(b.owner, [attached.id]);
	assert.deepEqual([preview.changes[0]!.state, preview.changes[0]!.reason], ['blocked', 'evidence_required']);
	assert.equal((preview.changes[0]!.now as { reference: string }).reference, 'https://example.test/return');
});

it('topic to task: the topic’s thread becomes the task’s, keeping its messages and tags, once, and never for a private thread', async () => {
	const b = await business('Topic to task');
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Summer lager' }), 201);
	const topic = (await json<{ thread: { id: string; revision: number } }>(request('POST', `${b.base}/threads`, b.member,
		{ id: randomUUID(), kind: 'topic', message: { id: randomUUID(), body: 'Order pallet wrap before the canning run\nWe have one roll left.' } }), 201)).thread;
	await json(request('POST', `${b.base}/threads/${topic.id}/tags/${tag.id}`, b.member, { expectedRevision: topic.revision }));
	await json(request('POST', `${b.base}/threads/${topic.id}/messages`, b.third, { id: randomUUID(), body: 'Coastal Packaging can deliver Monday.' }), 201);
	const threadsBefore = await count('select count(*) as n from threads where organisation_id = $1', b.org);
	const before = await b.messages(b.owner, topic.id);
	const changeSetId = randomUUID();
	const body = { expectedRevision: 2, ownerId: b.owner.user.id, due: '2031-10-05', changeSetId };
	const made = await request('POST', `${b.base}/threads/${topic.id}/task`, b.owner, body);
	const detail = await json<{ thread: { id: string; kind: string; title: string; revision: number }; card: { record: { kind: string; id: string } | null }; tags: { id: string }[] }>(made);
	assert.equal(made.headers.get(changeSetHeader), changeSetId);
	assert.deepEqual([detail.thread.id, detail.thread.kind, detail.thread.title, detail.thread.revision, detail.card.record?.kind, detail.tags.map(t => t.id)],
		[topic.id, 'record', 'Order pallet wrap before the canning run', 3, 'task', [tag.id]]);
	const taskId = detail.card.record!.id;
	const [task] = await db.owner<{ title: string; body: string; ownerId: string; due: string; status: string }[]>`select title, body, owner_id, due::text, status from tasks where id = ${taskId}`;
	assert.deepEqual(task, { title: 'Order pallet wrap before the canning run', body: '', ownerId: b.owner.user.id, due: '2031-10-05', status: 'open' });
	assert.equal(await count('select count(*) as n from threads where organisation_id = $1', b.org), threadsBefore, 'no second thread');
	const after = await b.messages(b.member, topic.id);
	assert.deepEqual(after.slice(0, before.length).map(m => m.body), before.map(m => m.body), 'the messages stay where they are');
	assert.deepEqual(after.slice(before.length).map(m => [m.kind, m.changeSetId]), [['change', changeSetId]], 'the creation is a change line in this thread');
	// Journalled as the task's creation: in its history and not reversible ("cancel or complete it instead").
	const history = await b.history(b.member, 'task', taskId);
	assert.deepEqual(history.changeSets.map(set => set.id), [changeSetId]);
	assert.deepEqual([history.changeSets[0]!.changes[0]!.operation, history.changeSets[0]!.changes[0]!.reason], ['create', 'record_created']);
	assert.deepEqual([history.start?.kind, history.start?.changeSetId], ['created', changeSetId]);
	// A retry after a lost response answers the same; another request is refused; the thread is now a record's.
	const retried = await json<{ thread: { id: string; kind: string }; card: { record: { id: string } } }>(request('POST', `${b.base}/threads/${topic.id}/task`, b.owner, body));
	assert.deepEqual([retried.thread.kind, retried.card.record.id], ['record', taskId]);
	assert.equal(await count('select count(*) as n from tasks where organisation_id = $1', b.org), 1);
	assert.equal((await json<{ code: string }>(request('POST', `${b.base}/threads/${topic.id}/task`, b.owner, { expectedRevision: 3 }), 409)).code, 'thread_is_record');
	assert.equal((await json<{ code: string }>(request('PATCH', `${b.base}/threads/${topic.id}`, b.owner, { expectedRevision: 3, title: 'Renamed' }), 400)).code, 'record_title');
	// A private thread stays private; a stale revision and an inactive owner are refused; strangers get the 404.
	const secret = (await json<{ thread: { id: string } }>(request('POST', `${b.base}/threads`, b.owner, { id: randomUUID(), kind: 'private', title: 'Margins', participantIds: [] }), 201)).thread.id;
	assert.equal((await json<{ code: string }>(request('POST', `${b.base}/threads/${secret}/task`, b.owner, { expectedRevision: 1 }), 400)).code, 'thread_not_topic');
	assert.equal((await request('POST', `${b.base}/threads/${secret}/task`, b.member, { expectedRevision: 1 })).status, 404);
	const another = (await json<{ thread: { id: string } }>(request('POST', `${b.base}/threads`, b.member, { id: randomUUID(), kind: 'topic', message: { id: randomUUID(), body: 'Fix the chiller' } }), 201)).thread.id;
	assert.equal((await json<{ code: string }>(request('POST', `${b.base}/threads/${another}/task`, b.owner, { expectedRevision: 2 }), 409)).code, 'stale_revision');
	assert.equal((await json<{ code: string }>(request('POST', `${b.base}/threads/${another}/task`, b.owner, { expectedRevision: 1, ownerId: randomUUID() }), 400)).code, 'owner_invalid');
	const stranger = await business('Strangers');
	assert.equal((await request('POST', `${b.base}/threads/${another}/task`, stranger.owner, { expectedRevision: 1 })).status, 404);
	assert.equal(await count('select count(*) as n from tasks where organisation_id = $1', b.org), 1, 'none of those made a task');
});

it('the baseline is history’s start for a record from before the journal, and its version is the record as it was', async () => {
	const old = await freshDatabase({ through: '0046_threads.sql' });
	try {
		const [org] = await old.owner<{ id: string }[]>`insert into organisations (name) values ('Before') returning id`;
		const [user] = await old.owner<{ id: string }[]>`insert into users (email, name) values (${`${randomUUID()}@example.test`}, 'Maya') returning id`;
		await old.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
		const [task] = await old.owner<{ id: string }[]>`insert into tasks (organisation_id, title, due, created_by) values (${org!.id}, 'Old task', '2031-01-01', ${user!.id}) returning id`;
		await applyMigrations(old.owner);
		const actor = { userId: user!.id, requestId: 'baseline-test' };
		const versions = new VersionsService(old.app);
		const commitments = new CommitmentsService(old.app);
		let history = await versions.history(actor, org!.id, 'task', task!.id, {});
		assert.deepEqual([history.changeSets.length, history.start?.kind, history.start?.revision, history.nextCursor], [0, 'baseline', 1, null], 'the baseline invents no changes');
		const edited = await commitments.updateTask(actor, org!.id, task!.id, { expectedRevision: 1, due: '2031-01-05' });
		history = await versions.history(actor, org!.id, 'task', task!.id, {});
		assert.deepEqual([history.changeSets.map(set => set.id), history.start?.kind], [[edited.changeSetId], 'baseline']);
		const version = await versions.version(actor, org!.id, 'task', task!.id, 1);
		assert.equal((version.snapshot as { row: { due: string } }).row.due, '2031-01-01');
	} finally { await old.close(); }
});
