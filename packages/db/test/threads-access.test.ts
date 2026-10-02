import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { databaseUrl, fixture, freshDatabase, withJournalledTenant, type Harness } from './harness.ts';

// Migration 0046 (threads contract §3, §4, §9): record threads made by their record's insert, record and topic threads
// visible to every active member through thread_visible(), tags on threads, and what a system routine (no person in the
// transaction) may touch. Direct SQL as the runtime role, bypassing any service.
const it = databaseUrl ? test : test.skip;
let db: Harness;
const RLS = /row-level security/;
const REFUSED = { code: '23514' };
const fp = (value: string) => createHash('sha256').update(value).digest();
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(): Promise<string> {
	return (await db.owner<{ id: string }[]>`insert into organisations (name) values ('Thread access test') returning id`)[0]!.id;
}
async function person(org: string, role: 'owner' | 'admin' | 'member' = 'member'): Promise<string> {
	const [user] = await db.owner<{ id: string }[]>`insert into users (email) values (${`${randomUUID()}@example.test`}) returning id`;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${user!.id}, ${role})`;
	return user!.id;
}
const as = <T>(org: string, user: string | undefined, work: (tx: TransactionSql) => Promise<T>) =>
	withJournalledTenant(db.app, user ? { organisationId: org, userId: user } : { organisationId: org }, work);
async function topic(org: string, me: string, kind: 'topic' | 'private' = 'topic'): Promise<string> {
	const id = randomUUID();
	await as(org, me, async (tx) => {
		await tx`select 1 from memberships where organisation_id = ${org} and user_id = ${me} for share`;
		const [row] = await tx<{ result: string }[]>`select thread_create(${id}, ${kind}, 'Canning line', ${fp(id)}) as result`;
		assert.equal(row!.result, 'created');
	});
	return id;
}
async function sendIn(tx: TransactionSql, org: string, me: string, thread: string, body = 'Shall we book it?') {
	const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1,
		last_message_at = greatest(last_message_at, now()) where id = ${thread} returning last_seq, last_change`;
	if (!c) throw new Error('not visible');
	await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
		values (${randomUUID()}, ${org}, ${thread}, ${c.lastSeq}, ${c.lastChange}, ${me}, ${body}, ${fp(body)})`;
}
const threadsOf = async (column: 'task_id' | 'reservation_id' | 'stock_item_id', id: string) =>
	(await db.owner.unsafe(`select id, kind, created_by, last_message_at, revision from threads where ${column} = $1`, [id])) as { id: string; kind: string; createdBy: string | null; lastMessageAt: Date | null }[];

it('inserting a task, a booking and a stock item makes exactly one record thread each; a tag and a step make none; deleting the record deletes it', async () => {
	const org = await organisation();
	const alice = await person(org);
	const before = (await db.owner`select count(*)::int as n from threads where organisation_id = ${org}`)[0]!.n;
	const [task] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title, created_by) values (${org}, 'Order cans', ${alice}) returning id`);
	const [step] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, parent_id, title) values (${org}, ${task!.id}, 'Count pallets') returning id`);
	await as(org, alice, (tx) => tx`insert into tags (organisation_id, name) values (${org}, 'Packaging')`);
	const [equipment] = await fixture(db.owner, org)<{ id: string }[]>`insert into equipment (organisation_id, name) values (${org}, 'Canning line') returning id`;
	const [booking] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
		values (${randomUUID()}, ${org}, ${equipment!.id}, 'Run', '2031-01-01T00:00:00Z', '2031-01-01T02:00:00Z', '2031-01-01T00:00:00Z', '2031-01-01T02:00:00Z', ${alice}) returning id`);
	const [item] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into stock_items (organisation_id, name, location, unit_label) values (${org}, 'Cans', 'Store', 'cases') returning id`);
	for (const [column, id] of [['task_id', task!.id], ['reservation_id', booking!.id], ['stock_item_id', item!.id]] as const) {
		const rows = await threadsOf(column, id);
		assert.equal(rows.length, 1, column);
		assert.deepEqual([rows[0]!.kind, rows[0]!.createdBy], ['record', alice], column);
		// Each change set on its record is a line (0047): the creation, and for the task its step; no message.
		assert.deepEqual((await db.owner`select kind from thread_messages where thread_id = ${rows[0]!.id}`).map((m) => m.kind),
			column === 'task_id' ? ['change', 'change'] : ['change'], column);
	}
	assert.equal((await threadsOf('task_id', step!.id)).length, 0, 'a step is part of its task’s thread');
	assert.equal((await db.owner`select count(*)::int as n from threads where organisation_id = ${org}`)[0]!.n, before + 3, 'the tag made none');
	// The system routine (no person) makes record threads too, attributed to nobody.
	const [system] = await as(org, undefined, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Monthly excise') returning id`);
	assert.deepEqual((await threadsOf('task_id', system!.id)).map((t) => t.createdBy), [null]);
	// A record has at most one thread; a record thread names exactly one record; nobody makes one for an unseen record.
	await assert.rejects(as(org, alice, (tx) => tx`insert into threads (organisation_id, kind, task_id, created_by) values (${org}, 'record', ${task!.id}, ${alice})`),
		{ code: '23505', constraint_name: 'threads_task' });
	await assert.rejects(as(org, alice, (tx) => tx`insert into threads (organisation_id, kind, task_id, created_by) values (${org}, 'record', ${step!.id}, ${alice})`), RLS, 'no thread for a step');
	await assert.rejects(as(org, alice, (tx) => tx`insert into threads (organisation_id, kind, created_by) values (${org}, 'record', ${alice})`), /row-level security|threads_shape_check/);
	// A task's place is fixed: it cannot become a step, nor a step a task, since only one of them has a thread.
	const [other] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Loose') returning id`);
	await assert.rejects(as(org, alice, (tx) => tx`update tasks set parent_id = ${task!.id} where id = ${other!.id}`), /cannot become a step/);
	await assert.rejects(as(org, alice, (tx) => tx`update tasks set parent_id = null where id = ${step!.id}`), /cannot become a step/);
	const thread = (await threadsOf('task_id', task!.id))[0]!.id;
	await as(org, alice, (tx) => sendIn(tx, org, alice, thread));
	await fixture(db.owner, org)`delete from tasks where id = ${task!.id}`;
	assert.equal((await db.owner`select 1 from threads where id = ${thread}`).length, 0, 'deleting the record deletes its thread');
	assert.equal((await db.owner`select 1 from thread_messages where thread_id = ${thread}`).length, 0, 'and its messages');
	await fixture(db.owner, org)`delete from stock_items where id = ${item!.id}`;
	assert.equal((await threadsOf('stock_item_id', item!.id)).length, 0);
});

it('every active member sees and writes record and topic threads; a removed member and another tenant see nothing', async () => {
	const org = await organisation(), other = await organisation();
	const alice = await person(org), bob = await person(org), owner = await person(org, 'owner'), outsider = await person(other, 'owner');
	const [task] = await fixture(db.owner, org)<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Brew day') returning id`;
	const record = (await threadsOf('task_id', task!.id))[0]!.id;
	const talk = await topic(org, alice);
	const secret = await topic(org, alice, 'private');
	await as(org, bob, (tx) => sendIn(tx, org, bob, record, 'On it'));
	await as(org, bob, (tx) => sendIn(tx, org, bob, talk, 'Tuesday works'));
	assert.equal((await db.owner`select 1 from thread_participants where thread_id in ${db.owner([record, talk])}`).length, 0, 'record and topic threads have no participants');
	const seen = (user: string, organisationId = org) => as(organisationId, user, async (tx) => ({
		threads: (await tx<{ id: string }[]>`select id from threads where id in ${tx([record, talk, secret])} order by id`).map((r) => r.id),
		messages: (await tx`select 1 from thread_messages where kind = 'message' and thread_id in ${tx([record, talk, secret])}`).length,
	}));
	for (const user of [alice, bob, owner]) {
		const view = await seen(user);
		assert.deepEqual(view.threads, (user === alice ? [record, talk, secret] : [record, talk]).sort(), user);
		assert.equal(view.messages, 2, user);
	}
	assert.deepEqual(await seen(outsider, other), { threads: [], messages: 0 });
	assert.equal((await as(org, alice, (tx) => tx<{ ok: boolean }[]>`select thread_visible(${talk}) as ok`))[0]!.ok, true);
	await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${bob}`;
	assert.deepEqual(await seen(bob), { threads: [], messages: 0 }, 'a removed member sees no thread at all');
	await assert.rejects(as(org, bob, (tx) => sendIn(tx, org, bob, talk)), /not visible/);
	// No direct path to a topic: it starts empty from the bootstrap, as its creator, and never as another kind.
	await assert.rejects(as(org, alice, async (tx) => (await tx<{ result: string }[]>`select thread_create(${randomUUID()}, 'topic', ${' '}, ${fp('x')}) as result`)[0]), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`update threads set kind = 'private' where id = ${talk}`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`update threads set task_id = ${task!.id} where id = ${talk}`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`update threads set title = 'Renamed' where id = ${record}`), REFUSED, 'a record thread has no title of its own');
});

it('tags attach to any visible thread as the person attaching them, and only to record threads when no person acts', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org);
	const [tag] = await fixture(db.owner, org)<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Summer lager') returning id`;
	const [task] = await fixture(db.owner, org)<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Hop order') returning id`;
	const record = (await threadsOf('task_id', task!.id))[0]!.id;
	const talk = await topic(org, alice), secret = await topic(org, alice, 'private');
	const attach = (user: string | undefined, thread: string, by: string | null = user ?? null) => as(org, user, (tx) =>
		tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${thread}, ${tag!.id}, ${by})`);
	await attach(bob, record); await attach(bob, talk); await attach(alice, secret);
	await assert.rejects(attach(bob, secret), RLS, 'a non-participant cannot tag a private thread');
	await assert.rejects(attach(alice, record, bob), REFUSED, 'attached_by is the person attaching');
	await assert.rejects(as(org, alice, (tx) => tx`update thread_tags set attached_at = now() where thread_id = ${record}`), /permission denied/);
	// Bob can count the tag's threads only where he can see them: the private thread is never counted or named.
	assert.equal((await as(org, bob, (tx) => tx`select 1 from thread_tags where tag_id = ${tag!.id}`)).length, 2);
	assert.equal((await as(org, alice, (tx) => tx`select 1 from thread_tags where tag_id = ${tag!.id}`)).length, 3);
	// The system routine reads and tags record threads, and nothing else: no topic, private thread or message.
	const [other] = await fixture(db.owner, org)<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Excise') returning id`;
	await as(org, undefined, (tx) => tx`insert into thread_tags (organisation_id, thread_id, tag_id) values (${org}, ${record}, ${other!.id})`);
	await assert.rejects(as(org, undefined, (tx) => tx`insert into thread_tags (organisation_id, thread_id, tag_id) values (${org}, ${talk}, ${other!.id})`), RLS);
	const system = await as(org, undefined, async (tx) => ({
		threads: (await tx<{ kind: string }[]>`select kind from threads`).map((r) => r.kind),
		messages: (await tx`select 1 from thread_messages`).length,
		audit: (await tx`select 1 from chat_audit_events`).length,
	}));
	assert.deepEqual(system, { threads: ['record'], messages: 0, audit: 0 });
	// Archiving keeps attachments; deleting a tag removes them; removal is a delete by someone who sees the thread.
	await fixture(db.owner, org)`update tags set archived_at = now() where id = ${tag!.id}`;
	assert.equal((await db.owner`select 1 from thread_tags where tag_id = ${tag!.id}`).length, 3);
	assert.equal((await as(org, bob, (tx) => tx`delete from thread_tags where thread_id = ${secret} returning 1`)).length, 0);
	assert.equal((await as(org, bob, (tx) => tx`delete from thread_tags where thread_id = ${talk} and tag_id = ${tag!.id} returning 1`)).length, 1);
	await fixture(db.owner, org)`delete from tags where id = ${tag!.id}`;
	assert.equal((await db.owner`select 1 from thread_tags where tag_id = ${tag!.id}`).length, 0);
});

it('tags carry an optional owner and dates, independently; the end cannot precede the start; every edit is a revision', async () => {
	const org = await organisation();
	const alice = await person(org);
	const insert = (values: { owner?: string | null; starts?: string | null; ends?: string | null }) => as(org, alice, (tx) => tx<{ id: string; revision: number }[]>`
		insert into tags (organisation_id, name, owner_id, starts_on, ends_on, created_by)
		values (${org}, ${randomUUID().slice(0, 8)}, ${values.owner ?? null}, ${values.starts ?? null}::date, ${values.ends ?? null}::date, ${alice}) returning id, revision`);
	await insert({}); await insert({ owner: alice }); await insert({ starts: '2027-01-01' }); await insert({ ends: '2027-02-01' });
	const [both] = await insert({ owner: alice, starts: '2027-01-01', ends: '2027-01-01' });
	await assert.rejects(insert({ starts: '2027-02-01', ends: '2027-01-01' }), { code: '23514', constraint_name: 'tags_dates_check' });
	await assert.rejects(insert({ owner: randomUUID() }), /foreign key/, 'the owner is a member');
	await as(org, alice, (tx) => tx`update tags set name = 'Renamed', revision = 99 where id = ${both!.id}`);
	assert.equal((await db.owner`select revision from tags where id = ${both!.id}`)[0]!.revision, 2);
	// Series tags are tenant-wide work data, like the series.
	const [series] = await fixture(db.owner, org)<{ id: string }[]>`insert into task_series (organisation_id, title, recurrence, anchor) values (${org}, 'Excise', 'monthly', '2026-01-01') returning id`;
	await as(org, undefined, (tx) => tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${org}, ${series!.id}, ${both!.id})`);
	const other = await organisation();
	assert.equal((await as(other, undefined, (tx) => tx`select 1 from task_series_tags`)).length, 0);
});
