import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import type { TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0046 (threads contract §3–§5, D25), moved from the 0042 chat suite: private threads' database security,
// proven by direct SQL, bypassing any service, as the role the API connects as: the harness's `db.app` connection signs
// in as SQL-created `captain_runtime` (asserted below). Service-shaped helpers follow the linked-chat §6 lock order.
// Pins, stars and reads are in threads-personal.test.ts; record and topic threads in threads-access.test.ts.
const it = databaseUrl ? test : test.skip;
let db: Harness;
const RLS = /row-level security/;
const DENIED = /permission denied/;
const REFUSED = { code: '23514' }; // check_violation, raised by the transition triggers and CHECK constraints
const fp = (value: string) => createHash('sha256').update(value).digest();
const tables = ['threads', 'thread_participants', 'thread_tags', 'thread_messages', 'chat_audit_events'] as const;

before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(): Promise<string> {
	return (await db.owner<{ id: string }[]>`insert into organisations (name) values ('Chat test') returning id`)[0]!.id;
}
async function person(org: string, role: 'owner' | 'admin' | 'member' = 'member'): Promise<string> {
	const [user] = await db.owner<{ id: string }[]>`insert into users (email) values (${`${randomUUID()}@example.test`}) returning id`;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${user!.id}, ${role})`;
	return user!.id;
}
/** One transaction as the runtime role for this person in this organisation, failing instead of waiting on a lock cycle. */
function as<T>(org: string, user: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
	return withTenant(db.app, { organisationId: org, userId: user }, async (tx) => { await tx`set local lock_timeout = '5s'`; return work(tx); });
}
async function lockShare(tx: TransactionSql, org: string, users: string[]) {
	for (const user of [...new Set(users)].sort()) await tx`select 1 from memberships where organisation_id = ${org} and user_id = ${user} for share`;
}
async function audit(tx: TransactionSql, org: string, conversation: string, actor: string, action: string, kind: string, subject: string | null, personal = false) {
	await tx`insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, personal, detail)
		values (${org}, ${conversation}, ${actor}, ${action}, ${kind}, ${subject}, ${personal}, ${tx.json({ threadId: conversation })})`;
}
async function addIn(tx: TransactionSql, org: string, conversation: string, actor: string, user: string) {
	await tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by) values (${org}, ${conversation}, ${user}, ${actor})`;
	await tx`update threads set revision = revision + 1 where id = ${conversation}`;
	await audit(tx, org, conversation, actor, 'chat.participant_added', 'participant', user);
}
/** §6 create: lock caller and named people, bootstrap, then add the others only when created. */
function create(org: string, me: string, others: string[] = [], id: string = randomUUID(), title = 'Packaging slot', pause = 0): Promise<{ id: string; result: string }> {
	return as(org, me, async (tx) => {
		await lockShare(tx, org, [me, ...others]);
		if (pause) await tx`select pg_sleep(${pause})`;
		const [row] = await tx<{ result: string }[]>`select thread_create(${id}, 'private', ${title}, ${fp(title)}) as result`;
		if (row!.result === 'created') for (const user of others) await addIn(tx, org, id, me, user);
		return { id, result: row!.result };
	});
}
/** §6 send: sender's membership, then the conversation's counters, then the message. */
async function sendIn(tx: TransactionSql, org: string, me: string, conversation: string, body = 'Can we move the slot?', id: string = randomUUID()): Promise<string> {
	await lockShare(tx, org, [me]);
	// now() is the transaction's start: a send that began earlier can commit later, and last_message_at never goes back.
	const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1,
		last_message_at = greatest(last_message_at, now()) where id = ${conversation} returning last_seq, last_change`;
	if (!c) throw new Error('not a participant');
	await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
		values (${id}, ${org}, ${conversation}, ${c.lastSeq}, ${c.lastChange}, ${me}, ${body}, ${fp(body)})`;
	await audit(tx, org, conversation, me, 'chat.message_sent', 'message', id);
	return id;
}
function send(org: string, me: string, conversation: string, body = 'Can we move the slot?', id: string = randomUUID()): Promise<string> {
	return as(org, me, (tx) => sendIn(tx, org, me, conversation, body, id));
}
/** A leave in the contract's order: audit and revision while still a participant, then the row. */
async function leaveIn(tx: TransactionSql, org: string, me: string, conversation: string) {
	await audit(tx, org, conversation, me, 'chat.participant_left', 'participant', me);
	await tx`update threads set revision = revision + 1 where id = ${conversation}`;
	await tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${conversation} and user_id = ${me}`;
}
function tombstone(org: string, me: string, conversation: string, message: string) {
	return as(org, me, async (tx) => {
		await lockShare(tx, org, [me]);
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${conversation} returning last_change`;
		const rows = await tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${me},
			revision = revision + 1, change_seq = ${c!.lastChange} where id = ${message} returning id`;
		if (!rows.length) throw new Error('not visible');
		await audit(tx, org, conversation, me, 'chat.message_deleted', 'message', message);
	});
}
/** §6 organisation removal: actor (share) and target (no key update) in user_id order, then end chat participation. */
function removeMember(org: string, actor: string, target: string, pause = 0) {
	return as(org, actor, async (tx) => {
		const rows = actor === target ? [[target, 'nku']] : [[actor, 'share'], [target, 'nku']].sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
		for (const [user, mode] of rows) await tx`select 1 from memberships where organisation_id = ${org} and user_id = ${user!} ${mode === 'share' ? tx`for share` : tx`for no key update`}`;
		await tx`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${target}`;
		if (pause) await tx`select pg_sleep(${pause})`;
		await tx`select thread_end_membership(${target})`;
	});
}
const counts = (org: string, user: string) => as(org, user, async (tx) => {
	const result: Record<string, number> = {};
	// Private threads only: a task made in a test has a record thread every member sees (threads-access.test.ts).
	for (const table of tables) result[table] = (await tx.unsafe(table === 'threads' ? `select 1 from threads where kind = 'private'`
		: `select 1 from ${table} where thread_id in (select id from threads where kind = 'private')`)).length;
	return result;
});
const participantState = async (conversation: string, user: string) =>
	(await db.owner<{ state: string }[]>`select state from thread_participants where thread_id = ${conversation} and user_id = ${user}`)[0]?.state;

it('the suite really runs as captain_runtime, which bypasses nothing', async () => {
	const [who] = await db.app<{ current: string; session: string; rowSecurity: string }[]>`
		select current_user as current, session_user as session, current_setting('row_security') as row_security`;
	assert.deepEqual({ ...who }, { current: 'captain_runtime', session: 'captain_runtime', rowSecurity: 'on' });
	assert.equal(db.runtimeRole, 'captain_runtime');
	const [role] = await db.owner`select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication as elevated,
		(select count(*) from pg_auth_members m where m.member = r.oid)::int as memberships from pg_roles r where rolname = 'captain_runtime'`;
	assert.deepEqual({ ...role }, { elevated: false, memberships: 0 });
});

it('thread tables force row security, grant no deletes but stars and tags, and expose only three definer functions', async () => {
	for (const table of [...tables, 'thread_pins', 'thread_stars', 'thread_reads', 'task_series_tags']) {
		const [flags] = await db.owner<{ rls: boolean; forced: boolean }[]>`select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where relname = ${table}`;
		assert.deepEqual(flags, { rls: true, forced: true }, table);
	}
	// Both runtime roles hold the same privileges (D6): captain_runtime, which the API uses, and legacy `app`.
	for (const role of ['captain_runtime', 'app']) {
		const privilege = async (table: string, kind: string) => (await db.owner<{ ok: boolean }[]>`select has_table_privilege(${role}, ${table}, ${kind}) as ok`)[0]!.ok;
		for (const table of ['threads', 'thread_participants', 'thread_messages', 'thread_pins', 'thread_reads', 'chat_audit_events'])
			assert.equal(await privilege(table, 'DELETE'), false, `${role} ${table}`);
		for (const table of ['thread_stars', 'thread_tags']) assert.equal(await privilege(table, 'DELETE'), true, `${role} ${table}`);
		// Threads are inserted directly only as record threads (row security); topic and private ones come from thread_create.
		assert.equal(await privilege('threads', 'INSERT'), true, role);
		for (const table of ['thread_tags', 'chat_audit_events']) assert.equal(await privilege(table, 'UPDATE'), false, `${role} ${table}`);
	}
	const policies = await db.owner<{ name: string; roles: string[] }[]>`select policyname as name, roles::text[] as roles from pg_policies
		where tablename in ${db.owner([...tables])} order by policyname`;
	assert.equal(policies.length, 14);
	for (const policy of policies) assert.deepEqual([...policy.roles].sort(), ['app', 'captain_runtime'], policy.name);
	const functions = await db.owner<{ name: string; definer: boolean; callable: boolean; legacyCallable: boolean; config: string[] | null }[]>`
		select p.proname as name, p.prosecdef as definer, has_function_privilege('captain_runtime', p.oid, 'EXECUTE') as callable,
			has_function_privilege('app', p.oid, 'EXECUTE') as legacy_callable, p.proconfig as config
		from pg_proc p where p.proname like 'thread\\_%' order by p.proname`;
	assert.deepEqual(functions.filter((f) => f.callable).map((f) => f.name), ['thread_create', 'thread_end_membership', 'thread_visible']);
	assert.equal((await db.owner`select 1 from pg_proc where proname like 'chat\\_%'`).length, 0, 'no 0042/0043 chat function survives');
	assert.deepEqual(functions.map((f) => f.legacyCallable), functions.map((f) => f.callable), 'app can call exactly what captain_runtime can');
	assert.ok(functions.filter((f) => f.callable).every((f) => f.definer), 'the callable functions are the only elevated paths');
	// Transition triggers run as the invoker; the single non-callable definer is the commit-time seq check, which reads
	// past row security so a caller who then leaves cannot evade it.
	assert.deepEqual(functions.filter((f) => !f.callable && f.definer).map((f) => f.name), ['thread_seq_check']);
	assert.ok(functions.every((f) => (f.config ?? []).includes('search_path=pg_catalog, public, pg_temp')), 'every thread function pins its search_path');
	const names = (await db.owner<{ name: string }[]>`select conname as name from pg_constraint where conrelid in ('threads'::regclass, 'thread_messages'::regclass)`).map((r) => r.name);
	for (const name of ['threads_pkey', 'threads_organisation_id_id_key', 'thread_messages_pkey', 'thread_messages_organisation_id_id_key',
		'thread_messages_thread_seq', 'thread_messages_thread_change']) assert.ok(names.includes(name), name);
});

it('0046 checks captain_runtime, never legacy app, and refuses any runtime role that could gain more', async () => {
	// Roles are cluster-wide, so no shared role is ever altered: the migration's own precondition block runs against a
	// throwaway role, with only its role name substituted, inside a transaction that always rolls back.
	const text = await readFile(new URL('../migrations/0046_threads.sql', import.meta.url), 'utf8');
	const block = /-- runtime-role precondition: begin\n([\s\S]*?)-- runtime-role precondition: end/.exec(text)?.[1];
	const binding = "runtime constant name := 'captain_runtime'";
	assert.equal(block?.split(binding).length, 2, 'the precondition names captain_runtime once, in its binding');
	assert.ok(!/'app'|\bapp\b/.test(block!.replace(binding, '')), 'the precondition never inspects, or depends on, legacy app');
	await db.owner.unsafe(block!); // the harness's captain_runtime, as 0041_runtime_role made it
	const probe = `chat_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
	class RolledBack extends Error {}
	const check = (setup: string) => db.owner.begin(async (tx) => {
		if (setup) await tx.unsafe(setup);
		await tx.unsafe(block!.replace(binding, `runtime constant name := '${probe}'`));
		throw new RolledBack();
	});
	await assert.rejects(check(''), /requires the runtime role/);
	await assert.rejects(check(`create role ${probe} login`), RolledBack, 'a plain login role passes');
	for (const [setup, reason] of [
		[`create role ${probe} superuser`, /superuser/],
		[`create role ${probe} bypassrls`, /bypassrls/],
		[`create role ${probe} createrole`, /createrole/],
		[`create role ${probe} createdb`, /createdb/],
		[`create role ${probe} replication`, /replication/],
		// Attributes are not inherited, but any membership could reach a role's privileges or SET ROLE into it.
		[`create role ${probe}; grant pg_read_all_data to ${probe}`, /member of another role/],
		[`create role ${probe}; create role ${probe}_x; grant ${probe}_x to ${probe} with admin option, inherit false, set false`, /member of another role/],
		[`create role ${probe}; create table ${probe}_owned (); alter table ${probe}_owned owner to ${probe}`, /owns objects/],
	] as const) await assert.rejects(check(setup), reason, setup);
	assert.equal((await db.owner`select 1 from pg_roles where rolname like ${`${probe}%`}`).length, 0, 'every attempt rolled back');
});

it('the bootstrap creates one caller row and matches only its own creator’s identical retry', async () => {
	const org = await organisation(), other = await organisation();
	const alice = await person(org), bob = await person(org), carol = await person(org), outsider = await person(other);
	const { id } = await create(org, alice, [bob]);
	const participants = await db.owner<{ userId: string; addedBy: string }[]>`select user_id, added_by from thread_participants where thread_id = ${id} order by added_at, user_id`;
	assert.deepEqual(new Set(participants.map((p) => `${p.userId}:${p.addedBy}`)), new Set([`${alice}:${alice}`, `${bob}:${alice}`]));
	const [conversation] = await db.owner`select revision, last_seq, last_change, created_by from threads where id = ${id}`;
	assert.deepEqual(conversation, { revision: 2, lastSeq: 0, lastChange: 0, createdBy: alice });
	assert.equal((await db.owner`select 1 from chat_audit_events where thread_id = ${id} and action = 'chat.thread_created' and actor_id = ${alice}`).length, 1);

	assert.equal((await create(org, alice, [bob], id)).result, 'matched', 'an identical retry by the creator');
	assert.equal((await db.owner`select 1 from thread_participants where thread_id = ${id}`).length, 2, 'a matched retry adds nothing');
	assert.equal((await create(org, alice, [bob], id, 'Another title')).result, 'unavailable', 'a different fingerprint');
	assert.equal((await create(org, carol, [], id)).result, 'unavailable', 'another member');
	assert.equal((await create(other, outsider, [], id)).result, 'unavailable', 'another tenant');
	assert.equal((await db.owner`select 1 from threads where id = ${id}`).length, 1);

	// A direct insert is admitted only for a record thread whose record the role can see (its record's trigger).
	for (const kind of ['private', 'topic'])
		await assert.rejects(as(org, carol, (tx) => tx`insert into threads (id, organisation_id, kind, title, create_fingerprint, created_by)
			values (${randomUUID()}, ${org}, ${kind}, 'Direct', ${fp('x')}, ${carol})`), RLS, kind);
	await assert.rejects(as(org, carol, (tx) => tx`select thread_create(${randomUUID()}, 'record', ${'A record'}, ${fp('x')})`), REFUSED, 'no record thread from the bootstrap');
	await assert.rejects(as(org, carol, (tx) => tx`select thread_create(${randomUUID()}, 'private', ${'   '}, ${fp('x')})`), REFUSED);
	await assert.rejects(as(org, carol, (tx) => tx`select thread_create(${randomUUID()}, 'private', ${'Short hash'}, ${Buffer.alloc(8)})`), REFUSED);

	await as(org, alice, async (tx) => {
		await audit(tx, org, id, alice, 'chat.participant_left', 'participant', alice);
		await tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${id} and user_id = ${alice}`;
	});
	assert.equal((await create(org, alice, [bob], id)).result, 'unavailable', 'a creator who left has no lasting power');
});

it('nobody but an active participant sees a private thread, its tags, messages or audit — owners and admins included', async () => {
	const org = await organisation(), other = await organisation();
	const owner = await person(org, 'owner'), admin = await person(org, 'admin'), alice = await person(org), bob = await person(org), carol = await person(org);
	const outsider = await person(other, 'owner');
	const [tag] = await db.owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Canning') returning id`;
	const { id } = await create(org, alice, [bob]);
	await send(org, alice, id);
	await as(org, alice, async (tx) => {
		await tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${id}, ${tag!.id}, ${alice})`;
		await tx`update threads set revision = revision + 1 where id = ${id}`;
		await audit(tx, org, id, alice, 'chat.tag_added', 'tag', tag!.id);
	});
	// Audit: created, participant added, message sent, tag added.
	assert.deepEqual(await counts(org, alice), { threads: 1, thread_participants: 2, thread_tags: 1, thread_messages: 1, chat_audit_events: 4 });
	for (const user of [owner, admin, carol]) assert.deepEqual(Object.values(await counts(org, user)), [0, 0, 0, 0, 0], user);
	assert.deepEqual(Object.values(await counts(other, outsider)), [0, 0, 0, 0, 0]);
	assert.deepEqual(Object.values(await counts(org, bob)).slice(0, 4), [1, 2, 1, 1]);
	await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${bob}`;
	assert.deepEqual(Object.values(await counts(org, bob)), [0, 0, 0, 0, 0], 'an inactive membership sees nothing, even before its participation ends');
	assert.equal((await as(org, carol, (tx) => tx<{ ok: boolean }[]>`select thread_visible(${id}) as ok`))[0]!.ok, false);
	assert.equal((await as(org, alice, (tx) => tx<{ ok: boolean }[]>`select thread_visible(${id}) as ok`))[0]!.ok, true);
});

it('an insert naming an inaccessible conversation fails exactly like one naming a conversation that does not exist', async () => {
	const org = await organisation();
	const alice = await person(org), carol = await person(org);
	const { id } = await create(org, alice);
	const [tag] = await db.owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Trade pack') returning id`;
	const attempts = (conversation: string) => [
		(tx: TransactionSql) => tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
			values (${randomUUID()}, ${org}, ${conversation}, 1, 1, ${carol}, 'Hi', ${fp('Hi')})`,
		(tx: TransactionSql) => tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by)
			values (${org}, ${conversation}, ${tag!.id}, ${carol})`,
		(tx: TransactionSql) => tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by) values (${org}, ${conversation}, ${carol}, ${carol})`,
		(tx: TransactionSql) => audit(tx, org, conversation, carol, 'chat.message_sent', 'message', null),
	];
	const failure = async (work: (tx: TransactionSql) => Promise<unknown>) => {
		try { await as(org, carol, work); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
		return null;
	};
	const hidden = attempts(id), missing = attempts(randomUUID());
	for (let i = 0; i < hidden.length; i++) {
		const [a, b] = [await failure(hidden[i]!), await failure(missing[i]!)];
		assert.ok(a && RLS.test(a.message), JSON.stringify(a));
		assert.deepEqual(a, b, `attempt ${i}: identical refusal`);
	}
});

it('participant transitions are enforced in the database: leave self, remove by an admin participant, explicit re-add only', async () => {
	const org = await organisation();
	const admin = await person(org, 'admin'), alice = await person(org), bob = await person(org), carol = await person(org), dave = await person(org);
	const { id } = await create(org, alice, [bob, admin]);
	const setState = (actor: string, user: string, state: string) => as(org, actor, (tx) =>
		tx`update thread_participants set state = ${state}, ended_at = ${state === 'active' ? null : new Date()} where thread_id = ${id} and user_id = ${user} returning user_id`);

	await assert.rejects(as(org, carol, (tx) => tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by) values (${org}, ${id}, ${carol}, ${carol})`), RLS);
	await assert.rejects(as(org, bob, (tx) => tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by) values (${org}, ${id}, ${carol}, ${alice})`), REFUSED, 'added_by is the person adding');
	await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${dave}`;
	await assert.rejects(as(org, bob, (tx) => addIn(tx, org, id, bob, dave)), REFUSED, 'an inactive member cannot be added');
	await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${dave}`;

	for (const state of ['left', 'removed']) await assert.rejects(setState(bob, alice, state), REFUSED, `a member cannot set another person's row to ${state}`);
	await assert.rejects(setState(bob, bob, 'removed'), REFUSED, 'nobody removes themselves; they leave');
	assert.equal((await setState(admin, bob, 'removed')).length, 1, 'an owner or admin who participates removes others');
	assert.equal(await participantState(id, bob), 'removed');
	assert.equal((await as(org, bob, (tx) => tx`update thread_participants set state = 'active', ended_at = null, added_by = ${bob} where thread_id = ${id} and user_id = ${bob} returning user_id`)).length, 0, 'no self re-add');
	// Bob was first added by Alice; a re-add by the admin that keeps Alice as the adder is refused.
	await assert.rejects(as(org, admin, (tx) => tx`update thread_participants set state = 'active', ended_at = null where thread_id = ${id} and user_id = ${bob}`), REFUSED, 'a re-add names its adder');
	assert.equal((await as(org, alice, (tx) => tx`update thread_participants set state = 'active', ended_at = null, added_by = ${alice}
		where thread_id = ${id} and user_id = ${bob} returning user_id`)).length, 1, 'an explicit re-add by a participant');
	await assert.rejects(as(org, alice, (tx) => tx`update thread_participants set user_id = ${carol} where thread_id = ${id} and user_id = ${bob}`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`update thread_participants set added_at = now() - interval '1 day' where thread_id = ${id} and user_id = ${bob}`), REFUSED);
});

it('a leave audits before access ends; the wrong order or a failed change writes nothing', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), carol = await person(org);
	const { id } = await create(org, alice, [bob, carol]);
	const leftRows = async (user: string) => (await db.owner`select 1 from chat_audit_events where thread_id = ${id} and action = 'chat.participant_left' and actor_id = ${user}`).length;
	// Everything that needs access happens first: the audit row and the revision bump, then the leave itself.
	await as(org, bob, async (tx) => {
		await audit(tx, org, id, bob, 'chat.participant_left', 'participant', bob);
		await tx`update threads set revision = revision + 1 where id = ${id}`;
		await tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${id} and user_id = ${bob}`;
	});
	assert.equal((await db.owner<{ revision: number }[]>`select revision from threads where id = ${id}`)[0]!.revision, 4, 'the leave moved the revision');
	assert.equal(await leftRows(bob), 1); assert.equal(await participantState(id, bob), 'left');
	await assert.rejects(as(org, carol, async (tx) => {
		await tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${id} and user_id = ${carol}`;
		await audit(tx, org, id, carol, 'chat.participant_left', 'participant', carol);
	}), RLS, 'auditing after losing access is refused, and the leave rolls back with it');
	assert.equal(await leftRows(carol), 0); assert.equal(await participantState(id, carol), 'active');
	await assert.rejects(as(org, carol, async (tx) => {
		await audit(tx, org, id, carol, 'chat.participant_left', 'participant', carol);
		await tx`update thread_participants set state = 'left', added_at = now() - interval '1 day' where thread_id = ${id} and user_id = ${carol}`;
	}), REFUSED, 'a failed state change after the audit insert');
	assert.equal(await leftRows(carol), 0, 'the audit row rolled back'); assert.equal(await participantState(id, carol), 'active');
	assert.equal((await as(org, bob, (tx) => tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${id} and user_id = ${bob} returning user_id`)).length, 0);
	await assert.rejects(as(org, bob, (tx) => audit(tx, org, id, bob, 'chat.participant_left', 'participant', bob)), RLS, 'a former participant writes nothing');
	assert.equal(await leftRows(bob), 1);
});

it('messages: counters must match; only the author or an admin participant tombstones; nobody rewrites text', async () => {
	const org = await organisation();
	const admin = await person(org, 'admin'), alice = await person(org), bob = await person(org);
	const { id } = await create(org, alice, [bob, admin]);
	const first = await send(org, alice, id, 'Slot moved to Thursday');
	const [before] = await db.owner<{ lastSeq: number; lastChange: number; revision: number }[]>`select last_seq, last_change, revision from threads where id = ${id}`;
	assert.deepEqual(before, { lastSeq: 1, lastChange: 1, revision: 3 }, 'a send leaves the revision alone');

	await assert.rejects(as(org, alice, async (tx) => {
		await tx`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${id}`;
		await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
			values (${randomUUID()}, ${org}, ${id}, 5, 2, ${alice}, 'Skip', ${fp('Skip')})`;
	}), REFUSED, 'the counters must match');
	// Without advancing the conversation the numbers are already taken: a bug, surfacing as the named seq constraint.
	await assert.rejects(as(org, alice, (tx) => tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
		values (${randomUUID()}, ${org}, ${id}, 1, 1, ${alice}, 'Stale', ${fp('Stale')})`), (error: unknown) =>
		(error as { code?: string }).code === '23505' && (error as { constraint_name?: string }).constraint_name === 'thread_messages_thread_seq');
	await assert.rejects(as(org, alice, async (tx) => {
		const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${id} returning last_seq, last_change`;
		await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
			values (${randomUUID()}, ${org}, ${id}, ${c!.lastSeq}, ${c!.lastChange}, ${bob}, 'As Bob', ${fp('As Bob')})`;
	}), REFUSED, 'nobody sends as someone else');

	const update = (actor: string, set: string) => as(org, actor, (tx) => tx.unsafe(`update thread_messages set ${set} where id = $1`, [first]));
	await assert.rejects(update(bob, `body = 'Rewritten'`), REFUSED, 'another person’s live text');
	await assert.rejects(update(alice, `body = 'Edited'`), REFUSED, 'author edits arrive in PR C');
	await assert.rejects(update(alice, 'seq = 9'), REFUSED);
	await assert.rejects(update(alice, `author_id = '${bob}'`), REFUSED);
	await assert.rejects(update(alice, 'author_id = null'), REFUSED, 'Rule A only for a membership that no longer exists');
	await assert.rejects(tombstone(org, bob, id, first), REFUSED, 'a member cannot tombstone someone else’s message');
	await assert.rejects(as(org, alice, async (tx) => {
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${id} returning last_change`;
		await tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${bob}, revision = revision + 1, change_seq = ${c!.lastChange} where id = ${first}`;
	}), REFUSED, 'deleted_by is the person deleting');
	await assert.rejects(as(org, alice, (tx) => tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${alice},
		revision = revision + 1 where id = ${first}`), REFUSED, 'a tombstone takes a fresh change number');
	await assert.rejects(as(org, admin, async (tx) => {
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${id} returning last_change`;
		await tx`update thread_messages set body = 'Moderated', sent_body_sha256 = null, deleted_at = now(), deleted_by = ${admin}, revision = revision + 1, change_seq = ${c!.lastChange} where id = ${first}`;
	}), REFUSED, 'a moderator cannot put text in a tombstone');

	await tombstone(org, admin, id, first);
	const [dead] = await db.owner`select body, sent_body_sha256, deleted_by, revision, change_seq, author_id from thread_messages where id = ${first}`;
	assert.deepEqual(dead, { body: null, sentBodySha256: null, deletedBy: admin, revision: 2, changeSeq: 2, authorId: alice });
	const [afterDelete] = await db.owner<{ lastSeq: number; lastChange: number; revision: number }[]>`select last_seq, last_change, revision from threads where id = ${id}`;
	assert.deepEqual(afterDelete, { lastSeq: 1, lastChange: 2, revision: 3 }, 'a tombstone moves only last_change');
	await assert.rejects(tombstone(org, alice, id, first), REFUSED, 'a tombstone is final');
	const own = await send(org, bob, id, 'My own note');
	await tombstone(org, bob, id, own);
});

it('concurrent sends get a dense, gap-free seq and never move last_message_at back', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org);
	const { id } = await create(org, alice, [bob]);
	// Sends that start first (earlier now()) may commit later: greatest() keeps last_message_at from going back.
	const sends = await Promise.all([...Array(6)].map((_, i) => send(org, i % 2 ? bob : alice, id, `Message ${i}`)));
	const seqs = (await db.owner<{ seq: number; changeSeq: number }[]>`select seq, change_seq from thread_messages where thread_id = ${id} order by seq`);
	assert.deepEqual(seqs.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
	assert.deepEqual(seqs.map((m) => m.changeSeq), [1, 2, 3, 4, 5, 6]);
	assert.equal(sends.length, 6);
	const [row] = await db.owner<{ lastSeq: number; lastChange: number; revision: number }[]>`select last_seq, last_change, revision from threads where id = ${id}`;
	assert.deepEqual(row, { lastSeq: 6, lastChange: 6, revision: 2 });
});

it('every advanced seq has its message by commit — a bare bump fails, even when the bumper then leaves', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), carol = await person(org);
	const { id } = await create(org, alice, [bob, carol]);
	const lastSeq = async () => (await db.owner<{ lastSeq: number }[]>`select last_seq from threads where id = ${id}`)[0]!.lastSeq;
	const bump = (tx: TransactionSql) => tx`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${id}`;

	await assert.rejects(as(org, alice, bump), REFUSED, 'a counter advance with no message');
	assert.equal(await lastSeq(), 0);
	// Row security would hide the conversation from Bob once he has left; the commit-time check does not rely on it.
	await assert.rejects(as(org, bob, async (tx) => { await bump(tx); await leaveIn(tx, org, bob, id); }), REFUSED, 'advance, then leave');
	assert.equal(await lastSeq(), 0); assert.equal(await participantState(id, bob), 'active', 'the whole transaction rolled back');

	await as(org, bob, async (tx) => { await sendIn(tx, org, bob, id, 'Last word before I go'); await leaveIn(tx, org, bob, id); });
	assert.equal(await lastSeq(), 1, 'a real send followed by a leave commits'); assert.equal(await participantState(id, bob), 'left');
	await as(org, alice, async (tx) => { await sendIn(tx, org, alice, id, 'One'); await sendIn(tx, org, alice, id, 'Two'); });
	assert.equal(await lastSeq(), 3, 'each send in one transaction checks its own number');
	await as(org, alice, async (tx) => {
		await tx.savepoint(async (sp) => { await bump(sp); throw new Error('roll back to the savepoint'); }).catch(() => undefined);
		await sendIn(tx, org, alice, id, 'After a rolled-back advance');
	});
	assert.equal(await lastSeq(), 4, 'an advance rolled back with its savepoint is not checked');
	assert.deepEqual((await db.owner<{ seq: number }[]>`select seq from thread_messages where thread_id = ${id} order by seq`).map((m) => m.seq), [1, 2, 3, 4]);

	const other = await organisation();
	const owner = await person(other, 'owner');
	const doomed = (await create(other, owner)).id;
	await withTenant(db.app, { organisationId: other, userId: owner }, async (tx) => {
		await sendIn(tx, other, owner, doomed, 'Closing the business');
		await tx`delete from organisations where id = ${other}`;
	});
	assert.equal((await db.owner`select 1 from threads where id = ${doomed}`).length, 0, 'organisation deletion after a send still commits');
});

it('chat timestamps are the server’s: caller-chosen times are ignored on every insert and transition', async () => {
	const org = await organisation();
	const admin = await person(org, 'admin'), alice = await person(org), bob = await person(org), carol = await person(org);
	const [tag] = await db.owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Pallet labels') returning id`;
	const { id } = await create(org, alice, [bob, admin]);
	const past = new Date('2001-01-01T00:00:00Z'), future = new Date('2099-01-01T00:00:00Z');
	const serverTime = (value: Date | null | undefined) => value instanceof Date && value.getTime() > Date.parse('2020-01-01') && value.getTime() < Date.parse('2090-01-01');
	const message = randomUUID();
	await as(org, alice, async (tx) => {
		await tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by, added_at) values (${org}, ${id}, ${carol}, ${alice}, ${past})`;
		await tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by, attached_at) values (${org}, ${id}, ${tag!.id}, ${alice}, ${past})`;
		await tx`insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, created_at) values (${org}, ${id}, ${alice}, 'chat.tag_added', 'tag', ${past})`;
		const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1, last_message_at = ${future}
			where id = ${id} returning last_seq, last_change`;
		await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256, created_at)
			values (${message}, ${org}, ${id}, ${c!.lastSeq}, ${c!.lastChange}, ${alice}, 'Dated', ${fp('Dated')}, ${past})`;
	});
	const [conversation] = await db.owner<{ createdAt: Date; lastMessageAt: Date }[]>`select created_at, last_message_at from threads where id = ${id}`;
	assert.ok(serverTime(conversation!.createdAt) && serverTime(conversation!.lastMessageAt), 'a send sets last_message_at itself');
	const [sent] = await db.owner<{ createdAt: Date }[]>`select created_at from thread_messages where id = ${message}`;
	assert.equal(sent!.createdAt.getTime(), conversation!.lastMessageAt.getTime(), 'a message takes its send’s time');
	assert.ok(serverTime((await db.owner<{ addedAt: Date }[]>`select added_at from thread_participants where thread_id = ${id} and user_id = ${carol}`)[0]!.addedAt));
	assert.ok(serverTime((await db.owner<{ createdAt: Date }[]>`select attached_at as created_at from thread_tags where thread_id = ${id}`)[0]!.createdAt));
	const audits = await db.owner<{ createdAt: Date }[]>`select created_at from chat_audit_events where thread_id = ${id}`;
	assert.ok(audits.length > 0 && audits.every((row) => serverTime(row.createdAt)), 'no back-dated audit');

	await as(org, bob, (tx) => tx`update thread_participants set state = 'left', ended_at = ${future} where thread_id = ${id} and user_id = ${bob}`);
	await as(org, admin, (tx) => tx`update thread_participants set state = 'removed', ended_at = ${past} where thread_id = ${id} and user_id = ${carol}`);
	const ended = await db.owner<{ endedAt: Date }[]>`select ended_at from thread_participants where thread_id = ${id} and user_id in ${db.owner([bob, carol])}`;
	assert.ok(ended.length === 2 && ended.every((row) => serverTime(row.endedAt)), 'leave and removal times are the server’s');
	await as(org, alice, (tx) => tx`update thread_participants set state = 'active', added_by = ${alice}, added_at = ${past}, ended_at = ${future}
		where thread_id = ${id} and user_id = ${bob}`);
	const [readded] = await db.owner<{ addedAt: Date; endedAt: Date | null }[]>`select added_at, ended_at from thread_participants where thread_id = ${id} and user_id = ${bob}`;
	assert.ok(serverTime(readded!.addedAt)); assert.equal(readded!.endedAt, null, 're-add clears ended_at');
	await as(org, alice, async (tx) => {
		const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${id} returning last_change`;
		await tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = ${past}, deleted_by = ${alice}, revision = revision + 1, change_seq = ${c!.lastChange} where id = ${message}`;
	});
	assert.ok(serverTime((await db.owner<{ deletedAt: Date }[]>`select deleted_at from thread_messages where id = ${message}`)[0]!.deletedAt), 'a tombstone’s time is the server’s');
});

it('conversation counters move by at most one, and revision never moves with message counters', async () => {
	const org = await organisation();
	const alice = await person(org);
	const { id } = await create(org, alice);
	const change = (set: string) => as(org, alice, (tx) => tx.unsafe(`update threads set ${set} where id = $1`, [id]));
	await change(`title = 'Renamed', revision = revision + 1`);
	await assert.rejects(change(`title = 'Quietly'`), REFUSED, 'a title change moves the revision');
	await assert.rejects(change('revision = revision + 2'), REFUSED);
	await assert.rejects(change('last_seq = last_seq + 1'), REFUSED, 'a send moves both counters');
	await assert.rejects(change('last_seq = last_seq + 1, last_change = last_change + 1, revision = revision + 1'), REFUSED, 'no combining the groups');
	await assert.rejects(change('last_change = last_change + 2'), REFUSED);
	await send(org, alice, id);
	await assert.rejects(change('last_seq = last_seq - 1'), REFUSED, 'counters never go back');
	await assert.rejects(change(`last_message_at = now() - interval '1 day'`), REFUSED);
	await assert.rejects(change(`create_fingerprint = '\\x00'::bytea`), REFUSED);
	const [row] = await db.owner`select title, revision, last_seq, last_change from threads where id = ${id}`;
	assert.deepEqual(row, { title: 'Renamed', revision: 2, lastSeq: 1, lastChange: 1 });
});

it('chat audit is participant-scoped and append-only; personal rows are the actor’s alone', async () => {
	const org = await organisation();
	const owner = await person(org, 'owner'), alice = await person(org), bob = await person(org);
	const { id } = await create(org, alice, [bob]);
	await as(org, alice, (tx) => audit(tx, org, id, alice, 'chat.star_set', 'star', null, true));
	const actions = (user: string) => as(org, user, async (tx) => (await tx<{ action: string }[]>`select action from chat_audit_events order by created_at, id`).map((r) => r.action));
	assert.ok((await actions(alice)).includes('chat.star_set'));
	assert.ok(!(await actions(bob)).includes('chat.star_set'), 'personal rows are visible only to their actor');
	assert.ok((await actions(bob)).includes('chat.thread_created'));
	assert.deepEqual(await actions(owner), []);
	await assert.rejects(as(org, alice, (tx) => audit(tx, org, id, bob, 'chat.message_sent', 'message', null)), REFUSED, 'audit names the person acting');
	await assert.rejects(as(org, alice, (tx) => audit(tx, org, id, alice, 'chat.star_set', 'star', null, false)), REFUSED, 'personal flag follows the action');
	await assert.rejects(as(org, alice, (tx) => tx`update chat_audit_events set detail = '{}' where thread_id = ${id}`), DENIED);
	await assert.rejects(as(org, alice, (tx) => tx`delete from chat_audit_events where thread_id = ${id}`), DENIED);
	assert.equal((await db.owner`select 1 from audit_events where subject_id = ${id} or detail::text like ${`%${id}%`}`).length, 0, 'the tenant-wide audit log carries no chat identifiers');
});

it('removal from the organisation ends participation everywhere through thread_end_membership, and reactivation restores nothing', async () => {
	const org = await organisation(), other = await organisation();
	const owner = await person(org, 'owner'), alice = await person(org), bob = await person(org), carol = await person(org), dave = await person(org);
	const outsider = await person(other, 'owner');
	const one = (await create(org, alice, [bob, carol])).id, two = (await create(org, bob, [carol])).id;
	const revisions = async () => Object.fromEntries((await db.owner<{ id: string; revision: number }[]>`select id, revision from threads where id in ${db.owner([one, two])}`).map((r) => [r.id, r.revision]));
	const before = await revisions();

	await assert.rejects(as(org, bob, (tx) => tx`select thread_end_membership(${carol})`), /refused/, 'the target is still active');
	await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${carol}`;
	await assert.rejects(as(org, bob, (tx) => tx`select thread_end_membership(${carol})`), /refused/, 'a member caller');
	await assert.rejects(as(other, outsider, (tx) => tx`select thread_end_membership(${carol})`), /refused/, 'another tenant');
	await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${carol}`;

	await removeMember(org, owner, carol);
	assert.equal(await participantState(one, carol), 'removed'); assert.equal(await participantState(two, carol), 'removed');
	const after = await revisions();
	assert.equal(after[one], before[one]! + 1); assert.equal(after[two], before[two]! + 1);
	const written = await db.owner<{ actorId: string; subjectId: string; detail: Record<string, unknown> }[]>`select actor_id, subject_id, detail from chat_audit_events where action = 'chat.participant_removed' and subject_id = ${carol}`;
	assert.equal(written.length, 2); assert.ok(written.every((r) => r.actorId === owner && Object.keys(r.detail).sort().join() === 'revision,threadId,userId'));
	assert.deepEqual(Object.values(await counts(org, owner)), [0, 0, 0, 0, 0], 'the removing admin reads none of the rows it wrote');
	const [returned] = await as(org, owner, (tx) => tx<{ result: unknown }[]>`select thread_end_membership(${carol}) as result`);
	assert.ok(returned!.result === '' || returned!.result === null, 'it returns nothing (void)');
	const [signature] = await db.owner<{ type: string }[]>`select pg_get_function_result('thread_end_membership(uuid)'::regprocedure) as type`;
	assert.equal(signature!.type, 'void');

	await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${carol}`;
	assert.equal(await participantState(one, carol), 'removed', 'reactivation restores nothing');
	assert.deepEqual(Object.values(await counts(org, carol)), [0, 0, 0, 0, 0]);
	await as(org, alice, (tx) => tx`update thread_participants set state = 'active', ended_at = null, added_by = ${alice} where thread_id = ${one} and user_id = ${carol}`);
	assert.equal((await counts(org, carol)).threads, 1, 'only an explicit re-add brings them back');

	await removeMember(org, dave, dave);
	await removeMember(org, bob, bob);
	assert.equal(await participantState(one, bob), 'removed', 'self-removal from the organisation');
});

it('lock order: concurrent removals by one admin and a create racing a removal all finish without a lock cycle', async () => {
	const org = await organisation();
	const owner = await person(org, 'owner'), alice = await person(org), carol = await person(org), dave = await person(org), erin = await person(org);
	const x = (await create(org, alice, [carol, dave])).id, y = (await create(org, alice, [carol, dave])).id;
	const outcomes = await Promise.allSettled([removeMember(org, owner, carol, 0.2), removeMember(org, owner, dave, 0.2)]);
	assert.deepEqual(outcomes.map((o) => o.status), ['fulfilled', 'fulfilled'], JSON.stringify(outcomes));
	for (const c of [x, y]) for (const u of [carol, dave]) assert.equal(await participantState(c, u), 'removed');

	const race = await Promise.allSettled([create(org, alice, [erin], randomUUID(), 'Race', 0.2), removeMember(org, owner, erin, 0.1)]);
	for (const outcome of race) if (outcome.status === 'rejected') assert.equal((outcome.reason as { code?: string }).code, '23514', 'only participant_unavailable, never a lock timeout or deadlock');
	assert.equal((await db.owner`select 1 from thread_participants where user_id = ${erin} and state = 'active'`).length, 0, 'the removed person ends with no active participation');
});

it('the same client ID from different people at once: exactly one wins, the other is a mapped collision', async () => {
	const org = await organisation(), other = await organisation();
	const alice = await person(org), bob = await person(org), outsider = await person(other);
	for (const [first, second] of [[[org, alice], [org, bob]], [[org, alice], [other, outsider]]] as const) {
		const id = randomUUID();
		const results = await Promise.all([create(first[0], first[1], [], id, 'Same id', 0.05), create(second[0], second[1], [], id, 'Same id', 0.05)]);
		assert.deepEqual(results.map((r) => r.result).sort(), ['created', 'unavailable'], 'no exception escapes the bootstrap');
	}
	const a = (await create(org, alice)).id, b = (await create(org, bob)).id;
	const id = randomUUID();
	const attempt = (me: string, conversation: string) => as(org, me, async (tx) => {
		await lockShare(tx, org, [me]);
		const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${conversation} returning last_seq, last_change`;
		await tx`select pg_sleep(0.05)`;
		const rows = await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
			values (${id}, ${org}, ${conversation}, ${c!.lastSeq}, ${c!.lastChange}, ${me}, 'Same id', ${fp('Same id')}) on conflict (id) do nothing returning id`;
		if (!rows.length) throw Object.assign(new Error('id unavailable'), { mapped: true });
		return 'sent';
	});
	const outcomes = await Promise.allSettled([attempt(alice, a), attempt(bob, b)]);
	assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
	const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
	assert.ok(loser.reason.mapped || ['thread_messages_pkey', 'thread_messages_organisation_id_id_key'].includes(loser.reason.constraint_name), String(loser.reason));
	assert.equal((await db.owner`select 1 from thread_messages where id = ${id}`).length, 1);
});

it('account and organisation deletion null attribution on live rows, tombstones and audit without bumps, then cascade', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), carol = await person(org);
	const [tag] = await db.owner<{ id: string }[]>`insert into tags (organisation_id, name) values (${org}, 'Launch') returning id`;
	const { id } = await create(org, alice, [bob]);
	await as(org, bob, (tx) => addIn(tx, org, id, bob, carol));
	await as(org, bob, (tx) => tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${org}, ${id}, ${tag!.id}, ${bob})`);
	const bobs = await send(org, bob, id, 'Bob wrote this');
	const alices = await send(org, alice, id, 'Alice wrote this');
	await tombstone(org, bob, id, bobs);
	const snapshot = async () => ({
		conversation: (await db.owner`select revision, last_seq, last_change, created_by from threads where id = ${id}`)[0],
		messages: await db.owner`select id, revision, change_seq, author_id, deleted_by from thread_messages where thread_id = ${id} order by seq`,
	});
	const before = await snapshot();

	await db.app`delete from users where id = ${bob}`; // account deletion cascades to the membership
	const after = await snapshot();
	assert.deepEqual(after.conversation, before.conversation, 'no counter or revision moved');
	assert.deepEqual(after.messages.map((m) => [m.id, m.revision, m.changeSeq]), before.messages.map((m) => [m.id, m.revision, m.changeSeq]));
	assert.deepEqual(after.messages.find((m) => m.id === bobs), { id: bobs, revision: 2, changeSeq: 3, authorId: null, deletedBy: null }, 'a tombstone is nulled too');
	assert.equal(after.messages.find((m) => m.id === alices)!.authorId, alice);
	assert.equal((await db.owner`select 1 from thread_participants where user_id = ${bob}`).length, 0, 'participation cascades');
	assert.equal((await db.owner<{ addedBy: string | null }[]>`select added_by from thread_participants where user_id = ${carol}`)[0]!.addedBy, null);
	assert.equal((await db.owner<{ attachedBy: string | null }[]>`select attached_by from thread_tags where thread_id = ${id}`)[0]!.attachedBy, null);
	assert.equal((await db.owner`select 1 from chat_audit_events where thread_id = ${id} and actor_id is null`).length > 0, true);

	await db.owner`delete from memberships where organisation_id = ${org} and user_id = ${alice}`; // membership deletion alone
	assert.equal((await db.owner<{ createdBy: string | null }[]>`select created_by from threads where id = ${id}`)[0]!.createdBy, null);

	const other = await organisation();
	const owner = await person(other, 'owner'), member = await person(other);
	const doomed = (await create(other, owner, [member])).id;
	const doomedMessage = await send(other, member, doomed);
	await send(other, owner, doomed);
	await tombstone(other, owner, doomed, doomedMessage);
	await withTenant(db.app, { organisationId: other, userId: owner }, (tx) => tx`delete from organisations where id = ${other}`);
	for (const table of tables) assert.equal((await db.owner.unsafe(`select 1 from ${table} where organisation_id = $1`, [other])).length, 0, table);
});
