import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { definitionByKey, requirementsOf } from '@captain/steps';
import { CommitmentsService } from '../commitments/service.ts';
import { taskAtTime } from '../commitments/chase.ts';
import { chaseFixture } from '../../test/chase-fixture.ts';
import { result, until } from '../../test/triage-fixture.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
const body = 'Hello Customer, could you let us know when payment of AUD 120 for INV-42, due 10 January 2020, can be expected? Thank you.';
it('independent task waits do not block reminders or invoice drafts; owner routing, fresh status, replay and person-only sending', async () => {
 const f = await chaseFixture(db); try {
  assert.deepEqual(f.registry.missing(definitionByKey('chase-due')!), []);
  assert.deepEqual(requirementsOf(definitionByKey('chase-due')!).sort(), ['connection:google', 'connection:xero', 'inference', 'push']);
  await f.push.subscribe(f.member, f.org, { endpoint: 'https://push.example.test/member', keys: { p256dh: 'fixture', auth: 'fixture' } });
  await f.tx(tx => tx`update tasks set owner_id = ${f.member.userId} where id = ${f.overdue.id}`);
  const [future] = await f.tx(tx => tx`insert into tasks (organisation_id, project_id, title, status, due, source_kind, created_by)
   select organisation_id, project_id, 'Future delivery', 'open', ${f.clock.today}::date + 5, 'person', ${f.userId} from tasks where id = ${f.due.id} returning id`);
  await f.enable(); f.provider.responses.push(result({ body })); const run = await f.start();
  const draft = await until(() => f.outbox.list(f.actor, f.org), d => d.length === 1);
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'waiting');
  assert.equal(f.sends(), 0); assert.equal(draft[0]!.threadId, null); assert.deepEqual(draft[0]!.to, ['customer@example.test']); assert.equal(draft[0]!.createdBy, run);
  assert.equal(f.payloads.length, 3); assert.ok(f.payloads.some(p => p.endpoint.endsWith('/member') && p.payload.title === 'Due soon: File the return'));
  assert.ok(f.payloads.some(p => p.endpoint.endsWith('/owner') && p.payload.title === 'Overdue: File the return'));
  const request = f.provider.requests.at(-1)!; assert.match(request.instruction, /UNTRUSTED DATA/); assert.match(request.input, /untrustedInvoice/); assert.match(request.input, /daysOverdue/); assert.ok(!request.input.includes('fixture-token'));
  const state = await f.workflows.run(f.actor, f.org, run); assert.equal(state.steps.filter(s => s.state === 'waiting').length, 2);
  const pending = state.steps.find(s => s.key === 'time.beforeDue' && s.state === 'waiting')!;
  const [expected] = await f.tx(tx => tx`select ((${f.clock.today}::date + 3)::timestamp + interval '7 hours') at time zone ${f.clock.timezone} as at`);
  assert.equal((pending.output as { wakeAt: string }).wakeAt, expected!.at.toISOString());
  await f.tx(tx => tx`update tasks set due = due + 1 where id = ${future!.id}`); await f.wake(run, String(future!.id));
  const [rescheduled] = await f.tx(tx => tx`select ((${f.clock.today}::date + 4)::timestamp + interval '7 hours') at time zone ${f.clock.timezone} as at`);
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.steps.some(s => s.key === 'time.beforeDue' && (s.output as any)?.wakeAt === rescheduled!.at.toISOString()));
  await f.outbox.send(f.member, f.org, String(draft[0]!.id)); assert.equal(f.sends(), 1);
  const sent = f.calls.find(c => c.path === 'messages/send')!.body; assert.equal(sent.threadId, undefined);
  const raw = Buffer.from(sent.raw, 'base64url').toString(); assert.ok(!raw.includes('In-Reply-To:')); assert.match(raw, /To: customer@example.test/);
  await f.tx(tx => tx`update tasks set status = 'done' where id in (${future!.id}, ${f.due.id})`);
  await f.wake(run, String(future!.id)); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  const after = await f.workflows.run(f.actor, f.org, run); assert.ok(after.steps.some(s => s.key === 'time.afterDue' && (s.output as any)?.status === 'done'));
  assert.equal(f.payloads.length, 3); const calls = f.provider.requests.length;
  await f.engine.boss.send('workflow_chase-due', { runId: run }); await new Promise(r => setTimeout(r, 800));
  assert.equal(f.provider.requests.length, calls); assert.equal((await f.tx(tx => tx`select * from outbox`)).length, 1);
 } finally { await f.engine.close(); }
});
it('a real delayed queue wake survives a worker restart and rereads the task, without waiting for the timeout', async () => {
 const f = await chaseFixture(db); try {
  await f.tx(tx => tx`update tasks set status = 'done'`);
  const task = await new CommitmentsService(db.app).createTask(f.actor, f.org, { title: 'Timer task', due: '2099-01-01' });
  await f.tx(tx => tx`update tasks set due = ${f.clock.today}::date + 5 where id = ${task.id}`);
  const original = f.registry.handlers.get('time.beforeDue')!; assert.ok('transaction' in original);
  let reads = 0; f.registry.handlers.set('time.beforeDue', { kind: 'await', transaction: async (ctx, args) => {
   reads++; const value = await original.transaction(ctx, args) as any;
   return value.ready ? value : { ...value, wakeAt: new Date(Date.now() + 2200) };
  } });
  await f.enable(); f.provider.responses.push(result({ body })); const run = await f.start();
  await until(() => f.outbox.list(f.actor, f.org), d => d.length === 1);
  const [step] = await f.tx(tx => tx`select deadline, output from workflow_run_steps where run_id = ${run} and key = 'time.beforeDue'`);
  assert.ok(step!.deadline.getTime() - new Date(step!.output.wakeAt).getTime() > 80 * 86400000);
  await f.engine.close(); await f.tx(tx => tx`update tasks set status = 'cancelled' where id = ${task.id}`); await f.engine.open();
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded'); assert.ok(reads >= 2); assert.equal(f.payloads.length, 0);
 } finally { await f.engine.close(); }
});
it('changed dates reschedule waits; completed/missing tasks are released; organisation time handles DST', async () => {
 const f = await chaseFixture(db); try {
  await f.tx(tx => tx`update organisations set timezone = 'Australia/Sydney' where id = ${f.org}`);
  await f.tx(tx => tx`update tasks set due = '2026-10-06' where id = ${f.due.id}`);
  const before = await f.tx(tx => taskAtTime(tx, f.org, f.due.id, 'before', 2, new Date('2026-10-03T12:00:00Z')));
  assert.equal(before.today, '2026-10-03'); assert.equal(before.ready, false); assert.equal(before.wakeAt!.toISOString(), '2026-10-03T20:00:00.000Z');
  const dueDay = await f.tx(tx => taskAtTime(tx, f.org, f.due.id, 'after', 0, new Date('2026-10-06T12:00:00Z'))); assert.equal(dueDay.ready, false);
  const overdue = await f.tx(tx => taskAtTime(tx, f.org, f.due.id, 'after', 0, new Date('2026-10-06T14:00:00Z'))); assert.equal(overdue.today, '2026-10-07'); assert.equal(overdue.ready, true);
  await f.tx(tx => tx`update tasks set due = '2026-10-10' where id = ${f.due.id}`);
  const moved = await f.tx(tx => taskAtTime(tx, f.org, f.due.id, 'before', 2, new Date('2026-10-03T12:00:00Z'))); assert.equal(moved.wakeAt!.toISOString(), '2026-10-07T20:00:00.000Z');
  await f.tx(tx => tx`delete from tasks where id = ${f.due.id}`); const gone = await f.tx(tx => taskAtTime(tx, f.org, f.due.id, 'after', 0, new Date())); assert.equal(gone.ready, true); assert.equal(gone.active, false);
 } finally { await f.engine.close(); }
});
it('budget pauses resume with validated output; invoices paid or changed during inference do not create drafts', async () => {
 const f = await chaseFixture(db); try {
  await f.tx(tx => tx`update tasks set status = 'done'`); await f.enable(); await f.inference.setBudget(f.actor, f.org, 0); const run = await f.start();
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused'); assert.equal((await f.outbox.list(f.actor, f.org)).length, 0);
  f.provider.responses.push(result({ body: 42 }), result({ body })); await f.inference.setBudget(f.actor, f.org, 1_000_000);
  await f.tx(tx => tx`update xero_invoices set amount_due = 0 where id = ${f.invoiceId}`);
  await f.tx(tx => f.engine.control(tx, f.org, run, 'resume')); const finished = await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  assert.equal((await f.outbox.list(f.actor, f.org)).length, 0); assert.match(JSON.stringify(finished.steps.at(-1)!.output), /no longer outstanding/);
  assert.equal((await f.tx(tx => tx`select * from model_usage where run_id = ${run}`)).length, 2); assert.equal(f.sends(), 0);
 } finally { await f.engine.close(); }
});
it('connection gaps and missing push recipients pause honestly; requirements refuse missing Google or Xero', async () => {
 const f = await chaseFixture(db); try {
  await f.tx(tx => tx`update connections set status = 'disconnected' where provider = 'xero'`); await assert.rejects(f.enable(), { code: 'requirements_unmet' });
  await f.tx(tx => tx`update connections set status = 'connected'`); await f.enable();
  await f.push.unsubscribe(f.actor, f.org, 'https://push.example.test/owner'); const run = await f.start();
  const paused = await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused'); assert.match(paused.reason!, /Notifications/); assert.equal((await f.outbox.list(f.actor, f.org)).length, 0);
  await f.push.subscribe(f.actor, f.org, { endpoint: 'https://push.example.test/owner', keys: { p256dh: 'fixture', auth: 'fixture' } });
  await f.tx(tx => tx`update connections set status = 'disconnected' where provider = 'xero'`); await f.tx(tx => f.engine.control(tx, f.org, run, 'resume'));
  const unavailable = await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused'); assert.match(unavailable.reason!, /Xero invoices are unavailable/);
 } finally { await f.engine.close(); }
});
it('consecutive and concurrent runs keep one pending chaser, then honour send spacing and discard', async () => {
 const f = await chaseFixture(db); try {
  await f.tx(tx => tx`update tasks set status = 'done'`); await f.enable();
  const run = async () => { f.provider.responses.push(result({ body })); const id = await f.start(); return until(() => f.workflows.run(f.actor, f.org, id), r => r.state === 'succeeded'); };
  await run(); const [first] = await f.outbox.list(f.actor, f.org);
  const [invoice] = await f.tx(tx => tx`select provider_id from xero_invoices where id = ${f.invoiceId}`);
  assert.equal(first!.invoiceProviderId, invoice!.providerId);
  const skipped = await run(); assert.match(JSON.stringify(skipped.steps.at(-1)!.output), /INV-42 is already waiting in the outbox/);
  assert.equal((await f.outbox.list(f.actor, f.org)).length, 1);
  // A lost provider response still leaves a pending draft, so no second chaser can escape it.
  await f.tx(tx => tx`update outbox set send_started_at = now() where id = ${first!.id}`);
  assert.match(JSON.stringify((await run()).steps.at(-1)!.output), /already waiting/);
  await f.tx(tx => tx`update outbox set send_started_at = null where id = ${first!.id}`);
  await f.outbox.send(f.actor, f.org, String(first!.id));
  await f.tx(tx => tx`update outbox set sent_at = now() - interval '6 days' where id = ${first!.id}`);
  assert.match(JSON.stringify((await run()).steps.at(-1)!.output), /Wait 7 days/); assert.equal((await f.outbox.list(f.actor, f.org)).length, 0);
  await f.workflows.enable(f.actor, f.org, 'chase-due', { enabled: true, parameters: { chaseAgainAfterDays: 5 } });
  await run(); const [custom] = await f.outbox.list(f.actor, f.org); assert.ok(custom);
  await f.outbox.change(f.actor, f.org, String(custom!.id), 'discard'); await f.enable();
  assert.match(JSON.stringify((await run()).steps.at(-1)!.output), /Wait 7 days/);
  await f.tx(tx => tx`update outbox set sent_at = now() - interval '8 days' where id = ${first!.id}`);
  await run(); const [second] = await f.outbox.list(f.actor, f.org); assert.notEqual(second!.id, first!.id);
  await f.outbox.change(f.actor, f.org, String(second!.id), 'discard');
  f.provider.responses.push(result({ body }), result({ body })); const ids = await Promise.all([f.start(), f.start()]);
  const runs = await Promise.all(ids.map(id => until(() => f.workflows.run(f.actor, f.org, id), r => r.state === 'succeeded')));
  assert.equal((await f.outbox.list(f.actor, f.org)).length, 1); assert.ok(runs.some(r => JSON.stringify(r.steps.at(-1)!.output).includes('already waiting')));
  assert.equal(f.sends(), 1);
 } finally { await f.engine.close(); }
});
it('old chase drafts are backfilled from journal identity and cannot suppress another tenant', async () => {
 const f = await chaseFixture(db), other = await chaseFixture(db); try {
  await other.engine.close();
  await f.tx(tx => tx`update tasks set status = 'done'`); await f.enable(); f.provider.responses.push(result({ body }));
  const id = await f.start(); await until(() => f.workflows.run(f.actor, f.org, id), r => r.state === 'succeeded');
  await f.tx(tx => tx`update outbox set invoice_provider_id = null`);
  const migration = await readFile(new URL('../../../../packages/db/migrations/0024_outbox_invoice.sql', import.meta.url), 'utf8');
  await db.owner.unsafe(migration.slice(migration.indexOf('update outbox')));
  const [draft] = await f.outbox.list(f.actor, f.org); assert.ok(draft!.invoiceProviderId);
  f.provider.responses.push(result({ body })); const next = await f.start();
  const skipped = await until(() => f.workflows.run(f.actor, f.org, next), r => r.state === 'succeeded'); assert.match(JSON.stringify(skipped.steps.at(-1)!.output), /already waiting/);
  await f.engine.close(); await other.engine.open();
  await other.tx(tx => tx`update xero_invoices set provider_id = ${draft!.invoiceProviderId} where id = ${other.invoiceId}`);
  await other.tx(tx => tx`update tasks set status = 'done'`); await other.enable(); other.provider.responses.push(result({ body }));
  const own = await other.start(); await until(() => other.workflows.run(other.actor, other.org, own), r => r.state === 'succeeded');
  const rows = await other.tx(tx => tx`select * from outbox where invoice_provider_id = ${draft!.invoiceProviderId}`);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.organisationId, other.org);
 } finally { await f.engine.close(); await other.engine.close(); }
});
