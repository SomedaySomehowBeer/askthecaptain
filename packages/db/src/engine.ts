/** Spike journal access. Business state remains behind tenant transactions (D4, D6). */
import { withTenant, type TenantContext } from './context.ts';
import type { Sql, TransactionSql } from 'postgres';
export type JournalContext = TenantContext & { userId: string };
export class EngineJournal {
 readonly db: Sql; readonly tenant: JournalContext;
 constructor(db: Sql, tenant: JournalContext) { this.db = db; this.tenant = tenant; }
 tx<T>(work: (tx: TransactionSql) => Promise<T>) { return withTenant(this.db, this.tenant, work); }
 async create(definition: { key: string; version: number }, enablementId: string, digest: string, snapshot: unknown) {
  return this.tx(async tx => {
   const [enabled] = await tx`select * from workflow_enablements where id = ${enablementId} and enabled and enabled_by = ${this.tenant.userId} and definition_key = ${definition.key} and definition_version = ${definition.version}`;
   const [member] = await tx`select 1 from memberships where organisation_id = ${this.tenant.organisationId} and user_id = ${this.tenant.userId} and status = 'active'`;
   if (!enabled || !member) throw Error('Workflow is not enabled by this active member');
   const [run] = await tx`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger)
    values (${this.tenant.organisationId}, ${enablementId}, ${definition.key}, ${definition.version}, ${digest}, ${tx.json(snapshot as never)}) returning id`;
   await this.audit(tx, String(run!.id), 'workflow.queued'); return String(run!.id);
  });
 }
 async run(id: string) {
  return this.tx(async tx => { const [run] = await tx`select * from workflow_runs where id = ${id}`; if (!run) throw Error('Run not found'); return run; });
 }
 async state(id: string, state: string, reason: string | null = null) {
  return this.tx(async tx => {
   await tx`update workflow_runs set state = ${state}, reason = ${reason}, started_at = coalesce(started_at, now()), finished_at = case when ${state} in ('failed', 'succeeded') then now() else null end where id = ${id}`;
   await this.audit(tx, id, 'workflow.' + state);
  });
 }
 async step(runId: string, path: string) { return this.tx(async tx => (await tx`select * from workflow_run_steps where run_id = ${runId} and path = ${path}`)[0]); }
 async record(runId: string, path: string, step: { kind: string; key: string }, state: string, digest: string, output: unknown = null, error: string | null = null) {
  return this.tx(async tx => {
   await tx`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`;
   const [found] = await tx`select id from workflow_run_steps where run_id = ${runId} and path = ${path}`;
   if (found) await tx`update workflow_run_steps set state = ${state}, input_digest = ${digest}, output = ${tx.json(output as never)}, error = ${error}, finished_at = case when ${state} in ('failed', 'succeeded', 'skipped') then now() else null end where id = ${found.id}`;
   else await tx`insert into workflow_run_steps (organisation_id, run_id, path, kind, key, state, input_digest, output, error, started_at, finished_at)
    values (${this.tenant.organisationId}, ${runId}, ${path}, ${step.kind}, ${step.key}, ${state}, ${digest}, ${tx.json(output as never)}, ${error}, now(), case when ${state} in ('failed', 'succeeded', 'skipped') then now() else null end)`;
   await this.audit(tx, runId, 'workflow.step_' + state, { path, key: step.key });
  });
 }
 async audit(tx: TransactionSql, runId: string, action: string, detail = {}) {
  await tx`insert into audit_events (organisation_id, actor_kind, actor_id, action, subject_type, subject_id, detail)
   values (${this.tenant.organisationId}, 'person', ${this.tenant.userId}, ${action}, 'workflow_run', ${runId}, ${tx.json(detail)})`;
 }
}
