import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from '@captain/db';
import { StubProvider, type Result } from '@captain/model';
import { definitions, digestOf } from '@captain/steps';
import { freshDatabase, type Harness } from '@captain/db/test';
import { InferenceService } from '../../../apps/api/src/inference/service.ts';
import { inferenceStep } from '../../../apps/api/src/workflows/bindings.ts';
import { BossEngine, Registry } from '../src/index.ts';
import { installQueues } from '../src/queue.ts';
export const threads = [{ id: 'one', needsOwner: true }, { id: 'two', needsOwner: false }, { id: 'three', needsOwner: true }];
const reply = (output: unknown): Result => ({ output, usage: { inputTokens: 1, outputTokens: 1 }, model: 'stub', latencyMs: 0 });
export async function database() {
 const db = await freshDatabase();
 await db.owner.unsafe(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8'));
 await installQueues(db.databaseUrl, definitions); return db;
}
export async function fixture(db: Harness, fault?: 'database' | 'provider' | 'fail') {
 const [org] = await db.owner`insert into organisations (name) values ('Runner fixture') returning id`;
 const [user] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}) returning id`;
 const tenant = { organisationId: String(org!.id), userId: String(user!.id) }, actor = { userId: tenant.userId, requestId: randomUUID() };
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${tenant.organisationId}, ${tenant.userId}, 'owner')`;
 const definition = structuredClone(definitions.find(d => d.key === 'inbox-triage')!);
 await db.owner`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, digest) values (${definition.key}, ${definition.version}, ${definition.name}, ${definition.description}, 1, '[]', '{}', '[]', ${digestOf(definition)}) on conflict do nothing`;
 const [e] = await db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, enabled_by, parameters) values (${tenant.organisationId}, ${definition.key}, ${definition.version}, true, ${tenant.userId}, '{"draftReplies":true}') returning id`;
 const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, tenant, fn);
 const provider = new StubProvider([reply({})]); const inference = new InferenceService(db.app, randomBytes(32), () => provider);
 await inference.request(actor, tenant.organisationId, 'claude'); await inference.setBudget(actor, tenant.organisationId, 100000);
 await inference.configure(actor, tenant.organisationId, { url: 'https://fixture.sprites.app/', secret: 'a'.repeat(64), spriteName: 'fixture', region: 'unknown', loginHint: null, loginUrl: null }); await inference.verify(actor, tenant.organisationId);
 provider.responses.push(reply({ needsOwner: true }), reply({ body: 'Fixture reply.' }), reply({ needsOwner: false }), reply({ needsOwner: true }), reply({ body: 'Fixture reply.' }));
 const registry = new Registry(); let failed = false; let writes = 0;
 registry.registerStep('gmail.newThreads', { kind: 'read', transaction: async () => threads });
 registry.registerStep('attachments.extractText', { kind: 'read', transaction: async () => [] });
 registry.registerStep('classifyThread', inferenceStep(inference, 'Classify labelled untrusted mail data.', z.object({ needsOwner: z.boolean() })));
 registry.registerStep('draftReply', inferenceStep(inference, 'Draft from labelled untrusted data.', z.object({ body: z.string() })));
 for (const key of ['triage.record', 'tasks.suggestFromTriage', 'tasks.completeFromConfirmations', 'contacts.upsertFromTriage']) registry.registerStep(key, { kind: 'write', transaction: async context => {
  // The real domain services arrive in PR B; the fixture asserts actor and transaction ownership.
  { const [row] = await context.tx`select current_setting('app.user_id') as actor`; if (row!.actor !== tenant.userId) throw Error('Wrong actor'); }
  return null;
 } });
 registry.registerStep('outbox.create', { kind: 'write', transaction: async ({ tx, organisationId, runId, idempotencyKey }, args) => {
  writes++; const [row] = await tx`insert into engine_spike.outbox (organisation_id, run_id, thread_id, body, idempotency_key) values (${organisationId}, ${runId}, ${(args.thread as { id: string }).id}, ${(args.draft as { body: string }).body}, ${idempotencyKey}) returning id`;
  if (fault === 'database' && !failed) { failed = true; throw Error('Injected crash before journal completion'); }
  return { id: String(row!.id) };
 } });
 registry.registerStep('outbox.sent', { kind: 'await', transaction: async ({ tx }, args) => {
  const id = (args.draft as { id: string }).id; const [row] = await tx`select state from engine_spike.outbox where id = ${id}`;
  return { ready: row?.state === 'sent', key: `outbox:${id}`, output: { sent: true } };
 } });
 registry.registerStep('gmail.label', { kind: 'write', retrySafe: true, call: async ({ organisationId, runId, idempotencyKey }, args) => {
  if (fault === 'fail') throw Error('Private provider diagnostic never journaled');
  // Fake Gmail keeps its own durable state; retry reconciles the same desired label.
  await tx(async sql => { await sql`insert into engine_spike.labels (organisation_id, run_id, thread_id, idempotency_key) values (${organisationId}, ${runId}, ${(args.thread as { id: string }).id}, ${idempotencyKey}) on conflict do nothing`; });
  if (fault === 'provider' && !failed) { failed = true; throw Error('Injected lost response after provider commit'); } return { labelled: true };
 } });
 const url = new URL(db.databaseUrl); url.username = 'app'; url.password = 'app';
 const make = (dayMs = 10000) => new BossEngine(db.app, url.toString(), registry, [definition], dayMs);
 const engine = make(); await engine.open(); await engine.boss.updateQueue('workflow_inbox-triage', { retryDelay: 1, retryLimit: 2, retryBackoff: false });
 const start = () => tx(sql => engine.start(sql, tenant.organisationId, definition.key));
 const state = async (runId: string) => (await tx(sql => sql`select * from workflow_runs where id = ${runId}`))[0]!;
 return { ...tenant, actor, tenant, tx, definition, enablementId: String(e!.id), registry, engine, make, start, state, provider, inference, writes: () => writes };
}
