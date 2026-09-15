import { createServer, type Server } from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import { digestOf, type WorkflowDefinition } from '@captain/steps';
import { EngineJournal } from '@captain/db/engine';
import { Crash, StepFailure, digest, interpret, type Catalogue, type Enablement, type Engine, type Event, type Snapshot } from './index.ts';
/** Local self-hosted spike: one Restate service for the inbox-triage definition. */
export class RestateEngine implements Engine {
 private server?: Server;
 readonly name: string;
 readonly journal: EngineJournal; readonly catalogue: Catalogue; readonly dayMs: number; readonly port: number; readonly ingress: string; readonly admin: string;
 constructor(journal: EngineJournal, catalogue: Catalogue, dayMs = 86400000, port = 19081, ingress = 'http://127.0.0.1:18080', admin = 'http://127.0.0.1:19070') { this.journal = journal; this.catalogue = catalogue; this.dayMs = dayMs; this.port = port; this.ingress = ingress; this.admin = admin; this.name = `inbox_triage_${journal.tenant.organisationId.replaceAll('-', '')}`; }
 async open() {
  const service = restate.service({ name: this.name, options: { retryPolicy: { initialInterval: 100, maxInterval: 1000 } }, handlers: { run: async (ctx: restate.Context, runId: string) => {
   const run = await ctx.run('load run', () => this.journal.run(runId));
   const snapshot = run.trigger as Snapshot;
   await ctx.run('running', () => this.journal.state(runId, 'running'));
   try {
    await interpret(snapshot, async (path, step, args, skipped) => {
     const hash = digest(args);
     try {
      if (skipped) { await ctx.run(`${path}:skip`, () => this.journal.record(runId, path, step, 'skipped', hash)); return null; }
      let output: unknown;
      if (step.kind === 'await') {
       const draftId = String((args.draft as { id: string }).id), wake = ctx.awakeable<unknown>();
       await ctx.run(`${path}:waiting`, () => this.journal.record(runId, path, step, 'waiting', hash, { draftId, awakeableId: wake.id }));
       const sent = await ctx.run(`${path}:already sent`, () => this.catalogue.wasSent(draftId));
       if (!sent) {
        await ctx.run(`${path}:park`, () => this.journal.state(runId, 'waiting'));
        const timeout = ctx.sleep(step.timeoutDays! * this.dayMs).map(() => 'timeout');
        if (await restate.RestatePromise.race([wake.promise, timeout]) === 'timeout') throw new restate.TerminalError('outbox.sent timed out; the owner did not send the draft');
       }
       output = { sent: true };
      } else {
       output = await ctx.run(`${path}:${step.key}`, async () => {
        await this.journal.record(runId, path, step, 'running', hash);
        try { return await this.catalogue.call({ runId, path, step, args }); }
        catch (error) { if (error instanceof Crash) throw error; throw new restate.TerminalError(error instanceof Error ? error.message : 'Step failed'); }
       });
      }
      await ctx.run(`${path}:journal`, () => this.journal.record(runId, path, step, 'succeeded', hash, output)); return output;
     } catch (error) {
      if (!(error instanceof restate.TerminalError)) throw error;
      await ctx.run(`${path}:failed`, () => this.journal.record(runId, path, step, 'failed', hash, null, error.message));
      throw new StepFailure(path, step.key, error.message);
     }
    });
    await ctx.run('succeeded', () => this.journal.state(runId, 'succeeded'));
   } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    await ctx.run('failed', () => this.journal.state(runId, 'failed', `${error.path} (${error.key}): ${error.message}`));
   }
  } } });
  this.server = createServer(restate.createEndpointHandler({ services: [service] }));
  await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.port, '0.0.0.0', resolve); });
  const response = await fetch(`${this.admin}/deployments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uri: `http://host.docker.internal:${this.port}`, force: true, use_http_11: true }) });
  if (!response.ok) { await this.close(); throw Error(`Restate registration failed ${response.status}: ${await response.text()}`); }
 }
 async close() { this.server?.closeAllConnections(); await new Promise<void>(resolve => this.server?.close(() => resolve())); }
 async start(definition: WorkflowDefinition, enablement: Enablement, trigger: unknown) {
  const runId = await this.journal.create(definition, enablement.id, digestOf(definition), { definition, enablement, trigger });
  const response = await fetch(`${this.ingress}/${this.name}/run/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': runId }, body: JSON.stringify(runId) });
  if (!response.ok) throw Error(`Restate start failed ${response.status}`); return runId;
 }
 async resume(runId: string, event: Event) {
  await this.journal.run(runId); await this.catalogue.sent(runId, event);
  const rows = await this.journal.tx(tx => tx`select output from workflow_run_steps where run_id = ${runId} and state = 'waiting'`);
  for (const row of rows) if (row.output.draftId === event.draftId) {
   const response = await fetch(`${this.ingress}/restate/awakeables/${row.output.awakeableId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sent: true }) });
   if (!response.ok) throw Error(`Awakeable resolution failed ${response.status}`);
  }
 }
}
