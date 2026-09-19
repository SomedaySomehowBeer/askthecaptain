import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip;
let db: Harness; let a: { org: string; connection: string; thread: string; message: string }; let b: typeof a;
const tables = ['mail_threads', 'mail_messages', 'mail_attachments'];
before(async () => {
	if (!databaseUrl) return; db = await freshDatabase();
	async function seed(name: string) {
		const [org] = await db.owner`insert into organisations (name) values (${name}) returning id`;
		const [user] = await db.owner`insert into users (email) values (${`${name}@example.test`}) returning id`;
		await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
		const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status)
			values (${org!.id}, 'google', ${user!.id}, ${`${name}@example.test`}, '{}', 'connected') returning id`;
		const [thread] = await db.owner`insert into mail_threads (organisation_id, connection_id, account_email, provider_id, last_message_at) values (${org!.id}, ${conn!.id}, ${`${name}@example.test`}, 't', now()) returning id`;
		const [message] = await db.owner`insert into mail_messages (organisation_id, connection_id, thread_id, provider_id, from_header, to_header, cc_header, subject, date_header, sent_at, snippet, in_reply_to, body)
			values (${org!.id}, ${conn!.id}, ${thread!.id}, 'm', 'from', 'to', '', 'subject', '', now(), 'snippet', '', 'body') returning id`;
		await db.owner`insert into mail_attachments (organisation_id, message_id, part_id, filename, media_type, size) values (${org!.id}, ${message!.id}, '1', 'invoice.pdf', 'application/pdf', 123)`;
		await db.owner`insert into mail_senders (organisation_id, email) values (${org!.id}, ${`${name.toLowerCase()}-sender@example.test`})`;
		return { org: org!.id as string, connection: conn!.id as string, thread: thread!.id as string, message: message!.id as string };
	}
	a = await seed('A'); b = await seed('B');
});
after(async () => { await db?.close(); });
it('mail tables isolate reads, writes and deletes; no context exposes no mail', async () => {
	for (const table of tables) {
		assert.equal((await db.app`select id from ${db.app(table)}`).length, 0);
		await withTenant(db.app, { organisationId: a.org }, async (tx) => {
			assert.deepEqual((await tx`select organisation_id from ${tx(table)}`).map((r) => r.organisationId), [a.org]);
			assert.equal((await tx`delete from ${tx(table)} where organisation_id = ${b.org} returning id`).length, 0);
		});
		await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`update ${tx(table)} set organisation_id = ${b.org}`), { code: '42501' });
	}
});
it('tenant A cannot link to B connection, thread, or message through foreign keys', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) =>
		tx`insert into mail_threads (organisation_id, connection_id, account_email, provider_id, last_message_at) values (${a.org}, ${b.connection}, 'a', 'cross', now())`), { code: '23503' });
	await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into mail_messages
		(organisation_id, connection_id, thread_id, provider_id, from_header, to_header, cc_header, subject, date_header, sent_at, snippet, in_reply_to, body)
		values (${a.org}, ${a.connection}, ${b.thread}, 'cross', '', '', '', '', '', now(), '', '', '')`), { code: '23503' });
	await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) =>
		tx`insert into mail_attachments (organisation_id, message_id, part_id, filename, media_type, size) values (${a.org}, ${b.message}, 'cross', '', 'text/plain', 0)`), { code: '23503' });
});
it('attachment schema has no byte/content column; scheduler discovery returns only connected tenant ids', async () => {
	const columns = await db.owner`select column_name, data_type from information_schema.columns where table_name = 'mail_attachments'`;
	assert.ok(columns.every((c) => c.dataType !== 'bytea')); assert.ok(!columns.some((c) => /body|data|content/.test(c.columnName)));
	assert.deepEqual((await db.app`select * from gmail_sync_organisations()`).map((r) => Object.keys(r)), [['organisationId'], ['organisationId']]);
	await db.owner`update connections set status = 'disconnected' where id = ${b.connection}`;
	assert.deepEqual((await db.app`select * from gmail_sync_organisations()`).map((r) => r.organisationId), [a.org]);
});
it('sender priors isolate by tenant and are keyed by address, not id', async () => {
	assert.equal((await db.app`select email from mail_senders`).length, 0);
	await withTenant(db.app, { organisationId: a.org }, async (tx) => {
		assert.deepEqual((await tx`select email from mail_senders`).map((r) => r.email), ['a-sender@example.test']);
		assert.equal((await tx`delete from mail_senders where organisation_id = ${b.org} returning email`).length, 0);
	});
	// A rejected statement aborts its transaction, so each refusal gets its own.
	await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into mail_senders (organisation_id, email) values (${b.org}, 'x@example.test')`));
	await assert.rejects(withTenant(db.app, { organisationId: a.org }, (tx) => tx`insert into mail_senders (organisation_id, email) values (${a.org}, 'Upper@example.test')`), /check/);
	assert.equal((await db.owner`select email from mail_senders where organisation_id = ${b.org}`).length, 1);
});

