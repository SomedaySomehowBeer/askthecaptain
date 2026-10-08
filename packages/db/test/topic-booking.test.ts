import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { withChangeSet } from '../src/versions.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0049 (bookings contract §2; versions contract §6; D29), by direct SQL as the runtime role: a topic becomes a
// booking's thread only through thread_make_booking, once, never a private thread, never with a second thread, and the
// overlap constraint and archived equipment refuse it as they refuse any booking.
const it = databaseUrl ? test : test.skip;
let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(): Promise<{ org: string; user: string; other: string; kettle: string }> {
	const [org] = await db.owner<{ id: string }[]>`insert into organisations (name) values ('Topic booking test') returning id`;
	const ids: string[] = [];
	for (const role of ['owner', 'member']) {
		const [user] = await db.owner<{ id: string }[]>`insert into users (email, name) values (${`${randomUUID()}@example.test`}, ${role}) returning id`;
		await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, ${role})`;
		ids.push(user!.id);
	}
	const [kettle] = await as(org!.id, ids[0]!, (tx) => tx<{ id: string }[]>`insert into equipment (organisation_id, name) values (${org!.id}, 'Kettle') returning id`);
	return { org: org!.id, user: ids[0]!, other: ids[1]!, kettle: kettle!.id };
}
const as = <T>(org: string, user: string, work: (tx: TransactionSql) => Promise<T>) =>
	withChangeSet(db.app, { organisationId: org, userId: user }, { actorKind: 'person', causeKind: 'request', causeId: randomUUID() }, (tx) => work(tx));
const make = (tx: TransactionSql, thread: string, equipment: string, starts: string, ends: string, revision: number, owner: string | null = null, setup = 0, cleanup = 0) =>
	tx<{ booking: string }[]>`select thread_make_booking(${thread}::uuid, ${equipment}::uuid, ${starts}::timestamptz, ${ends}::timestamptz, ${setup}::integer, ${cleanup}::integer,
		${owner}::uuid, ${revision}::integer) as booking`;

it('a topic becomes a booking’s thread only through thread_make_booking: once, never a private thread, never a second thread', async () => {
	const { org, user, other, kettle } = await organisation();
	const fingerprint = createHash('sha256').update('topic').digest();
	const topic = randomUUID(), secret = randomUUID();
	await withTenant(db.app, { organisationId: org, userId: user }, async (tx) => {
		await tx`select thread_create(${topic}::uuid, 'topic', 'Brew the autumn lager', ${fingerprint}::bytea)`;
		await tx`select thread_create(${secret}::uuid, 'private', 'Margins', ${fingerprint}::bytea)`;
	});
	// No direct path: the runtime cannot turn a topic into a booking's thread, even naming one it inserted with the setting.
	await assert.rejects(as(org, user, async (tx) => {
		const id = randomUUID();
		await tx`select set_config('app.topic_booking_id', ${id}, true)`;
		await tx`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
			values (${id}, ${org}, ${kettle}, 'Sneaky', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', ${user})`;
		await tx`update threads set kind = 'record', reservation_id = ${id}, title = null, create_fingerprint = null, revision = revision + 1 where id = ${topic}`;
	}), /thread_make_booking|keeps its identity|threads_reservation|duplicate|check constraint/);
	const id = randomUUID();
	await as(org, user, async (tx) => {
		await tx`select set_config('app.topic_booking_id', ${id}, true)`;
		await tx`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
			values (${id}, ${org}, ${kettle}, 'Still threaded', '2031-01-02T00:00:00Z', '2031-01-02T01:00:00Z', '2031-01-02T00:00:00Z', '2031-01-02T01:00:00Z', ${user})`;
	});
	assert.equal((await db.owner`select count(*)::int as n from threads where reservation_id = ${id}`)[0]!.n, 1, 'the setting alone skips nothing');
	// The task setting does not open the booking path, nor the booking setting the task path.
	await assert.rejects(as(org, user, async (tx) => {
		const [task] = await tx<{ id: string }[]>`insert into tasks (organisation_id, title, created_by) values (${org}, 'Sneaky', ${user}) returning id`;
		await tx`select set_config('app.topic_booking_id', ${task!.id}, true)`;
		await tx`update threads set kind = 'record', task_id = ${task!.id}, title = null, create_fingerprint = null, revision = revision + 1 where id = ${topic}`;
	}), /thread_make_task|keeps its identity|threads_task|duplicate|check constraint/);
	// Refused without a change set, for a private thread, for a stranger, at a stale revision, for an inactive owner.
	await assert.rejects(withTenant(db.app, { organisationId: org, userId: user }, (tx) => make(tx, topic, kettle, '2031-02-01T00:00:00Z', '2031-02-01T01:00:00Z', 1)), /needs a change set/);
	await assert.rejects(as(org, user, (tx) => make(tx, secret, kettle, '2031-02-01T00:00:00Z', '2031-02-01T01:00:00Z', 1)), /only a topic thread/);
	await assert.rejects(as(org, other, (tx) => make(tx, secret, kettle, '2031-02-01T00:00:00Z', '2031-02-01T01:00:00Z', 1)), /not available/);
	await assert.rejects(as(org, user, (tx) => make(tx, topic, kettle, '2031-02-01T00:00:00Z', '2031-02-01T01:00:00Z', 7)), /changed since/);
	await assert.rejects(as(org, user, (tx) => make(tx, topic, kettle, '2031-02-01T00:00:00Z', '2031-02-01T01:00:00Z', 1, randomUUID())), /owner is an active member/);
	await assert.rejects(as(org, user, (tx) => make(tx, topic, randomUUID(), '2031-02-01T00:00:00Z', '2031-02-01T01:00:00Z', 1)), /equipment is not available/);
	// The table's own checks hold: the end after the start.
	await assert.rejects(as(org, user, (tx) => make(tx, topic, kettle, '2031-02-01T01:00:00Z', '2031-02-01T01:00:00Z', 1)), /check constraint/);
	// The overlap constraint is the authority, setup and cleanup included; nothing of the attempt stays.
	await assert.rejects(as(org, user, (tx) => make(tx, topic, kettle, '2031-01-02T01:30:00Z', '2031-01-02T03:00:00Z', 1, null, 45)), /equipment_reservations_no_overlap/);
	assert.equal((await db.owner`select kind from threads where id = ${topic}`)[0]!.kind, 'topic');
	const threads = (await db.owner`select count(*)::int as n from threads where organisation_id = ${org}`)[0]!.n;
	const [made] = await as(org, other, (tx) => make(tx, topic, kettle, '2031-01-02T01:30:00Z', '2031-01-02T03:00:00Z', 1, user, 30, 15));
	const [thread] = await db.owner<{ kind: string; reservationId: string; title: string | null; createFingerprint: Buffer | null; revision: number; createdBy: string }[]>`select kind,
		reservation_id, title, create_fingerprint, revision, created_by from threads where id = ${topic}`;
	assert.deepEqual([thread!.kind, thread!.reservationId, thread!.title, thread!.createFingerprint, thread!.revision, thread!.createdBy], ['record', made!.booking, null, null, 2, user]);
	assert.equal((await db.owner`select count(*)::int as n from threads where organisation_id = ${org}`)[0]!.n, threads, 'no second thread');
	const [booking] = await db.owner<{ title: string; ownerId: string; createdBy: string; setupMinutes: number; cleanupMinutes: number; occupied: string }[]>`select title, owner_id,
		created_by, setup_minutes, cleanup_minutes, to_char(occupied_starts_at at time zone 'UTC', 'HH24:MI') || '-' || to_char(occupied_ends_at at time zone 'UTC', 'HH24:MI') as occupied
		from equipment_reservations where id = ${made!.booking}`;
	assert.deepEqual(booking, { title: 'Brew the autumn lager', ownerId: user, createdBy: other, setupMinutes: 30, cleanupMinutes: 15, occupied: '01:00-03:15' });
	const journal = await db.owner<{ operation: string; recordKind: string }[]>`select operation, record_kind from record_changes where record_id = ${made!.booking}`;
	assert.deepEqual(journal.map((c) => `${c.recordKind}:${c.operation}`), ['reservation:create']);
	assert.equal((await db.owner`select count(*)::int as n from thread_messages where thread_id = ${topic} and kind = 'change'`)[0]!.n, 1, 'its creation is a change line in the thread');
	await assert.rejects(as(org, user, (tx) => make(tx, topic, kettle, '2031-03-01T00:00:00Z', '2031-03-01T01:00:00Z', 2)), /only a topic thread/, 'only once');
	await assert.rejects(as(org, user, (tx) => tx`select thread_make_task(${topic}::uuid, null, null, 2)`), /only a topic thread/, 'nor a task afterwards');
	// Archived equipment takes no booking this way either.
	const later = randomUUID();
	await withTenant(db.app, { organisationId: org, userId: user }, (tx) => tx`select thread_create(${later}::uuid, 'topic', 'Clean the kettle', ${fingerprint}::bytea)`);
	const [shelf] = await as(org, user, (tx) => tx<{ id: string }[]>`insert into equipment (organisation_id, name, archived_at) values (${org}, 'Old kettle', now()) returning id`);
	await assert.rejects(as(org, user, (tx) => make(tx, later, shelf!.id, '2031-03-01T00:00:00Z', '2031-03-01T01:00:00Z', 1)), /archived equipment/);
	const fns = await db.owner<{ name: string; runtime: boolean; legacy: boolean; definer: boolean; config: string[] | null }[]>`select p.proname as name,
		has_function_privilege('captain_runtime', p.oid, 'EXECUTE') as runtime, has_function_privilege('app', p.oid, 'EXECUTE') as legacy, p.prosecdef as definer, p.proconfig as config
		from pg_proc p where p.proname in ('thread_make_booking', 'thread_make_task', 'thread_for_record', 'thread_guard') order by 1`;
	assert.deepEqual(fns.map((f) => [f.name, f.runtime, f.legacy, f.definer]),
		[['thread_for_record', false, false, false], ['thread_guard', false, false, false], ['thread_make_booking', true, true, true], ['thread_make_task', true, true, true]]);
	assert.ok(fns.every((f) => (f.config ?? []).includes('search_path=pg_catalog, public, pg_temp')));
});
