import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PgBoss } from 'pg-boss';
import { infer, StubProvider } from '@captain/model';
import { EngineJournal } from '@captain/db/engine';
import { definitions, digestOf } from '@captain/steps';
import { freshDatabase, type Harness } from '@captain/db/test';
import { Crash, type Call, type Catalogue, type Enablement, type Event } from '../src/index.ts';
export const threads = [{ id: 'one', needsOwner: true }, { id: 'two', needsOwner: false }, { id: 'three', needsOwner: true }];
type FaultOptions = { crashKey?: string; failKey?: string; fences?: boolean };
export class FakeCatalogue implements Catalogue {
 readonly journal: EngineJournal; readonly options: FaultOptions;
 constructor(journal: EngineJournal, options: FaultOptions = {}) { this.journal = journal; this.options = options; }
 async call(call: Call): Promise<unknown> {
  const { step, args, runId, path } = call;
  if (step.key === this.options.failKey) throw Error('Fixture classification unavailable');
  if (step.key === 'gmail.newThreads') return threads;
  if (step.kind === 'infer') {
   const classification = step.key === 'classifyThread';
   const output = classification ? { needsOwner: (args.thread as typeof threads[number]).needsOwner } : { body: 'Fixture reply, awaiting its owner.' };
   return infer<unknown>({ organisationId: this.journal.tenant.organisationId, step: step.key, tier: step.tier!, instruction: 'Read the labelled fixture data and return the schema.', input: args, schema: classification ? z.object({ needsOwner: z.boolean() }) : z.object({ body: z.string() }) }, 'claude', new StubProvider([{ output, usage: { inputTokens: 1, outputTokens: 1 }, model: 'stub', latencyMs: 0 }]), { before: async () => {}, record: async () => {}, failed: async () => {} });
  }
  if (!['outbox.create', 'gmail.label'].includes(step.key)) return null; // Other triage services are explicitly fixtures.
  const output = await this.journal.tx(async tx => {
   const organisationId = this.journal.tenant.organisationId, key = this.options.fences === false ? null : `${runId}:${path}`;
   const threadId = (args.thread as { id: string }).id;
   const [row] = step.key === 'outbox.create'
    ? await tx`insert into engine_spike.outbox (organisation_id, run_id, thread_id, body, idempotency_key) values (${organisationId}, ${runId}, ${threadId}, ${(args.draft as { body: string }).body}, ${key}) on conflict (organisation_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key returning id`
    : await tx`insert into engine_spike.labels (organisation_id, run_id, thread_id, idempotency_key) values (${organisationId}, ${runId}, ${threadId}, ${key}) on conflict (organisation_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key returning id`;
   await this.journal.audit(tx, runId, `spike.${step.key}`, { path }); return { id: String(row!.id) };
  }); // Side effect committed BEFORE the engine journal; this is the failure boundary under test.
  if (step.key === this.options.crashKey) {
   const crashed = await this.journal.tx(tx => tx`insert into engine_spike.faults (organisation_id, run_id, key) values (${this.journal.tenant.organisationId}, ${runId}, ${step.key}) on conflict do nothing returning key`);
   if (crashed.length) throw new Crash('Simulated process loss after side effect, before journal');
  }
  return output;
 }
 async sent(runId: string, event: Event) {
  if (event.key !== 'outbox.sent') throw Error('Unsupported event');
  await this.journal.tx(async tx => {
   const rows = await tx`update engine_spike.outbox set state = 'sent' where id = ${event.draftId} and run_id = ${runId} returning id`;
   if (!rows.length) throw Error('Draft not found in this run');
   await this.journal.audit(tx, runId, 'spike.outbox_sent');
  });
 }
 async wasSent(draftId: string) { return this.journal.tx(async tx => (await tx`select state from engine_spike.outbox where id = ${draftId}`)[0]?.state === 'sent'); }
}
export async function fixture(db: Harness, options: ConstructorParameters<typeof FakeCatalogue>[1] = {}) {
 const [org] = await db.owner`insert into organisations (name) values ('Engine spike') returning id`;
 const [user] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}) returning id`;
 const tenant = { organisationId: String(org!.id), userId: String(user!.id) };
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${tenant.organisationId}, ${tenant.userId}, 'owner')`;
 const definition = structuredClone(definitions.find(d => d.key === 'inbox-triage')!);
 await db.owner`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, digest) values (${definition.key}, ${definition.version}, ${definition.name}, ${definition.description}, 1, '[]', '{}', '[]', ${digestOf(definition)}) on conflict do nothing`;
 const [row] = await db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, enabled_by, parameters) values (${tenant.organisationId}, ${definition.key}, ${definition.version}, true, ${tenant.userId}, '{"draftReplies":true}') returning id`;
 const enablement: Enablement = { id: String(row!.id), organisationId: tenant.organisationId, enabledBy: tenant.userId, parameters: { draftReplies: true } };
 // Owner-only queue schema setup is separate from the non-bypassing runtime connection.
 const setup = new PgBoss({ connectionString: db.databaseUrl, schema: 'engine_queue', schedule: false, supervise: false });
 await setup.start(); await setup.createQueue(`spike_${tenant.organisationId.replaceAll('-', '')}`, { retryLimit: 3, retryDelay: 1 }); await setup.stop();
 await db.owner`grant usage on schema engine_queue to app`;
 await db.owner`grant select, insert, update, delete on all tables in schema engine_queue to app`;
 await db.owner`grant usage on all sequences in schema engine_queue to app`;
 const journal = new EngineJournal(db.app, tenant); return { journal, definition, enablement, catalogue: new FakeCatalogue(journal, options) };
}
export async function database() { const db = await freshDatabase(); await db.owner.unsafe(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8')); return db; }
