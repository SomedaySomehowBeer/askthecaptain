import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { withTenant } from '@captain/db';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { expireAttachments } from './expiry.ts';
import { triageFixture, classification, result, until } from '../../test/triage-fixture.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
it('real triage journals, caps attachment retention, suggests tasks, drafts without sending, and a member sends once after a lost response', async () => {
 const f = await triageFixture(db); try {
  const thread = await f.mail(); await f.mail('known-update', 'known@example.test');
  await f.tx(sql => sql`update contacts set source = 'hand' where email = 'known@example.test'`);
  f.provider.responses.push(result(classification()), result({ body: 'Thanks for the update.' }), result(classification()));
  const run = await f.start(); const runId = run;
  await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${runId}`), rows => rows[0]?.state === 'waiting');
  const [triage] = await f.tx(sql => sql`select * from mail_triage`); assert.equal(triage!.needsOwner, true); assert.equal(triage!.model, 'stub-claude');
  assert.equal(f.sends(), 0); const [task] = await f.tx(sql => sql`select * from tasks`); assert.equal(task!.status, 'suggested'); assert.equal(task!.sourceId, thread);
  const steps = await f.tx(sql => sql`select key, output from workflow_run_steps where run_id = ${runId}`);
  assert.match(JSON.stringify(steps), /PDF text extraction is not installed/); assert.ok(!JSON.stringify(steps).includes('UNTRUSTED-ATTACHMENT'));
  assert.ok(JSON.stringify(f.provider.requests).includes('UNTRUSTED-ATTACHMENT')); assert.ok(!JSON.stringify(f.provider.requests).includes('fixture-token'));
  const [draft] = await f.outbox.list(f.member, f.org); assert.ok(draft); await f.outbox.change(f.member, f.org, draft.id, 'edit', 'A person edited this.');
  f.loseSend(); await assert.rejects(f.outbox.send(f.member, f.org, draft.id), { code: 'send_uncertain' });
  await assert.rejects(f.outbox.change(f.member, f.org, draft.id, 'discard'), { code: 'send_uncertain' });
  f.failLabel(); const sent = await f.outbox.send(f.member, f.org, draft.id); assert.equal(sent.state, 'sent'); assert.equal(sent.sentBy, f.member.userId);
  await f.outbox.send(f.member, f.org, draft.id); assert.equal(f.sends(), 1);
  const send = f.calls.find(c => c.path === 'messages/send')!.body; assert.equal(send.threadId, 'thread-one'); const raw = Buffer.from(send.raw, 'base64url').toString();
  assert.match(raw, /In-Reply-To: <thread-one@supplier.test>/); assert.match(raw, /References: <thread-one@supplier.test>/); assert.ok(raw.includes(Buffer.from('A person edited this.').toString('base64')));
  await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${runId}`), rows => rows[0]?.state === 'succeeded');
  assert.equal((await f.tx(sql => sql`select * from mail_triage where needs_owner = false`)).length, 1);
  assert.equal((await f.tx(sql => sql`select id from outbox`)).length, 1); assert.equal(f.calls.filter(c => c.path === 'labels' && c.body).length, 1);
  const [event] = await f.tx(sql => sql`select actor_kind, actor_id from audit_events where action = 'outbox.sent'`); assert.equal(event!.actorKind, 'person'); assert.equal(event!.actorId, f.member.userId);
  await db.owner`update attachment_text set extracted_at = now() - interval '2 days', expires_at = now() - interval '1 day' where organisation_id = ${f.org}`;
  assert.equal(await expireAttachments(db.app, f.org), 2);
  const again = await f.start(); await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${again}`), rows => rows[0]?.state === 'succeeded');
  assert.equal((await f.tx(sql => sql`select id from outbox`)).length, 1);
 } finally { await f.engine.close(); }
});
it('discard wakes the wait; paused inference resumes; exact confirmations close only one matching duty', async () => {
 const f = await triageFixture(db); try {
  await f.mail('confirmation', 'known@example.test', 'Tax lodged REF-2026');
  await f.tx(sql => sql`update contacts set source = 'hand' where email = 'known@example.test'`);
  const commitments = new CommitmentsService(db.app); const task = await commitments.createTask(f.actor, f.org, { title: 'Tax lodged', body: 'REF-2026' });
  const other = await commitments.createTask(f.actor, f.org, { title: 'Tax lodged!', body: 'REF-2026' });
  await f.inference.setBudget(f.actor, f.org, 0); const run = await f.start();
  await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${run}`), rows => rows[0]?.state === 'paused');
  const output = { ...classification(true), category: 'confirmation', facts: { counterparty: 'Known', amounts: [], dates: [], references: ['REF-2026'] }, tasks: [], confirmations: [{ title: 'Tax lodged', reference: 'REF-2026' }, { title: 'Wrong title', reference: 'REF-2026' }] };
  f.provider.responses.push(result(output), result({ body: 'Thank you.' })); await f.inference.setBudget(f.actor, f.org, 1_000_000);
  await f.tx(sql => f.engine.control(sql, f.org, run, 'resume'));
  const drafts = await until(() => f.outbox.list(f.actor, f.org), rows => rows.length === 1);
  await f.outbox.change(f.member, f.org, drafts[0]!.id, 'discard');
  await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${run}`), rows => rows[0]?.state === 'succeeded');
  const tasks = await f.tx(sql => sql`select id, title, status from tasks`);
  assert.equal(tasks.find(t => t.id === task.id)!.status, 'done'); assert.equal(tasks.find(t => t.id === other.id)!.status, 'open');
  assert.equal(tasks.find(t => t.title === 'Wrong title')!.status, 'suggested'); assert.equal(f.sends(), 0);
 } finally { await f.engine.close(); }
});
it('HTTP outbox actions require membership; tenant tables reject cross-tenant reads, writes and foreign keys', async () => {
 const f = await triageFixture(db); try {
  const thread = await f.mail();
  const draft = await f.outbox.create(f.member, f.org, { threadId: thread, to: ['supplier@example.test'], subject: 'Delivery update', body: 'Hello.' });
  const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), outbox: f.outbox });
  const memberSession = await auth.issueSessionFor(f.member.userId); const strangerSession = await auth.issueSessionFor(f.stranger.userId);
  const request = (path: string, token?: string, method = 'GET', body?: object) => app.request(`/v1/organisations/${f.org}/${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('outbox')).status, 401); assert.equal((await request('outbox', strangerSession.token)).status, 404);
  for (const action of ['edit', 'send', 'discard']) assert.equal((await request(`outbox/${draft.id}/${action}`, strangerSession.token, 'POST', { body: 'bad' })).status, 404);
  assert.equal((await request(`outbox/${draft.id}/edit`, memberSession.token, 'POST', { body: 'Edited via HTTP.' })).status, 200);
  assert.equal((await request('outbox', memberSession.token, 'POST', { to: ['victim@example.test'], subject: 'Hi\r\nBcc: attacker@example.test', body: 'bad' })).status, 400);
  await f.tx(sql => sql`update connections set account_email = 'different@example.test'`);
  await assert.rejects(f.outbox.send(f.member, f.org, draft.id), { code: 'reconnect_required' }); assert.equal(f.sends(), 0);
  await f.tx(sql => sql`update connections set account_email = 'business@example.test'`);
  const [run] = await f.tx(sql => sql`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger, state)
   select organisation_id, id, definition_key, definition_version, 'fixture', '{}', 'succeeded' from workflow_enablements returning id`);
  const [message] = await f.tx(sql => sql`select id from mail_messages`);
  await f.tx(sql => sql`insert into mail_triage (organisation_id, thread_id, category, needs_owner, summary, facts, produced_by, model, source_message_id)
   values (${f.org}, ${thread}, 'other', true, 'Fixture', '{}', ${run!.id}, 'stub', ${message!.id})`);
  await f.tx(sql => sql`insert into attachment_text (organisation_id, message_id, attachment_id, text) values (${f.org}, ${message!.id}, 'own', 'private')`);
  const [other] = await db.owner`insert into organisations (name) values ('Other tenant') returning id`;
  const otherTx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: String(other!.id), userId: f.userId }, fn);
  for (const table of ['mail_triage', 'attachment_text', 'outbox']) assert.equal((await otherTx(sql => sql.unsafe(`select * from ${table}`))).length, 0);
  await assert.rejects(otherTx(sql => sql`insert into attachment_text (organisation_id, message_id, attachment_id, text) values (${other!.id}, ${message!.id}, 'x', 'x')`), { code: '23503' });
  await assert.rejects(f.tx(sql => sql`insert into attachment_text (organisation_id, message_id, attachment_id, text) values (${other!.id}, ${message!.id}, 'x', 'x')`), { code: '42501' });
  await assert.rejects(f.tx(sql => sql`insert into attachment_text (organisation_id, message_id, attachment_id, text) values (${f.org}, ${message!.id}, 'huge', ${'x'.repeat(20001)})`), { code: '23514' });
  assert.equal((await otherTx(sql => sql`update outbox set body = 'cross tenant' where id = ${draft.id} returning id`)).length, 0);
  await assert.rejects(otherTx(sql => sql`insert into mail_triage (organisation_id, thread_id, category, needs_owner, summary, facts, produced_by, model, source_message_id)
   values (${other!.id}, ${thread}, 'other', true, 'Cross tenant', '{}', ${run!.id}, 'stub', ${message!.id})`), { code: '23503' });
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${other!.id}, ${f.userId}, 'member')`;
  await assert.rejects(otherTx(sql => sql`insert into outbox (organisation_id, connection_id, account_email, "to", subject, body, idempotency_key)
   values (${other!.id}, ${f.conn.id}, 'business@example.test', '{}', 'x', 'x', 'cross')`), { code: '23503' });
  for (const table of ['mail_triage', 'attachment_text', 'outbox']) assert.equal((await otherTx(sql => sql.unsafe(`delete from ${table} returning *`))).length, 0);
  assert.equal((await request(`outbox/${draft.id}/discard`, memberSession.token, 'POST')).status, 200);
 } finally { await f.engine.close(); }
});
