import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { withChangeSet, type CauseKind } from '../src/versions.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0048 (versions contract §4, §6; D29), by direct SQL as the runtime role: a reversal's changes are linked to
// the changes they reverse, and only those; a topic becomes a task's thread only through thread_make_task.
const it = databaseUrl ? test : test.skip;
let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(): Promise<{ org: string; user: string; other: string }> {
	const [org] = await db.owner<{ id: string }[]>`insert into organisations (name) values ('Reversals test') returning id`;
	const ids: string[] = [];
	for (const role of ['owner', 'member']) {
		const [user] = await db.owner<{ id: string }[]>`insert into users (email, name) values (${`${randomUUID()}@example.test`}, ${role}) returning id`;
		await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, ${role})`;
		ids.push(user!.id);
	}
	return { org: org!.id, user: ids[0]!, other: ids[1]! };
}
const as = <T>(org: string, user: string, causeKind: CauseKind, work: (tx: TransactionSql) => Promise<T>) =>
	withChangeSet(db.app, { organisationId: org, userId: user }, { actorKind: 'person', causeKind, causeId: randomUUID() }, (tx) => work(tx));
const changes = (recordId: string) => db.owner<{ id: string; changeSetId: string; field: string | null; reversesChangeId: string | null }[]>`select id, change_set_id, field,
	reverses_change_id from record_changes where record_id = ${recordId} order by id`;
const link = (tx: TransactionSql, links: Record<string, string>) => tx`select set_config('app.reverses', ${JSON.stringify(links)}, true)`;

it('a reversal links each change to the change it reverses; it cannot write an unnamed or mismatched change; nothing else links', async () => {
	const { org, user } = await organisation();
	const [task] = await as(org, user, 'request', (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title, due, created_by) values (${org}, 'Brew', '2031-01-01', ${user}) returning id`);
	await as(org, user, 'request', (tx) => tx`update tasks set due = '2031-01-05', title = 'Brew 42' where id = ${task!.id}`);
	const [due, title] = (await changes(task!.id)).filter((c) => c.field).sort((a, b) => a.field!.localeCompare(b.field!));
	const key = (field: string) => `task:${task!.id}:::${field}`;
	// An ordinary write ignores the setting: it reverses nothing.
	await as(org, user, 'request', async (tx) => { await link(tx, { [key('body')]: due!.id }); await tx`update tasks set body = 'notes' where id = ${task!.id}`; });
	assert.equal((await changes(task!.id)).at(-1)!.reversesChangeId, null);
	// A reversal must name every change it writes, against the same field.
	await assert.rejects(as(org, user, 'reversal', (tx) => tx`update tasks set due = '2031-01-01' where id = ${task!.id}`), /writes only the changes it names/);
	await assert.rejects(as(org, user, 'reversal', async (tx) => { await link(tx, { [key('due')]: title!.id }); await tx`update tasks set due = '2031-01-01' where id = ${task!.id}`; }),
		/earlier change of the same field or item/);
	await assert.rejects(as(org, user, 'reversal', async (tx) => { await link(tx, { [key('due')]: due!.id }); await tx`update tasks set due = '2031-01-01', title = 'Brew' where id = ${task!.id}`; }),
		/writes only the changes it names/, 'one unnamed change refuses the whole reversal');
	assert.equal((await db.owner`select due::text from tasks where id = ${task!.id}`)[0]!.due, '2031-01-05');
	await as(org, user, 'reversal', async (tx) => { await link(tx, { [key('due')]: due!.id }); await tx`update tasks set due = '2031-01-01' where id = ${task!.id}`; });
	const last = (await changes(task!.id)).at(-1)!;
	assert.deepEqual([last.field, last.reversesChangeId], ['due', due!.id]);
	// The runtime can neither write the journal nor change a link.
	await assert.rejects(withTenant(db.app, { organisationId: org, userId: user }, (tx) => tx`update record_changes set reverses_change_id = null where id = ${last.id}`), /permission denied/);
});

it('a topic becomes a task’s thread only through thread_make_task: once, never a private thread, never a second thread', async () => {
	const { org, user, other } = await organisation();
	const fingerprint = createHash('sha256').update('topic').digest();
	const topic = randomUUID(), secret = randomUUID();
	await withTenant(db.app, { organisationId: org, userId: user }, async (tx) => {
		await tx`select thread_create(${topic}::uuid, 'topic', 'Order pallet wrap', ${fingerprint}::bytea)`;
		await tx`select thread_create(${secret}::uuid, 'private', 'Margins', ${fingerprint}::bytea)`;
	});
	// No direct path: the runtime cannot change a thread's kind, even naming a task it inserted with the internal setting.
	await assert.rejects(as(org, user, 'request', async (tx) => {
		const [task] = await tx<{ id: string }[]>`insert into tasks (organisation_id, title, created_by) values (${org}, 'Sneaky', ${user}) returning id`;
		await tx`update threads set kind = 'record', task_id = ${task!.id}, title = null, create_fingerprint = null, revision = revision + 1 where id = ${topic}`;
	}), /check constraint|thread_make_task|keeps its identity|threads_task|duplicate/);
	const id = randomUUID();
	await as(org, user, 'request', async (tx) => {
		await tx`select set_config('app.topic_task_id', ${id}, true)`;
		await tx`insert into tasks (id, organisation_id, title, created_by) values (${id}, ${org}, 'Still threaded', ${user})`;
	});
	assert.equal((await db.owner`select count(*)::int as n from threads where task_id = ${id}`)[0]!.n, 1, 'the setting alone skips nothing');
	// Refused without a change set (the task insert is journalled), for a private thread, at a stale revision, for a stranger.
	await assert.rejects(withTenant(db.app, { organisationId: org, userId: user }, (tx) => tx`select thread_make_task(${topic}::uuid, null, null, 1)`), /needs a change set/);
	await assert.rejects(as(org, user, 'request', (tx) => tx`select thread_make_task(${secret}::uuid, null, null, 1)`), /only a topic thread/);
	await assert.rejects(as(org, other, 'request', (tx) => tx`select thread_make_task(${secret}::uuid, null, null, 1)`), /not available/);
	await assert.rejects(as(org, user, 'request', (tx) => tx`select thread_make_task(${topic}::uuid, null, null, 7)`), /changed since/);
	const threads = (await db.owner`select count(*)::int as n from threads where organisation_id = ${org}`)[0]!.n;
	const [made] = await as(org, other, 'request', (tx) => tx<{ task: string }[]>`select thread_make_task(${topic}::uuid, ${user}::uuid, '2031-10-05'::date, 1) as task`);
	const [thread] = await db.owner<{ kind: string; taskId: string; title: string | null; createFingerprint: Buffer | null; revision: number; createdBy: string }[]>`select kind, task_id,
		title, create_fingerprint, revision, created_by from threads where id = ${topic}`;
	assert.deepEqual([thread!.kind, thread!.taskId, thread!.title, thread!.createFingerprint, thread!.revision, thread!.createdBy], ['record', made!.task, null, null, 2, user]);
	assert.equal((await db.owner`select count(*)::int as n from threads where organisation_id = ${org}`)[0]!.n, threads, 'no second thread');
	const [task] = await db.owner<{ title: string; ownerId: string; due: string; createdBy: string }[]>`select title, owner_id, due::text, created_by from tasks where id = ${made!.task}`;
	assert.deepEqual(task, { title: 'Order pallet wrap', ownerId: user, due: '2031-10-05', createdBy: other });
	const journal = await db.owner<{ operation: string; recordKind: string }[]>`select operation, record_kind from record_changes where record_id = ${made!.task}`;
	assert.deepEqual(journal.map((c) => `${c.recordKind}:${c.operation}`), ['task:create']);
	assert.equal((await db.owner`select count(*)::int as n from thread_messages where thread_id = ${topic} and kind = 'change'`)[0]!.n, 1, 'its creation is a change line in the thread');
	await assert.rejects(as(org, user, 'request', (tx) => tx`select thread_make_task(${topic}::uuid, null, null, 2)`), /only a topic thread/, 'only once');
	const fns = await db.owner<{ name: string; runtime: boolean; legacy: boolean; definer: boolean }[]>`select p.proname as name, has_function_privilege('captain_runtime', p.oid, 'EXECUTE') as runtime,
		has_function_privilege('app', p.oid, 'EXECUTE') as legacy, p.prosecdef as definer from pg_proc p where p.proname in ('thread_make_task', 'record_changes_reverses') order by 1`;
	assert.deepEqual(fns.map((f) => [f.name, f.runtime, f.legacy, f.definer]), [['record_changes_reverses', false, false, false], ['thread_make_task', true, true, true]]);
});
