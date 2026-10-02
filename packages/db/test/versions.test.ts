import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Sql, TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { applyMigrations } from '../src/migrate.ts';
import { ChangeSetUnavailable, fingerprintOf, journalFields, journalled, journalledTables, openChangeSet, withChangeSet } from '../src/versions.ts';
import { databaseUrl, fixture, freshDatabase, type Harness } from './harness.ts';

// Migration 0047 (versions contract §2, §3; D29): the database writes the change journal. Proven here by direct SQL as the
// runtime role (`captain_runtime`), bypassing every service; the API's write paths are proven in apps/api.
const it = databaseUrl ? test : test.skip;
const before0047 = '0046_threads.sql';
const migration = '0047_versions.sql';
const fp = (value: string) => createHash('sha256').update(value).digest();
let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(owner: Sql = db.owner): Promise<string> {
	return (await owner<{ id: string }[]>`insert into organisations (name) values ('Versions test') returning id`)[0]!.id;
}
async function person(org: string, role = 'member', owner: Sql = db.owner): Promise<string> {
	const [user] = await owner<{ id: string }[]>`insert into users (email, name) values (${`${randomUUID()}@example.test`}, ${`Person ${role}`}) returning id`;
	await owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${user!.id}, ${role})`;
	return user!.id;
}
/** One person's change set and work, as the API would do it. */
const as = <T>(org: string, user: string | undefined, work: (tx: TransactionSql) => Promise<T>) =>
	withChangeSet(db.app, user ? { organisationId: org, userId: user } : { organisationId: org },
		{ actorKind: user ? 'person' : 'system', causeKind: user ? 'request' : 'routine', causeId: user ? randomUUID() : 'test' }, (tx) => work(tx));
/** The runtime role with no change set. */
const bare = <T>(org: string, user: string | undefined, work: (tx: TransactionSql) => Promise<T>) =>
	withTenant(db.app, user ? { organisationId: org, userId: user } : { organisationId: org }, work);
const threadOf = async (column: 'task_id' | 'reservation_id' | 'stock_item_id', id: string) =>
	(await db.owner<{ id: string }[]>`select id from threads where ${db.owner(column)} = ${id}`)[0]!.id;
const changes = (recordId: string) => db.owner<{ changeSetId: string; operation: string; field: string | null; itemKind: string | null; itemId: string | null;
	before: unknown; after: unknown; baseRevision: number | null; resultRevision: number }[]>`select change_set_id, operation, field, item_kind, item_id, before, after,
	base_revision, result_revision from record_changes where record_id = ${recordId} order by id`;
const versions = (recordId: string) => db.owner<{ changeSetId: string; revision: number; snapshot: Record<string, any> }[]>`select change_set_id, revision, snapshot
	from record_versions where record_id = ${recordId} order by id`;
const lines = (threadId: string) => db.owner<{ kind: string; changeSetId: string | null; authorId: string | null; seq: number }[]>`select kind, change_set_id, author_id, seq
	from thread_messages where thread_id = ${threadId} order by seq`;
const NO_CHANGE_SET = /needs a change set/;

it('journal_fields() and the TypeScript mirror name the same fields for the same tables', async () => {
	const [row] = await db.owner<{ fields: Record<string, string[]> }[]>`select journal_fields() as fields`;
	// The connection's camel transform rewrites JSON keys; compare against the raw text.
	const [raw] = await db.owner<{ text: string }[]>`select journal_fields()::text as text`;
	assert.deepEqual(JSON.parse(raw!.text), journalFields);
	assert.deepEqual(Object.keys(row!.fields).length, journalledTables.length);
	const triggers = await db.owner<{ table: string; name: string }[]>`select c.relname as table, t.tgname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid
		where not t.tgisinternal and t.tgname like '%journal%' order by 1, 2`;
	for (const table of journalledTables) {
		assert.deepEqual(triggers.filter((t) => t.table === table).map((t) => t.name), [`${table}_journal`, `${table}_journal_guard`], table);
	}
	// Every compared field is a column of its table.
	for (const [table, fields] of Object.entries(journalFields)) {
		const columns = (await db.owner<{ name: string }[]>`select column_name as name from information_schema.columns where table_name = ${table}`).map((c) => c.name);
		for (const field of fields) assert.ok(columns.includes(field), `${table}.${field}`);
	}
});

it('a write with no change set is refused for every journalled table, and the change set must be this transaction’s', async () => {
	const org = await organisation(), alice = await person(org);
	const [tag] = await fixture(db.owner, org)<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Brewing') returning id`;
	const [task] = await fixture(db.owner, org)<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Brew') returning id`;
	const [series] = await fixture(db.owner, org)<{ id: string }[]>`insert into task_series (organisation_id, title, recurrence, anchor) values (${org}, 'Excise', 'monthly', '2026-01-01') returning id`;
	const [kettle] = await fixture(db.owner, org)<{ id: string }[]>`insert into equipment (organisation_id, name) values (${org}, 'Kettle') returning id`;
	const thread = await threadOf('task_id', task!.id);
	const writes: [string, (tx: TransactionSql) => Promise<unknown>][] = [
		['tasks', (tx) => tx`insert into tasks (organisation_id, title) values (${org}, 'Unjournalled')`],
		['tasks', (tx) => tx`update tasks set title = 'Renamed' where id = ${task!.id}`],
		['tasks', (tx) => tx`update tasks set updated_at = now() where id = ${task!.id}`],
		['task_series', (tx) => tx`insert into task_series (organisation_id, title, recurrence, anchor) values (${org}, 'More', 'monthly', '2026-01-01')`],
		['evidence', (tx) => tx`insert into evidence (organisation_id, task_id, kind, reference) values (${org}, ${task!.id}, 'url', 'https://example.test')`],
		['equipment', (tx) => tx`update equipment set name = 'Copper' where id = ${kettle!.id}`],
		['equipment_reservations', (tx) => tx`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
			values (${randomUUID()}, ${org}, ${kettle!.id}, 'Boil', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', ${alice})`],
		['stock_items', (tx) => tx`insert into stock_items (organisation_id, name, location, unit_label) values (${org}, 'Malt', 'Store', 'kg')`],
		['tags', (tx) => tx`insert into tags (organisation_id, name) values (${org}, 'Unjournalled')`],
		['thread_tags', (tx) => tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${thread}, ${tag!.id}, ${alice})`],
		['task_series_tags', (tx) => tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${org}, ${series!.id}, ${tag!.id})`],
	];
	for (const [table, write] of writes) await assert.rejects(bare(org, alice, write), NO_CHANGE_SET, table);
	assert.deepEqual(new Set(writes.map(([table]) => table)), new Set(journalledTables));
	// The owner is refused too: the rule is the database's, not the runtime role's.
	await assert.rejects(db.owner`delete from tags where id = ${tag!.id}`, NO_CHANGE_SET);
	// A change set from an earlier transaction, or another organisation's, cannot be named.
	const earlier = await as(org, alice, (tx) => tx<{ id: string }[]>`select current_setting('app.change_set_id') as id`);
	await assert.rejects(bare(org, alice, async (tx) => {
		await tx`select set_config('app.change_set_id', ${earlier[0]!.id}, true)`;
		await tx`update tasks set title = 'Borrowed' where id = ${task!.id}`;
	}), /must name the change set this transaction opened/);
	// One change set per organisation per transaction.
	await assert.rejects(as(org, alice, (tx) => openChangeSet(tx, { actorKind: 'person', causeKind: 'request' })), /change_sets_one_per_transaction/);
	assert.equal((await db.owner`select title from tasks where id = ${task!.id}`)[0]!.title, 'Brew', 'nothing was written');
});

it('creation, field updates, step and evidence add/remove and tag attach/detach are typed changes with one version per record per change set', async () => {
	const org = await organisation(), alice = await person(org);
	const [tag] = await fixture(db.owner, org)<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Packaging') returning id`;
	const [task] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title, due, created_by) values (${org}, 'Order cans', '2031-05-01', ${alice}) returning id`);
	const id = task!.id, thread = await threadOf('task_id', id);
	let journal = await changes(id);
	assert.deepEqual(journal.map((c) => [c.operation, c.field, c.itemKind, c.before, c.baseRevision, c.resultRevision]), [['create', null, null, null, null, 1]]);
	assert.equal((journal[0]!.after as Record<string, unknown>).title, 'Order cans', 'a creation carries the full row');
	assert.equal((journal[0]!.after as Record<string, unknown>).due, '2031-05-01');
	// One change set: a step, evidence on the task, a tag on its thread and two field edits, in several statements.
	const [step, evidence] = await as(org, alice, async (tx) => {
		const [s] = await tx<{ id: string }[]>`insert into tasks (organisation_id, parent_id, title) values (${org}, ${id}, 'Count pallets') returning id`;
		const [e] = await tx<{ id: string }[]>`insert into evidence (organisation_id, task_id, kind, reference, attached_by) values (${org}, ${id}, 'url', 'https://example.test/quote', ${alice}) returning id`;
		await tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${thread}, ${tag!.id}, ${alice})`;
		await tx`update tasks set title = 'Order 500 cans', owner_id = ${alice} where id = ${id}`;
		await tx`update tasks set updated_at = now() where id = ${id}`; // a revision touch: bookkeeping
		return [s!.id, e!.id];
	});
	journal = await changes(id);
	const set = journal.slice(1);
	assert.deepEqual(set.map((c) => [c.operation, c.field, c.itemKind, c.itemId]).sort(), [
		['attach', null, 'tag', tag!.id], ['create', null, 'evidence', evidence], ['create', null, 'step', step],
		['update', 'owner_id', null, null], ['update', 'title', null, null]].sort());
	assert.ok(set.every((c) => c.changeSetId === set[0]!.changeSetId), 'one change set');
	assert.ok(set.every((c) => c.baseRevision === 1 && c.resultRevision === 3), 'revisions are the record’s before and after the change set');
	assert.deepEqual(set.filter((c) => c.field === 'title').map((c) => [c.before, c.after]), [['Order cans', 'Order 500 cans']]);
	assert.deepEqual(set.filter((c) => c.field === 'owner_id').map((c) => [c.before, c.after]), [[null, alice]]);
	let versionRows = await versions(id);
	assert.deepEqual(versionRows.map((v) => v.revision), [1, 3], 'exactly one version per record per change set');
	const snapshot = versionRows[1]!.snapshot;
	assert.equal(snapshot.row.title, 'Order 500 cans');
	assert.deepEqual(snapshot.steps.map((s: { id: string }) => s.id), [step]);
	assert.deepEqual(snapshot.evidence.map((e: { id: string }) => e.id), [evidence]);
	assert.deepEqual(snapshot.tags, [tag!.id]);
	assert.deepEqual((await lines(thread)).map((m) => [m.kind, m.changeSetId, m.authorId]),
		[['change', journal[0]!.changeSetId, alice], ['change', set[0]!.changeSetId, alice]], 'one change line per change set in the task’s thread');
	// Removing: the step and evidence go with their full rows, the tag is detached.
	await as(org, alice, async (tx) => {
		await tx`delete from tasks where id = ${step}`;
		await tx`delete from evidence where id = ${evidence}`;
		await tx`delete from thread_tags where thread_id = ${thread} and tag_id = ${tag!.id}`;
		await tx`update tasks set updated_at = now() where id = ${id}`;
	});
	const removed = (await changes(id)).slice(journal.length);
	assert.deepEqual(removed.map((c) => [c.operation, c.itemKind]).sort(), [['detach', 'tag'], ['remove', 'evidence'], ['remove', 'step']]);
	assert.equal((removed.find((c) => c.itemKind === 'step')!.before as Record<string, unknown>).title, 'Count pallets', 'a removed item’s before is its full row');
	assert.ok(removed.every((c) => c.after === null));
	versionRows = await versions(id);
	assert.deepEqual(versionRows.at(-1)!.snapshot.steps, []);
	// Bookkeeping only: no change, no version, no line.
	const before = { changes: (await changes(id)).length, versions: (await versions(id)).length, lines: (await lines(thread)).length };
	await as(org, alice, (tx) => tx`update tasks set updated_at = now(), revision = 99 where id = ${id}`);
	await as(org, alice, (tx) => tx`update tasks set title = title, due = due where id = ${id}`);
	assert.deepEqual({ changes: (await changes(id)).length, versions: (await versions(id)).length, lines: (await lines(thread)).length }, before);
});

it('bookings, stock counts, series tags, equipment and tags are journalled; only records with threads get change lines', async () => {
	const org = await organisation(), alice = await person(org);
	const { kettle, booking, item, series, tag } = await as(org, alice, async (tx) => {
		const [k] = await tx<{ id: string }[]>`insert into equipment (organisation_id, name) values (${org}, 'Kettle') returning id`;
		const [b] = await tx<{ id: string }[]>`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
			values (${randomUUID()}, ${org}, ${k!.id}, 'Boil', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', ${alice}) returning id`;
		const [i] = await tx<{ id: string }[]>`insert into stock_items (organisation_id, name, location, unit_label) values (${org}, 'Malt', 'Store', 'kg') returning id`;
		const [s] = await tx<{ id: string }[]>`insert into task_series (organisation_id, title, recurrence, anchor) values (${org}, 'Excise', 'monthly', '2026-01-01') returning id`;
		const [t] = await tx<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Tax') returning id`;
		await tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${org}, ${s!.id}, ${t!.id})`;
		return { kettle: k!.id, booking: b!.id, item: i!.id, series: s!.id, tag: t!.id };
	});
	const [created] = await db.owner<{ changeSetId: string }[]>`select change_set_id from record_changes where record_id = ${booking}`;
	const linesOf = await db.owner<{ threadId: string }[]>`select thread_id from thread_messages where change_set_id = ${created!.changeSetId} order by thread_id`;
	assert.deepEqual(linesOf.map((l) => l.threadId).sort(), [await threadOf('reservation_id', booking), await threadOf('stock_item_id', item)].sort(),
		'one line in each affected thread, and none for equipment, series or tag');
	assert.deepEqual((await versions(series))[0]!.snapshot.tags, [tag]);
	assert.deepEqual((await changes(series)).map((c) => [c.operation, c.itemKind]), [['create', null], ['attach', 'tag']]);
	// A booking change: the moved fields, not the derived occupancy.
	await as(org, alice, (tx) => tx`update equipment_reservations set starts_at = '2031-01-01T02:00:00Z', ends_at = '2031-01-01T03:00:00Z',
		occupied_starts_at = '2031-01-01T02:00:00Z', occupied_ends_at = '2031-01-01T03:00:00Z', revision = revision + 1 where id = ${booking}`);
	const moved = (await changes(booking)).filter((c) => c.operation === 'update');
	assert.deepEqual(moved.map((c) => c.field).sort(), ['ends_at', 'starts_at']);
	assert.deepEqual(moved.find((c) => c.field === 'starts_at')!.after, '2031-01-01T02:00:00+00:00', 'timestamps are typed, in UTC');
	// A stock count, exactly as a decimal string, with when and by whom; the item now has a revision.
	await as(org, alice, async (tx) => {
		const [count] = await tx<{ id: string }[]>`insert into stock_counts (organisation_id, item_id, counted_by, count) values (${org}, ${item}, ${alice}, 12.50) returning id`;
		await tx`update stock_items s set current_count = c.count, counted_at = c.counted_at, counted_by = c.counted_by from stock_counts c where s.id = ${item} and c.id = ${count!.id}`;
	});
	const counted = (await changes(item)).filter((c) => c.operation === 'update');
	assert.deepEqual(counted.map((c) => c.field).sort(), ['counted_at', 'counted_by', 'current_count']);
	assert.deepEqual(counted.find((c) => c.field === 'current_count')!.after, '12.50');
	assert.deepEqual(counted.map((c) => [c.baseRevision, c.resultRevision]), Array(3).fill([1, 2]));
	await as(org, alice, (tx) => tx`update equipment set name = 'Copper kettle', revision = revision + 1 where id = ${kettle}`);
	await as(org, alice, (tx) => tx`update tags set archived_at = now() where id = ${tag}`);
	assert.deepEqual((await changes(kettle)).map((c) => [c.operation, c.field, c.after]), [['create', null, (await changes(kettle))[0]!.after], ['update', 'name', 'Copper kettle']]);
	assert.deepEqual((await changes(tag)).map((c) => [c.operation, c.field]), [['create', null], ['update', 'archived_at']]);
	assert.equal((await db.owner`select count(*)::int as n from thread_messages where change_set_id in (select change_set_id from record_changes where record_id in (${kettle}, ${tag}, ${series}) and operation = 'update')`)[0]!.n, 0);
});

it('system routines are journalled as the system with their cause; a workflow writes as its enabling person', async () => {
	const org = await organisation(), alice = await person(org);
	const [task] = await as(org, undefined, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title, source_kind) values (${org}, 'Monthly excise', 'series') returning id`);
	const [set] = await db.owner`select s.actor_id, s.actor_kind, s.cause_kind, s.cause_id from change_sets s join record_changes c on c.change_set_id = s.id where c.record_id = ${task!.id}`;
	assert.deepEqual({ ...set }, { actorId: null, actorKind: 'system', causeKind: 'routine', causeId: 'test' });
	assert.equal((await lines(await threadOf('task_id', task!.id)))[0]!.authorId, null, 'the system’s line has no author');
	const run = randomUUID();
	await withChangeSet(db.app, { organisationId: org, userId: alice }, { actorKind: 'workflow', causeKind: 'workflow_run', causeId: run }, (tx) => tx`update tasks set title = 'Monthly excise (filed)' where id = ${task!.id}`);
	const [workflow] = await db.owner`select s.actor_id, s.actor_kind, s.cause_kind, s.cause_id from change_sets s join record_changes c on c.change_set_id = s.id where c.record_id = ${task!.id} and c.operation = 'update'`;
	assert.deepEqual({ ...workflow }, { actorId: alice, actorKind: 'workflow', causeKind: 'workflow_run', causeId: run });
	// The system has no person; a person's change set needs an active member; nobody opens a baseline.
	await assert.rejects(withChangeSet(db.app, { organisationId: org, userId: alice }, { actorKind: 'system', causeKind: 'routine' }, async () => undefined), /no person/);
	await assert.rejects(withChangeSet(db.app, { organisationId: org }, { actorKind: 'person', causeKind: 'request' }, async () => undefined), /active member/);
	await assert.rejects(withChangeSet(db.app, { organisationId: org, userId: alice }, { actorKind: 'person', causeKind: 'baseline' as never }, async () => undefined), /caused by/);
	await assert.rejects(bare(org, alice, (tx) => tx`insert into change_sets (organisation_id, actor_id, actor_kind, cause_kind) values (${org}, ${alice}, 'person', 'baseline')`), /row-level security/);
	const bob = await person(org);
	await assert.rejects(bare(org, alice, (tx) => tx`insert into change_sets (organisation_id, actor_id, actor_kind, cause_kind) values (${org}, ${bob}, 'person', 'request')`), /row-level security/,
		'a change set names the transaction’s own person');
});

it('a change set id is a retry id: the same actor and request match, anything else is unavailable', async () => {
	const org = await organisation(), other = await organisation(), alice = await person(org), bob = await person(org), outsider = await person(other);
	const id = randomUUID(), request = fingerprintOf({ operation: 'task.create', request: { title: 'Mash in' } });
	const open = (organisationId: string, userId: string, fingerprint: Buffer, changeSetId = id) => withTenant(db.app, { organisationId, userId },
		(tx) => openChangeSet(tx, { id: changeSetId, actorKind: 'person', causeKind: 'request', fingerprint }));
	assert.deepEqual(await open(org, alice, request), { id, matched: false });
	assert.deepEqual(await open(org, alice, request), { id, matched: true }, 'the same request again');
	for (const [organisationId, userId, fingerprint] of [[org, alice, fingerprintOf({ operation: 'task.create', request: { title: 'Other' } })], [org, bob, request], [other, outsider, request]] as const)
		await assert.rejects(open(organisationId, userId, fingerprint), ChangeSetUnavailable);
	// Two first uses of one id at once: one creates, the other waits for it and matches.
	const fresh = randomUUID();
	const both = await Promise.all([open(org, alice, request, fresh), open(org, alice, request, fresh)]);
	assert.deepEqual(both.map((r) => r.matched).sort(), [false, true]);
	// A change set rolled back with its transaction leaves its id free.
	const lost = randomUUID();
	await assert.rejects(withTenant(db.app, { organisationId: org, userId: alice }, async (tx) => {
		await openChangeSet(tx, { id: lost, actorKind: 'person', causeKind: 'request', fingerprint: request }); throw new Error('lost response');
	}), /lost response/);
	assert.deepEqual(await open(org, alice, request, lost), { id: lost, matched: false });
});

it('the journal is tenant-scoped and append-only for the runtime, and a removed member reads no history', async () => {
	const a = await organisation(), b = await organisation();
	const alice = await person(a), bob = await person(b);
	const [task] = await as(a, alice, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title) values (${a}, 'A only') returning id`);
	await as(b, bob, (tx) => tx`insert into tasks (organisation_id, title) values (${b}, 'B only')`);
	const seen = (org: string, user: string | undefined) => bare(org, user, async (tx) => ({
		sets: (await tx`select 1 from change_sets`).length, changes: (await tx`select 1 from record_changes`).length, versions: (await tx`select 1 from record_versions`).length }));
	// Organisations made after 0047 have no baseline: everything in them was journalled from its creation.
	assert.deepEqual(await seen(a, alice), { sets: 1, changes: 1, versions: 1 }, 'A’s creation; nothing of B’s');
	assert.deepEqual(await seen(b, bob), { sets: 1, changes: 1, versions: 1 });
	assert.deepEqual(await seen(a, bob), { sets: 0, changes: 0, versions: 0 }, 'a stranger to A');
	assert.deepEqual(await seen(a, undefined), { sets: 0, changes: 0, versions: 0 }, 'no person, no history');
	assert.equal((await db.app`select 1 from record_changes`).length + (await db.app`select 1 from change_sets`).length + (await db.app`select 1 from record_versions`).length, 0, 'no tenant context');
	for (const statement of ['update change_sets set request_id = \'x\'', 'delete from change_sets', 'update record_changes set after = \'{}\'', 'delete from record_changes',
		'update record_versions set revision = 9', 'delete from record_versions'])
		await assert.rejects(bare(a, alice, (tx) => tx.unsafe(statement)), /permission denied/, statement);
	const [set] = await db.owner<{ id: string }[]>`select change_set_id as id from record_changes where record_id = ${task!.id}`;
	await assert.rejects(bare(a, alice, (tx) => tx`insert into record_changes (organisation_id, change_set_id, record_kind, record_id, operation, after, result_revision)
		values (${a}, ${set!.id}, 'task', ${task!.id}, 'create', '{}', 1)`), /permission denied/, 'only the journal writes changes');
	await assert.rejects(bare(a, alice, (tx) => tx`insert into record_versions (organisation_id, change_set_id, record_kind, record_id, revision, snapshot)
		values (${a}, ${set!.id}, 'task', ${task!.id}, 1, '{}')`), /permission denied/);
	await db.owner`update memberships set status = 'removed' where organisation_id = ${a} and user_id = ${alice}`;
	assert.deepEqual(await seen(a, alice), { sets: 0, changes: 0, versions: 0 }, 'a removed member reads no history');
});

it('a change line is the journal’s alone: never inserted, edited, deleted or pinned by anyone else, and unread for others', async () => {
	const org = await organisation(), alice = await person(org, 'owner'), bob = await person(org);
	const [task] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Brew') returning id`);
	const thread = await threadOf('task_id', task!.id);
	const [line] = await db.owner<{ id: string; changeSetId: string; seq: number; changeSeq: number }[]>`select id, change_set_id, seq, change_seq from thread_messages where thread_id = ${thread}`;
	// Inserted directly, with or without this transaction's change set, by a person: refused.
	await assert.rejects(as(org, alice, async (tx) => {
		const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${thread} returning last_seq, last_change`;
		await tx`insert into thread_messages (id, organisation_id, thread_id, kind, seq, change_seq, author_id, change_set_id)
			values (${randomUUID()}, ${org}, ${thread}, 'change', ${c!.lastSeq}, ${c!.lastChange}, ${alice}, current_setting('app.change_set_id')::uuid)`;
	}), /written only by the journal/);
	await assert.rejects(as(org, alice, async (tx) => {
		const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${thread} returning last_seq, last_change`;
		await tx`insert into thread_messages (id, organisation_id, thread_id, kind, seq, change_seq, author_id, body, sent_body_sha256)
			values (${randomUUID()}, ${org}, ${thread}, 'approval', ${c!.lastSeq}, ${c!.lastChange}, ${alice}, 'Approve?', ${fp('Approve?')})`;
	}), /only a message can be sent/, 'approval cards stay refused');
	// Edited, tombstoned or pinned: refused, whoever asks (the author and an owner included).
	await assert.rejects(bare(org, alice, async (tx) => {
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${thread} returning last_change`;
		await tx`update thread_messages set body = 'Rewritten', revision = 2, change_seq = ${c!.lastChange} where id = ${line!.id}`;
	}), /cannot be edited or deleted|check constraint/);
	await assert.rejects(bare(org, alice, async (tx) => {
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${thread} returning last_change`;
		await tx`update thread_messages set deleted_at = now(), deleted_by = ${alice}, revision = 2, change_seq = ${c!.lastChange} where id = ${line!.id}`;
	}), /cannot be edited or deleted|check constraint/);
	await assert.rejects(bare(org, alice, async (tx) => {
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${thread} returning last_change`;
		await tx`insert into thread_pins (organisation_id, thread_id, message_id, pinned_by, change_seq) values (${org}, ${thread}, ${line!.id}, ${alice}, ${c!.lastChange})`;
	}), /only a message can be pinned/);
	assert.equal((await lines(thread)).length, 1);
	// Unread for everyone but its actor.
	const unread = (user: string) => bare(org, user, async (tx) => (await tx`select 1 from thread_messages where thread_id = ${thread} and seq > 0
		and deleted_at is null and author_id is distinct from ${user}::uuid`).length);
	assert.equal(await unread(bob), 1);
	assert.equal(await unread(alice), 0);
});

it('a deleted record keeps its history, readable as its last snapshot; organisation deletion takes the journal with it', async () => {
	const org = await organisation(), alice = await person(org);
	const [item] = await as(org, alice, (tx) => tx<{ id: string }[]>`insert into stock_items (organisation_id, name, location, unit_label) values (${org}, 'Hops', 'Store', 'kg') returning id`);
	await fixture(db.owner, org)`delete from stock_items where id = ${item!.id}`; // the runtime may not delete stock; maintenance may, journalled
	const journal = await changes(item!.id);
	assert.deepEqual(journal.map((c) => c.operation), ['create', 'remove']);
	assert.equal((journal[1]!.before as Record<string, unknown>).name, 'Hops');
	const last = (await versions(item!.id)).at(-1)!;
	assert.deepEqual([last.snapshot.removed, last.snapshot.row.name, last.revision], [true, 'Hops', 1]);
	assert.equal((await bare(org, alice, (tx) => tx`select 1 from record_versions where record_id = ${item!.id}`)).length, 2, 'members still read it');
	await withTenant(db.app, { organisationId: org, userId: alice }, (tx) => tx`delete from organisations where id = ${org}`);
	for (const table of ['change_sets', 'record_changes', 'record_versions'])
		assert.equal((await db.owner.unsafe(`select 1 from ${table} where organisation_id = $1`, [org])).length, 0, table);
});

it('a few thousand rows journal in one statement, set-based, with one version and one line per record', async () => {
	const org = await organisation(), alice = await person(org);
	const started = Date.now();
	await as(org, alice, (tx) => tx`insert into tasks (organisation_id, title) select ${org}, 'Bulk ' || n from generate_series(1, 3000) n`);
	await as(org, alice, (tx) => tx`update tasks set due = '2031-01-01' where organisation_id = ${org}`);
	const elapsed = Date.now() - started;
	const [counts] = await db.owner<{ changes: number; versions: number; lines: number }[]>`select
		(select count(*)::int from record_changes where organisation_id = ${org}) as changes,
		(select count(*)::int from record_versions where organisation_id = ${org}) as versions,
		(select count(*)::int from thread_messages where organisation_id = ${org} and kind = 'change') as lines`;
	assert.deepEqual({ ...counts }, { changes: 6000, versions: 6000, lines: 6000 });
	assert.ok(elapsed < 120_000, `3,000 creations and 3,000 edits journalled in ${elapsed} ms`);
});

it('0047 from 0046: one baseline per organisation, one version per record at its revision, no changes; Xero sync state leaves audit_events', async () => {
	const old = await freshDatabase({ through: before0047 });
	try {
		const { owner } = old;
		const o = await organisation(owner), quiet = await organisation(owner);
		const lead = await person(o, 'owner', owner), member = await person(o, 'member', owner);
		const [tag] = await owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${o}, 'Production') returning id`;
		const [task] = await owner<{ id: string }[]>`insert into tasks (organisation_id, title, owner_id) values (${o}, 'Brew batch 42', ${member}) returning id`;
		const [step] = await owner<{ id: string }[]>`insert into tasks (organisation_id, parent_id, title) values (${o}, ${task!.id}, 'Weigh the malt') returning id`;
		await owner`insert into evidence (organisation_id, task_id, kind, reference) values (${o}, ${task!.id}, 'url', 'https://example.test/recipe')`;
		await owner`update tasks set title = 'Brew batch 43' where id = ${task!.id}`; // revision 2
		const thread = (await owner<{ id: string }[]>`select id from threads where task_id = ${task!.id}`)[0]!.id;
		await owner`insert into thread_tags (organisation_id, thread_id, tag_id) values (${o}, ${thread}, ${tag!.id})`;
		await owner`insert into tasks (organisation_id, title) select ${o}, 'Bulk ' || n from generate_series(1, 2000) n`;
		const [series] = await owner<{ id: string }[]>`insert into task_series (organisation_id, title, recurrence, anchor) values (${o}, 'Excise', 'monthly', '2026-01-01') returning id`;
		await owner`insert into task_series_tags (organisation_id, series_id, tag_id) values (${o}, ${series!.id}, ${tag!.id})`;
		const [kettle] = await owner<{ id: string }[]>`insert into equipment (organisation_id, name) values (${o}, 'Kettle') returning id`;
		await owner`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
			values (${randomUUID()}, ${o}, ${kettle!.id}, 'Boil', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', '2031-01-01T00:00:00Z', '2031-01-01T01:00:00Z', ${lead})`;
		await owner`insert into stock_items (organisation_id, name, location, unit_label, current_count, counted_at, counted_by) values (${o}, 'Malt', 'Store', 'kg', 3.25, now(), ${member})`;
		const topic = randomUUID();
		await withTenant(old.app, { organisationId: o, userId: lead }, (tx) => tx`select thread_create(${topic}, 'topic', 'Packaging day', ${fp('t')})`);
		// Xero: a connection synced, then reconnected and failed; another synced.
		const [xero] = await owner<{ id: string }[]>`insert into connections (organisation_id, provider, connected_by, provider_account_id, status, scopes) values (${o}, 'xero', ${lead}, 'tenant-1', 'connected', '{}') returning id`;
		const event = (action: string, at: string, detail: Record<string, unknown> = {}) => owner`insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail, created_at)
			values (${o}, 'system', ${action}, 'connection', ${xero!.id}, ${owner.json(detail as never)}, ${at})`;
		await event('xero.connected', '2026-09-01T00:00:00Z'); await event('xero.synced', '2026-09-02T00:00:00Z');
		await event('xero.connected', '2026-09-03T00:00:00Z'); await event('xero.synced', '2026-09-04T00:00:00Z'); await event('xero.sync_failed', '2026-09-05T00:00:00Z', { error: 'Rate limited' });
		const audits = (await owner<{ n: number }[]>`select count(*)::int as n from audit_events`)[0]!.n;
		const revisions = await owner<{ id: string; revision: number }[]>`select id, revision from tasks where parent_id is null`;

		const startedAt = Date.now();
		assert.deepEqual(await applyMigrations(owner), [migration]);
		const took = Date.now() - startedAt;
		const sets = await owner<{ organisationId: string; actorKind: string; causeKind: string }[]>`select organisation_id, actor_kind, cause_kind from change_sets order by organisation_id`;
		assert.deepEqual(sets.map((s) => [s.organisationId, s.actorKind, s.causeKind]).sort(), [[o, 'system', 'baseline'], [quiet, 'system', 'baseline']].sort(), 'one per organisation, the quiet one too');
		assert.equal((await owner`select 1 from record_changes`).length, 0, 'the baseline invents no changes');
		assert.equal((await owner`select 1 from thread_messages where kind = 'change'`).length, 0, 'nor change lines');
		const counted = await owner<{ kind: string; n: number }[]>`select record_kind as kind, count(*)::int as n from record_versions group by 1 order by 1`;
		assert.deepEqual(Object.fromEntries(counted.map((c) => [c.kind, c.n])), { equipment: 1, reservation: 1, series: 1, stock_item: 1, tag: 1, task: 2001, thread: 1 },
			'every record once: top-level tasks (steps are their task’s), bookings, stock, series, equipment, tags and topic threads');
		const byTask = new Map((await owner<{ recordId: string; revision: number }[]>`select record_id, revision from record_versions where record_kind = 'task'`).map((v) => [v.recordId, v.revision]));
		for (const row of revisions) assert.equal(byTask.get(row.id), row.revision, 'at its current revision');
		const [snapshot] = await owner<{ snapshot: Record<string, any> }[]>`select snapshot from record_versions where record_id = ${task!.id}`;
		assert.deepEqual([snapshot!.snapshot.row.title, snapshot!.snapshot.steps.map((s: { id: string }) => s.id), snapshot!.snapshot.evidence.length, snapshot!.snapshot.tags],
			['Brew batch 43', [step!.id], 1, [tag!.id]]);
		assert.equal((await owner<{ revision: number }[]>`select revision from stock_items`)[0]!.revision, 1, 'stock items start at revision 1');
		const [state] = await owner`select state, error, last_synced_at from xero_sync_state where connection_id = ${xero!.id}`;
		assert.deepEqual({ ...state }, { state: 'failed', error: 'Rate limited', lastSyncedAt: new Date('2026-09-04T00:00:00Z') }, 'the latest event, and the last sync since reconnecting');
		assert.equal((await owner<{ n: number }[]>`select count(*)::int as n from audit_events`)[0]!.n, audits, 'audit rows stay as history');
		assert.ok(took < 120_000, `0047 over ~2,000 records took ${took} ms`);
		// Afterwards every write is journalled from the baseline on.
		await journalled(old.app, { organisationId: o, userId: member }, (tx) => tx`update tasks set title = 'Brew batch 44' where id = ${task!.id}`);
		const [first] = await owner<{ baseRevision: number; resultRevision: number }[]>`select base_revision, result_revision from record_changes where record_id = ${task!.id}`;
		assert.deepEqual({ ...first }, { baseRevision: 2, resultRevision: 3 }, 'the first change builds on the baseline version');
		assert.deepEqual(await applyMigrations(owner), []);
	} finally { await old.close(); }
});
