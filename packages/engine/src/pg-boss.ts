import { PgBoss } from 'pg-boss';
import { digestOf, type WorkflowDefinition } from '@captain/steps';
import { EngineJournal } from '@captain/db/engine';
import { Crash, Park, StepFailure, digest, interpret, type Catalogue, type Enablement, type Engine, type Event, type Snapshot } from './index.ts';
/** Spike only: a worker in the existing process; PostgreSQL owns delivery and timers. */
export class BossEngine implements Engine {
 readonly queue: string;
 readonly boss: PgBoss; readonly journal: EngineJournal; readonly catalogue: Catalogue; readonly dayMs: number;
 constructor(boss: PgBoss, journal: EngineJournal, catalogue: Catalogue, dayMs = 86400000) { this.boss = boss; this.journal = journal; this.catalogue = catalogue; this.dayMs = dayMs; this.queue = `spike_${journal.tenant.organisationId.replaceAll('-', '')}`; }
 async open() {
  await this.boss.start(); await this.boss.createQueue(this.queue, { retryLimit: 3, retryDelay: 1 });
  await this.boss.work<{ runId: string }>(this.queue, { pollingIntervalSeconds: 0.5 }, async jobs => { for (const job of jobs) await this.execute(job.data.runId); });
 }
 async close() { await this.boss.stop({ graceful: true, timeout: 5000 }); }
 async start(definition: WorkflowDefinition, enablement: Enablement, trigger: unknown) {
  const snapshot: Snapshot = { definition, enablement, trigger };
  const runId = await this.journal.create(definition, enablement.id, digestOf(definition), snapshot);
  await this.boss.send(this.queue, { runId }); return runId;
 }
 async resume(runId: string, event: Event) {
  await this.journal.run(runId); await this.catalogue.sent(runId, event);
  await this.boss.send(this.queue, { runId });
 }
 private async execute(runId: string) {
  // Serialize duplicate event deliveries without holding a transaction across a durable wait.
  await this.journal.tx(async lock => {
   await lock`select pg_advisory_xact_lock(hashtextextended(${runId + ':execution'}, 0))`;
   const run = await this.journal.run(runId); if (['failed', 'succeeded'].includes(run.state)) return;
   const snapshot = run.trigger as Snapshot;
   await this.journal.state(runId, 'running');
   try {
    await interpret(snapshot, async (path, step, args, skipped) => {
     const hash = digest(args), prior = await this.journal.step(runId, path);
     if (prior?.state === 'succeeded' || prior?.state === 'skipped') return prior.output;
     if (skipped) { await this.journal.record(runId, path, step, 'skipped', hash); return null; }
     try {
      let output: unknown;
      if (step.kind === 'await') {
       const draftId = String((args.draft as { id: string }).id);
       const deadline = prior?.output?.deadline ?? Date.now() + step.timeoutDays! * this.dayMs;
       if (await this.catalogue.wasSent(draftId)) output = { sent: true };
       else if (Date.now() >= deadline) throw Error('outbox.sent timed out; the owner did not send the draft');
       else {
        // A persisted delayed job survives worker shutdown. Event delivery also queues the run.
        await this.boss.send(this.queue, { runId }, { startAfter: new Date(deadline) });
        await this.journal.record(runId, path, step, 'waiting', hash, { draftId, deadline });
        await this.journal.state(runId, 'waiting'); throw new Park();
       }
      } else {
       await this.journal.record(runId, path, step, 'running', hash);
       output = await this.catalogue.call({ runId, path, step, args });
      }
      await this.journal.record(runId, path, step, 'succeeded', hash, output); return output;
     } catch (error) {
      if (error instanceof Crash || error instanceof Park) throw error;
      const reason = error instanceof Error ? error.message : 'Step failed';
      await this.journal.record(runId, path, step, 'failed', hash, null, reason); throw new StepFailure(path, step.key, reason);
     }
    });
    await this.journal.state(runId, 'succeeded');
   } catch (error) {
    if (error instanceof Park) return;
    if (error instanceof Crash) throw error; // pg-boss retries the job; completed steps are replayed from SQL.
    await this.journal.state(runId, 'failed', error instanceof StepFailure ? `${error.path} (${error.key}): ${error.message}` : 'Invalid spike definition');
   }
  });
 }
}
