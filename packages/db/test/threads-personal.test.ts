import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Sql, TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { databaseUrl, fixture, freshDatabase, type Harness } from './harness.ts';

// Migration 0046 (threads contract §3, §4; D25), moved from the 0043 suite: pins, stars, read positions and author edits,
// proven by direct SQL, bypassing any service, as the role the API connects as (`db.app` signs in as captain_runtime).
// Service-shaped helpers follow the linked-chat §6 lock order: membership, then thread, then message, then pin. Pins are
// narrowed (owner's review, 1 October): one live pin per thread, set and cleared only by an owner or admin.
const it = databaseUrl ? test : test.skip;
let db: Harness;
const RLS = /row-level security/;
const DENIED = /permission denied/;
const REFUSED = { code: '23514' }; // check_violation, raised by the transition triggers and CHECK constraints
const fp = (value: string) => createHash('sha256').update(value).digest();
const newTables = ['thread_pins', 'thread_stars', 'thread_reads'] as const;

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
	const rows = await tx`select 1 from threads where id = ${conversation} for update`;
	if (!rows.length) throw new Error('not a participant');
}
async function addIn(tx: TransactionSql, org: string, conversation: string, actor: string, user: string, extra: { readStartSeq?: number } = {}) {
	if (extra.readStartSeq === undefined) await tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by) values (${org}, ${conversation}, ${user}, ${actor})`;
	else await tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by, read_start_seq) values (${org}, ${conversation}, ${user}, ${actor}, ${extra.readStartSeq})`;
	await tx`update threads set revision = revision + 1 where id = ${conversation}`;
}
function create(org: string, me: string, others: string[] = [], runtime: Sql = db.app): Promise<string> {
	const id = randomUUID();
	return as(org, me, async (tx) => {
		await lockShare(tx, org, [me, ...others]);
		const [row] = await tx<{ result: string }[]>`select thread_create(${id}, 'private', 'Pins and reads', ${fp('Pins and reads')}) as result`;
		assert.equal(row!.result, 'created');
		for (const user of others) await addIn(tx, org, id, me, user);
		return id;
	}, runtime);
}
async function sendIn(tx: TransactionSql, org: string, me: string, conversation: string, body = 'Can we move the slot?'): Promise<string> {
	const id = randomUUID();
	await lockShare(tx, org, [me]);
	const [c] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads set last_seq = last_seq + 1, last_change = last_change + 1,
		last_message_at = greatest(last_message_at, now()) where id = ${conversation} returning last_seq, last_change`;
	if (!c) throw new Error('not a participant');
	await tx`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
		values (${id}, ${org}, ${conversation}, ${c.lastSeq}, ${c.lastChange}, ${me}, ${body}, ${fp(body)})`;
	return id;
}
const send = (org: string, me: string, conversation: string, body?: string, runtime: Sql = db.app) => as(org, me, (tx) => sendIn(tx, org, me, conversation, body), runtime);
/** Advances last_change once, under the conversation lock, and returns the new number. */
async function nextChange(tx: TransactionSql, conversation: string): Promise<number> {
	const [c] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${conversation} returning last_change`;
	if (!c) throw new Error('not a participant');
	return c.lastChange;
}
async function editIn(tx: TransactionSql, org: string, me: string, conversation: string, message: string, body: string) {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	const change = await nextChange(tx, conversation);
	const rows = await tx`update thread_messages set body = ${body}, revision = revision + 1, change_seq = ${change} where id = ${message} returning id`;
	if (!rows.length) throw new Error('not visible');
}
async function tombstoneIn(tx: TransactionSql, org: string, me: string, conversation: string, message: string) {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	const change = await nextChange(tx, conversation);
	const rows = await tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${me},
		revision = revision + 1, change_seq = ${change} where id = ${message} returning id`;
	if (!rows.length) throw new Error('not visible');
	// §5: any live pin on it is unpinned in the same transaction, with the next change number.
	const [pin] = await tx<{ id: string }[]>`select id from thread_pins where message_id = ${message} and unpinned_at is null for update`;
	if (pin) await unpinIn(tx, me, conversation, pin.id);
}
async function pinIn(tx: TransactionSql, org: string, me: string, conversation: string, message: string): Promise<string> {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	const change = await nextChange(tx, conversation);
	const [pin] = await tx<{ id: string }[]>`insert into thread_pins (organisation_id, thread_id, message_id, change_seq, pinned_by)
		values (${org}, ${conversation}, ${message}, ${change}, ${me}) returning id`;
	return pin!.id;
}
async function unpinIn(tx: TransactionSql, me: string, conversation: string, pin: string) {
	const change = await nextChange(tx, conversation);
	const rows = await tx`update thread_pins set unpinned_at = now(), unpinned_by = ${me}, change_seq = ${change} where id = ${pin} returning id`;
	if (!rows.length) throw new Error('not visible');
}
async function leaveIn(tx: TransactionSql, org: string, me: string, conversation: string) {
	await lockShare(tx, org, [me]); await lockConversation(tx, conversation);
	await tx`update threads set revision = revision + 1 where id = ${conversation}`;
	await tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${conversation} and user_id = ${me}`;
}
async function readdIn(tx: TransactionSql, org: string, actor: string, conversation: string, user: string) {
	await lockShare(tx, org, [actor, user]); await lockConversation(tx, conversation);
	await tx`update thread_participants set state = 'active', added_by = ${actor}, added_at = now(), ended_at = null
		where thread_id = ${conversation} and user_id = ${user}`;
	await tx`update threads set revision = revision + 1 where id = ${conversation}`;
}
/** §13 read, as the service does it: only an advance is written, clamped to last_seq. */
async function readIn(tx: TransactionSql, org: string, me: string, conversation: string, seq: number) {
	await tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq)
		select ${org}, ${conversation}, ${me}, least(${seq}::int, c.last_seq) from threads c where c.id = ${conversation}
		on conflict (thread_id, user_id) do update set last_read_seq = excluded.last_read_seq
		where thread_reads.last_read_seq < excluded.last_read_seq`;
}
const baseline = async (conversation: string, user: string, h: Harness = db) =>
	(await h.owner<{ readStartSeq: number }[]>`select read_start_seq from thread_participants where thread_id = ${conversation} and user_id = ${user}`)[0]?.readStartSeq;
const counters = async (conversation: string) =>
	(await db.owner<{ lastSeq: number; lastChange: number; revision: number }[]>`select last_seq, last_change, revision from threads where id = ${conversation}`)[0]!;
/** What the service reports: max(baseline, the person's own read row, 0), read as that person. */
const effectiveRead = (org: string, user: string, conversation: string) => as(org, user, async (tx) =>
	(await tx<{ position: number }[]>`select greatest(p.read_start_seq, coalesce(r.last_read_seq, 0)) as position from thread_participants p
		left join thread_reads r on r.thread_id = p.thread_id and r.user_id = p.user_id
		where p.thread_id = ${conversation} and p.user_id = ${user}`)[0]?.position);

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
		thread_pins: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false },
		thread_stars: { SELECT: true, INSERT: true, UPDATE: false, DELETE: true, TRUNCATE: false },
		thread_reads: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false },
	};
	for (const role of ['captain_runtime', 'app'])
		for (const [table, privileges] of Object.entries(expected))
			for (const [privilege, held] of Object.entries(privileges))
				assert.equal((await db.owner<{ ok: boolean }[]>`select has_table_privilege(${role}, ${table}, ${privilege}) as ok`)[0]!.ok, held, `${role} ${privilege} ${table}`);
	const functions = await db.owner<{ name: string; definer: boolean; runtime: boolean; legacy: boolean }[]>`
		select p.proname as name, p.prosecdef as definer, has_function_privilege('captain_runtime', p.oid, 'EXECUTE') as runtime,
			has_function_privilege('app', p.oid, 'EXECUTE') as legacy from pg_proc p where p.proname like 'thread\\_%' order by p.proname`;
	assert.deepEqual(functions.filter((f) => f.runtime).map((f) => f.name), ['thread_create', 'thread_end_membership', 'thread_make_task', 'thread_visible']);
	assert.deepEqual(functions.map((f) => f.legacy), functions.map((f) => f.runtime));
	assert.deepEqual(functions.filter((f) => f.definer && !f.runtime).map((f) => f.name), ['thread_seq_check'], 'no other definer function');
	for (const name of ['thread_pins_guard', 'thread_stars_guard', 'thread_reads_guard']) assert.ok(functions.some((f) => f.name === name && !f.definer && !f.runtime), name);
	const [index] = await db.owner<{ def: string }[]>`select indexdef as def from pg_indexes where indexname = 'thread_pins_live'`;
	assert.match(index!.def, /UNIQUE INDEX thread_pins_live ON public\.thread_pins USING btree \(thread_id\) WHERE \(unpinned_at IS NULL\)/, 'one live pin per thread');
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
	await assert.rejects(as(org, bob, (tx) => tx`update thread_participants set read_start_seq = 0 where thread_id = ${id} and user_id = ${bob}`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`update thread_participants set read_start_seq = 1 where thread_id = ${id} and user_id = ${bob}`), REFUSED);
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

it('a record or topic thread has no baseline: a member who never read it starts at 0, and only their own row moves', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org);
	const [task] = await fixture(db.owner, org)<{ id: string }[]>`insert into tasks (organisation_id, title) values (${org}, 'Fill the fermenter') returning id`;
	const [record] = await db.owner<{ id: string }[]>`select id from threads where task_id = ${task!.id}`;
	for (let i = 0; i < 3; i++) await send(org, alice, record!.id);
	const position = (user: string) => as(org, user, async (tx) => (await tx<{ position: number }[]>`select coalesce((select last_read_seq from thread_reads
		where thread_id = ${record!.id} and user_id = ${user}), 0) as position`)[0]!.position);
	assert.equal(await position(bob), 0, 'never opened: everything is unread');
	await assert.rejects(as(org, bob, (tx) => tx`insert into thread_participants (organisation_id, thread_id, user_id, added_by) values (${org}, ${record!.id}, ${bob}, ${bob})`),
		REFUSED, 'a record thread has no participants');
	await as(org, bob, (tx) => readIn(tx, org, bob, record!.id, 2));
	assert.equal(await position(bob), 2);
	assert.equal(await position(alice), 0, 'a read row is personal');
	await assert.rejects(as(org, alice, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq) values (${org}, ${record!.id}, ${bob}, 3)`), REFUSED);
});

it('read positions: only your own, only forward, never past last_seq, and hidden while you are not participating', async () => {
	const org = await organisation(), other = await organisation();
	const alice = await person(org), bob = await person(org), outsider = await person(org);
	const id = await create(org, alice, [bob]);
	for (let i = 0; i < 4; i++) await send(org, alice, id);
	await as(org, bob, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq) values (${org}, ${id}, ${bob}, 2)`);
	await assert.rejects(as(org, alice, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq) values (${org}, ${id}, ${bob}, 4)`), REFUSED);
	await assert.rejects(as(org, alice, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq) values (${org}, ${id}, ${alice}, 5)`), REFUSED, 'past last_seq');
	await assert.rejects(as(org, alice, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq) values (${org}, ${id}, ${alice}, -1)`), REFUSED);
	await assert.rejects(as(org, bob, (tx) => tx`update thread_reads set last_read_seq = 1 where thread_id = ${id} and user_id = ${bob}`), REFUSED, 'backwards');
	await assert.rejects(as(org, bob, (tx) => tx`update thread_reads set last_read_seq = 2 where thread_id = ${id} and user_id = ${bob}`), REFUSED, 'not an advance');
	await assert.rejects(as(org, bob, (tx) => tx`update thread_reads set last_read_seq = 5 where thread_id = ${id} and user_id = ${bob}`), REFUSED, 'past last_seq');
	assert.equal((await as(org, alice, (tx) => tx`update thread_reads set last_read_seq = 3 where thread_id = ${id} and user_id = ${bob} returning 1`)).length, 0, 'someone else’s row is invisible');
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 99)); // the service clamps to last_seq
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 1)); // a stale, lower read writes nothing
	assert.equal((await db.owner`select last_read_seq from thread_reads where thread_id = ${id} and user_id = ${bob}`)[0]!.lastReadSeq, 4);
	// No oracle: a non-participant's insert fails identically for this conversation and for one that does not exist.
	const attempt = (conversation: string) => as(org, outsider, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq)
		values (${org}, ${conversation}, ${outsider}, 0)`).then(() => 'inserted', (error: Error) => error.message);
	assert.match(await attempt(id), RLS);
	assert.equal(await attempt(id), await attempt(randomUUID()));
	assert.match(await as(other, outsider, (tx) => tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq)
		values (${org}, ${id}, ${outsider}, 0)`).then(() => 'inserted', (error: Error) => error.message), RLS);
	await as(org, bob, (tx) => leaveIn(tx, org, bob, id));
	assert.equal((await as(org, bob, (tx) => tx`select 1 from thread_reads where thread_id = ${id}`)).length, 0, 'hidden after leaving');
	await as(org, alice, (tx) => readdIn(tx, org, alice, id, bob));
	assert.equal((await as(org, bob, (tx) => tx`select last_read_seq from thread_reads where thread_id = ${id}`)).length, 1, 'visible again after a re-add');
});

it('stars: personal, set or cleared but never changed, and hidden while you are not participating', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), outsider = await person(org);
	const id = await create(org, alice, [bob]);
	await as(org, bob, (tx) => tx`insert into thread_stars (organisation_id, thread_id, user_id) values (${org}, ${id}, ${bob})`);
	assert.equal((await as(org, bob, (tx) => tx`insert into thread_stars (organisation_id, thread_id, user_id) values (${org}, ${id}, ${bob})
		on conflict do nothing returning 1`)).length, 0, 'starring again is a no-op');
	await assert.rejects(as(org, alice, (tx) => tx`insert into thread_stars (organisation_id, thread_id, user_id) values (${org}, ${id}, ${bob})`), REFUSED);
	await assert.rejects(as(org, bob, (tx) => tx`update thread_stars set created_at = now() where thread_id = ${id}`), DENIED);
	assert.equal((await as(org, alice, (tx) => tx`select 1 from thread_stars where thread_id = ${id}`)).length, 0, 'another person’s star is invisible');
	assert.equal((await as(org, alice, (tx) => tx`delete from thread_stars where thread_id = ${id} returning 1`)).length, 0, 'and cannot be cleared by them');
	const attempt = (conversation: string) => as(org, outsider, (tx) => tx`insert into thread_stars (organisation_id, thread_id, user_id)
		values (${org}, ${conversation}, ${outsider})`).then(() => 'inserted', (error: Error) => error.message);
	assert.match(await attempt(id), RLS);
	assert.equal(await attempt(id), await attempt(randomUUID()));
	await as(org, bob, (tx) => leaveIn(tx, org, bob, id));
	assert.equal((await as(org, bob, (tx) => tx`select 1 from thread_stars where thread_id = ${id}`)).length, 0, 'hidden after leaving');
	assert.equal((await as(org, bob, (tx) => tx`delete from thread_stars where thread_id = ${id} returning 1`)).length, 0);
	await as(org, alice, (tx) => readdIn(tx, org, alice, id, bob));
	assert.equal((await as(org, bob, (tx) => tx`delete from thread_stars where thread_id = ${id} returning 1`)).length, 1, 'kept, and clearable after a re-add');
});

it('edits: the author alone replaces the body, keeping its hash; nobody else, and never a tombstone', async () => {
	const org = await organisation();
	const alice = await person(org), bob = await person(org), boss = await person(org, 'admin');
	const id = await create(org, alice, [bob, boss]);
	const message = await send(org, alice, id, 'Original words');
	const [before] = await db.owner<{ sentBodySha256: Buffer; changeSeq: number }[]>`select sent_body_sha256, change_seq from thread_messages where id = ${message}`;
	const start = await counters(id);
	await as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const change = await nextChange(tx, id);
		await tx`update thread_messages set body = 'Better words', revision = 2, change_seq = ${change}, edited_at = '2000-01-01' where id = ${message}`;
	});
	const [edited] = await db.owner<{ body: string; revision: number; changeSeq: number; editedAt: Date; sentBodySha256: Buffer }[]>`
		select body, revision, change_seq, edited_at, sent_body_sha256 from thread_messages where id = ${message}`;
	assert.equal(edited!.body, 'Better words'); assert.equal(edited!.revision, 2);
	assert.ok(edited!.sentBodySha256.equals(before!.sentBodySha256), 'the original hash stays for send retries');
	assert.ok(edited!.editedAt.getUTCFullYear() > 2000, 'edited_at is the server’s time');
	assert.ok(edited!.changeSeq > before!.changeSeq);
	assert.deepEqual({ ...(await counters(id)) }, { lastSeq: start.lastSeq, lastChange: start.lastChange + 1, revision: start.revision }, 'an edit moves only last_change');
	const attempt = (who: string, set: (tx: TransactionSql, change: number) => Promise<unknown>) => as(org, who, async (tx) => {
		await lockShare(tx, org, [who]); await lockConversation(tx, id); await set(tx, await nextChange(tx, id));
	});
	await assert.rejects(attempt(bob, (tx, c) => tx`update thread_messages set body = 'Bob''s words', revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'another participant');
	await assert.rejects(attempt(boss, (tx, c) => tx`update thread_messages set body = 'Moderated', revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'a moderator');
	await assert.rejects(attempt(alice, (tx, c) => tx`update thread_messages set body = 'New', sent_body_sha256 = ${fp('New')}, revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'the hash');
	await assert.rejects(attempt(alice, (tx, c) => tx`update thread_messages set revision = 3, change_seq = ${c} where id = ${message}`), REFUSED, 'the same body');
	await assert.rejects(attempt(alice, (tx, c) => tx`update thread_messages set body = 'Skip', revision = 4, change_seq = ${c} where id = ${message}`), REFUSED, 'a skipped revision');
	await assert.rejects(attempt(alice, (tx, c) => tx`update thread_messages set body = 'Stale', revision = 3, change_seq = ${c - 1} where id = ${message}`), REFUSED, 'a stale change number');
	await assert.rejects(as(org, alice, (tx) => tx`update thread_messages set body = 'No bump', revision = 3 where id = ${message}`), REFUSED, 'no fresh change number');
	await assert.rejects(attempt(alice, (tx, c) => tx`update thread_messages set body = 'Moved', revision = 3, change_seq = ${c}, seq = 9 where id = ${message}`), REFUSED, 'its place');
	await as(org, boss, (tx) => tombstoneIn(tx, org, boss, id, message)); // a moderator's tombstone still works
	await assert.rejects(attempt(alice, (tx, c) => tx`update thread_messages set body = 'Back', revision = 4, change_seq = ${c} where id = ${message}`), REFUSED, 'a tombstone');
	// An edit that also moves the conversation revision is refused by the conversation trigger.
	const other = await send(org, alice, id, 'Second');
	await assert.rejects(as(org, alice, (tx) => tx`update threads set last_change = last_change + 1, revision = revision + 1 where id = ${id}`), REFUSED);
	await as(org, alice, (tx) => editIn(tx, org, alice, id, other, 'Second, edited'));
});

it('pins: only an owner or admin pins a live message of the thread as themselves; one live pin per thread; unpinning is final', async () => {
	const org = await organisation();
	const alice = await person(org, 'admin'), bob = await person(org), outsider = await person(org);
	const id = await create(org, alice, [bob]), elsewhere = await create(org, alice);
	const message = await send(org, alice, id, 'Pin me'), foreign = await send(org, alice, elsewhere, 'Not here'), doomed = await send(org, alice, id, 'Gone');
	const second = await send(org, bob, id, 'Pin me too');
	await as(org, alice, (tx) => tombstoneIn(tx, org, alice, id, doomed));
	const tryPin = (who: string, messageId: string, pinnedBy = who, bump = true) => as(org, who, async (tx) => {
		await lockShare(tx, org, [who]); await lockConversation(tx, id);
		const change = bump ? await nextChange(tx, id) : (await counters(id)).lastChange - 1;
		await tx`insert into thread_pins (organisation_id, thread_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${messageId}, ${change}, ${pinnedBy})`;
	});
	await assert.rejects(tryPin(bob, message), REFUSED, 'a member, even a participant, does not pin');
	const start = await counters(id);
	const pin = await as(org, alice, (tx) => pinIn(tx, org, alice, id, message));
	assert.deepEqual({ ...(await counters(id)) }, { ...start, lastChange: start.lastChange + 1 }, 'a pin moves only last_change');
	const [row] = await db.owner<{ changeSeq: number; pinnedBy: string }[]>`select change_seq, pinned_by from thread_pins where id = ${pin}`;
	assert.deepEqual({ ...row }, { changeSeq: start.lastChange + 1, pinnedBy: alice });
	await assert.rejects(tryPin(alice, second), { code: '23505', constraint_name: 'thread_pins_live' }, 'one live pin per thread');
	await assert.rejects(tryPin(alice, message, bob), REFUSED, 'as someone else');
	// With no live pin, the remaining refusals are the guard's.
	await as(org, alice, async (tx) => { await lockShare(tx, org, [alice]); await lockConversation(tx, id); await unpinIn(tx, alice, id, pin); });
	await assert.rejects(tryPin(alice, doomed), REFUSED, 'a tombstone');
	await assert.rejects(tryPin(alice, foreign), REFUSED, 'a message of another thread');
	await assert.rejects(tryPin(alice, randomUUID()), REFUSED, 'a message that does not exist, refused the same way');
	await assert.rejects(tryPin(alice, second, alice, false), REFUSED, 'without its fresh change number');
	// No oracle for a non-participant.
	const attempt = (conversation: string) => as(org, outsider, (tx) => tx`insert into thread_pins (organisation_id, thread_id, message_id, change_seq, pinned_by)
		values (${org}, ${conversation}, ${message}, 1, ${outsider})`).then(() => 'inserted', (error: Error) => error.message);
	assert.match(await attempt(id), RLS);
	assert.equal(await attempt(id), await attempt(randomUUID()));
	const [unpinned] = await db.owner<{ unpinnedBy: string; unpinnedAt: Date }[]>`select unpinned_by, unpinned_at from thread_pins where id = ${pin}`;
	assert.equal(unpinned!.unpinnedBy, alice); assert.ok(unpinned!.unpinnedAt);
	await assert.rejects(as(org, alice, async (tx) => {
		await lockConversation(tx, id); const change = await nextChange(tx, id);
		await tx`update thread_pins set unpinned_at = null, unpinned_by = null, change_seq = ${change} where id = ${pin}`;
	}), REFUSED, 'an unpinned pin never changes again');
	await assert.rejects(as(org, bob, (tx) => tx`delete from thread_pins where id = ${pin}`), DENIED, 'pins are never deleted');
	const again = await as(org, alice, (tx) => pinIn(tx, org, alice, id, second)); // pinning again is a new pin
	await assert.rejects(as(org, bob, async (tx) => { await lockShare(tx, org, [bob]); await lockConversation(tx, id); await unpinIn(tx, bob, id, again); }),
		REFUSED, 'a member does not unpin');
	await assert.rejects(as(org, bob, async (tx) => {
		await lockConversation(tx, id); const change = await nextChange(tx, id);
		await tx`update thread_pins set unpinned_at = now(), unpinned_by = ${alice}, change_seq = ${change} where id = ${again}`;
	}), REFUSED, 'unpinned as someone else');
	// The author deleting their own pinned message unpins it in the same transaction, admin or not.
	await as(org, bob, (tx) => tombstoneIn(tx, org, bob, id, second));
	assert.equal((await db.owner`select 1 from thread_pins where thread_id = ${id} and unpinned_at is null`).length, 0);
	assert.equal((await db.owner`select 1 from thread_pins where message_id in ${db.owner([message, second])}`).length, 2);
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
		await tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${alice}, revision = revision + 1, change_seq = ${n} where id = ${first}`;
		await tx`insert into thread_pins (organisation_id, thread_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${second}, ${n}, ${alice})`;
	}), REFUSED);
	// A pin takes n; an edit in the same transaction reusing n is refused.
	await assert.rejects(as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`insert into thread_pins (organisation_id, thread_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${second}, ${n}, ${alice})`;
		await tx`update thread_messages set body = 'Edited', revision = revision + 1, change_seq = ${n} where id = ${first}`;
	}), REFUSED);
	// And an unpin reusing a number a message holds.
	const pin = await as(org, alice, (tx) => pinIn(tx, org, alice, id, second));
	await assert.rejects(as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`update thread_messages set body = 'Edited', revision = revision + 1, change_seq = ${n} where id = ${first}`;
		await tx`update thread_pins set unpinned_at = now(), unpinned_by = ${alice}, change_seq = ${n} where id = ${pin}`;
	}), REFUSED);
	// Each with its own advance, the same work succeeds; the deferred dense-seq check is untouched by any of it.
	await as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const n = await nextChange(tx, id);
		await tx`update thread_messages set body = 'Edited', revision = revision + 1, change_seq = ${n} where id = ${first}`;
		await unpinIn(tx, alice, id, pin);
	});
	await assert.rejects(as(org, alice, (tx) => tx`update threads set last_seq = last_seq + 1, last_change = last_change + 1 where id = ${id}`), REFUSED,
		'a bare seq advance still fails at commit');
	const numbers = await db.owner<{ n: number }[]>`select change_seq as n from thread_messages where thread_id = ${id} union all select change_seq from thread_pins where thread_id = ${id}`;
	assert.equal(new Set(numbers.map((r) => r.n)).size, numbers.length, 'every current number is held once');
});

it('account deletion nulls pin attribution without moving a counter and removes personal rows; organisation deletion removes all', async () => {
	const org = await organisation();
	const alice = await person(org, 'owner'), bob = await person(org, 'admin');
	const id = await create(org, alice, [bob]);
	const message = await send(org, alice, id, 'Keep'), other = await send(org, alice, id, 'Also');
	const dropped = await as(org, bob, (tx) => pinIn(tx, org, bob, id, other));
	await as(org, bob, async (tx) => { await lockShare(tx, org, [bob]); await lockConversation(tx, id); await unpinIn(tx, bob, id, dropped); });
	const kept = await as(org, bob, (tx) => pinIn(tx, org, bob, id, message));
	await as(org, bob, (tx) => tx`insert into thread_stars (organisation_id, thread_id, user_id) values (${org}, ${id}, ${bob})`);
	await as(org, bob, (tx) => readIn(tx, org, bob, id, 2));
	const before = await counters(id);
	const pinsBefore = await db.owner<{ id: string; changeSeq: number }[]>`select id, change_seq from thread_pins where thread_id = ${id} order by id`;
	await db.app`delete from users where id = ${bob}`; // account deletion cascades to the membership
	const pins = await db.owner<{ id: string; pinnedBy: string | null; unpinnedBy: string | null; changeSeq: number; unpinnedAt: Date | null }[]>`
		select id, pinned_by, unpinned_by, change_seq, unpinned_at from thread_pins where thread_id = ${id} order by id`;
	assert.deepEqual(pins.map((p) => [p.id, p.pinnedBy, p.unpinnedBy, p.changeSeq]), pinsBefore.map((p) => [p.id, null, null, p.changeSeq]));
	assert.ok(pins.find((p) => p.id === kept && p.unpinnedAt === null), 'the live pin stays live');
	assert.deepEqual({ ...(await counters(id)) }, { ...before }, 'no counter moves');
	for (const table of ['thread_stars', 'thread_reads'])
		assert.equal((await db.owner.unsafe(`select 1 from ${table} where thread_id = $1`, [id])).length, 0, table);
	await as(org, alice, (tx) => tx`delete from organisations where id = ${org}`);
	for (const table of newTables) assert.equal((await db.owner.unsafe(`select 1 from ${table} where organisation_id = $1`, [org])).length, 0, table);
});

it('races, each under the thread lock: one live pin, reads converge up, one star, no pin on a tombstone, one edit per revision', async () => {
	const org = await organisation();
	const alice = await person(org, 'admin'), bob = await person(org, 'admin');
	const id = await create(org, alice, [bob]);
	for (let i = 0; i < 5; i++) await send(org, alice, id);
	const [target] = await db.owner<{ id: string }[]>`select id from thread_messages where thread_id = ${id} and seq = 1`;
	// Two admins pin at once: exactly one live pin; the other fails on the exact index name.
	const start = await counters(id);
	const pins = await Promise.allSettled([as(org, alice, (tx) => pinIn(tx, org, alice, id, target!.id)), as(org, bob, (tx) => pinIn(tx, org, bob, id, target!.id))]);
	assert.equal(pins.filter((p) => p.status === 'fulfilled').length, 1);
	const loser = pins.find((p) => p.status === 'rejected') as PromiseRejectedResult;
	assert.equal((loser.reason as { constraint_name?: string }).constraint_name, 'thread_pins_live');
	assert.equal((await counters(id)).lastChange, start.lastChange + 1, 'the loser’s advance rolled back with it');
	// Read advances arriving out of order converge on the furthest.
	await Promise.all([as(org, bob, (tx) => readIn(tx, org, bob, id, 5)), as(org, bob, (tx) => readIn(tx, org, bob, id, 3))]);
	assert.equal((await db.owner`select last_read_seq from thread_reads where thread_id = ${id} and user_id = ${bob}`)[0]!.lastReadSeq, 5);
	// Starring twice at once leaves one star.
	await Promise.all([0, 1].map(() => as(org, bob, (tx) => tx`insert into thread_stars (organisation_id, thread_id, user_id) values (${org}, ${id}, ${bob}) on conflict do nothing`)));
	assert.equal((await db.owner`select 1 from thread_stars where thread_id = ${id} and user_id = ${bob}`).length, 1);
	// A tombstone racing a pin of the same message: never a live pin on a tombstone, and the unpin follows the tombstone.
	const winner = (await db.owner<{ id: string }[]>`select id from thread_pins where thread_id = ${id} and unpinned_at is null`)[0]!.id;
	await as(org, alice, async (tx) => { await lockShare(tx, org, [alice]); await lockConversation(tx, id); await unpinIn(tx, alice, id, winner); });
	const [victim] = await db.owner<{ id: string }[]>`select id from thread_messages where thread_id = ${id} and seq = 2`;
	const racingPin = as(org, bob, async (tx) => {
		await lockShare(tx, org, [bob]); await lockConversation(tx, id);
		const [live] = await tx<{ deletedAt: Date | null }[]>`select deleted_at from thread_messages where id = ${victim!.id}`;
		if (live!.deletedAt) return 'message_deleted'; // the service's 409, checked under the lock
		const change = await nextChange(tx, id);
		await tx`insert into thread_pins (organisation_id, thread_id, message_id, change_seq, pinned_by) values (${org}, ${id}, ${victim!.id}, ${change}, ${bob})`;
		return 'pinned';
	});
	await Promise.all([racingPin, as(org, alice, (tx) => tombstoneIn(tx, org, alice, id, victim!.id))]);
	const [dead] = await db.owner<{ changeSeq: number }[]>`select change_seq from thread_messages where id = ${victim!.id} and deleted_at is not null`;
	assert.ok(dead, 'the tombstone landed');
	assert.equal((await db.owner`select 1 from thread_pins where message_id = ${victim!.id} and unpinned_at is null`).length, 0, 'no live pin on a tombstone');
	for (const pin of await db.owner<{ changeSeq: number }[]>`select change_seq from thread_pins where message_id = ${victim!.id}`)
		assert.ok(pin.changeSeq > dead!.changeSeq, 'any unpin is numbered after the tombstone');
	// Two edits from the same revision: the second sees the first's revision and writes nothing.
	const [mine] = await db.owner<{ id: string }[]>`select id from thread_messages where thread_id = ${id} and seq = 3`;
	const editFrom = (expected: number, body: string) => as(org, alice, async (tx) => {
		await lockShare(tx, org, [alice]); await lockConversation(tx, id);
		const [row] = await tx<{ revision: number }[]>`select revision from thread_messages where id = ${mine!.id} for update`;
		if (row!.revision !== expected) return 'stale_revision';
		const change = await nextChange(tx, id);
		await tx`update thread_messages set body = ${body}, revision = ${expected + 1}, change_seq = ${change} where id = ${mine!.id}`;
		return 'edited';
	});
	const edits = await Promise.all([editFrom(1, 'One'), editFrom(1, 'Two')]);
	assert.deepEqual([...edits].sort(), ['edited', 'stale_revision']);
	assert.equal((await db.owner`select revision from thread_messages where id = ${mine!.id}`)[0]!.revision, 2);
});
