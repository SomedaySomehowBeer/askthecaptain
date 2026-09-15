import { PgBoss } from 'pg-boss';
import { type Sql, type TransactionSql } from '@captain/db';
import { EngineJournal, enabled, timezone, advance, scheduled, waiting, lastIncomplete, exhaust, unfinished, type Enabled } from '@captain/db/engine';
import { digestOf, resolveParameters, type WorkflowDefinition, type Trigger } from '@captain/steps';
import { Park, Wait, WorkflowPause, digest, interpret, type Snapshot } from './index.ts';
import { Registry, type HandlerContext, type WaitResult } from './registry.ts';
import { transactionalBoss, queueName, failedQueue, schema } from './queue.ts';
export { queueName } from './queue.ts';
export class WorkflowProblem extends Error {}
const terminal = ['cancelled', 'succeeded', 'failed', 'paused'];
const pauseWords: Record<string, string> = {
 stocktake_limit: 'Stocktake is limited to 100 items per location and 100 shop stock rows with reorder points. Reduce the selection, then start a new run.',
 stocktake_count: 'The recorded count is no longer available. Check Stock and start a new stocktake.',
 stocktake_project: 'More than one active project has the Purchasing project name. Give them distinct names, then Resume.',
 stocktake_google: 'Reconnect Google in Settings, then Resume to create the supplier draft.',
 budget_spent: 'The inference allowance is spent. Increase it in Settings or wait for the next month, then Resume.',
 needs_login: 'Inference needs sign-in. Reconnect it in Settings, then Resume.',
 runtime_not_ready: 'Inference is unavailable. Restore the runtime in Settings, then Resume.'
};
export class BossEngine {
 readonly db: Sql; readonly boss: PgBoss; readonly registry: Registry; readonly definitions: WorkflowDefinition[];
 readonly dayMs: number; ready = false;
 constructor(db: Sql, url: string, registry: Registry, definitions: WorkflowDefinition[], dayMs = 86400000) {
  this.db = db; this.registry = registry; this.definitions = definitions; this.dayMs = dayMs;
  this.boss = new PgBoss({ connectionString: url, schema, migrate: false, createSchema: false });
  this.boss.on('error', () => console.error('[workflows] queue unavailable; inspect the operator runbook'));
 }
 async open() {
  await this.boss.start();
  for (const d of this.definitions) await this.boss.work<{ runId: string }, void, { pollingIntervalSeconds: number; includeMetadata: true }>(queueName(d.key), { pollingIntervalSeconds: 0.5, includeMetadata: true }, async jobs => {
   for (const job of jobs) await this.execute(job.data.runId, job.retryCount >= job.retryLimit);
  });
  await this.boss.work<{ runId: string }>(failedQueue, async jobs => { for (const job of jobs) await this.exhausted(job.data.runId); });
  this.ready = true;
 }
 async close() { this.ready = false; await this.boss.stop({ graceful: true, timeout: 30000 }); }
 unavailable(definition: WorkflowDefinition) { return !this.ready ? 'The workflow runner is stopped. Ask the operator to start it.' : this.registry.missing(definition).length ? 'The steps for this workflow are not installed yet.' : null; }
 private journal(org: string, userId?: string) { return new EngineJournal(this.db, { organisationId: org, ...(userId ? { userId } : {}) }); }
 private async send(tx: TransactionSql, key: string, runId: string, startAfter?: Date) {
  await transactionalBoss(tx).send(queueName(key), { runId }, { ...(startAfter ? { startAfter } : {}) });
 }
 private async create(tx: TransactionSql, e: Enabled, definition: WorkflowDefinition, trigger: unknown, scheduleKey: string | null = null) {
  const journal = this.journal(e.organisationId, e.enabledBy);
  const snapshot: Snapshot = { definition, enablement: e, trigger };
  return journal.create(tx, e, definition, digestOf(definition), snapshot, trigger, scheduleKey);
 }
 async start(tx: TransactionSql, organisationId: string, key: string, trigger: unknown = { kind: 'manual' }, parameters?: Record<string, unknown>) {
  const definition = this.definitions.find(d => d.key === key); if (!definition) throw new WorkflowProblem('Workflow not found');
  const problem = this.unavailable(definition); if (problem) throw new WorkflowProblem(problem);
  const e = (await enabled(tx, key))[0]; if (!e || e.organisationId !== organisationId) throw new WorkflowProblem('Turn this workflow on first');
  if (e.definitionVersion !== definition.version) throw new WorkflowProblem('This workflow has changed. Save its parameters in Settings before starting a new run.');
  const resolved = resolveParameters(definition.parameters, { ...e.parameters, ...parameters });
  if (resolved.problems.length) throw new WorkflowProblem(resolved.problems.map(p => `${p.path} ${p.message}`).join('; '));
  const runId = await this.create(tx, { ...e, parameters: resolved.values }, definition, trigger); await this.send(tx, key, runId); return runId;
 }
 /** Events and destination wake-ups commit with the source write. waitKey wakes existing runs,
  * including a wait whose transaction is still committing; early events are read from destination state. */
 async emit(tx: TransactionSql, organisationId: string, event: string, data: unknown, waitKey?: string) {
  if (!this.ready && !waitKey) return;
  if (!this.ready) { const [installed] = await tx`select to_regclass('workflow_queue.job') is not null as ready`; if (!installed!.ready) return; }
  // Match the worker/control lock order: enablements before runs.
  const enablements = await enabled(tx);
  if (waitKey) for (const run of await unfinished(tx)) await this.wake(tx, organisationId, run.id, waitKey);
  if (!this.ready) return;
  for (const e of enablements) {
   const d = this.definitions.find(d => d.key === e.definitionKey);
   if (d && !this.unavailable(d) && d.triggers.some(t => t.kind === 'event' && t.event === event)) await this.start(tx, organisationId, d.key, { kind: 'event', event, data });
  }
 }
 private async schedule(tx: TransactionSql, e: Enabled, d: WorkflowDefinition, trigger: Extract<Trigger, { kind: 'daily' | 'weekly' }>, key: string) {
  const runId = await this.create(tx, e, d, trigger, key);
  const [hour, minute] = trigger.at.split(':'); const day = trigger.kind === 'weekly' ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(trigger.day) : '*';
  await transactionalBoss(tx).schedule(queueName(d.key), `${minute} ${hour} * * ${day}`, { runId }, { key, tz: await timezone(tx, e.organisationId), missed: 'once' });
 }
 /** One real, pinned next run per schedule. Its first delivery atomically installs the successor. */
 async configure(tx: TransactionSql, organisationId: string, enablementId: string, key: string) {
  const d = this.definitions.find(d => d.key === key)!;
  const [installed] = await tx`select to_regclass('workflow_queue.schedule') is not null as ready`;
  if (!installed!.ready) return;
  for (const [index] of d.triggers.entries()) await transactionalBoss(tx).unschedule(queueName(key), `${enablementId}_${index}`);
  for (const run of await scheduled(tx, enablementId)) await this.control(tx, organisationId, run.id, 'cancel', false);
  const e = (await enabled(tx, key))[0];
  if (e) for (const [index, trigger] of d.triggers.entries()) if (trigger.kind === 'daily' || trigger.kind === 'weekly') await this.schedule(tx, e, d, trigger, `${e.id}_${index}`);
 }
 async control(tx: TransactionSql, organisationId: string, runId: string, action: 'cancel' | 'resume', replaceSchedule = true) {
  const pending = await this.journal(organisationId).run(tx, runId, false);
  const e = (await enabled(tx, pending.definitionKey))[0];
  const journal = this.journal(organisationId); const run = await journal.run(tx, runId);
  if (action === 'cancel') {
   if (['succeeded', 'failed', 'cancelled'].includes(run.state)) return;
   await journal.state(tx, runId, 'cancelled', 'Cancelled by a person.');
   // All queues are installed without partitions. Delete pending retries/timers in this same transaction.
   await tx`delete from workflow_queue.job where name = ${queueName(run.definitionKey)} and data ->> 'runId' = ${runId} and state < 'active'`;
   if (run.scheduleKey && !run.scheduleAdvanced) {
    await transactionalBoss(tx).unschedule(queueName(run.definitionKey), run.scheduleKey);
    const trigger = (run.snapshot as Snapshot | null)?.trigger as Trigger | undefined;
    if (replaceSchedule && e && trigger && (trigger.kind === 'daily' || trigger.kind === 'weekly')) await this.schedule(tx, e, (run.snapshot as Snapshot).definition, trigger, run.scheduleKey);
    await advance(tx, runId);
   }
  } else {
   if (!this.ready) throw new WorkflowProblem('The workflow runner is stopped.');
   if (run.state !== 'paused' || !run.snapshot) throw new WorkflowProblem('Only a paused production run can resume.');
   if (!await journal.authorised(tx, run)) throw new WorkflowProblem('Enable the workflow and restore the enabling person’s active membership first.');
   await journal.state(tx, runId, 'queued'); await this.send(tx, run.definitionKey, runId);
  }
 }
 /** The destination service calls this in the transaction recording sent/discarded. Early events
  * are also observed by the await handler reading destination state, so there is no lost wake-up. */
 async wake(tx: TransactionSql, organisationId: string, runId: string, key: string) {
  await this.journal(organisationId).run(tx, runId);
  for (const run of await waiting(tx, key, runId)) {
   await this.journal(organisationId).state(tx, run.id, 'queued'); await this.send(tx, run.definitionKey, run.id);
  }
 }
 private async route(runId: string) {
  const [context] = await this.db<{ organisationId: string; userId: string | null }[]>`select * from workflow_run_context(${runId})`;
  return context && this.journal(context.organisationId, context.userId ?? undefined);
 }
 private async exhausted(runId: string) {
  const journal = await this.route(runId); if (!journal) return;
  await journal.tx(async tx => {
   const run = await journal.run(tx, runId); if (terminal.includes(run.state) || run.state === 'waiting') return;
   const step = await lastIncomplete(tx, runId); const reason = `${step ? `${step.path} (${step.key})` : 'Starting the run'}: retries exhausted. Inspect the service before starting a new run.`;
   await exhaust(tx, runId, reason); await journal.state(tx, runId, 'failed', reason);
  });
 }
 private async execute(runId: string, finalAttempt: boolean) {
  const journal = await this.route(runId); if (!journal) return;
  // One worker per workflow per process; reserve room in the pool for its short step transactions.
  // This lock survives overlapping event/timer jobs, but never spans a durable wait.
  await journal.tx(async lock => {
   await lock`select pg_advisory_xact_lock(hashtextextended(${runId + ':execution'}, 0))`;
   const snapshot = await journal.tx(async tx => {
    const pending = await journal.run(tx, runId, false);
    const currentEnablement = (await enabled(tx, pending.definitionKey))[0];
    const run = await journal.run(tx, runId); if (terminal.includes(run.state)) return null;
    const snapshot = run.snapshot as Snapshot | null;
    if (!snapshot || digestOf(snapshot.definition) !== run.definitionDigest || snapshot.definition.version !== run.definitionVersion || snapshot.enablement.enabledBy !== run.enabledBy || snapshot.definition.key !== run.definitionKey || snapshot.enablement.id !== run.enablementId || snapshot.enablement.organisationId !== journal.tenant.organisationId) {
     await journal.state(tx, runId, 'paused', 'This run has no valid pinned definition. Start a new run.'); return null;
    }
    // Lock enablement before a scheduled run to serialize schedule edits (configure uses that order).
    if (run.scheduleKey && !run.scheduleAdvanced) {
     const e = currentEnablement;
     const trigger = snapshot.trigger as Trigger;
     if (e && (trigger.kind === 'daily' || trigger.kind === 'weekly')) await this.schedule(tx, e, snapshot.definition, trigger, run.scheduleKey);
     await advance(tx, runId);
    }
    if (!await journal.authorised(tx, run)) { await journal.state(tx, runId, 'paused', 'The workflow is off or its enabling person is no longer an active member. Restore access, then Resume.'); return null; }
    await journal.state(tx, runId, 'running'); return snapshot;
   });
   if (!snapshot) return;
   try {
    await interpret(snapshot, async (path, step, args, skipped, itemIndex) => {
     const hash = digest(args); const context: HandlerContext = { organisationId: journal.tenant.organisationId, userId: snapshot.enablement.enabledBy, enablementId: snapshot.enablement.id, runId, path, itemIndex, step, idempotencyKey: JSON.stringify([journal.tenant.organisationId, runId, path, itemIndex]) };
     let park = false, waiting = false;
     try {
      const saved = await journal.tx(async tx => {
       const run = await journal.run(tx, runId); if (terminal.includes(run.state)) { park = true; return {}; }
       if (!await journal.authorised(tx, run)) { await journal.state(tx, runId, 'paused', 'The workflow is off or its enabling person is no longer an active member. Restore access, then Resume.'); park = true; return {}; }
       const prior = await journal.step(tx, runId, path);
       if (prior && prior.inputDigest !== hash) throw Error('Pinned inputs changed');
       if (prior?.state === 'succeeded' || prior?.state === 'skipped') return { output: prior.output };
       if (skipped) { await journal.record(tx, runId, path, itemIndex, step, 'skipped', hash); return { output: null }; }
       const handler = this.registry.get(step);
       if ('transaction' in handler) {
        const output = await handler.transaction({ ...context, tx }, args);
        if (handler.kind === 'await' && !(output as WaitResult).ready) {
         const result = output as WaitResult; const deadline = prior?.deadline ?? new Date(Date.now() + step.timeoutDays! * this.dayMs);
         if (Date.now() >= deadline.getTime()) { await journal.record(tx, runId, path, itemIndex, step, 'failed', hash, null, 'The wait timed out.'); await journal.state(tx, runId, 'failed', `${path} (${step.key}): the wait timed out.`); }
         else {
          const wakeAt = result.wakeAt ? new Date(Math.min(result.wakeAt.getTime(), deadline.getTime())) : deadline;
          if (!Number.isFinite(wakeAt.getTime()) || wakeAt.getTime() <= Date.now()) throw Error('An unresolved wait needs a future wake time');
          const previousWake = (prior?.output as { wakeAt?: string } | null)?.wakeAt;
          if (!prior?.deadline || previousWake !== wakeAt.toISOString()) await this.send(tx, snapshot.definition.key, runId, wakeAt);
          await journal.record(tx, runId, path, itemIndex, step, 'waiting', hash, { wakeAt: wakeAt.toISOString() }, null, { deadline, key: result.key });
          await journal.state(tx, runId, 'waiting'); waiting = true;
         }
         park = true; return {};
        }
        const value = handler.kind === 'await' ? (output as WaitResult).output ?? null : output ?? null;
        await journal.record(tx, runId, path, itemIndex, step, 'succeeded', hash, value); return { output: value };
       }
       // Durable intent precedes provider/inference I/O; adapters reconcile repeats using the key.
       await journal.record(tx, runId, path, itemIndex, step, 'running', hash); return { external: handler };
      });
      if (park) throw waiting ? new Wait() : new Park();
      if (!saved.external) return saved.output;
      const output = await saved.external.call(context, args) ?? null;
      await journal.tx(async tx => { await journal.run(tx, runId); await journal.record(tx, runId, path, itemIndex, step, 'succeeded', hash, output); });
      return output;
     } catch (error) {
      if (error instanceof Park) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const pause = error instanceof WorkflowPause ? error.message : pauseWords[code]; const words = pause ?? 'The service did not complete this step. Retry delivery is automatic.';
      await journal.tx(async tx => {
       const run = await journal.run(tx, runId); if (terminal.includes(run.state)) return;
       await journal.record(tx, runId, path, itemIndex, step, 'failed', hash, null, words);
       if (pause || finalAttempt) await journal.state(tx, runId, pause ? 'paused' : 'failed', `${path} (${step.key}): ${pause ?? 'Retries exhausted. Inspect the service before starting a new run.'}`);
      });
      if (pause || finalAttempt) throw new Park();
      throw Error('Workflow step retry required'); // Never copy provider errors/mail into queue output.
     }
    });
    await journal.tx(async tx => { const run = await journal.run(tx, runId); if (!terminal.includes(run.state)) await journal.state(tx, runId, 'succeeded'); });
   } catch (error) {
    if (error instanceof Park) return;
    if (finalAttempt) await this.exhausted(runId); else throw Error('Workflow retry required');
   }
  });
 }
}
