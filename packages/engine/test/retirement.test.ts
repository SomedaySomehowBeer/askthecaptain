import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { freshDatabase } from '@captain/db/test';
import { withTenant } from '@captain/db';
import { definitions, retiredWorkflowVersions, digestOf } from '@captain/steps';
import { BossEngine, Registry, type Snapshot } from '../src/index.ts';
import { installQueues, queueName } from '../src/queue.ts';
const it = process.env.DATABASE_URL ? test : test.skip;
it('retirement cancels all unfinished old versions across tenants, removes schedules/retries, preserves history and current versions, and is idempotent', async () => {
 const db = await freshDatabase();
 const legacy = Object.keys(retiredWorkflowVersions).map(key => ({ ...structuredClone(definitions[0]!), key, version: key === 'chase-due' ? 3 : key === 'stocktake' ? 2 : 1 }));
 await installQueues(db.databaseUrl, [...legacy, ...definitions]);
 const engine = new BossEngine(db.app, db.databaseUrl, new Registry(), definitions, 86400000, retiredWorkflowVersions);
 try {
  await engine.boss.start();
  const [u] = await db.owner`insert into users (email) values ('retirement@test.invalid') returning id`;
  const userId = String(u!.id), organisations: string[] = [];
  const records: { id: string; key: string; version: number; state: string; snapshot: Snapshot; enablement: string; org: string }[] = [];
  for (let tenant = 0; tenant < 2; tenant++) {
   const [o] = await db.owner`insert into organisations (name) values ('Retirement test') returning id`; const org = String(o!.id); organisations.push(org);
   await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${userId}, 'owner')`;
   for (const d of [...legacy, ...definitions]) {
    await db.owner`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, digest) values (${d.key}, ${d.version}, ${d.name}, '', 1, '[]', '{}', '[]', ${digestOf(d)}) on conflict do nothing`;
    // The unique enablement key is upgraded to the current version for current-version runs.
    const [e] = await db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, enabled_by) values (${org}, ${d.key}, ${d.version}, true, ${userId})
     on conflict (organisation_id, definition_key) do update set definition_version = excluded.definition_version returning id`;
    for (const state of ['queued','running','waiting','paused','succeeded','failed','cancelled']) {
     const id = randomUUID(), scheduleKey = randomUUID();
     const snapshot: Snapshot = { definition: d, enablement: { id: String(e!.id), organisationId: org, enabledBy: userId, parameters: {} }, trigger: { kind: 'daily', at: '07:00' } };
     await db.owner`insert into workflow_runs (id, organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger, snapshot, enabled_by, state, schedule_key)
      values (${id}, ${org}, ${e!.id}, ${d.key}, ${d.version}, ${digestOf(d)}, '{}', ${db.owner.json(snapshot as never)}, ${userId}, ${state}, ${scheduleKey})`;
     await engine.boss.schedule(queueName(d.key), '0 7 * * *', { runId: id }, { key: scheduleKey });
     await engine.boss.send(queueName(d.key), { runId: id }, { startAfter: new Date(Date.now() + 86400000) });
     records.push({ id, key: d.key, version: d.version, state, snapshot, enablement: String(e!.id), org });
    }
   }
  }
  const migration = await readFile(new URL('../../db/migrations/0037_retire_assistant_workflows.sql', import.meta.url), 'utf8');
  await db.owner.begin(tx => tx.unsafe(migration));
  const rows = await db.owner`select * from workflow_runs`;
  for (const r of records) {
   const row = rows.find(row => row.id === r.id)!; const retired = r.version <= retiredWorkflowVersions[r.key]!;
   assert.equal(row.state, retired && ['queued','running','waiting','paused'].includes(r.state) ? 'cancelled' : r.state);
   assert.deepEqual(row.snapshot, r.snapshot);
   assert.equal((await db.owner`select 1 from workflow_queue.schedule where data->>'runId' = ${r.id}`).length, retired ? 0 : 1);
   assert.equal((await db.owner`select 1 from workflow_queue.job where data->>'runId' = ${r.id}`).length, retired ? 0 : 1);
  }
  for (const e of await db.owner`select * from workflow_enablements`) assert.equal(e.enabled, e.definitionVersion > retiredWorkflowVersions[e.definitionKey]!);
  const count = (await db.owner`select count(*)::int as n from audit_events where action in ('workflow.retired','workflow.cancelled')`)[0]!.n;
  assert.ok(count > 0); await db.owner.begin(tx => tx.unsafe(migration));
  assert.equal((await db.owner`select count(*)::int as n from audit_events where action in ('workflow.retired','workflow.cancelled')`)[0]!.n, count);
  const visible = await withTenant(db.app, { organisationId: organisations[0]!, userId }, tx => tx`select organisation_id from workflow_runs`);
  assert.ok(visible.length); assert.ok(visible.every(r => r.organisationId === organisations[0]));
 } finally { await engine.close(); await db.close(); }
});
it('old queued snapshots cannot execute or advance schedules and old paused runs cannot resume or wake', async () => {
 const db = await freshDatabase(); await installQueues(db.databaseUrl, definitions);
 const registry = new Registry(); let calls = 0;
 registry.registerStep('tasks.due', { kind: 'read', transaction: async () => { calls++; return []; } });
 const engine = new BossEngine(db.app, db.databaseUrl, registry, definitions, 86400000, retiredWorkflowVersions);
 try {
  const [u] = await db.owner`insert into users (email) values ('fence@test.invalid') returning id`;
  const [o] = await db.owner`insert into organisations (name) values ('Fence test') returning id`;
  const org = String(o!.id), userId = String(u!.id), d = { ...structuredClone(definitions[0]!), version: 3 };
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${userId}, 'owner')`;
  await db.owner`insert into workflow_definitions (key,version,name,description,job,triggers,parameters,steps,digest) values (${d.key},3,'Old','','5','[]','{}','[]',${digestOf(d)})`;
  const [e] = await db.owner`insert into workflow_enablements (organisation_id,definition_key,definition_version,enabled,enabled_by) values (${org},${d.key},3,true,${userId}) returning id`;
  const snapshot: Snapshot = { definition: d, enablement: { id: String(e!.id), organisationId: org, enabledBy: userId, parameters: {} }, trigger: { kind: 'daily', at: '07:00' } };
  const [run] = await db.owner`insert into workflow_runs (organisation_id,enablement_id,definition_key,definition_version,definition_digest,trigger,snapshot,enabled_by,state,schedule_key) values (${org},${e!.id},${d.key},3,${digestOf(d)},'{}',${db.owner.json(snapshot as never)},${userId},'paused','old-schedule') returning id`;
  const id = String(run!.id), tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: org, userId }, fn);
  await engine.open();
  await assert.rejects(tx(sql => engine.control(sql, org, id, 'resume')), /retired/);
  await db.owner`update workflow_runs set state = 'waiting' where id = ${id}`;
  await tx(sql => engine.wake(sql, org, id, 'old-key'));
  assert.equal((await db.owner`select state from workflow_runs where id = ${id}`)[0]!.state, 'waiting');
  await db.owner`update workflow_runs set state = 'queued' where id = ${id}`;
  await engine.boss.send(queueName(d.key), { runId: id });
  for (let n = 0; n < 100; n++) { if ((await db.owner`select state from workflow_runs where id = ${id}`)[0]!.state === 'cancelled') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal((await db.owner`select state from workflow_runs where id = ${id}`)[0]!.state, 'cancelled'); assert.equal(calls, 0);
  assert.equal((await db.owner`select id from workflow_runs`).length, 1); assert.deepEqual(await engine.boss.getSchedules(), []);
 } finally { await engine.close(); await db.close(); }
});
