import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { withTenant } from '@captain/db';
import { EmbedUnavailable, similar, type EmbedClient } from '@captain/retrieval';
import { newDataKey, seal } from '../connections/encryption.ts';
import { NotesService } from '../notes/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { IndexService } from './service.ts';
let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
const it = (name: string, fn: () => Promise<void>) => test(name, { skip: !databaseUrl && 'DATABASE_URL not set' }, fn);
/** A deterministic encoder: a bag of words hashed into 384 dimensions, normalised, so similar text lands close. */
function fakeClient(): EmbedClient & { calls: string[][] } {
	const embed = (text: string) => {
		const v = new Array<number>(384).fill(0);
		for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) { let h = 7; for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 384]! += 1; }
		const norm = Math.hypot(...v) || 1; return v.map((x) => x / norm);
	};
	const client = { calls: [] as string[][], async identity() { return { encoder: 'fake', version: '1', dimensions: 384 }; }, async embed(units: string[]) { client.calls.push(units); return { encoder: 'fake', version: '1', dimensions: 384, vectors: units.map(embed) }; } };
	return client;
}
async function tenant() {
	const master = randomBytes(32);
	const [user] = await db.owner`insert into users (email) values (${`${randomBytes(8).toString('hex')}@test.com`}) returning id`;
	const org = await new OrganisationService(db.app).create({ userId: user!.id, requestId: 'test' }, { name: 'Index' });
	const data = newDataKey(master, org.id); await db.owner`update organisations set data_key_wrapped = ${data.wrapped} where id = ${org.id}`;
	const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status, access_token_encrypted, access_token_expires_at)
		values (${org.id}, 'google', ${user!.id}, 'business@example.test', '{}', 'connected', ${seal(data.key, Buffer.from('test-access'), org.id, 'access_token')}, now() + interval '1 hour') returning id`;
	return { org: String(org.id), user: String(user!.id), conn: String(conn!.id) };
}
async function thread(t: { org: string; conn: string }, messages: { subject: string; body: string; rfc?: string; inReplyTo?: string; sentAt: string }[]) {
	const [row] = await db.owner`insert into mail_threads (organisation_id, connection_id, account_email, provider_id, last_message_at) values (${t.org}, ${t.conn}, 'business@example.test', ${randomUUID()}, ${messages.at(-1)!.sentAt}) returning id`;
	const ids: string[] = [];
	for (const m of messages) {
		const [msg] = await db.owner`insert into mail_messages (organisation_id, connection_id, thread_id, provider_id, from_header, to_header, cc_header, subject, date_header, sent_at, snippet, in_reply_to, body, rfc_message_id)
			values (${t.org}, ${t.conn}, ${row!.id}, ${randomUUID()}, 'sam@supplier.test', 'business@example.test', '', ${m.subject}, ${m.sentAt}, ${m.sentAt}, '', ${m.inReplyTo ?? ''}, ${m.body}, ${m.rfc ?? ''}) returning id`;
		ids.push(String(msg!.id));
	}
	return { id: String(row!.id), ids };
}
const long = (topic: string) => `${topic}. `.repeat(12) + 'Could you confirm the delivery date and reissue the invoice with the new address? We also need the pallet count before Friday.';
it('fills messages oldest first, short replies inherit their parent, thread and note vectors are kept, and a second fill is idle', async () => {
	const t = await tenant(); const client = fakeClient(); const index = new IndexService(db.app, client);
	const kegs = await thread(t, [
		{ subject: 'Keg order for October', body: long('Twelve kegs of pale ale and six of stout'), rfc: '<kegs-1@supplier.test>', sentAt: '2026-09-01T09:00:00Z' },
		{ subject: 'Re: Keg order for October', body: 'Yes please, go ahead.\n\nOn Tue, Sam wrote:\n> Twelve kegs of pale ale', inReplyTo: '<kegs-1@supplier.test>', sentAt: '2026-09-01T10:00:00Z' },
	]);
	const cans = await thread(t, [{ subject: 'Can labels artwork', body: long('The label artwork for the lager cans needs a barcode fix'), sentAt: '2026-09-02T09:00:00Z' }]);
	const notes = new NotesService(db.app, null, (org) => index.fill(org));
	// Created without the save hook so the first fill below does the work and its counts can be checked.
	const note = await new NotesService(db.app).create({ userId: t.user, requestId: 'r' }, t.org, { title: 'Call about kegs', body: 'Sam confirmed the keg order: twelve pale ale, six stout, delivery on the 14th.' });
	const first = await index.fill(t.org);
	assert.deepEqual(first, { messages: 3, notes: 1, threads: 2, unavailable: false });
	const rows = await withTenant(db.app, { organisationId: t.org }, (tx) => tx`select source_kind, source_id, inherited, tokens, encoder, encoder_version from content_vectors order by source_kind, tokens`);
	assert.equal(rows.length, 4); assert.ok(rows.every((r) => r.encoder === 'fake' && r.encoderVersion === '1'));
	const reply = rows.find((r) => r.sourceId === kegs.ids[1])!; assert.equal(reply.inherited, true); assert.ok(Number(reply.tokens) < 40);
	const [parentVector, replyVector] = await withTenant(db.app, { organisationId: t.org }, (tx) => tx`select vector::text from content_vectors where source_id in (${kegs.ids[0]!}, ${kegs.ids[1]!}) order by source_id = ${kegs.ids[0]!} desc`);
	assert.equal(parentVector!.vector, replyVector!.vector);
	assert.ok(!client.calls.flat().some((u) => u.includes('Yes please')), 'the short reply was not sent to the encoder');
	const threads = await withTenant(db.app, { organisationId: t.org }, (tx) => tx`select id, vector is not null as has, vector_encoder from mail_threads order by last_message_at`);
	assert.deepEqual(threads.map((r) => [r.has, r.vectorEncoder]), [[true, 'fake@1'], [true, 'fake@1']]);
	const [saved] = await withTenant(db.app, { organisationId: t.org }, (tx) => tx`select vector is not null as has, vector_encoder from notes where id = ${note.id}`);
	assert.deepEqual([saved!.has, saved!.vectorEncoder], [true, 'fake@1']);
	assert.deepEqual(await index.fill(t.org), { messages: 0, notes: 0, threads: 0, unavailable: false });
	// Retrieval: a seed about kegs finds the keg thread and the note before the cans thread.
	const seed = (await client.embed(['keg order pale ale stout delivery'])).vectors[0]!;
	const found = await withTenant(db.app, { organisationId: t.org }, (tx) => similar(tx, seed, { encoder: 'fake', version: '1' }, { minScore: 0 }));
	assert.deepEqual(found.slice(0, 2).map((f) => f.id).sort(), [kegs.id, note.id].sort()); assert.equal(found.at(-1)!.id, cans.id);
	// An edit re-embeds the note; a save that changes nothing embedded only marks it seen.
	const before = client.calls.length;
	await notes.update({ userId: t.user, requestId: 'r' }, t.org, note.id, { title: 'Call about kegs', body: 'Sam confirmed the keg order: twelve pale ale, six stout, delivery on the 21st.' });
	assert.equal(client.calls.length, before + 1);
	await notes.update({ userId: t.user, requestId: 'r' }, t.org, note.id, { title: 'Call about kegs', body: 'Sam confirmed the keg order: twelve pale ale, six stout, delivery on the 21st.' });
	assert.equal(client.calls.length, before + 1);
	// Vectors cascade with their source and stay inside the tenant.
	await db.owner`delete from mail_threads where id = ${cans.id}`;
	assert.equal((await withTenant(db.app, { organisationId: t.org }, (tx) => tx`select 1 from content_vectors where source_id = ${cans.ids[0]!}`)).length, 0);
	const other = await tenant();
	assert.equal((await withTenant(db.app, { organisationId: other.org }, (tx) => tx`select 1 from content_vectors`)).length, 0);
	assert.equal((await withTenant(db.app, { organisationId: other.org }, (tx) => similar(tx, seed, { encoder: 'fake', version: '1' }, { minScore: 0 }))).length, 0);
});
it('an unavailable service leaves rows unembedded and a missing one means no index', async () => {
	const t = await tenant(); await thread(t, [{ subject: 'Hello', body: long('Anything at all'), sentAt: '2026-09-03T09:00:00Z' }]);
	const down: EmbedClient = { async identity() { return { encoder: 'fake', version: '1', dimensions: 384 }; }, async embed() { throw new EmbedUnavailable(503, 'HTTP 503'); } };
	assert.deepEqual(await new IndexService(db.app, down).fill(t.org), { messages: 0, notes: 0, threads: 0, unavailable: true });
	assert.equal((await withTenant(db.app, { organisationId: t.org }, (tx) => tx`select 1 from content_vectors`)).length, 0);
	const none = new IndexService(db.app, null); assert.equal(none.available, false);
	assert.deepEqual(await none.fill(t.org), { messages: 0, notes: 0, threads: 0, unavailable: true });
	// The budget bounds one call; the rest waits for the next.
	const client = fakeClient(); const index = new IndexService(db.app, client);
	for (let i = 0; i < 3; i++) await thread(t, [{ subject: `More ${i}`, body: long(`Topic number ${i}`), sentAt: `2026-09-04T0${i}:00:00Z` }]);
	assert.equal((await index.fill(t.org, { budget: 2 })).messages, 2);
	assert.deepEqual(await index.fill(t.org, { budget: 64, messages: false }), { messages: 0, notes: 0, threads: 0, unavailable: false });
	assert.equal((await index.fill(t.org, { budget: 64 })).messages, 2);
});
