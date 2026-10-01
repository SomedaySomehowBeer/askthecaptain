import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Sql, TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { applyMigrations } from '../src/migrate.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0046 (threads contract §8, §9): on a database at 0045, projects become tags, tags move onto threads, every
// top-level task, booking and stock item gets its record thread, and the 0042/0043 tables, projects, task_tags and the
// three project_id columns are gone. Each case migrates a fresh database to 0045, adds fixtures, and applies 0046 itself.
const it = databaseUrl ? test : test.skip;
const before0046 = '0045_drop_assistant_storage.sql';
const migration = '0046_threads.sql';
const retiredTables = ['conversations', 'conversation_participants', 'conversation_links', 'messages', 'message_pins', 'conversation_stars', 'conversation_reads',
	'projects', 'task_tags'];
const newTables = ['threads', 'thread_participants', 'thread_tags', 'task_series_tags', 'thread_messages', 'thread_pins', 'thread_stars', 'thread_reads', 'chat_audit_events'];
const fp = (value: string) => createHash('sha256').update(value).digest();

let latest: Harness;
before(async () => { if (databaseUrl) latest = await freshDatabase(); });
after(async () => { await latest?.close(); });

const tablesPresent = async (owner: Sql, names: string[]) => (await owner<{ name: string }[]>`select t as name from unnest(${names}::text[]) with ordinality as u(t, n)
	where to_regclass('public.' || t) is not null order by n`).map((r) => r.name);
const projectColumns = async (owner: Sql) => (await owner<{ name: string }[]>`select table_name || '.' || column_name as name from information_schema.columns
	where table_schema = 'public' and column_name = 'project_id' order by 1`).map((r) => r.name);
const applied = async (owner: Sql) => (await owner<{ name: string }[]>`select name from schema_migrations order by name`).map((r) => r.name);
const rows = async (query: Promise<Record<string, unknown>[]>) => (await query).map((row) => ({ ...row }));

async function person(owner: Sql, org: string, role = 'member', member = true): Promise<string> {
	const [user] = await owner<{ id: string }[]>`insert into users (email, name) values (${`${randomUUID()}@example.test`}, 'Fixture person') returning id`;
	if (member) await owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${user!.id}, ${role})`;
	return user!.id;
}

it('the latest schema has the thread tables and none of the retired ones, and migrating again changes nothing', async () => {
	assert.deepEqual(await tablesPresent(latest.owner, retiredTables), []);
	assert.deepEqual(await tablesPresent(latest.owner, newTables), newTables);
	assert.deepEqual(await projectColumns(latest.owner), []);
	assert.equal((await applied(latest.owner)).at(-1), migration);
	assert.deepEqual(await applyMigrations(latest.owner), []);
	const [chatAudit] = await latest.owner<{ column: boolean }[]>`select exists (select 1 from information_schema.columns where table_name = 'chat_audit_events' and column_name = 'thread_id') as column`;
	assert.equal(chatAudit!.column, true, 'chat_audit_events is in its new shape');
});

it('projects become tags, tags move onto threads, records get threads, and the old tables and columns go', async () => {
	const db = await freshDatabase({ through: before0046 });
	try {
		const { owner } = db;
		const [org] = await owner<{ id: string }[]>`insert into organisations (name) values ('Harbour Brewing') returning id`;
		const o = org!.id;
		const lead = await person(owner, o, 'owner'), member = await person(owner, o), gone = await person(owner, o, 'member', false);
		const [other] = await owner<{ id: string }[]>`insert into organisations (name) values ('Other place') returning id`;
		// Tags that exist already; one shares a name with a project, case-insensitively.
		const [production, sales] = await owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${o}, 'Production'), (${o}, 'Sales') returning id`;
		const [p1] = await owner<{ id: string }[]>`insert into projects (organisation_id, name, description, owner_id, created_by) values (${o}, 'production', 'Brew days', ${member}, ${lead}) returning id`;
		const [p2] = await owner<{ id: string }[]>`insert into projects (organisation_id, name, owner_id, created_by, archived_at) values (${o}, 'Summer lager', ${lead}, ${lead}, '2026-08-01T00:00:00Z') returning id`;
		const [p3] = await owner<{ id: string }[]>`insert into projects (organisation_id, name, owner_id, created_by) values (${o}, 'Winter stout', ${gone}, ${gone}) returning id`;
		const [p4] = await owner<{ id: string }[]>`insert into projects (organisation_id, name) values (${other!.id}, 'Production') returning id`;
		const task = async (title: string, project: string | null, parent: string | null = null) =>
			(await owner<{ id: string }[]>`insert into tasks (organisation_id, project_id, parent_id, title) values (${o}, ${project}, ${parent}, ${title}) returning id`)[0]!.id;
		const brew = await task('Brew batch 42', p1!.id), loose = await task('Clean the office', null), launch = await task('Launch party', p2!.id);
		const both = await task('Order malt', p1!.id), step = await task('Weigh the malt', p1!.id, brew);
		await owner`insert into task_tags (organisation_id, task_id, tag_id, attached_by) values (${o}, ${both}, ${production!.id}, ${member}), (${o}, ${loose}, ${sales!.id}, ${lead})`;
		const [series] = await owner<{ id: string }[]>`insert into task_series (organisation_id, project_id, title, recurrence, anchor) values (${o}, ${p2!.id}, 'Weekly tasting', 'monthly', '2026-01-01') returning id`;
		const [plain] = await owner<{ id: string }[]>`insert into task_series (organisation_id, title, recurrence, anchor) values (${o}, 'Excise', 'monthly', '2026-01-01') returning id`;
		const [kettle] = await owner<{ id: string }[]>`insert into equipment (organisation_id, name) values (${o}, 'Kettle') returning id`;
		const booking = async (title: string, project: string | null, start: string) => (await owner<{ id: string }[]>`insert into equipment_reservations
			(id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, project_id, created_by)
			values (${randomUUID()}, ${o}, ${kettle!.id}, ${title}, ${start}::timestamptz, ${start}::timestamptz + interval '2 hours', ${start}::timestamptz, ${start}::timestamptz + interval '2 hours', ${project}, ${lead}) returning id`)[0]!.id;
		const brewing = await booking('Brew', p1!.id, '2031-03-01T00:00:00Z'), cleaning = await booking('Clean', null, '2031-03-02T00:00:00Z');
		const [hops] = await owner<{ id: string }[]>`insert into stock_items (organisation_id, name, location, unit_label) values (${o}, 'Hops', 'Store', 'kg') returning id`;
		// Saved views naming a merged project and a carried one.
		const view = async (projectId: string) => (await owner<{ id: string }[]>`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
			values (${randomUUID()}, ${o}, ${member}, ${`View ${projectId}`}, 1, ${owner.json({ owner: 'me', status: 'open', tagIds: [], projectId })}) returning id`)[0]!.id;
		const mergedView = await view(p1!.id), carriedView = await view(p3!.id);
		// Demo chats in the 0042/0043 tables, written the way the API wrote them.
		const conversation = randomUUID();
		await withTenant(db.app, { organisationId: o, userId: lead }, async (tx: TransactionSql) => {
			await tx`select 1 from memberships where organisation_id = ${o} and user_id in ${tx([lead, member].sort())} order by user_id for share`;
			assert.equal((await tx<{ result: string }[]>`select chat_create_conversation(${conversation}, 'Packaging slot', ${fp('Packaging slot')}) as result`)[0]!.result, 'created');
			await tx`insert into conversation_participants (organisation_id, conversation_id, user_id, added_by) values (${o}, ${conversation}, ${member}, ${lead})`;
			await tx`update conversations set revision = revision + 1 where id = ${conversation}`;
			await tx`insert into conversation_links (organisation_id, conversation_id, target_kind, task_id, linked_by) values (${o}, ${conversation}, 'task', ${brew}, ${lead})`;
			await tx`insert into conversation_links (organisation_id, conversation_id, target_kind, project_id, linked_by) values (${o}, ${conversation}, 'project', ${p1!.id}, ${lead})`;
			const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update conversations set last_seq = last_seq + 1, last_change = last_change + 1,
				last_message_at = greatest(last_message_at, now()) where id = ${conversation} returning last_seq, last_change`;
			const message = randomUUID();
			await tx`insert into messages (id, organisation_id, conversation_id, seq, change_seq, author_id, body, sent_body_sha256)
				values (${message}, ${o}, ${conversation}, ${c!.lastSeq}, ${c!.lastChange}, ${lead}, 'Can we move the slot?', ${fp('Can we move the slot?')})`;
			const [n] = await tx<{ lastChange: number }[]>`update conversations set last_change = last_change + 1 where id = ${conversation} returning last_change`;
			await tx`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by) values (${o}, ${conversation}, ${message}, ${n!.lastChange}, ${lead})`;
			await tx`insert into conversation_stars (organisation_id, conversation_id, user_id) values (${o}, ${conversation}, ${lead})`;
			await tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq) values (${o}, ${conversation}, ${lead}, 1)`;
			await tx`insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, detail)
				values (${o}, ${conversation}, ${lead}, 'chat.message_sent', 'message', ${message}, ${tx.json({ conversationId: conversation })})`;
		});
		const tagsBefore = (await owner<{ n: number }[]>`select count(*)::int as n from tags`)[0]!.n;

		assert.deepEqual(await applyMigrations(db.owner), [migration]);
		assert.equal((await applied(owner)).at(-1), migration);

		// The old tables and columns are gone; the new ones exist; the demo chats are not copied anywhere.
		assert.deepEqual(await tablesPresent(owner, retiredTables), [], 'the 0042/0043 tables, projects and task_tags are dropped');
		assert.deepEqual(await tablesPresent(owner, newTables), newTables);
		assert.deepEqual(await projectColumns(owner), [], 'no project_id column remains on tasks, series or bookings');
		for (const table of ['thread_participants', 'thread_messages', 'thread_pins', 'thread_stars', 'thread_reads', 'chat_audit_events'])
			assert.equal((await owner.unsafe(`select count(*)::int as n from ${table}`))[0]!.n, 0, `${table} starts empty`);
		assert.equal((await owner`select count(*)::int as n from threads where kind <> 'record'`)[0]!.n, 0, 'no topic or private thread is invented');

		// Projects to tags: the namesake keeps its id and takes the owner; the others keep the project's id; a non-member
		// owner is not carried; descriptions are not carried; another tenant's project stays its own.
		const tags = await rows(owner`select id, organisation_id, name, owner_id, created_by, archived_at is not null as archived, revision from tags order by name, organisation_id`);
		assert.equal(tags.length, tagsBefore + 3, 'one new tag for each project that matched none');
		const tag = (id: string) => tags.find((t) => t.id === id);
		assert.deepEqual(tag(production!.id), { id: production!.id, organisationId: o, name: 'Production', ownerId: member, createdBy: null, archived: false, revision: 1 });
		assert.deepEqual(tag(p2!.id), { id: p2!.id, organisationId: o, name: 'Summer lager', ownerId: lead, createdBy: lead, archived: true, revision: 1 });
		assert.deepEqual(tag(p3!.id), { id: p3!.id, organisationId: o, name: 'Winter stout', ownerId: null, createdBy: null, archived: false, revision: 1 });
		assert.deepEqual(tag(p4!.id), { id: p4!.id, organisationId: other!.id, name: 'Production', ownerId: null, createdBy: null, archived: false, revision: 1 });
		assert.equal(tag(p1!.id), undefined, 'the merged project left no tag of its own');
		assert.equal(tag(sales!.id)!.ownerId, null);

		// Record threads: one per top-level task, booking and stock item; none for the step.
		const record = async (column: string, id: string) => (await owner.unsafe(`select id, last_message_at, revision from threads where ${column} = $1`, [id])) as { id: string; lastMessageAt: Date | null; revision: number }[];
		for (const id of [brew, loose, launch, both]) assert.equal((await record('task_id', id)).length, 1, id);
		assert.equal((await record('task_id', step)).length, 0, 'a step has no thread');
		for (const id of [brewing, cleaning]) assert.equal((await record('reservation_id', id)).length, 1);
		assert.equal((await record('stock_item_id', hops!.id)).length, 1);
		assert.equal((await owner`select count(*)::int as n from threads where kind = 'record'`)[0]!.n, 7);
		assert.ok((await owner`select last_message_at, revision, last_seq from threads`).every((t) => t.lastMessageAt === null && t.revision === 1 && t.lastSeq === 0));

		// Tags on threads: task tags and projects, once each, and the booking's project; the series' project as a series tag.
		const threadTags = await rows(owner`select coalesce(th.task_id, th.reservation_id) as record, tt.tag_id, tt.attached_by from thread_tags tt
			join threads th on th.id = tt.thread_id order by 1, 2`);
		const expected = [
			{ record: brew, tagId: production!.id, attachedBy: null },
			{ record: loose, tagId: sales!.id, attachedBy: lead },
			{ record: launch, tagId: p2!.id, attachedBy: null },
			{ record: both, tagId: production!.id, attachedBy: member },
			{ record: brewing, tagId: production!.id, attachedBy: null },
		].sort((a, b) => (a.record + a.tagId < b.record + b.tagId ? -1 : 1));
		assert.deepEqual(threadTags, expected, 'a task tagged with its own project’s namesake counts once');
		assert.deepEqual(await rows(owner`select series_id, tag_id from task_series_tags`), [{ seriesId: series!.id, tagId: p2!.id }]);
		assert.equal((await owner`select 1 from task_series_tags where series_id = ${plain!.id}`).length, 0);

		// Saved views follow a merged project to its tag; a carried project's id is the tag's already.
		const filters = Object.fromEntries((await owner<{ id: string; filter: { projectId: string } }[]>`select id, filter from saved_views`).map((v) => [v.id, v.filter.projectId]));
		assert.deepEqual(filters, { [mergedView]: production!.id, [carriedView]: p3!.id });

		// The equipment overlap rule is untouched, and records made after the migration get their threads.
		await assert.rejects(owner`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, created_by)
			values (${randomUUID()}, ${o}, ${kettle!.id}, 'Overlap', '2031-03-01T01:00:00Z', '2031-03-01T03:00:00Z', '2031-03-01T01:00:00Z', '2031-03-01T03:00:00Z', ${lead})`, { code: '23P01' });
		const [fresh] = await owner<{ id: string }[]>`insert into tasks (organisation_id, title) values (${o}, 'After the migration') returning id`;
		assert.equal((await record('task_id', fresh!.id)).length, 1);
		// The runtime role sees its own tenant's record threads and tags, and nothing of the other's.
		const seen = await withTenant(db.app, { organisationId: o, userId: member }, async (tx: TransactionSql) => ({
			threads: (await tx`select id from threads`).length, tags: (await tx`select 1 from thread_tags`).length }));
		assert.deepEqual(seen, { threads: 8, tags: 5 });
	} finally { await db.close(); }
});

it('two projects whose names differ only in case stop the migration, and nothing is changed or recorded', async () => {
	const db = await freshDatabase({ through: before0046 });
	try {
		const [org] = await db.owner<{ id: string }[]>`insert into organisations (name) values ('Duplicates') returning id`;
		await db.owner`insert into projects (organisation_id, name) values (${org!.id}, 'Purchasing'), (${org!.id}, 'purchasing ')`;
		await assert.rejects(applyMigrations(db.owner), /migration 0046 refused: 1 project names are used by more than one project/);
		assert.equal((await applied(db.owner)).at(-1), before0046, '0046 is not recorded');
		assert.deepEqual(await tablesPresent(db.owner, retiredTables), retiredTables, 'nothing was dropped');
		assert.equal((await db.owner`select 1 from pg_class where relname = 'threads'`).length, 0);
		await db.owner`update projects set name = 'Purchasing (old)' where name = 'purchasing '`;
		assert.deepEqual(await applyMigrations(db.owner), [migration], 'applies once the names are distinct');
		assert.equal((await db.owner`select count(*)::int as n from tags where organisation_id = ${org!.id}`)[0]!.n, 2);
	} finally { await db.close(); }
});

it('a task tag on a step, which has no thread to carry it, stops the migration rather than being lost', async () => {
	const db = await freshDatabase({ through: before0046 });
	try {
		const [org] = await db.owner<{ id: string }[]>`insert into organisations (name) values ('Step tag') returning id`;
		const lead = await person(db.owner, org!.id, 'owner');
		const [parent] = await db.owner<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org!.id}, 'Parent') returning id`;
		const [step] = await db.owner<{ id: string }[]>`insert into tasks (organisation_id, parent_id, title) values (${org!.id}, ${parent!.id}, 'Step') returning id`;
		const [tag] = await db.owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${org!.id}, 'Odd') returning id`;
		await db.owner`insert into task_tags (organisation_id, task_id, tag_id, attached_by) values (${org!.id}, ${step!.id}, ${tag!.id}, ${lead})`;
		await assert.rejects(applyMigrations(db.owner), /migration 0046: 1 tag attachments in but 0 thread tags written/);
		assert.equal((await applied(db.owner)).at(-1), before0046);
		assert.equal((await db.owner`select 1 from task_tags`).length, 1, 'the attachment is kept');
	} finally { await db.close(); }
});
