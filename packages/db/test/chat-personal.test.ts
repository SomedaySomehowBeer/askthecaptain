import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Sql, TransactionSql } from 'postgres';
import { applyMigrations } from '../src/migrate.ts';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0043 (D25, linked-chat contract §5, §9.3, §9.4, §13; PR C): pins, stars, read positions and author edits,
// proven by direct SQL, bypassing any service, as the role the API connects as (`db.app` signs in as captain_runtime).
// Service-shaped helpers follow the §6 lock order: membership, then conversation, then message, then pin.
const it = databaseUrl ? test : test.skip;
let db: Harness;
const RLS = /row-level security/;
const DENIED = /permission denied/;
const REFUSED = { code: '23514' }; // check_violation, raised by the transition triggers and CHECK constraints
const fp = (value: string) => createHash('sha256').update(value).digest();
const newTables = ['message_pins', 'conversation_stars', 'conversation_reads'] as const;

before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

// Fixtures ------------------------------------------------------------------------------------------------------

async function organisation(h: Harness = db): Promise<string> {
	return (await h.owner<{ id: string }[]>`insert into organisations (name) values ('Chat personal test') returning id`)[0]!.id;
}
async function person(org: string, role: 'owner' | 'admin' | 'member' = 'member', h: Harness = db): Promise<string> {
	const [user] = await h.owner<{ id: string }[]>`insert into users (email) values (${`${randomUUID()}@example.test`}) returning id`;
	await h.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${user!.id}, ${role})`;
	return user!.id;
}
/** One transaction as the runtime role for this person in this organisation, failing instead of waiting on a lock cycle. */
function as<T>(org: string, user: string, work: (tx: TransactionSql) => Promise<T>, runtime: Sql = db.app): Promise<T> {
	return withTenant(runtime, { organisationId: org, userId: user }, async (tx) => { await tx`set local lock_timeout = '5s'`; return work(tx); });
}
async function lockShare(tx: TransactionSql, org: string, users: string[]) {
	for (const user of [...new Set(users)].sort()) await tx`select 1 from memberships where organisation_id = ${org} and user_id = ${user} for share`;
}
async function lockConversation(tx: TransactionSql, conversation: string) {
	const rows = await tx`select 1 from conversations where id = ${conversation} for update`;
	if (!rows.length) throw new Error('not a participant');
}
async function addIn(tx: TransactionSql, org: string, conversation: string, actor: string, user: string, extra: { readStartSeq?: number } = {}) {
	if (extra.readStartSeq === undefined) await tx`insert into conversation_participants (organisation_id, conversation_id, user_id, added_by) values (${org}, ${conversation}, ${user}, ${actor})`;
	else await tx`insert into conversation_participants (organisation_id, conversation_id, user_id, added_by, read_start_seq) values (${org}, ${conversation}, ${user}, ${actor}, ${extra.readStartSeq})`;
	await tx`update conversations set revision = revision + 1 where id = ${conversation}`;
}
function create(org: string, me: string, others: string[] = [], runtime: Sql = db.app): Promise<string> {
	const id = randomUUID();
	return as(org, me, async (tx) => {
		await lockShare(tx, org, [me, ...others]);
		const [row] = await tx<{ result: string }[]>`select chat_create_conversation(${id}, 'Pins and reads', ${fp('Pins and reads')}) as result`;
		assert.equal(row!.result, 'created');
		for (const user of others) await addIn(tx, org, id, me, user);
		return id;
	}, runtime);
}
async function sendIn(tx: TransactionSql, org: string, me: string, conversation: string, body = 'Can we move the slot?'): Promise<string> {
	const id = randomUUID();
	await lockShare(tx, org, [me]);
	const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update conversations set last_seq = last_seq + 1, last_change = last_change + 1,
		last_message_at = greatest(last_message_at, now()) where id = ${conversation} returning last_seq, last_change`;
	if (!c) throw new Error('not a participant');
	await tx`insert into messages (id, organisation_id, conversation_id, seq, change_seq, author_id, body, sent_body_sha256)
		values (${id}, ${org}, ${conversation}, ${c.lastSeq}, ${c.lastChange}, ${me}, ${body}, ${fp(body)})`;
	return id;
}
const send = (org: string, me: string, conversation: string, body?: string, runtime: Sql = db.app) => as(org, me, (tx) => sendIn(tx, org, me, conversation, body), runtime);
/** Advances last_change once, under the conversation lock, and returns the new number. */
async function nextChange(tx: TransactionSql, conversation: string): Promise<number> {
	const [c] = await tx<{ lastChange: number }[]>`update conversations set last_change = last_change + 1 where id = ${conversation} returning last_change`;
	if (!c) throw new Error('not a participant');
	return c.lastChange;
}
async function editIn(tx: TransactionSql, org: string, me: string, conversation: string, message: string, body: string) {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	const change = await nextChange(tx, conversation);
	const rows = await tx`update messages set body = ${body}, revision = revision + 1, change_seq = ${change} where id = ${message} returning id`;
	if (!rows.length) throw new Error('not visible');
}
async function tombstoneIn(tx: TransactionSql, org: string, me: string, conversation: string, message: string) {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	const change = await nextChange(tx, conversation);
	const rows = await tx`update messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${me},
		revision = revision + 1, change_seq = ${change} where id = ${message} returning id`;
	if (!rows.length) throw new Error('not visible');
	// §5: any live pin on it is unpinned in the same transaction, with the next change number.
	const [pin] = await tx<{ id: string }[]>`select id from message_pins where message_id = ${message} and unpinned_at is null for update`;
	if (pin) await unpinIn(tx, me, conversation, pin.id);
}
async function pinIn(tx: TransactionSql, org: string, me: string, conversation: string, message: string): Promise<string> {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	const change = await nextChange(tx, conversation);
	const [pin] = await tx<{ id: string }[]>`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by)
		values (${org}, ${conversation}, ${message}, ${change}, ${me}) returning id`;
	return pin!.id;
}
async function unpinIn(tx: TransactionSql, me: string, conversation: string, pin: string) {
	const change = await nextChange(tx, conversation);
	const rows = await tx`update message_pins set unpinned_at = now(), unpinned_by = ${me}, change_seq = ${change} where id = ${pin} returning id`;
	if (!rows.length) throw new Error('not visible');
}
async function leaveIn(tx: TransactionSql, org: string, me: string, conversation: string) {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	await tx`update conversations set revision = revision + 1 where id = ${conversation}`;
	await tx`update conversation_participants set state = 'left', ended_at = now() where conversation_id = ${conversation} and user_id = ${me}`;
}
async function readdIn(tx: TransactionSql, org: string, actor: string, conversation: string, user: string) {
	await lockShare(tx, org, [actor, user]); await lockConversation(tx, conversation);
	await tx`update conversation_participants set state = 'active', added_by = ${actor}, added_at = now(), ended_at = null
		where conversation_id = ${conversation} and user_id = ${user}`;
	await tx`update conversations set revision = revision + 1 where id = ${conversation}`;
}
/** §13 read, as the service does it: only an advance is written, clamped to last_seq. */
async function readIn(tx: TransactionSql, org: string, me: string, conversation: string, seq: number) {
	await tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq)
		select ${org}, ${conversation}, ${me}, least(${seq}::int, c.last_seq) from conversations c where c.id = ${conversation}
		on conflict (conversation_id, user_id) do update set last_read_seq = excluded.last_read_seq
		where conversation_reads.last_read_seq < excluded.last_read_seq`;
}
const baseline = async (conversation: string, user: string, h: Harness = db) =>
	(await h.owner<{ readStartSeq: number }[]>`select read_start_seq from conversation_participants where conversation_id = ${conversation} and user_id = ${user}`)[0]?.readStartSeq;
const counters = async (conversation: string) =>
	(await db.owner<{ lastSeq: number; lastChange: number; revision: number }[]>`select last_seq, last_change, revision from conversations where id = ${conversation}`)[0]!;
/** What the service reports: max(baseline, the person's own read row, 0), read as that person. */
const effectiveRead = (org: string, user: string, conversation: string) => as(org, user, async (tx) =>
	(await tx<{ position: number }[]>`select greatest(p.read_start_seq, coalesce(r.last_read_seq, 0)) as position from conversation_participants p
		left join conversation_reads r on r.conversation_id = p.conversation_id and r.user_id = p.user_id
		where p.conversation_id = ${conversation} and p.user_id = ${user}`)[0]?.position);

// Tests -------------------------------------------------------------------------------------------------------

it('runs as captain_runtime; the new tables force row security, name both roles, and add no elevated path', async () => {
	const [who] = await db.app<{ current: string; session: string }[]>`select current_user as current, session_user as session`;
	assert.deepEqual({ ...who }, { current: 'captain_runtime', session: 'captain_runtime' });
	for (const table of newTables) {
		const [flags] = await db.owner<{ rls: boolean; forced: boolean }[]>`select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where relname = ${table}`;
		assert.deepEqual({ ...flags }, { rls: true, forced: true }, table);
	}
	const policies = await db.owner<{ name: string; roles: string[] }[]>`select policyname as name, roles::text[] as roles from pg_policies
		where tablename in ${db.owner([...newTables])} order by policyname`;
	assert.equal(policies.length, 9);
	for (const policy of policies) assert.deepEqual([...policy.roles].sort(), ['app', 'captain_runtime'], policy.name);
	const expected: Record<string, Record<string, boolean>> = {
		message_pins: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false },
		conversation_stars: { SELECT: true, INSERT: true, UPDATE: false, DELETE: true, TRUNCATE: false },
		conversation_reads: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false },
	};
	for (const role of ['captain_runtime', 'app'])
		for (const [table, privileges] of Object.entries(expected))
			for (const [privilege, held] of Object.entries(privileges))
				assert.equal((await db.owner<{ ok: boolean }[]>`select has_table_privilege(${role}, ${table}, ${privilege}) as ok`)[0]!.ok, held, `${role} ${privilege} ${table}`);
	const functions = await db.owner<{ name: string; definer: boolean; runtime: boolean; legacy: boolean }[]>`
		select p.proname as name, p.prosecdef as definer, has_function_privilege('captain_runtime', p.oid, 'EXECUTE') as runtime,
			has_function_privilege('app', p.oid, 'EXECUTE') as legacy from pg_proc p where p.proname like 'chat\\_%' order by p.proname`;
	assert.deepEqual(functions.filter((f) => f.runtime).map((f) => f.name), ['chat_create_conversation', 'chat_end_membership', 'chat_participant']);
	assert.deepEqual(functions.map((f) => f.legacy), functions.map((f) => f.runtime));
	assert.deepEqual(functions.filter((f) => f.definer && !f.runtime).map((f) => f.name), ['chat_conversations_seq_check'], 'no new definer function');
	for (const name of ['chat_pins_guard', 'chat_stars_guard', 'chat_reads_guard']) assert.ok(functions.some((f) => f.name === name && !f.definer && !f.runtime), name);
	const [trigger] = await db.owner<{ enabled: string }[]>`select tgenabled as enabled from pg_trigger where tgname = 'conversation_participants_guard'`;
	assert.equal(trigger!.enabled, 'O', 'the participant trigger is enabled again after the backfill');
});

it('the read baseline is the database’s: last_seq on create, add and re-add, never the caller’s, and fixed otherwise', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), carol = await person(org);
	const id = await create(org, alice);
	assert.equal(await baseline(id, alice), 0, 'the creator starts at the start');
	for (let i = 0; i < 3; i++) await send(org, alice, id);
	await as(org, alice, async (tx) => { await lockShare(tx, org, [alice, bob]); await lockConversation(tx, id); await addIn(tx, org, id, alice, bob, { readStartSeq: 99 }); });
	assert.equal(await baseline(id, bob), 3, 'a caller-chosen baseline is replaced by the conversation’s last_seq');
	await as(org, alice, async (tx) => { await lockShare(tx, org, [alice, carol]); await lockConversation(tx, id); await addIn(tx, org, id, alice, carol, { readStartSeq: 0 }); });
	assert.equal(await baseline(id, carol), 3, 'nor can it be lowered to show history as unread');
	await assert.rejects(as(org, bob, (tx) => tx`update conversation_participants set read_start_seq = 0 where conversation_id = ${id} and user_id = ${bob}`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`update conversation_participants set read_start_seq = 1 where conversation_id = ${id} and user_id = ${bob}`), REFUSED);
	// Bob reads to 2, leaves; while he is away the conversation moves on.
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 2));
	assert.equal(await effectiveRead(org, bob, id), 3, 'the baseline wins over an older personal read');
	await as(org, bob, (tx) => leaveIn(tx, org, bob, id));
	assert.equal(await baseline(id, bob), 3, 'leaving keeps the baseline');
	await send(org, alice, id); await send(org, alice, id);
	await as(org, alice, (tx) => readdIn(tx, org, alice, id, bob));
	assert.equal(await baseline(id, bob), 5, 're-adding resets the baseline to the conversation’s last_seq');
	assert.equal(await effectiveRead(org, bob, id), 5, 'so the time away is not a flood of unread messages');
	assert.equal((await counters(id)).lastSeq, 5);
});

it('0043 backfills every existing participant’s baseline to the conversation’s last_seq, then re-enables the trigger', async () => {
	const old = await freshDatabase({ through: '0042_chat_core.sql' });
	try {
		const org = await organisation(old);
		const alice = await person(org, 'member', old), bob = await person(org, 'member', old), carol = await person(org, 'member', old);
		const busy = await create(org, alice, [bob, carol], old.app), quiet = await create(org, bob, [], old.app);
		for (let i = 0; i < 4; i++) await send(org, alice, busy, 'before 0043', old.app);
		await as(org, carol, (tx) => leaveIn(tx, org, carol, busy), old.app);
		assert.deepEqual(await applyMigrations(old.owner, undefined, '0043_chat_personal_pins.sql'), ['0043_chat_personal_pins.sql']);
		const rows = await old.owner<{ conversationId: string; userId: string; state: string; readStartSeq: number }[]>`
			select conversation_id, user_id, state, read_start_seq from conversation_participants where conversation_id in ${old.owner([busy, quiet])}`;
		const at = (conversation: string, user: string) => rows.find((r) => r.conversationId === conversation && r.userId === user)?.readStartSeq;
		assert.deepEqual([at(busy, alice), at(busy, bob), at(busy, carol), at(quiet, bob)], [4, 4, 4, 0], 'active and former participants alike');
		const [trigger] = await old.owner<{ enabled: string }[]>`select tgenabled as enabled from pg_trigger where tgname = 'conversation_participants_guard'`;
		assert.equal(trigger!.enabled, 'O');
		await assert.rejects(as(org, bob, (tx) => tx`update conversation_participants set read_start_seq = 0 where conversation_id = ${busy} and user_id = ${bob}`, old.app), REFUSED);
	} finally { await old.close(); }
});

it('read positions: only your own, only forward, never past last_seq, and hidden while you are not participating', async () => {
	const org = await organisation(), other = await organisation();
	const alice = await person(org), bob = await person(org), outsider = await person(org);
	const id = await create(org, alice, [bob]);
	for (let i = 0; i < 4; i++) await send(org, alice, id);
	await as(org, bob, (tx) => tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq) values (${org}, ${id}, ${bob}, 2)`);
	await assert.rejects(as(org, alice, (tx) => tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq) values (${org}, ${id}, ${bob}, 4)`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq) values (${org}, ${id}, ${alice}, 5)`), REFUSED, 'past last_seq');
	await assert.rejects(as(org, alice, (tx) => tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq) values (${org}, ${id}, ${alice}, -1)`), REFUSED);
	await assert.rejects(as(org, bob, (tx) => tx`update conversation_reads set last_read_seq = 1 where conversation_id = ${id} and user_id = ${bob}`), REFUSED, 'backwards');
	await assert.rejects(as(org, bob, (tx) => tx`update conversation_reads set last_read_seq = 2 where conversation_id = ${id} and user_id = ${bob}`), REFUSED, 'not an advance');
	await assert.rejects(as(org, bob, (tx) => tx`update conversation_reads set last_read_seq = 5 where conversation_id = ${id} and user_id = ${bob}`), REFUSED, 'past last_seq');
	assert.equal((await as(org, alice, (tx) => tx`update conversation_reads set last_read_seq = 3 where conversation_id = ${id} and user_id = ${bob} returning 1`)).length, 0, 'someone else’s row is invisible');
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 99)); // the service clamps to last_seq
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 1)); // a stale, lower read writes nothing
	assert.equal((await db.owner`select last_read_seq from conversation_reads where conversation_id = ${id} and user_id = ${bob}`)[0]!.lastReadSeq, 4);
	// No oracle: a non-participant's insert fails identically for this conversation and for one that does not exist.
	const attempt = (conversation: string) => as(org, outsider, (tx) => tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq)
		values (${org}, ${conversation}, ${outsider}, 0)`).then(() => 'inserted', (error: Error) => error.message);
	assert.match(await attempt(id), RLS);
	assert.equal(await attempt(id), await attempt(randomUUID()));
	assert.match(await as(other, outsider, (tx) => tx`insert into conversation_reads (organisation_id, conversation_id, user_id, last_read_seq)
		values (${org}, ${id}, ${outsider}, 0)`).then(() => 'inserted', (error: Error) => error.message), RLS);
	await as(org, bob, (tx) => leaveIn(tx, org, bob, id));
	assert.equal((await as(org, bob, (tx) => tx`select 1 from conversation_reads where conversation_id = ${id}`)).length, 0, 'hidden after leaving');
	await as(org, alice, (tx) => readdIn(tx, org, alice, id, bob));
	assert.equal((await as(org, bob, (tx) => tx`select last_read_seq from conversation_reads where conversation_id = ${id}`)).length, 1, 'visible again after a re-add');
});

it('stars: personal, set or cleared but never changed, and hidden while you are not participating', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), outsider = await person(org);
	const id = await create(org, alice, [bob]);
	await as(org, bob, (tx) => tx`insert into conversation_stars (organisation_id, conversation_id, user_id) values (${org}, ${id}, ${bob})`);
	assert.equal((await as(org, bob, (tx) => tx`insert into conversation_stars (organisation_id, conversation_id, user_id) values (${org}, ${id}, ${bob})
		on conflict do nothing returning 1`)).length, 0, 'starring again is a no-op');
	await assert.rejects(as(org, alice, (tx) => tx`insert into conversation_stars (organisation_id, conversation_id, user_id) values (${org}, ${id}, ${bob})`), REFUSED);
	await assert.rejects(as(org, bob, (tx) => tx`update conversation_stars set created_at = now() where conversation_id = ${id}`), DENIED);
	assert.equal((await as(org, alice, (tx) => tx`select 1 from conversation_stars where conversation_id = ${id}`)).length, 0, 'another person’s star is invisible');
	assert.equal((await as(org, alice, (tx) => tx`delete from conversation_stars where conversation_id = ${id} returning 1`)).length, 0, 'and cannot be cleared by them');
	const attempt = (conversation: string) => as(org, outsider, (tx) => tx`insert into conversation_stars (organisation_id, conversation_id, user_id)
		values (${org}, ${conversation}, ${outsider})`).then(() => 'inserted', (error: Error) => error.message);
	assert.match(await attempt(id), RLS);
	assert.equal(await attempt(id), await attempt(randomUUID()));
	await as(org, bob, (tx) => leaveIn(tx, org, bob, id));
	assert.equal((await as(org, bob, (tx) => tx`select 1 from conversation_stars where conversation_id = ${id}`)).length, 0, 'hidden after leaving');
	assert.equal((await as(org, bob, (tx) => tx`delete from conversation_stars where conversation_id = ${id} returning 1`)).length, 0);
	await as(org, alice, (tx) => readdIn(tx, org, alice, id, bob));
	assert.equal((await as(org, bob, (tx) => tx`delete from conversation_stars where conversation_id = ${id} returning 1`)).length, 1, 'kept, and clearable after a re-add');
});

it('edits: the author alone replaces the body, keeping its hash; nobody else, and never a tombstone', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), boss = await person(org, 'admin');
	const id = await create(org, alice, [bob, boss]);
	const message = await send(org, alice, id, 'Original words');
	const [before] = await db.owner<{ sentBodySha256: Buffer; changeSeq: number }[]>`select sent_body_sha256, change_seq from messages where id = ${message}`;
	const start = await counters(id);
	await as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const change = await nextChange(tx, id);
		await tx`update messages set body = 'Better words', revision = 2, change_seq = ${change}, edited_at = '2000-01-01' where id = ${message}`;
	});
	const [edited] = await db.owner<{ body: string; revision: number; changeSeq: number; editedAt: Date; sentBodySha256: Buffer }[]>`
		select body, revision, change_seq, edited_at, sent_body_sha256 from messages where id = ${message}`;
	assert.equal(edited!.body, 'Better words'); assert.equal(edited!.revision, 2);
	assert.ok(edited!.sentBodySha256.equals(before!.sentBodySha256), 'the original hash stays for send retries');
	assert.ok(edited!.editedAt.getUTCFullYear() > 2000, 'edited_at is the server’s time');
	assert.ok(edited!.changeSeq > before!.changeSeq);
	assert.deepEqual({ ...(await counters(id)) }, { lastSeq: start.lastSeq, lastChange: start.lastChange + 1, revision: start.revision }, 'an edit moves only last_change');
	const attempt = (who: string, set: (tx: TransactionSql, change: number) => Promise<unknown>) => as(org, who, async (tx) => {
		await lockShare(tx, org, [who]); await lockConversation(tx, id); await set(tx, await nextChange(tx, id));
	});
	await assert.rejects(attempt(bob, (tx, c) => tx`update messages set body = 'Bob''s words', revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'another participant');
	await assert.rejects(attempt(boss, (tx, c) => tx`update messages set body = 'Moderated', revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'a moderator');
	await assert.rejects(attempt(alice, (tx, c) => tx`update messages set body = 'New', sent_body_sha256 = ${fp('New')}, revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'the hash');
	await assert.rejects(attempt(alice, (tx, c) => tx`update messages set revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'the same body');
	await assert.rejects(attempt(alice, (tx, c) => tx`update messages set body = 'Skip', revision = 4, change_seq = ${c} where id = ${message}`), REFUSED, 'a skipped revision');
	await assert.rejects(attempt(alice, (tx, c) => tx`update messages set body = 'Stale', revision = 3, change_seq = ${c - 1} where id = ${message}`), REFUSED, 'a stale change number');
	await assert.rejects(as(org, alice, (tx) => tx`update messages set body = 'No bump', revision = 3 where id = ${message}`), REFUSED, 'no fresh change number');
	await assert.rejects(attempt(alice, (tx, c) => tx`update messages set body = 'Moved', revision = 3, change_seq = ${c}, seq = 9 where id = ${message}`), REFUSED, 'its place');
	await as(org, boss, (tx) => tombstoneIn(tx, org, boss, id, message)); // a moderator's tombstone still works
	await assert.rejects(attempt(alice, (tx, c) => tx`update messages set body = 'Back', revision = 4, change_seq = ${c} where id = ${message}`), REFUSED, 'a tombstone');
	// An edit that also moves the conversation revision is refused by the conversation trigger.
	const other = await send(org, alice, id, 'Second');
	await assert.rejects(as(org, alice, (tx) => tx`update conversations set last_change = last_change + 1, revision = revision + 1 where id = ${id}`), REFUSED);
	await as(org, alice, (tx) => editIn(tx, org, alice, id, other, 'Second, edited'));
});

it('pins: any participant pins a live message of their conversation as themselves; unpinning is final', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), outsider = await person(org);
	const id = await create(org, alice, [bob]), elsewhere = await create(org, alice);
	const message = await send(org, alice, id, 'Pin me'), foreign = await send(org, alice, elsewhere, 'Not here'), doomed = await send(org, alice, id, 'Gone');
	await as(org, alice, (tx) => tombstoneIn(tx, org, alice, id, doomed));
	const start = await counters(id);
	const pin = await as(org, bob, (tx) => pinIn(tx, org, bob, id, message));
	assert.deepEqual({ ...(await counters(id)) }, { ...start, lastChange: start.lastChange + 1 }, 'a pin moves only last_change');
	const [row] = await db.owner<{ changeSeq: number; pinnedBy: string }[]>`select change_seq, pinned_by from message_pins where id = ${pin}`;
	assert.deepEqual({ ...row }, { changeSeq: start.lastChange + 1, pinnedBy: bob });
	const tryPin = (who: string, messageId: string, pinnedBy = who, bump = true) => as(org, who, async (tx) => {
		await lockShare(tx, org, [who]); await lockConversation(tx, id);
		const change = bump ? await nextChange(tx, id) : (await counters(id)).lastChange - 1;
		await tx`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${messageId}, ${change}, ${pinnedBy})`;
	});
	await assert.rejects(tryPin(bob, message, alice), REFUSED, 'as someone else');
	await assert.rejects(tryPin(bob, doomed), REFUSED, 'a tombstone');
	await assert.rejects(tryPin(bob, foreign), REFUSED, 'a message of another conversation');
	await assert.rejects(tryPin(bob, randomUUID()), REFUSED, 'a message that does not exist, refused the same way');
	const fresh = await send(org, alice, id, 'Fresh');
	await assert.rejects(tryPin(bob, fresh, bob, false), REFUSED, 'without its fresh change number');
	await assert.rejects(tryPin(alice, message), { code: '23505', constraint_name: 'message_pins_live_message' }, 'one live pin per message');
	// No oracle for a non-participant.
	const attempt = (conversation: string) => as(org, outsider, (tx) => tx`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by)
		values (${org}, ${conversation}, ${message}, 1, ${outsider})`).then(() => 'inserted', (error: Error) => error.message);
	assert.match(await attempt(id), RLS);
	assert.equal(await attempt(id), await attempt(randomUUID()));
	// Unpinning: any participant, as themselves, with a fresh number; then final.
	await assert.rejects(as(org, alice, async (tx) => {
		await lockConversation(tx, id); const change = await nextChange(tx, id);
		await tx`update message_pins set unpinned_at = now(), unpinned_by = ${bob}, change_seq = ${change} where id = ${pin}`;
	}), REFUSED, 'unpinned as someone else');
	await as(org, alice, async (tx) => { await lockShare(tx, org, [alice]); await lockConversation(tx, id); await unpinIn(tx, alice, id, pin); });
	const [unpinned] = await db.owner<{ unpinnedBy: string; unpinnedAt: Date }[]>`select unpinned_by, unpinned_at from message_pins where id = ${pin}`;
	assert.equal(unpinned!.unpinnedBy, alice); assert.ok(unpinned!.unpinnedAt);
	await assert.rejects(as(org, alice, async (tx) => {
		await lockConversation(tx, id); const change = await nextChange(tx, id);
		await tx`update message_pins set unpinned_at = null, unpinned_by = null, change_seq = ${change} where id = ${pin}`;
	}), REFUSED, 'an unpinned pin never changes again');
	await assert.rejects(as(org, bob, (tx) => tx`delete from message_pins where id = ${pin}`), DENIED, 'pins are never deleted');
	await as(org, bob, (tx) => pinIn(tx, org, bob, id, message)); // pinning again is a new pin
	assert.equal((await db.owner`select 1 from message_pins where message_id = ${message}`).length, 2);
});

it('one change number, one row: a message and a pin in a conversation never hold the same current number', async () => {
	const org = await organisation();
	const alice = await person(org, 'admin');
	const id = await create(org, alice);
	const first = await send(org, alice, id, 'First'), second = await send(org, alice, id, 'Second');
	// Tombstone takes n; a pin in the same transaction reusing n (without its own advance) is refused.
	await assert.rejects(as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`update messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${alice}, revision = revision + 1, change_seq = ${n} where id = ${first}`;
		await tx`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${second}, ${n}, ${alice})`;
	}), REFUSED);
	// A pin takes n; an edit in the same transaction reusing n is refused.
	await assert.rejects(as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${second}, ${n}, ${alice})`;
		await tx`update messages set body = 'Edited', revision = revision + 1, change_seq = ${n} where id = ${first}`;
	}), REFUSED);
	// And an unpin reusing a number a message holds.
	const pin = await as(org, alice, (tx) => pinIn(tx, org, alice, id, second));
	await assert.rejects(as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`update messages set body = 'Edited', revision = revision + 1, change_seq = ${n} where id = ${first}`;
		await tx`update message_pins set unpinned_at = now(), unpinned_by = ${alice}, change_seq = ${n} where id = ${pin}`;
	}), REFUSED);
	// Each with its own advance, the same work succeeds; the deferred dense-seq check is untouched by any of it.
	await as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`update messages set body = 'Edited', revision = revision + 1, change_seq = ${n} where id = ${first}`;
		await unpinIn(tx, alice, id, pin);
	});
	await assert.rejects(as(org, alice, (tx) => tx`update conversations set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${id}`), REFUSED,
		'a bare seq advance still fails at commit');
	const numbers = await db.owner<{ n: number }[]>`select change_seq as n from messages where conversation_id = ${id} union all select change_seq from message_pins where conversation_id = ${id}`;
	assert.equal(new Set(numbers.map((r) => r.n)).size, numbers.length, 'every current number is held once');
});

it('account deletion nulls pin attribution without moving a counter and removes personal rows; organisation deletion removes all', async () => {
	const org = await organisation();
	const alice = await person(org, 'owner'), bob = await person(org);
	const id = await create(org, alice, [bob]);
	const message = await send(org, alice, id, 'Keep'), other = await send(org, alice, id, 'Also');
	const kept = await as(org, bob, (tx) => pinIn(tx, org, bob, id, message));
	const dropped = await as(org, bob, (tx) => pinIn(tx, org, bob, id, other));
	await as(org, bob, async (tx) => { await lockShare(tx, org, [bob]); await lockConversation(tx, id); await unpinIn(tx, bob, id, dropped); });
	await as(org, bob, (tx) => tx`insert into conversation_stars (organisation_id, conversation_id, user_id) values (${org}, ${id}, ${bob})`);
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 2));
	const before = await counters(id);
	const pinsBefore = await db.owner<{ id: string; changeSeq: number }[]>`select id, change_seq from message_pins where conversation_id = ${id} order by id`;
	await db.app`delete from users where id = ${bob}`; // account deletion cascades to the membership
	const pins = await db.owner<{ id: string; pinnedBy: string | null; unpinnedBy: string | null; changeSeq: number; unpinnedAt: Date | null }[]>`
		select id, pinned_by, unpinned_by, change_seq, unpinned_at from message_pins where conversation_id = ${id} order by id`;
	assert.deepEqual(pins.map((p) => [p.id, p.pinnedBy, p.unpinnedBy, p.changeSeq]), pinsBefore.map((p) => [p.id, null, null, p.changeSeq]));
	assert.ok(pins.find((p) => p.id === kept && p.unpinnedAt === null), 'the live pin stays live');
	assert.deepEqual({ ...(await counters(id)) }, { ...before }, 'no counter moves');
	for (const table of ['conversation_stars', 'conversation_reads'])
		assert.equal((await db.owner.unsafe(`select 1 from ${table} where conversation_id = $1`, [id])).length, 0, table);
	await as(org, alice, (tx) => tx`delete from organisations where id = ${org}`);
	for (const table of newTables) assert.equal((await db.owner.unsafe(`select 1 from ${table} where organisation_id = $1`, [org])).length, 0, table);
});

it('races, each under the conversation lock: one live pin, reads converge up, one star, no pin on a tombstone, one edit per revision', async () => {
	const org = await organisation();
	const alice = await person(org, 'admin'), bob = await person(org);
	const id = await create(org, alice, [bob]);
	for (let i = 0; i < 5; i++) await send(org, alice, id);
	const [target] = await db.owner<{ id: string }[]>`select id from messages where conversation_id = ${id} and seq = 1`;
	// Two people pin the same message at once: exactly one live pin; the other fails on the exact index name.
	const start = await counters(id);
	const pins = await Promise.allSettled([as(org, alice, (tx) => pinIn(tx, org, alice, id, target!.id)), as(org, bob, (tx) => pinIn(tx, org, bob, id, target!.id))]);
	assert.equal(pins.filter((p) => p.status === 'fulfilled').length, 1);
	const loser = pins.find((p) => p.status === 'rejected') as PromiseRejectedResult;
	assert.equal((loser.reason as { constraint_name?: string }).constraint_name, 'message_pins_live_message');
	assert.equal((await counters(id)).lastChange, start.lastChange + 1, 'the loser’s advance rolled back with it');
	// Read advances arriving out of order converge on the furthest.
	await Promise.all([as(org, bob, (tx) => readIn(tx, org, bob, id, 5)), as(org, bob, (tx) => readIn(tx, org, bob, id, 3))]);
	assert.equal((await db.owner`select last_read_seq from conversation_reads where conversation_id = ${id} and user_id = ${bob}`)[0]!.lastReadSeq, 5);
	// Starring twice at once leaves one star.
	await Promise.all([0, 1].map(() => as(org, bob, (tx) => tx`insert into conversation_stars (organisation_id, conversation_id, user_id) values (${org}, ${id}, ${bob}) on conflict do nothing`)));
	assert.equal((await db.owner`select 1 from conversation_stars where conversation_id = ${id} and user_id = ${bob}`).length, 1);
	// A tombstone racing a pin of the same message: never a live pin on a tombstone, and the unpin follows the tombstone.
	const [victim] = await db.owner<{ id: string }[]>`select id from messages where conversation_id = ${id} and seq = 2`;
	const racingPin = as(org, bob, async (tx) => {
		await lockShare(tx, org, [bob]); await lockConversation(tx, id);
		const [live] = await tx<{ deletedAt: Date | null }[]>`select deleted_at from messages where id = ${victim!.id}`;
		if (live!.deletedAt) return 'message_deleted'; // the service's 409, checked under the lock
		const change = await nextChange(tx, id);
		await tx`insert into message_pins (organisation_id, conversation_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${victim!.id}, ${change}, ${bob})`;
		return 'pinned';
	});
	await Promise.all([racingPin, as(org, alice, (tx) => tombstoneIn(tx, org, alice, id, victim!.id))]);
	const [dead] = await db.owner<{ changeSeq: number }[]>`select change_seq from messages where id = ${victim!.id} and deleted_at is not null`;
	assert.ok(dead, 'the tombstone landed');
	assert.equal((await db.owner`select 1 from message_pins where message_id = ${victim!.id} and unpinned_at is null`).length, 0, 'no live pin on a tombstone');
	for (const pin of await db.owner<{ changeSeq: number }[]>`select change_seq from message_pins where message_id = ${victim!.id}`)
		assert.ok(pin.changeSeq > dead!.changeSeq, 'any unpin is numbered after the tombstone');
	// Two edits from the same revision: the second sees the first's revision and writes nothing.
	const [mine] = await db.owner<{ id: string }[]>`select id from messages where conversation_id = ${id} and seq = 3`;
	const editFrom = (expected: number, body: string) => as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const [row] = await tx<{ revision: number }[]>`select revision from messages where id = ${mine!.id} for update`;
		if (row!.revision !== expected) return 'stale_revision';
		const change = await nextChange(tx, id);
		await tx`update messages set body = ${body}, revision = ${expected + 1}, change_seq = ${change} where id = ${mine!.id}`;
		return 'edited';
	});
	const edits = await Promise.all([editFrom(1, 'One'), editFrom(1, 'Two')]);
	assert.deepEqual([...edits].sort(), ['edited', 'stale_revision']);
	assert.equal((await db.owner`select revision from messages where id = ${mine!.id}`)[0]!.revision, 2);
});
