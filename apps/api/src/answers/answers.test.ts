import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { InferenceError } from '@captain/model';
import { answersFixture } from '../../test/answers-fixture.ts';
import { result } from '../../test/triage-fixture.ts';
import { dateRange } from './dates.ts';
import { AnswerService } from './service.ts';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationLifecycle } from '../organisations/lifecycle.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
it('retrieval uses civil dates, whole name words/exact emails, current provider accounts and bounded, sourced records', async () => {
 const f = await answersFixture(db); try {
  assert.deepEqual(dateRange('last month', '2026-03-01'), { from: '2026-02-01', to: '2026-03-01', label: 'last month', explicit: true });
  assert.equal(dateRange('this week', '2026-01-01').from, '2025-12-29'); assert.equal(dateRange('February 2024', '2026-01-01').to, '2024-03-01');
  assert.equal(dateRange('May I ask a question?', '2026-09-16').explicit, false);
  const civil = await f.retrieve('tasks today', new Date('2026-02-28T12:30:00Z')); assert.equal(civil.today, '2026-03-01'); assert.equal(civil.range.to, '2026-03-02');
  const expired = await f.mail('just-expired'); await f.tx(tx => tx`update mail_messages set sent_at = now() - interval '60 days 1 minute' where thread_id = ${expired}`);
  const named = await f.retrieve('What did Alex discuss?'); assert.ok(!named.rows.some(r => r.source.id === `thread:${expired}`)); assert.ok(named.rows.some(r => r.source.id === `contact:${f.contactId}`)); assert.ok(named.rows.some(r => r.source.kind === 'thread'));
  await f.mail('unrelated', 'other@example.test');
  const exact = await f.retrieve('Mail with xsupplier@example.test'); assert.ok(!exact.rows.some(r => r.source.kind === 'thread'));
  const company = await f.retrieve('Unpaid invoices and meetings today for Supply Co'); assert.ok(company.rows.some(r => r.source.kind === 'company')); assert.ok(company.rows.some(r => r.source.kind === 'event'));
  assert.ok(company.rows.every(r => r.source.url.startsWith('/') && r.source.id && r.source.label)); assert.ok(!JSON.stringify(company).includes('PRIVATE')); assert.ok(!JSON.stringify(company).includes('fixture-token'));
  const overdue = await f.retrieve('What tasks are overdue today?'); assert.ok(overdue.rows.some(r => r.source.id === `task:${f.overdue.id}`)); assert.ok(!overdue.rows.some(r => r.source.id === `task:${f.due.id}`));
  const suggested = await f.retrieve('Suggested tasks'); assert.deepEqual(suggested.rows.filter(r => r.source.kind === 'task').map(r => r.data.status), ['suggested']);
  assert.ok((await f.retrieve('What unpaid invoices are outstanding today?')).rows.some(r => r.source.id === `invoice:${f.invoiceId}`));
  const paid = await f.retrieve('Paid invoices last month'); assert.equal(paid.rows.filter(r => r.source.kind === 'invoice').length, 0);
  await f.tx(tx => tx`update xero_invoices set status = 'PAID', fully_paid_at = (date_trunc('month', ${f.clock.today}::date) - interval '1 day')::date, amount_due = 0, amount_paid = total where id = ${f.invoiceId}`);
  assert.ok((await f.retrieve('Paid invoices last month')).rows.some(r => r.source.id === `invoice:${f.invoiceId}`));
  const stock = await f.retrieve('What stock do we have?'); assert.equal(stock.rows.filter(r => r.source.kind === 'stock')[0]!.data.currentCount, '12'); assert.equal(stock.rows.filter(r => r.source.kind === 'shop_stock')[0]!.data.available, 8);
  await f.tx(tx => tx`update connections set account_email = 'other@example.test' where provider = 'google'`);
  assert.equal((await f.retrieve('Mail with Alex Supplier')).rows.filter(r => r.source.kind === 'thread').length, 0);
 } finally { await f.engine.close(); }
});
it('caps, 60-day mail boundaries, incomplete caches and missing connections remain explicit', async () => {
 const f = await answersFixture(db); try {
  await f.tx(tx => tx`insert into tasks (organisation_id, project_id, title, status, due, source_kind, created_by)
   select ${f.org}, project_id, 'Extra task ' || n, 'open', '2020-01-02', 'person', ${f.userId} from tasks cross join generate_series(1, 25) n where id = ${f.due.id}`);
  for (let n = 0; n < 22; n++) await f.mail(`mail-${n}`, 'supplier@example.test', 'PRIVATE');
  const old = await f.mail('old-mail'); await f.tx(tx => tx`update mail_messages set sent_at = now() - interval '61 days', subject = 'TOO OLD' where thread_id = ${old}`);
  const data = await f.retrieve('Open tasks and mail with Alex Supplier'); assert.equal(data.rows.filter(r => r.source.kind === 'task').length, 20); assert.equal(data.rows.filter(r => r.source.kind === 'thread').length, 20);
  assert.match(data.warnings.join(' '), /first 20 task/); assert.match(data.warnings.join(' '), /first 20 thread/); assert.ok(!JSON.stringify(data).includes('TOO OLD'));
  f.provider.responses.push(result({ answer: 'Here are the matching records.', sources: [data.rows.find(r => r.source.kind === 'task')!.source.id], confidence: 'from_data' }));
  const capped = await f.answers.ask(f.member, f.org, 'Open tasks and mail with Alex Supplier'); assert.equal(capped.confidence, 'partly'); assert.match(capped.answer, /Data limits:.*first 20/s);
  await f.tx(tx => tx`update connections set status = 'disconnected' where provider in ('xero', 'shopify')`);
  await f.tx(tx => tx`update calendars set synced_to = now() - interval '1 day'`);
  await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, detail) values (${f.org}, 'system', 'mail.sync_failed', 'connection', '{}')`);
  const gaps = await f.retrieve('Invoices, stock, mail and calendar this week'); assert.match(gaps.warnings.join(' '), /Xero/); assert.match(gaps.warnings.join(' '), /Shopify/); assert.match(gaps.warnings.join(' '), /Calendar/); assert.match(gaps.warnings.join(' '), /mail/);
  assert.equal(gaps.rows.filter(r => ['invoice', 'shop_stock'].includes(r.source.kind)).length, 0);
 } finally { await f.engine.close(); }
});
it('the HTTP path makes one data-only infer, drops fabricated references, records the actual model and usage, and keeps prior questions out of context', async () => {
 const f = await answersFixture(db); try {
  const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 }); const session = await auth.issueSessionFor(f.member.userId);
  const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), inference: f.inference, rateLimiter: f.limiter });
  const path = `/v1/organisations/${f.org}/answers`, headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
  assert.equal((await app.request(path)).status, 401);
  const source = `task:${f.overdue.id}`; f.provider.responses.push(result({ answer: 'File the return is overdue.', sources: [source, 'invented:' + randomUUID(), source], confidence: 'from_data' }));
  const requests = f.provider.requests.length;
  const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ question: 'What tasks are overdue?' }) }); assert.equal(response.status, 201); const answer = await response.json();
  assert.equal(answer.model, 'stub-claude'); assert.equal(answer.confidence, 'partly'); assert.equal(answer.sources.length, 1); assert.equal(answer.sources[0].url, '/commitments'); assert.equal(f.provider.requests.length, requests + 1);
  const request = f.provider.requests.at(-1)!; assert.match(request.instruction, /UNTRUSTED DATA/); assert.match(request.input, /untrustedRetrievedData/); assert.ok(!request.input.includes('PRIVATE')); assert.ok(!request.input.includes('fixture-token'));
  const [usage] = await f.tx(tx => tx`select step_key, run_id, model, tier from model_usage where step_key = 'answer'`); assert.equal(usage!.runId, null); assert.equal(usage!.tier, 'large'); assert.equal(usage!.model, answer.model);
  const [audit] = await f.tx(tx => tx`select actor_id, actor_kind from audit_events where action = 'answer.created'`); assert.equal(audit!.actorId, f.member.userId); assert.equal(audit!.actorKind, 'person');
  f.provider.responses.push(result({ answer: 'That is not in the saved data. Name a person, source and date range.', sources: [], confidence: 'not_in_data' }));
  const next = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ question: 'What colour is the moon?' }) }); assert.equal(next.status, 201); assert.equal((await next.json()).confidence, 'not_in_data');
  assert.ok(!f.provider.requests.at(-1)!.input.includes('What tasks are overdue?'));
  const history = await (await app.request(path + '?limit=3', { headers })).json(); assert.equal(history.answers.length, 2); assert.equal(history.availability, null);
  assert.equal((await f.answers.list(f.actor, f.org)).answers.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.sends(), 0);
  assert.equal((await app.request(path, { method: 'POST', headers, body: JSON.stringify({ question: ' ', history: [] }) })).status, 400);
  assert.equal((await app.request(path + '?limit=999', { headers })).status, 400);
 } finally { await f.engine.close(); }
});
it('unavailable inference, spent budgets and organisation rate limits do not invoke a provider; invalid output never persists', async () => {
 const f = await answersFixture(db); try {
  const initial = f.provider.requests.length;
  await f.inference.setBudget(f.actor, f.org, 0); assert.equal((await f.answers.list(f.member, f.org)).availability!.code, 'budget_spent');
  await assert.rejects(f.answers.ask(f.member, f.org, 'Open tasks'), { code: 'budget_spent' }); assert.equal(f.provider.requests.length, initial);
  await f.inference.setBudget(f.actor, f.org, 1_000_000); await f.tx(tx => tx`update inference_runtimes set status = 'needs_login'`);
  await assert.rejects(f.answers.ask(f.member, f.org, 'Open tasks'), { code: 'needs_login' }); assert.equal(f.provider.requests.length, initial);
  await f.tx(tx => tx`update inference_runtimes set status = 'ready'`); f.provider.responses.push(result({ answer: 3 }), result({ answer: 3 }));
  await assert.rejects(f.answers.ask(f.member, f.org, 'Open tasks'), { code: 'invalid_output' }); assert.equal((await f.answers.list(f.member, f.org)).answers.length, 0);
  f.provider.responses.push(new InferenceError('provider_unavailable')); await assert.rejects(f.answers.ask(f.member, f.org, 'Open tasks'), { code: 'provider_unavailable' });
  const count = f.provider.requests.length;
  for (let n = 0; n < 30; n++) f.limiter.hit(`answers:${f.org}`, 30, 3_600_000);
  await assert.rejects(f.answers.ask(f.actor, f.org, 'Open tasks'), { status: 429 }); assert.equal(f.provider.requests.length, count);
  f.advanceRate(); f.provider.responses.push(result({ answer: 'Not found.', sources: [], confidence: 'not_in_data' })); await f.answers.ask(f.member, f.org, 'Unknown information');
  assert.equal((await new AnswerService(db.app).list(f.member, f.org)).availability!.code, 'runtime_not_ready');
 } finally { await f.engine.close(); }
});
it('forced tenant RLS, asking-person writes and tenant-qualified membership keys hold; exports include answers', async () => {
 const f = await answersFixture(db); try {
  f.provider.responses.push(result({ answer: 'File the return is overdue.', sources: [`task:${f.overdue.id}`], confidence: 'from_data' })); const answer = await f.answers.ask(f.member, f.org, 'Overdue tasks');
  const [other] = await db.owner`insert into organisations (name) values ('Other') returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${other!.id}, ${f.userId}, 'owner')`;
  const otherTx = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: String(other!.id), userId: f.userId }, work);
  assert.equal((await otherTx(tx => tx`select * from answers`)).length, 0);
  await assert.rejects(otherTx(tx => tx`insert into answers (organisation_id, asked_by, question, answer, sources, confidence, model) values (${f.org}, ${f.userId}, 'Q', 'A', '[]', 'not_in_data', 'fixture')`), { code: '42501' });
  await assert.rejects(f.tx(tx => tx`insert into answers (organisation_id, asked_by, question, answer, sources, confidence, model) values (${f.org}, ${f.member.userId}, 'Q', 'A', '[]', 'not_in_data', 'fixture')`), { code: '42501' });
  await assert.rejects(db.owner`insert into answers (organisation_id, asked_by, question, answer, sources, confidence, model) values (${other!.id}, ${f.member.userId}, 'Q', 'A', '[]', 'not_in_data', 'fixture')`, { code: '23503' });
  const [rls] = await db.owner`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'answers'`; assert.ok(rls!.relrowsecurity && rls!.relforcerowsecurity);
  await assert.rejects(f.answers.list(f.stranger, f.org), { status: 404 });
  let exported = ''; for await (const line of new OrganisationLifecycle(db.app).export(f.actor, f.org)) exported += line; assert.ok(exported.includes(answer.id));
  await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.member.userId}`;
  assert.equal((await withTenant(db.app, { organisationId: f.org, userId: f.member.userId }, tx => tx`select * from answers`)).length, 0);
 } finally { await f.engine.close(); }
});
