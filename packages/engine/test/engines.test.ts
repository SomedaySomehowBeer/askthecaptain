import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { withTenant } from '@captain/db';
import type { Harness } from '@captain/db/test';
import { BossEngine } from '../src/pg-boss.ts';
import { RestateEngine } from '../src/restate.ts';
import { fixture, database } from './fixture.ts';
let db: Harness;
before(async () => { if (process.env.DATABASE_URL) db = await database(); });
after(async () => { await db?.close(); });
async function until(check: () => Promise<boolean>, description: string) {
 const end = Date.now() + 30000;
 while (Date.now() < end) { if (await check()) return; await delay(100); }
 throw Error(`Timed out waiting for ${description}`);
}
for (const kind of ['pg-boss', 'restate'] as const) {
 const it = !process.env.DATABASE_URL || (kind === 'restate' && !process.env.ENGINE_RESTATE) ? test.skip : test;
 const queueUrl = () => { const url = new URL(db.databaseUrl); url.username = 'app'; url.password = 'app'; return url.toString(); };
 const make = (f: Awaited<ReturnType<typeof fixture>>, dayMs = 1000) => kind === 'pg-boss'
  ? new BossEngine(new PgBoss({ connectionString: queueUrl(), schema: 'engine_queue', schedule: false, supervise: false, migrate: false, createSchema: false }), f.journal, f.catalogue, dayMs)
  : new RestateEngine(f.journal, f.catalogue, dayMs);
 async function finish(f: Awaited<ReturnType<typeof fixture>>, engine: ReturnType<typeof make>, runId: string) {
  await until(async () => {
   const run = await f.journal.run(runId); assert.notEqual(run.state, 'failed', run.reason);
   const drafts = await f.journal.tx(tx => tx`select id from engine_spike.outbox where run_id = ${runId} and state = 'drafted'`);
   for (const draft of drafts) await engine.resume(runId, { key: 'outbox.sent', draftId: String(draft.id) });
   return run.state === 'succeeded';
  }, `${kind} run completion`);
 }
 for (const crashKey of [undefined, 'outbox.create']) it(`${kind}: ${crashKey ? 'crash after committed write resumes without duplicates' : 'triage three threads creates two drafts and labels each once'}`, async () => {
  const f = await fixture(db, { crashKey }); const engine = make(f); await engine.open();
  try {
   const runId = await engine.start(f.definition, f.enablement, { kind: 'mail.synced' }); await finish(f, engine, runId);
   const drafts = await f.journal.tx(tx => tx`select thread_id from engine_spike.outbox where run_id = ${runId}`);
   const labels = await f.journal.tx(tx => tx`select thread_id from engine_spike.labels where run_id = ${runId}`);
   assert.deepEqual(drafts.map(d => d.threadId).sort(), ['one', 'three']); assert.deepEqual(labels.map(d => d.threadId).sort(), ['one', 'three', 'two']);
   const steps = await f.journal.tx(tx => tx`select * from workflow_run_steps where run_id = ${runId}`);
   assert.ok(steps.every(s => s.state === 'succeeded' && /^[a-f0-9]{64}$/.test(s.inputDigest)));
  } finally { await engine.close(); }
 });
 it(`${kind}: a later event survives a worker restart and resumes the wait`, async () => {
  const f = await fixture(db); let engine = make(f); await engine.open();
  try {
   const runId = await engine.start(f.definition, f.enablement, {});
   await until(async () => (await f.journal.run(runId)).state === 'waiting', 'durable wait');
   await engine.close(); await delay(150); engine = make(f); await engine.open(); await finish(f, engine, runId);
  } finally { await engine.close(); }
 });
 it(`${kind}: timeoutDays expires with a named step and reason`, async () => {
  const f = await fixture(db); const engine = make(f, 100); await engine.open();
  try {
   const runId = await engine.start(f.definition, f.enablement, {});
   await until(async () => (await f.journal.run(runId)).state === 'failed', 'timeout');
   assert.match((await f.journal.run(runId)).reason, /outbox.sent.*timed out/);
  } finally { await engine.close(); }
 });
 it(`${kind}: failed journal names the step and reason`, async () => {
  const f = await fixture(db, { failKey: 'classifyThread' }); const engine = make(f); await engine.open();
  try {
   const runId = await engine.start(f.definition, f.enablement, {});
   await until(async () => (await f.journal.run(runId)).state === 'failed', 'classification failure');
   assert.match((await f.journal.run(runId)).reason, /classifyThread.*Fixture classification unavailable/);
   const failed = await f.journal.tx(tx => tx`select key, error from workflow_run_steps where run_id = ${runId} and state = 'failed'`);
   assert.deepEqual(failed.map(s => [s.key, s.error]), [['classifyThread', 'Fixture classification unavailable']]);
   const { WorkflowService } = await import('../../../apps/api/src/workflows/service.ts');
   const exposed = await new WorkflowService(db.app).run({ userId: f.enablement.enabledBy, requestId: 'engine-spike' }, f.enablement.organisationId, runId);
   assert.equal(exposed.state, 'failed'); assert.equal(exposed.steps.find(s => s.state === 'failed')?.key, 'classifyThread');
   console.log(`${kind} Activity API: ${JSON.stringify({ state: exposed.state, reason: exposed.reason, step: exposed.steps.find(s => s.state === 'failed')?.path })}`);
  } finally { await engine.close(); }
 });
 it(`${kind}: negative control without a destination fence duplicates the committed draft`, async () => {
  const f = await fixture(db, { crashKey: 'outbox.create', fences: false }); const engine = make(f); await engine.open();
  try {
   const runId = await engine.start(f.definition, f.enablement, {}); await finish(f, engine, runId);
   const drafts = await f.journal.tx(tx => tx`select id from engine_spike.outbox where run_id = ${runId}`); assert.equal(drafts.length, 3);
  } finally { await engine.close(); }
 });
}
test('spike fixtures and both journals isolate tenants under the app role', { skip: !process.env.DATABASE_URL }, async () => {
 const a = await fixture(db), b = await fixture(db); const runId = await a.journal.create(a.definition, a.enablement.id, 'fixture', {});
 await assert.rejects(b.journal.run(runId), /Run not found/);
 await assert.rejects(withTenant(db.app, b.journal.tenant, tx => tx`insert into engine_spike.outbox (organisation_id, run_id, thread_id, body) values (${a.enablement.organisationId}, ${runId}, 'x', 'x')`), { code: '42501' });
 for (const table of ['outbox', 'labels', 'faults']) assert.equal((await db.app.unsafe(`select * from engine_spike.${table}`)).length, 0);
});
