import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withTenant } from '@captain/db';
import { InferenceError } from '@captain/model';
import type { Harness } from '@captain/db/test';
import { installQueues } from '../src/queue.ts';
import { fixture, database } from './fixture.ts';
let db: Harness; const it = process.env.DATABASE_URL ? test : test.skip;
before(async () => { if (process.env.DATABASE_URL) db = await database(); }); after(async () => { await db?.close(); });
export async function until(check: () => Promise<boolean>, description: string) {
 const end = Date.now() + 30000; while (Date.now() < end) { if (await check()) return; await delay(100); } throw Error(`Timed out: ${description}`);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function finish(f: Fixture, runId: string, engine = f.engine) {
 await until(async () => {
  const run = await f.state(runId); assert.notEqual(run.state, 'failed', run.reason); assert.notEqual(run.state, 'paused', run.reason);
  await f.tx(async tx => { const drafts = await tx`update engine_spike.outbox set state = 'sent' where run_id = ${runId} and state = 'drafted' returning id`;
   for (const draft of drafts) await engine.wake(tx, f.organisationId, runId, `outbox:${draft.id}`);
  }); return run.state === 'succeeded';
 }, 'triage completion');
}
for (const fault of [undefined, 'database', 'provider'] as const) it(`full triage with real inference service and fake Gmail: ${fault ?? 'success'}`, async () => {
 const f = await fixture(db, fault); try {
  const id = await f.start(); await finish(f, id);
  const result = await f.tx(async tx => ({ drafts: await tx`select * from engine_spike.outbox where run_id = ${id}`, labels: await tx`select * from engine_spike.labels where run_id = ${id}`,
   steps: await tx`select * from workflow_run_steps where run_id = ${id}`, usage: await tx`select * from model_usage where run_id = ${id}`, audits: await tx`select actor_id from audit_events where subject_id = ${id}` }));
  assert.equal(result.drafts.length, 2); assert.equal(result.labels.length, 3); assert.equal(result.usage.length, 5);
  assert.equal(f.writes(), fault === 'database' ? 3 : 2); // Rolled-back first draft, not a committed duplicate.
  assert.ok(result.steps.every(s => s.state === 'succeeded')); assert.ok(result.steps.some(s => s.itemIndex === 2));
  assert.ok(result.audits.every(a => a.actorId === f.userId));
  const jobs = await db.owner`select data from workflow_queue.job where data ->> 'runId' = ${id}`;
  assert.ok(jobs.every(j => JSON.stringify(Object.keys(j.data)) === '["runId"]'));
 } finally { await f.engine.close(); }
});
for (const code of ['budget_spent', 'needs_login', 'runtime_not_ready'] as const) it(`${code} pauses and Resume retries the same pinned run`, async () => {
 const f = await fixture(db); try {
  f.provider.responses.unshift(new InferenceError(code)); const id = await f.start();
  await until(async () => (await f.state(id)).state === 'paused', code);
  assert.match(String((await f.state(id)).reason), /classifyThread/);
  // Repair runtime state as the operator would after login; do not consume fixture inference output.
  await db.owner`update inference_runtimes set status = 'ready' where organisation_id = ${f.organisationId}`;
  await f.tx(tx => f.engine.control(tx, f.organisationId, id, 'resume')); await finish(f, id);
  assert.equal((await f.state(id)).definitionVersion, f.definition.version);
 } finally { await f.engine.close(); }
});
it('a committed wait survives worker restart, then an early destination event completes it', async () => {
 const f = await fixture(db); const id = await f.start();
 await until(async () => (await f.state(id)).state === 'waiting', 'wait'); await f.engine.close();
 const next = f.make(); await next.open(); try { await finish(f, id, next); } finally { await next.close(); }
});
it('cancel drops pending timers, and duplicate delivery cannot continue the run', async () => {
 const f = await fixture(db); try {
  const id = await f.start(); await until(async () => (await f.state(id)).state === 'waiting', 'wait');
  await f.tx(tx => f.engine.control(tx, f.organisationId, id, 'cancel'));
  assert.equal((await db.owner`select id from workflow_queue.job where data ->> 'runId' = ${id} and state < 'active'`).length, 0);
  await f.engine.boss.send('workflow_inbox-triage', { runId: id }); await delay(700);
  assert.equal((await f.state(id)).state, 'cancelled'); assert.equal((await f.tx(tx => tx`select * from engine_spike.labels where run_id = ${id}`)).length, 0);
 } finally { await f.engine.close(); }
});
it('membership removal pauses at continuation; other tenants cannot read or change its journal', async () => {
 const f = await fixture(db); try {
  const id = await f.start(); await until(async () => (await f.state(id)).state === 'waiting', 'wait');
  await db.owner`update memberships set status = 'removed' where organisation_id = ${f.organisationId}`;
  await f.engine.boss.send('workflow_inbox-triage', { runId: id }); await until(async () => (await f.state(id)).state === 'paused', 'inactive member');
  const [other] = await db.owner`insert into organisations (name) values ('Other tenant') returning id`;
  await withTenant(db.app, { organisationId: String(other!.id), userId: f.userId }, async tx => {
   assert.equal((await tx`select * from workflow_runs where id = ${id}`).length, 0); assert.equal((await tx`select * from workflow_run_steps where run_id = ${id}`).length, 0);
   assert.equal((await tx`update workflow_runs set state = 'cancelled' where id = ${id} returning id`).length, 0);
   await assert.rejects(f.engine.control(tx, String(other!.id), id, 'cancel'), /not found/);
  });
 } finally { await f.engine.close(); }
});
it('retry exhaustion names the failed step without recording raw provider errors', async () => {
 const f = await fixture(db, 'fail'); try {
  await f.tx(async tx => { await tx`update workflow_enablements set parameters = '{"draftReplies":false}' where id = ${f.enablementId}`; });
  const id = await f.start();
  // Input outputs follow the alternate branch: only classification calls are needed.
  f.provider.responses.splice(0, f.provider.responses.length, ...[true, false, true].map(needsOwner => ({ output: { needsOwner }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'stub', latencyMs: 0 })));
  await until(async () => (await f.state(id)).state === 'failed', 'exhaustion');
  assert.match(String((await f.state(id)).reason), /gmail.label.*Retries exhausted/);
  assert.ok(!JSON.stringify(await f.tx(tx => tx`select * from workflow_run_steps where run_id = ${id}`)).includes('Private provider'));
 } finally { await f.engine.close(); }
});
it('enqueue and schedules share the enablement transaction, timezone and only-run-id payload', async () => {
 const f = await fixture(db); try {
  await assert.rejects(f.tx(async tx => { await f.engine.start(tx, f.organisationId, f.definition.key); throw Error('rollback'); }), /rollback/);
  assert.equal((await f.tx(tx => tx`select * from workflow_runs`)).length, 0);
  await f.tx(tx => f.engine.configure(tx, f.organisationId, f.enablementId, f.definition.key));
  // The schedule key carries the trigger's index in the definition; find the daily one rather than assuming its place.
  const daily = f.definition.triggers.findIndex(t => t.kind !== 'event');
  const rows = await f.engine.boss.getSchedules('workflow_inbox-triage'); const row = rows.find(r => r.key === `${f.enablementId}_${daily}`)!;
  assert.equal(row.timezone, 'Australia/Perth'); assert.equal(row.cron, '00 06 * * *'); assert.deepEqual(Object.keys(row.data as object), ['runId']);
  const id = (row.data as { runId: string }).runId; await f.engine.boss.send('workflow_inbox-triage', { runId: id }); await finish(f, id);
  const next = (await f.engine.boss.getSchedules('workflow_inbox-triage')).find(r => r.key === row.key)!; assert.notEqual((next.data as { runId: string }).runId, id);
  await f.tx(async tx => { await tx`update workflow_enablements set enabled = false where id = ${f.enablementId}`; await f.engine.configure(tx, f.organisationId, f.enablementId, f.definition.key); });
  assert.ok(!(await f.engine.boss.getSchedules('workflow_inbox-triage')).some(r => r.key === row.key));
 } finally { await f.engine.close(); }
});
it('timeout remains durable and names the awaiting step', async () => {
 const f = await fixture(db); await f.engine.close(); const engine = f.make(100); await engine.open();
 try {
  const id = await f.tx(tx => engine.start(tx, f.organisationId, f.definition.key));
  await until(async () => (await f.state(id)).state === 'failed', 'timeout');
  assert.match(String((await f.state(id)).reason), /outbox.sent.*timed out/);
 } finally { await engine.close(); }
});
it('snapshots stay pinned after enablement edits and cannot be rewritten', async () => {
 const f = await fixture(db); try {
  const id = await f.start(); await until(async () => (await f.state(id)).state === 'waiting', 'wait');
  await f.tx(async tx => { await tx`update workflow_enablements set parameters = '{"draftReplies":false}', definition_version = ${f.definition.version + 1} where id = ${f.enablementId}`; });
  await assert.rejects(f.tx(async tx => { await tx`update workflow_runs set snapshot = '{}' where id = ${id}`; }), /immutable/);
  await finish(f, id); assert.equal((await f.state(id)).definitionVersion, f.definition.version);
  assert.equal((await f.tx(tx => tx`select id from engine_spike.outbox where run_id = ${id}`)).length, 2);
 } finally { await f.engine.close(); }
});
it('weekly cron uses the enablement timezone; turning off while stopped removes its schedule', async () => {
 const f = await fixture(db); try {
  f.definition.triggers = [{ kind: 'weekly', day: 'mon', at: '08:00' }];
  await f.tx(tx => f.engine.configure(tx, f.organisationId, f.enablementId, f.definition.key));
  const row = (await f.engine.boss.getSchedules()).find(s => s.key === `${f.enablementId}_0`)!;
  assert.equal(row.cron, '00 08 * * 1'); assert.equal(row.timezone, 'Australia/Perth');
  await f.engine.close();
  await f.tx(async tx => { await tx`update workflow_enablements set enabled = false where id = ${f.enablementId}`; await f.engine.configure(tx, f.organisationId, f.enablementId, f.definition.key); });
  assert.equal((await db.owner`select * from workflow_queue.schedule where key = ${row.key}`).length, 0);
 } finally { await f.engine.close(); }
});
it('the failure queue journals a worker lost on its last attempt', async () => {
 const f = await fixture(db); try {
  // Simulate the supervisor's terminal-delivery handoff after process loss.
  const id = await f.tx(async tx => {
   const id = await f.engine.start(tx, f.organisationId, f.definition.key);
   await tx`delete from workflow_queue.job where data ->> 'runId' = ${id}`;
   await tx`update workflow_runs set state = 'running' where id = ${id}`;
   await tx`insert into workflow_run_steps (organisation_id, run_id, path, kind, key, state) values (${f.organisationId}, ${id}, 'steps.0', 'read', 'gmail.newThreads', 'running')`; return id;
  });
  await f.engine.boss.send('workflow_failed', { runId: id }); await until(async () => (await f.state(id)).state === 'failed', 'dead letter');
  assert.match(String((await f.state(id)).reason), /gmail.newThreads.*retries exhausted/);
 } finally { await f.engine.close(); }
});

it('release installation is repeatable without replacing pending work or schedules', async () => {
 const f = await fixture(db);
 try {
  await f.tx(tx => f.engine.configure(tx, f.organisationId, f.enablementId, f.definition.key));
  const [run] = await f.tx(tx => tx`select id from workflow_runs where enablement_id = ${f.enablementId}`);
  const jobId = await f.engine.boss.send('workflow_inbox-triage', { runId: run!.id }, { startAfter: new Date(Date.now() + 86400000) });
  await f.engine.close();
  const queues = await db.owner`select name from workflow_queue.queue order by name`;
  const key = `${f.enablementId}_${f.definition.triggers.findIndex(t => t.kind !== 'event')}`;
  const schedules = await db.owner`select name, key, cron, timezone, data from workflow_queue.schedule where key = ${key}`;
  for (let attempt = 0; attempt < 2; attempt++) await installQueues(db.databaseUrl, [f.definition]);
  assert.deepEqual(await db.owner`select name from workflow_queue.queue order by name`, queues);
  assert.deepEqual(await db.owner`select name, key, cron, timezone, data from workflow_queue.schedule where key = ${key}`, schedules);
  const [job] = await db.owner`select state, data from workflow_queue.job where id = ${jobId}`;
  assert.equal(job!.state, 'created'); assert.deepEqual(job!.data, { runId: run!.id });
  await f.engine.open(); // Runtime app-role startup still works after repeated release installs.
 } finally { await f.engine.close(); }
});
