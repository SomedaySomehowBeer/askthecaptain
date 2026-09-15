import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { GmailClient } from '@captain/connectors/gmail';
import { GoogleConnector } from '@captain/connectors';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { ConnectionService } from '../connections/service.ts';
import { newDataKey, seal } from '../connections/encryption.ts';
import { OrganisationService } from '../organisations/service.ts';
import { MailSync, startMailSchedule } from './sync.ts';
const it = databaseUrl ? test : test.skip;
let db: Harness; let template: Record<string, any>;
before(async () => { if (databaseUrl) db = await freshDatabase(); template = JSON.parse(await readFile(new URL('../../../../packages/connectors/test/fixtures/thread.json', import.meta.url), 'utf8')); });
after(async () => { await db?.close(); });
async function setup() {
	const master = randomBytes(32); const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
	const [user, member, stranger] = await db.owner`insert into users (email) values (${`${randomBytes(8).toString('hex')}@test.com`}), (${`${randomBytes(8).toString('hex')}@test.com`}), (${`${randomBytes(8).toString('hex')}@test.com`}) returning id`;
	const org = await new OrganisationService(db.app).create({ userId: user!.id, requestId: 'test' }, { name: 'Mailbox' });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org.id}, ${member!.id}, 'member')`;
	const data = newDataKey(master, org.id); await db.owner`update organisations set data_key_wrapped = ${data.wrapped} where id = ${org.id}`;
	const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status, access_token_encrypted, access_token_expires_at)
		values (${org.id}, 'google', ${user!.id}, 'business@example.test', '{}', 'connected', ${seal(data.key, Buffer.from('test-access'), org.id, 'access_token')}, now() + interval '1 hour') returning id`;
	let mode = 'initial'; let failThread = ''; let historyExpired = false; let renamed = false; let held: Promise<void> | undefined; let heldThread = ''; let threadHold: Promise<void> | undefined;
	const calls: URL[] = [];
	const gmail = new GmailClient(async (input) => {
		const url = new URL(String(input)); calls.push(url); const path = url.pathname;
		if (path.endsWith('/profile')) { if (held) await held; return Response.json({ emailAddress: 'business@example.test', historyId: '100' }); }
		if (path.endsWith('/labels')) return Response.json({ labels: [{ id: 'INBOX', name: 'Inbox' }, { id: 'Label_supplier', name: renamed ? 'Partners' : 'Suppliers' }] });
		if (path.endsWith('/history')) {
			if (historyExpired) return new Response('', { status: 404 });
			assert.ok(['100', '120'].includes(url.searchParams.get('startHistoryId')!));
			return Response.json(url.searchParams.has('pageToken') ? { historyId: '120', history: [{ messagesDeleted: [{ message: { threadId: 'thread-2' } }] }] }
				: { historyId: '120', history: [{ messages: [{ threadId: 'thread-1' }, { threadId: 'thread-1' }] }], nextPageToken: 'next' });
		}
		if (path.endsWith('/threads')) {
			assert.match(url.searchParams.get('q')!, /^after:\d+$/);
			if (mode === 'bulk') return Response.json({ threads: Array.from({ length: 75 }, (_, n) => ({ id: `bulk-${n}` })) });
			if (mode === 'cap') { const page = Number(url.searchParams.get('pageToken') ?? 0); return Response.json({ threads: Array.from({ length: 100 }, (_, n) => ({ id: `cap-${page * 100 + n}` })), nextPageToken: String(page + 1) }); }
			return Response.json(url.searchParams.has('pageToken') ? { threads: [{ id: 'thread-2' }] } : { threads: [{ id: 'thread-1' }], nextPageToken: 'next' });
		}
		const id = path.split('/').at(-1)!; if (id === heldThread) await threadHold;
		if (id === failThread) return new Response('private provider error', { status: 500 });
		if ((mode === 'incremental' && id === 'thread-2') || mode === 'cap') return new Response('', { status: 404 });
		const thread = structuredClone(template); thread.id = id; thread.messages[0].id = `${id}-message`; thread.messages[0].threadId = id;
		if (id === 'thread-2') thread.messages[0].internalDate = String(Number(thread.messages[0].internalDate) + 1000);
		if (mode === 'bulk') thread.messages[0].payload.headers.find((h: any) => h.name.toLowerCase() === 'from').value = `Person ${id} <${id}@supplier.test>`;
		if (mode === 'incremental') { thread.messages[0].payload.parts.pop(); thread.messages[0].snippet = 'Updated preview'; }
		return Response.json(thread);
	});
	const connections = new ConnectionService(db.app, new GoogleConnector('test', 'test', 'https://api.test/cb'), master, 'https://app.test');
	const sync = new MailSync(db.app, connections, gmail);
	const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), connections, mailSync: sync });
	const ownerToken = (await auth.issueSessionFor(user!.id)).token; const memberToken = (await auth.issueSessionFor(member!.id)).token; const strangerToken = (await auth.issueSessionFor(stranger!.id)).token;
	const request = (path = '', token = ownerToken, method = 'GET') => app.request(`/v1/organisations/${org.id}/mail/${path}`, { method, headers: { authorization: `Bearer ${token}` } });
	return { org: org.id, conn: conn!.id, sync, anotherSync: () => new MailSync(db.app, connections, gmail), request, ownerToken, memberToken, strangerToken, calls,
		mode: (value: string) => { mode = value; }, fail: (id: string) => { failThread = id; }, expire: () => { historyExpired = true; }, rename: () => { renamed = true; }, hold: (promise: Promise<void>) => { held = promise; }, holdThread: (id: string, promise: Promise<void>) => { heldThread = id; threadHold = promise; } };
}
it('initial pagination, idempotent upserts, latest-message reads and attachment metadata', async () => {
	const s = await setup(); const first = await s.sync.run(s.org); assert.equal(first.threads, 2); assert.equal(first.attachments, 4);
	const [peopleRun] = await db.owner`select actor_kind, detail from audit_events where organisation_id = ${s.org} and action = 'contacts.synced'`;
	assert.equal(peopleRun!.actorKind, 'system'); assert.ok(peopleRun!.detail.created > 0);
	const list = await (await s.request('threads?limit=1', s.memberToken)).json(); assert.equal(list.threads.length, 1); assert.equal(list.hasMore, true);
	const older = await (await s.request(`threads?limit=1&before=${encodeURIComponent(list.nextBefore)}`)).json();
	assert.equal(older.threads.length, 1); assert.notEqual(older.threads[0].id, list.threads[0].id); assert.equal(older.hasMore, false);
	assert.equal(list.threads[0].attachmentCount, 2); assert.deepEqual(list.threads[0].labelNames, ['Inbox', 'Suppliers']);
	const detail = await (await s.request(`threads/${list.threads[0].id}`, s.memberToken)).json(); assert.equal(detail.messages[0].body, 'Your delivery is on Thursday.');
	assert.equal(detail.messages[0].attachments[0].filename, 'delivery.pdf'); assert.ok(!JSON.stringify(detail).includes('ATTACHMENT-NEVER-STORE'));
	assert.equal((await (await s.request('threads?since=2030-01-01T00:00:00Z')).json()).threads.length, 0);
	assert.equal((await s.request('threads?limit=0')).status, 400); assert.equal((await s.request('threads?since=not-a-date')).status, 400);
	const before = await db.owner`select id from mail_messages where organisation_id = ${s.org} order by id`;
	await s.sync.run(s.org); assert.deepEqual(await db.owner`select id from mail_messages where organisation_id = ${s.org} order by id`, before);
	const events = await db.owner`select actor_kind, detail from audit_events where organisation_id = ${s.org} and action = 'mail.synced'`;
	assert.equal(events.length, 2); assert.ok(events.every((e) => e.actorKind === 'system')); assert.ok(!JSON.stringify(events).includes('delivery'));
});
it('incremental pagination handles deletions, changed attachments, label renames and advances only the final cursor', async () => {
	const s = await setup(); await s.sync.run(s.org); s.mode('incremental'); s.rename();
	const result = await s.sync.run(s.org); assert.equal(result.full, false); assert.equal(result.threads, 1); assert.equal(result.deleted, 1);
	const list = await (await s.request('threads')).json(); assert.equal(list.threads.length, 1); assert.equal(list.threads[0].attachmentCount, 1);
	assert.deepEqual(list.threads[0].labelNames, ['Inbox', 'Partners']); assert.equal(list.threads[0].snippet, 'Updated preview');
	const [cursor] = await db.owner`select cursor from sync_cursors where organisation_id = ${s.org}`; assert.equal(JSON.parse(cursor!.cursor).historyId, '120');
});
it('a failed first batch leaves mail and cursor untouched; history 404 performs a full recent resync', async () => {
	const s = await setup(); s.fail('thread-2');
	await assert.rejects(s.sync.run(s.org), { code: 'mail_sync_failed' });
	assert.equal((await db.owner`select id from mail_threads where organisation_id = ${s.org}`).length, 0);
	assert.equal((await db.owner`select id from sync_cursors where organisation_id = ${s.org}`).length, 0);
	const failed = await (await s.request('threads')).json(); assert.equal(failed.lastSync.detail.success, false); assert.ok(!JSON.stringify(failed).includes('private provider'));
	s.fail(''); await s.sync.run(s.org); s.expire(); assert.equal((await s.sync.run(s.org)).full, true);
});
it('manual sync is owner/admin only, members read, outsiders cannot read, and revoked connections refuse sync', async () => {
	const s = await setup(); assert.equal((await s.request('sync', s.memberToken, 'POST')).status, 403);
	assert.equal((await s.request('threads', s.strangerToken)).status, 404); assert.equal((await s.request('sync', s.strangerToken, 'POST')).status, 404);
	assert.equal((await s.request('sync', s.ownerToken, 'POST')).status, 200);
	const list = await (await s.request('threads')).json(); assert.equal((await s.request(`threads/${list.threads[0].id}`, s.strangerToken)).status, 404);
	await db.owner`update connections set status = 'revoked' where id = ${s.conn}`;
	assert.equal((await s.request('sync', s.ownerToken, 'POST')).status, 503); assert.equal((await (await s.request('threads')).json()).connection.status, 'revoked');
});
it('overlap is rejected and a changed account cannot receive mail fetched for the old account', async () => {
	const s = await setup(); let release!: () => void; s.hold(new Promise<void>((resolve) => { release = resolve; }));
	const first = s.sync.run(s.org);
	await assert.rejects(s.sync.run(s.org), { code: 'sync_running' });
	// Wait until the first run has taken its snapshot and reached the held profile response.
	for (let n = 0; n < 100 && !s.calls.some((url) => url.pathname.endsWith('/profile')); n++) await new Promise((r) => setTimeout(r, 5));
	await db.owner`update connections set account_email = 'replacement@example.test' where id = ${s.conn}`;
	release(); await assert.rejects(first, { code: 'mail_sync_failed' });
	assert.equal((await db.owner`select id from mail_threads where organisation_id = ${s.org}`).length, 0);
});
it('initial sync is capped at 500 threads and reports that limit', async () => {
	const s = await setup(); s.mode('cap'); const result = await s.sync.run(s.org);
	assert.equal(result.capped, true); assert.equal(s.calls.filter((u) => /\/threads\/cap-/.test(u.pathname)).length, 500);
	assert.equal(s.calls.filter((u) => u.pathname.endsWith('/threads')).length, 5);
});
it('a third-batch failure preserves two batches and contacts, leaves history unchanged, and retries idempotently', async () => {
 for (const previous of [null, JSON.stringify({ accountEmail: 'business@example.test', historyId: '100', capped: false })]) {
  const s = await setup(); s.mode('bulk'); s.fail('bulk-51');
  if (previous) { await db.owner`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${s.org}, ${s.conn}, 'gmail.history', ${previous})`; s.expire(); }
  await assert.rejects(s.sync.run(s.org), { code: 'mail_sync_failed' });
  const first = await db.owner`select id from mail_threads where organisation_id = ${s.org} order by id`; assert.equal(first.length, 50);
  assert.equal((await db.owner`select id from contacts where organisation_id = ${s.org} and email like '%@supplier.test'`).length, 50);
  const [cursor] = await db.owner`select cursor from sync_cursors where organisation_id = ${s.org} and resource = 'gmail.history'`;
  assert.equal(cursor?.cursor ?? null, previous);
  const [failure] = await db.owner`select detail from audit_events where organisation_id = ${s.org} and action = 'mail.sync_failed'`;
  assert.equal(failure!.detail.threads, 50); assert.match(failure!.detail.error, /incomplete/);
  const pages = await db.owner`select detail from audit_events where organisation_id = ${s.org} and action = 'mail.batch_synced'`;
  assert.deepEqual(pages.map((p) => p.detail.threads), [25, 25]);
  assert.equal((await (await s.request('threads')).json()).lastSync.detail.success, false);
  s.fail(''); assert.equal((await s.sync.run(s.org)).threads, 75);
  const final = await db.owner`select id from mail_threads where organisation_id = ${s.org} order by id`;
  assert.equal(final.length, 75); assert.deepEqual(final.slice(0, 50), [...first]);
  assert.equal((await db.owner`select id from contacts where organisation_id = ${s.org} and email like '%@supplier.test'`).length, 75);
  assert.equal(JSON.parse((await db.owner`select cursor from sync_cursors where organisation_id = ${s.org} and resource = 'gmail.history'`)[0]!.cursor).historyId, '100');
 }
});
it('a waiting provider holds no transaction or connection row lock; another runner cannot enter between batches', async () => {
 const s = await setup(); s.mode('bulk'); let release!: () => void; s.holdThread('bulk-50', new Promise<void>((resolve) => { release = resolve; }));
 const run = s.sync.run(s.org); const rejected = assert.rejects(run, { code: 'mail_sync_failed' });
 try {
  for (let n = 0; n < 500 && !s.calls.some((u) => u.pathname.endsWith('/bulk-50')); n++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.calls.some((u) => u.pathname.endsWith('/bulk-50')));
  assert.equal((await db.owner`select id from mail_threads where organisation_id = ${s.org}`).length, 50);
  assert.equal((await db.owner`select pid from pg_stat_activity where datname = current_database() and usename = 'app' and xact_start is not null`).length, 0);
  await assert.rejects(s.anotherSync().run(s.org), { code: 'sync_running' });
  await db.owner.begin(async (tx) => { await tx`set local lock_timeout = '1s'`; await tx`update connections set status = 'disconnected' where id = ${s.conn}`; });
 } finally { release(); await rejected; }
 assert.equal((await db.owner`select id from mail_threads where organisation_id = ${s.org}`).length, 50);
 assert.equal((await db.owner`select id from sync_cursors where organisation_id = ${s.org}`).length, 0);
});
it('a replaced lease or changed history cursor fences the old runner before it can persist a batch', async () => {
 for (const changed of ['lease', 'history']) {
  const s = await setup(); let release!: () => void; s.holdThread('thread-1', new Promise<void>((resolve) => { release = resolve; }));
  const run = s.sync.run(s.org); const rejected = assert.rejects(run, { code: 'sync_running' });
  try {
   for (let n = 0; n < 500 && !s.calls.some((u) => u.pathname.endsWith('/thread-1')); n++) await new Promise((r) => setTimeout(r, 10));
   assert.ok(s.calls.some((u) => u.pathname.endsWith('/thread-1')));
   if (changed === 'lease') await db.owner`update sync_cursors set cursor = 'replacement' where organisation_id = ${s.org} and resource = 'gmail.sync-lock'`;
   else await db.owner`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${s.org}, ${s.conn}, 'gmail.history', 'changed')`;
  } finally { release(); await rejected; }
  assert.equal((await db.owner`select id from mail_threads where organisation_id = ${s.org}`).length, 0);
  assert.equal((await db.owner`select cursor from sync_cursors where organisation_id = ${s.org}`)[0]!.cursor, changed === 'lease' ? 'replacement' : 'changed');
 }
});
it('an expired lease from a stopped process can be reclaimed', async () => {
 const s = await setup();
 await db.owner`insert into sync_cursors (organisation_id, connection_id, resource, cursor, updated_at)
  values (${s.org}, ${s.conn}, 'gmail.sync-lock', 'stopped-run', now() - interval '3 minutes')`;
 assert.equal((await s.sync.run(s.org)).threads, 2);
 assert.equal((await db.owner`select id from sync_cursors where organisation_id = ${s.org} and resource = 'gmail.sync-lock'`).length, 0);
});
test('scheduler is disabled explicitly and guards overlapping interval ticks', async () => {
	let scans = 0; let runs = 0; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
	const routine = { async organisations() { scans++; return ['org']; }, async run() { runs++; await held; return {} as any; } };
	await startMailSchedule(routine, true, 5)(); assert.equal(scans, 0);
	const stop = startMailSchedule(routine, false, 5); await new Promise((r) => setTimeout(r, 30));
	assert.equal(scans, 1); assert.equal(runs, 1); release(); await stop();
});
