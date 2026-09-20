import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { withTenant } from '@captain/db';
import { createApp } from '../app.ts';
import { TriageService } from './service.ts';
import { NotesService } from '../notes/service.ts';
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
  // An unknown sender needs the owner; a request earns the draft under the initial rule (needs owner and a request or a known sender).
  f.provider.responses.push(result({ ...classification(), category: 'request' }), result({ body: 'Thanks for the update.' }), result(classification()));
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
  await f.outbox.send(f.member, f.org, draft.id); assert.equal(f.sends(), 1); assert.equal(sent.outcome, 'edited_sent');
  const [prior] = await f.tx(sql => sql`select drafts_edited, drafts_sent, replies from mail_senders where email = 'supplier@example.test'`); assert.equal(prior!.draftsEdited, 1); assert.equal(prior!.draftsSent, 0); assert.equal(prior!.replies, 1);
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
  const discarded = await f.outbox.change(f.member, f.org, drafts[0]!.id, 'discard'); assert.equal(discarded.outcome, 'discarded');
  await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${run}`), rows => rows[0]?.state === 'succeeded');
  assert.equal((await f.tx(sql => sql`select drafts_discarded from mail_senders where email = 'known@example.test'`))[0]!.draftsDiscarded, 1);
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
  assert.equal((await request(`outbox/${draft.id}/remind`, memberSession.token, 'POST', { when: 'later' })).status, 400);
  assert.equal((await request(`outbox/${draft.id}/remind`, memberSession.token, 'POST', { when: 'tomorrow' })).status, 200);
  const [reminded] = await f.tx(sql => sql`select remind_at, state from outbox where id = ${draft.id}`); assert.equal(reminded!.state, 'drafted'); assert.ok(new Date(reminded!.remindAt).getTime() > Date.now());
  assert.equal((await request(`outbox/${draft.id}/not_needed`, memberSession.token, 'POST')).status, 200);
  const [closed] = await f.tx(sql => sql`select state, outcome from outbox where id = ${draft.id}`); assert.equal(closed!.state, 'discarded'); assert.equal(closed!.outcome, 'not_needed');
  assert.equal((await f.tx(sql => sql`select needs_owner from mail_triage where thread_id = ${thread}`))[0]!.needsOwner, false);
  assert.equal((await f.tx(sql => sql`select drafts_not_needed from mail_senders where email = 'supplier@example.test'`))[0]!.draftsNotNeeded, 1);
 } finally { await f.engine.close(); }
});
it('the gate files bulk, list and automated mail with no model call, learns a quiet sender, and a reply resets it', async () => {
 const f = await triageFixture(db); try {
  await f.mail('promo', 'deals@shop.test', 'Big sale on everything', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] });
  await f.mail('list', 'news@list.test', 'This week in brewing', { listUnsubscribe: true });
  await f.mail('robot', 'no-reply@bank.test', 'Your statement is ready');
  for (const n of [1, 2, 3]) await f.mail(`quiet-${n}`, 'quiet@vendor.test', `FYI number ${n}.\nKind regards,\nQuiet\n> quoted line`);
  await f.tx(sql => sql`update contacts set source = 'hand' where email = 'quiet@vendor.test'`);
  // The fixture's verification call is already in the stub's log; count model calls from here.
  const before = f.provider.requests.length;
  f.provider.responses.push(result(classification()), result(classification()), result(classification()));
  const run = await f.start(); await until(() => f.tx(sql => sql`select state, reason from workflow_runs where id = ${run}`), rows => rows[0]?.state === 'succeeded');
  const rows = await f.tx(sql => sql`select t.provider_id, mt.model, mt.needs_owner, mt.summary from mail_triage mt join mail_threads t on t.id = mt.thread_id`);
  const model = Object.fromEntries(rows.map(r => [r.providerId, r.model]));
  assert.deepEqual(model, { promo: 'gate:category_promotions', list: 'gate:list_header', robot: 'gate:automated_sender', 'quiet-1': 'stub-claude', 'quiet-2': 'stub-claude', 'quiet-3': 'stub-claude' });
  assert.ok(rows.every(r => r.needsOwner === false)); assert.match(rows.find(r => r.providerId === 'promo')!.summary, /Promotions/);
  assert.equal(f.provider.requests.length, before + 3);
  // The model saw own text only: the sign-off and the quoted line were cut before the request left.
  assert.ok(!JSON.stringify(f.provider.requests).includes('quoted line')); assert.ok(!JSON.stringify(f.provider.requests).includes('Kind regards'));
  assert.equal((await f.tx(sql => sql`select 1 from audit_events where action = 'mail.filed'`)).length, 3);
  const [quiet] = await f.tx(sql => sql`select threads_seen, information_verdicts, needs_owner_count from mail_senders where email = 'quiet@vendor.test'`);
  assert.deepEqual(quiet, { threadsSeen: 3, informationVerdicts: 3, needsOwnerCount: 0 });
  await f.mail('quiet-4', 'quiet@vendor.test', 'FYI number 4');
  const second = await f.start(); await until(() => f.tx(sql => sql`select state from workflow_runs where id = ${second}`), rows => rows[0]?.state === 'succeeded');
  assert.equal((await f.tx(sql => sql`select model from mail_triage mt join mail_threads t on t.id = mt.thread_id where t.provider_id = 'quiet-4'`))[0]!.model, 'gate:sender_prior');
  assert.equal(f.provider.requests.length, before + 3);
  await f.tx(sql => sql`update mail_senders set replies = 1 where email = 'quiet@vendor.test'`); f.provider.responses.push(result(classification()));
  await f.mail('quiet-5', 'quiet@vendor.test', 'FYI number 5');
  const third = await f.start(); await until(() => f.tx(sql => sql`select state from workflow_runs where id = ${third}`), rows => rows[0]?.state === 'succeeded');
  assert.equal((await f.tx(sql => sql`select model from mail_triage mt join mail_threads t on t.id = mt.thread_id where t.provider_id = 'quiet-5'`))[0]!.model, 'stub-claude');
  assert.equal(f.provider.requests.length, before + 4);
 } finally { await f.engine.close(); }
});


it('a person can ask for a draft on a needs-you thread, hold it for later, or say no reply is wanted', async () => {
 const f = await triageFixture(db); try {
  const thread = await f.mail(); const triage = new TriageService(db.app, f.connections, f.inference, f.gmail);
  const [run] = await f.tx(sql => sql`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger, state)
   select organisation_id, id, definition_key, definition_version, 'fixture', '{}', 'succeeded' from workflow_enablements returning id`);
  const [message] = await f.tx(sql => sql`select id from mail_messages`);
  await f.tx(sql => sql`insert into mail_triage (organisation_id, thread_id, category, needs_owner, summary, facts, produced_by, model, source_message_id)
   values (${f.org}, ${thread}, 'other', true, 'Fixture', '{}', ${run!.id}, 'stub', ${message!.id})`);
  const held = await triage.threadAction(f.member, f.org, thread, 'remind', 'next_week'); assert.ok(new Date(held.remindAt).getTime() > Date.now() + 5 * 24 * 3600 * 1000);
  f.provider.responses.push(result({ body: 'Thanks, Thursday suits us.' }));
  const draft = await triage.requestDraft(f.member, f.org, thread);
  assert.equal(draft.body, 'Thanks, Thursday suits us.'); assert.equal(draft.createdByPerson, f.member.userId); assert.equal(draft.state, 'drafted'); assert.deepEqual(draft.to, ['supplier@example.test']);
  assert.ok(!JSON.stringify(f.provider.requests.at(-1)).includes('fixture-token'));
  assert.equal((await f.tx(sql => sql`select drafts_requested from mail_senders where email = 'supplier@example.test'`))[0]!.draftsRequested, 1);
  assert.equal((await f.tx(sql => sql`select remind_at from mail_triage where thread_id = ${thread}`))[0]!.remindAt, null);
  await assert.rejects(triage.requestDraft(f.member, f.org, thread), { code: 'draft_exists' });
  await f.outbox.change(f.member, f.org, draft.id, 'discard');
  const closed = await triage.threadAction(f.member, f.org, thread, 'not_needed'); assert.equal(closed.needsOwner, false);
  const [prior] = await f.tx(sql => sql`select information_verdicts, needs_owner_count from mail_senders where email = 'supplier@example.test'`); assert.equal(prior!.informationVerdicts, 1); assert.equal(prior!.needsOwnerCount, 0);
  await assert.rejects(triage.threadAction(f.stranger, f.org, thread, 'not_needed'), { status: 404 });
 } finally { await f.engine.close(); }
});

it('a saved note is read by the same run as mail: classified with the person as author, its tasks suggested, and not read again unchanged', async () => {
 const f = await triageFixture(db); try {
  const notes = new NotesService(db.app, (sql, org, event, data) => f.engine.emit(sql, org, event, data));
  f.provider.responses.push(result({ category: 'plan', summary: 'Cans for October are being arranged.', facts: { counterparty: 'CanCo', amounts: ['2,000 cans'], dates: ['October'], references: [] }, tasks: [{ title: 'Chase the can quote', reference: 'CanCo', due: null }] }));
  const note = await notes.create(f.actor, f.org, { title: 'Call with CanCo', body: 'Long call about cans for October. '.repeat(8) + 'They will send a quote on Friday; we chase if it has not arrived.' });
  const [run] = await until(() => f.tx(sql => sql`select id, state from workflow_runs order by created_at desc limit 1`), rows => rows[0]?.state === 'succeeded');
  const [triage] = await f.tx(sql => sql`select * from note_triage where note_id = ${note.id}`); assert.equal(triage!.category, 'plan'); assert.equal(triage!.producedBy, run!.id);
  const [task] = await f.tx(sql => sql`select * from tasks where source_kind = 'note' and source_id = ${note.id}`); assert.equal(task!.status, 'suggested'); assert.equal(task!.title, 'Chase the can quote');
  assert.ok(!JSON.stringify(f.provider.requests).includes('fixture-token')); const calls = f.provider.requests.length;
  await notes.update(f.actor, f.org, note.id, { title: 'Call with CanCo', body: 'Long call about cans for October. '.repeat(8) + 'They will send a quote on Friday; we chase if it has not arrived.', projectId: null });
  await until(() => f.tx(sql => sql`select state from workflow_runs order by created_at desc limit 1`), rows => rows[0]?.state === 'succeeded');
  assert.equal(f.provider.requests.length, calls);
  await notes.create(f.actor, f.org, { body: 'Too short to read.' });
  await until(() => f.tx(sql => sql`select state from workflow_runs order by created_at desc limit 1`), rows => rows[0]?.state === 'succeeded');
  assert.equal(f.provider.requests.length, calls);
 } finally { await f.engine.close(); }
});
