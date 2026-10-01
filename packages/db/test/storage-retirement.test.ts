import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Sql, TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { applyMigrations } from '../src/migrate.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0045 (R5b, docs/plans/assistant-code-removal-2026-09.md): the retired assistant's storage is dropped only
// when empty, in one transaction, without CASCADE; retained business data and the tables that lost a legacy column are
// untouched. Each case migrates a fresh database only as far as 0044 and applies 0045 itself.
const it = databaseUrl ? test : test.skip;
const before0045 = '0044_native_handoff.sql';
const migration = '0045_drop_assistant_storage.sql';
const retiredTables = ['note_triage', 'notes', 'content_vectors', 'project_candidate_sources', 'project_candidates', 'project_sources',
	'discovery_seeds', 'mail_triage', 'sent_triage', 'attachment_text', 'mail_attachments', 'outbox', 'mail_messages', 'mail_senders',
	'mail_threads', 'calendar_events', 'calendars', 'briefs', 'answers', 'webhook_attempts', 'webhook_events'];
const retiredColumns = [['contacts', 'last_thread_id'], ['workflow_enablements', 'mail_cursor'], ['workflow_enablements', 'sent_cursor']] as const;
const retiredFunctions = ['gmail_sync_organisations()', 'calendar_sync_organisations()', 'attachment_text_organisations()', 'index_organisations()',
	'content_vectors_cascade()', 'project_sources_cascade()', 'clear_changed_event_note()'];
const fp = (value: string) => createHash('sha256').update(value).digest();

let latest: Harness;
// 0046 drops projects and the 0042/0043 tables this file checks were retained, so every case stops at 0045.
before(async () => { if (databaseUrl) latest = await freshDatabase({ through: migration }); });
after(async () => { await latest?.close(); });

async function present(owner: Sql) {
	const tables = (await owner<{ name: string }[]>`select t as name from unnest(${retiredTables}::text[]) with ordinality as u(t, n)
		where to_regclass('public.' || t) is not null order by n`).map((r) => r.name);
	const columns = (await owner<{ name: string }[]>`select table_name || '.' || column_name as name from information_schema.columns
		where table_schema = 'public' and (table_name, column_name) in (('contacts', 'last_thread_id'), ('workflow_enablements', 'mail_cursor'), ('workflow_enablements', 'sent_cursor'))
		order by 1`).map((r) => r.name);
	const functions = (await owner<{ name: string }[]>`select f as name from unnest(${retiredFunctions}::text[]) with ordinality as u(f, n)
		where to_regprocedure('public.' || f) is not null order by n`).map((r) => r.name);
	return { tables, columns, functions };
}
const applied = async (owner: Sql) => (await owner<{ name: string }[]>`select name from schema_migrations order by name`).map((r) => r.name);
async function organisation(owner: Sql, name: string) {
	const [org] = await owner<{ id: string }[]>`insert into organisations (name) values (${name}) returning id`;
	const [user] = await owner<{ id: string }[]>`insert into users (email) values (${`${randomUUID()}@example.test`}) returning id`;
	await owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
	return { org: org!.id, user: user!.id };
}

it('the latest schema has none of the retired storage, keeps what the plan retains, and migrating again changes nothing', async () => {
	assert.deepEqual(await present(latest.owner), { tables: [], columns: [], functions: [] });
	assert.equal((await applied(latest.owner)).at(-1), migration);
	assert.deepEqual(await applyMigrations(latest.owner, undefined, migration), [], 'a second run applies nothing');
	// Retained on purpose (plan R5b step 5).
	assert.equal((await latest.owner`select 1 from pg_extension where extname = 'vector'`).length, 1, 'the vector extension stays (0030 needs it)');
	const projectColumns = (await latest.owner<{ name: string }[]>`select column_name as name from information_schema.columns where table_schema = 'public' and table_name = 'projects'`).map((r) => r.name);
	for (const column of ['proposed_at', 'accepted_at', 'state', 'brief']) assert.ok(projectColumns.includes(column), column);
	const checks = (await latest.owner<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint
		where contype = 'c' and conrelid in ('evidence'::regclass, 'tasks'::regclass, 'auth_requests'::regclass)`).map((r) => r.def).join('\n');
	for (const kept of ["'mail'", "'note'", "'google_connection'"]) assert.ok(checks.includes(kept), `provenance or kind value ${kept} is kept`);
	// contacts no longer references any legacy table; its remaining foreign keys point only at retained tables.
	const contactRefs = (await latest.owner<{ target: string }[]>`select confrelid::regclass::text as target from pg_constraint where conrelid = 'contacts'::regclass and contype = 'f'`).map((r) => r.target);
	assert.deepEqual(contactRefs.filter((t) => retiredTables.includes(t)), []);
	assert.ok(contactRefs.includes('companies'));
	// No grant, policy or function privilege survives for dropped objects, for app or captain_runtime.
	const grants = (await latest.owner<{ object: string }[]>`select c.relname as object from pg_class c cross join lateral aclexplode(c.relacl) a
		where a.grantee in ('app'::regrole, 'captain_runtime'::regrole) and c.relname = any(${retiredTables}::text[])`).map((r) => r.object);
	assert.deepEqual(grants, []);
	// Retained grants still hold for both roles on the tables that lost a column.
	for (const role of ['app', 'captain_runtime']) for (const table of ['contacts', 'workflow_enablements', 'tasks', 'connections', 'conversations'])
		assert.equal((await latest.owner<{ ok: boolean }[]>`select has_table_privilege(${role}, ${table}, 'SELECT') as ok`)[0]!.ok, true, `${role} ${table}`);
});

it('a legacy table with a row stops the migration; nothing is dropped, deleted or recorded', async () => {
	const db = await freshDatabase({ through: before0045 });
	try {
		const { org } = await organisation(db.owner, 'Unknown writer');
		await db.owner`insert into mail_senders (organisation_id, email) values (${org}, 'sender@example.test')`;
		await assert.rejects(applyMigrations(db.owner, undefined, migration), /migration 0045 refused: mail_senders has rows; nothing was dropped/);
		assert.equal((await applied(db.owner)).at(-1), before0045, '0045 is not recorded');
		assert.deepEqual(await present(db.owner), { tables: retiredTables, columns: retiredColumns.map(([t, c]) => `${t}.${c}`).sort(), functions: retiredFunctions }, 'nothing dropped');
		assert.equal((await db.owner`select 1 from mail_senders where organisation_id = ${org}`).length, 1, 'the row is kept, not deleted');
	} finally { await db.close(); }
});

it('a set retained column stops the migration even with every legacy table empty; cleared, it applies and keeps the row', async () => {
	const db = await freshDatabase({ through: before0045 });
	try {
		const { org } = await organisation(db.owner, 'Old cursor');
		await db.owner`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, digest)
			values ('r5b-probe', 1, 'Probe', 'A retained enablement', 5, '[]', '{}', '[]', 'probe')`;
		const [enablement] = await db.owner<{ id: string }[]>`insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, parameters, mail_cursor)
			values (${org}, 'r5b-probe', 1, true, ${db.owner.json({ keep: 'me' })}, ${randomUUID()}) returning id`;
		await assert.rejects(applyMigrations(db.owner, undefined, migration), /migration 0045 refused: workflow_enablements\.mail_cursor or sent_cursor is set/);
		await db.owner`update workflow_enablements set mail_cursor = null, sent_cursor = ${randomUUID()} where id = ${enablement!.id}`;
		await assert.rejects(applyMigrations(db.owner, undefined, migration), /migration 0045 refused: workflow_enablements\.mail_cursor or sent_cursor is set/, 'sent_cursor alone also stops it');
		assert.equal((await applied(db.owner)).at(-1), before0045);
		assert.equal((await present(db.owner)).tables.length, retiredTables.length, 'nothing dropped');
		await db.owner`update workflow_enablements set sent_cursor = null where id = ${enablement!.id}`;
		assert.deepEqual(await applyMigrations(db.owner, undefined, migration), [migration]);
		assert.deepEqual(await present(db.owner), { tables: [], columns: [], functions: [] });
		const [kept] = await db.owner`select organisation_id, definition_key, enabled, parameters from workflow_enablements where id = ${enablement!.id}`;
		assert.deepEqual({ ...kept }, { organisationId: org, definitionKey: 'r5b-probe', enabled: true, parameters: { keep: 'me' } });
		assert.deepEqual(await applyMigrations(db.owner, undefined, migration), [], 'a second run applies nothing');
	} finally { await db.close(); }
});

it('a set contacts.last_thread_id stops the migration with every legacy table empty', async () => {
	const db = await freshDatabase({ through: before0045 });
	try {
		const { org } = await organisation(db.owner, 'Old thread link');
		// Fixture only: 0006's foreign key would need a mail_threads row, which the table guard would report first. Removing
		// it here lets the column guard be reached on its own; the column still exists, so the migration still drops it.
		await db.owner`alter table contacts drop constraint contacts_organisation_id_last_thread_id_fkey`;
		await db.owner`insert into contacts (organisation_id, email, source, last_thread_id) values (${org}, 'linked@example.test', 'mail', ${randomUUID()})`;
		await assert.rejects(applyMigrations(db.owner, undefined, migration), /migration 0045 refused: contacts\.last_thread_id is set; nothing was dropped/);
		assert.equal((await applied(db.owner)).at(-1), before0045);
		assert.deepEqual(await present(db.owner), { tables: retiredTables, columns: retiredColumns.map(([t, c]) => `${t}.${c}`).sort(), functions: retiredFunctions });
	} finally { await db.close(); }
});

it('an unknown dependency on a legacy table fails the migration and rolls back every step already taken', async () => {
	const db = await freshDatabase({ through: before0045 });
	try {
		// Something outside the plan depends on `answers`, which is dropped late: by then both columns and most tables are
		// already gone inside the transaction. Without CASCADE the drop fails, and the whole migration must roll back.
		await db.owner`create view r5b_unknown_reader as select organisation_id, question from answers`;
		await assert.rejects(applyMigrations(db.owner, undefined, migration), /cannot drop table answers because other objects depend on it/);
		assert.equal((await applied(db.owner)).at(-1), before0045, '0045 is not recorded');
		assert.deepEqual(await present(db.owner), { tables: retiredTables, columns: retiredColumns.map(([t, c]) => `${t}.${c}`).sort(), functions: retiredFunctions },
			'the columns and the tables dropped before answers are all back');
		const [contactsFk] = await db.owner<{ n: number }[]>`select count(*)::int as n from pg_constraint where conname = 'contacts_organisation_id_last_thread_id_fkey'`;
		assert.equal(contactsFk!.n, 1, 'the foreign key removed with the column is back too');
		assert.equal((await db.owner`select 1 from pg_views where viewname = 'r5b_unknown_reader'`).length, 1, 'nothing was dropped to make room');
		// Once the unknown dependency is resolved deliberately, the migration applies.
		await db.owner`drop view r5b_unknown_reader`;
		assert.deepEqual(await applyMigrations(db.owner, undefined, migration), [migration]);
		assert.deepEqual(await present(db.owner), { tables: [], columns: [], functions: [] });
	} finally { await db.close(); }
});

it('Work, contacts, provenance and chat survive the migration unchanged and stay confined by row security', async () => {
	const db = await freshDatabase({ through: before0045 });
	try {
		const { org, user } = await organisation(db.owner, 'Harbour Brewing');
		const other = await organisation(db.owner, 'Other Place');
		const citation = randomUUID();
		const brief = { what: [], standing: [{ text: 'Two sites seen.', evidence: { kind: 'note', id: citation } }], people: [], questions: [] };
		const [project] = await db.owner<{ id: string }[]>`insert into projects (organisation_id, name, brief) values (${org}, 'City taproom', ${db.owner.json(brief)}) returning id`;
		const [task] = await db.owner<{ id: string }[]>`insert into tasks (organisation_id, project_id, title, source_kind, source_id) values (${org}, ${project!.id}, 'Reply to the brewer', 'mail', 'thread-17') returning id`;
		await db.owner`insert into evidence (organisation_id, task_id, kind, reference, label) values (${org}, ${task!.id}, 'note', ${citation}, 'Site visit')`;
		const [company] = await db.owner<{ id: string }[]>`insert into companies (organisation_id, name) values (${org}, 'Maltings') returning id`;
		await db.owner`insert into contacts (organisation_id, company_id, email, source) values (${org}, ${company!.id}, 'brewer@example.test', 'mail')`;
		// A conversation with one message, created the way the API does (as the runtime role, §6 lock order).
		const conversation = randomUUID();
		await withTenant(db.app, { organisationId: org, userId: user }, async (tx: TransactionSql) => {
			await tx`select 1 from memberships where organisation_id = ${org} and user_id = ${user} for share`;
			const [created] = await tx<{ result: string }[]>`select chat_create_conversation(${conversation}, 'Packaging slot', ${fp('Packaging slot')}) as result`;
			assert.equal(created!.result, 'created');
			const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update conversations set last_seq = last_seq + 1, last_change = last_change + 1,
				last_message_at = greatest(last_message_at, now()) where id = ${conversation} returning last_seq, last_change`;
			const message = randomUUID();
			await tx`insert into messages (id, organisation_id, conversation_id, seq, change_seq, author_id, body, sent_body_sha256)
				values (${message}, ${org}, ${conversation}, ${c!.lastSeq}, ${c!.lastChange}, ${user}, 'Can we move the slot?', ${fp('Can we move the slot?')})`;
			await tx`insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, personal, detail)
				values (${org}, ${conversation}, ${user}, 'chat.message_sent', 'message', ${message}, false, ${tx.json({ conversationId: conversation })})`;
		});
		// Plain arrays of plain rows: postgres.js returns an Array subclass, which strict deep-equality would compare by prototype.
		const rows = async (query: Promise<Record<string, unknown>[]>) => (await query).map((row) => ({ ...row }));
		const snapshot = async () => ({
			projects: await rows(db.owner`select id, name, brief, state from projects where organisation_id = ${org} order by id`),
			tasks: await rows(db.owner`select id, title, source_kind, source_id, project_id from tasks where organisation_id = ${org} order by id`),
			evidence: await rows(db.owner`select kind, reference, label from evidence where organisation_id = ${org} order by id`),
			contacts: await rows(db.owner`select email, source, company_id from contacts where organisation_id = ${org} order by id`),
			conversations: await rows(db.owner`select id, title, last_seq from conversations where organisation_id = ${org} order by id`),
			messages: await rows(db.owner`select conversation_id, seq, body from messages where organisation_id = ${org} order by id`),
			audits: (await db.owner`select count(*)::int as n from chat_audit_events where organisation_id = ${org}`)[0]!.n,
			memberships: (await db.owner`select count(*)::int as n from memberships where organisation_id in (${org}, ${other.org})`)[0]!.n
		});
		const beforeRows = await snapshot();
		assert.deepEqual(await applyMigrations(db.owner, undefined, migration), [migration]);
		assert.deepEqual(await snapshot(), beforeRows, 'every retained row is unchanged');
		// The runtime role still sees exactly its own tenant's Work and chat, and nothing of the other organisation.
		const seen = await withTenant(db.app, { organisationId: other.org, userId: other.user }, async (tx: TransactionSql) => ({
			tasks: (await tx`select id from tasks`).length, contacts: (await tx`select id from contacts`).length,
			conversations: (await tx`select id from conversations`).length, messages: (await tx`select id from messages`).length
		}));
		assert.deepEqual(seen, { tasks: 0, contacts: 0, conversations: 0, messages: 0 });
		const mine = await withTenant(db.app, { organisationId: org, userId: user }, async (tx: TransactionSql) => ({
			tasks: (await tx`select id from tasks`).length, messages: (await tx`select id from messages`).length
		}));
		assert.deepEqual(mine, { tasks: 1, messages: 1 });
	} finally { await db.close(); }
});
