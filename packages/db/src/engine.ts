/** Tenant journal; the runner passes this same transaction to database step handlers. */
import type { Sql, TransactionSql } from 'postgres';
import { withTenant } from './context.ts';
export type Context = { organisationId: string; userId?: string };
export type Enabled = { id: string; organisationId: string; enabledBy: string; parameters: Record<string, unknown>; definitionKey: string; definitionVersion: number };
export type Run = { id: string; state: string; reason: string | null; snapshot: unknown; enabledBy: string | null; enablementId: string; definitionKey: string; definitionVersion: number; definitionDigest: string; scheduleKey: string | null; scheduleAdvanced: boolean };
export type JournalStep = { state: string; inputDigest: string; output: unknown; deadline: Date | null; waitKey: string | null };
export class EngineJournal {
 readonly db: Sql; readonly tenant: Context;
 constructor(db: Sql, tenant: Context) { this.db = db; this.tenant = tenant; }
 tx<T>(work: (tx: TransactionSql) => Promise<T>) { return withTenant(this.db, this.tenant, work); }
 async run(tx: TransactionSql, id: string, lock = true) { const [row] = await tx<Run[]>`select * from workflow_runs where id = ${id} ${lock ? tx`for update` : tx``}`; if (!row) throw Error('Run not found'); return row; }
 async create(tx: TransactionSql, enabled: Enabled, definition: { key: string; version: number }, digest: string, snapshot: unknown, trigger: unknown, scheduleKey: string | null = null) {
  const [run] = await tx`insert into workflow_runs (organisation_id, enablement_id, enabled_by, definition_key, definition_version, definition_digest, snapshot, trigger, schedule_key)
   values (${this.tenant.organisationId}, ${enabled.id}, ${enabled.enabledBy}, ${definition.key}, ${definition.version}, ${digest}, ${tx.json(snapshot as never)}, ${tx.json(trigger as never)}, ${scheduleKey}) returning id`;
  const id = String(run!.id); await this.audit(tx, id, 'workflow.queued'); return id;
 }
 async authorised(tx: TransactionSql, run: Run) {
  const [row] = await tx`select 1 from workflow_enablements e join memberships m on m.organisation_id = e.organisation_id
   where e.id = ${run.enablementId} and e.enabled and m.user_id = ${run.enabledBy} and m.status = 'active' for share of m`;
  return !!row;
 }
 async state(tx: TransactionSql, id: string, state: string, reason: string | null = null) {
  await tx`update workflow_runs set state = ${state}, reason = ${reason}, started_at = case when ${state} = 'running' then coalesce(started_at, now()) else started_at end,
   finished_at = case when ${state} in ('succeeded', 'failed', 'cancelled') then now() else null end where id = ${id}`;
  await this.audit(tx, id, 'workflow.' + state);
 }
 async step(tx: TransactionSql, runId: string, path: string) { return (await tx<JournalStep[]>`select * from workflow_run_steps where run_id = ${runId} and path = ${path}`)[0]; }
 async record(tx: TransactionSql, runId: string, path: string, itemIndex: number | null, step: { kind: string; key: string }, state: string, digest: string, output: unknown = null, error: string | null = null, wait?: { deadline: Date; key: string }) {
  await tx`insert into workflow_run_steps (organisation_id, run_id, path, item_index, kind, key, state, input_digest, output, error, deadline, wait_key, started_at, finished_at)
   values (${this.tenant.organisationId}, ${runId}, ${path}, ${itemIndex}, ${step.kind}, ${step.key}, ${state}, ${digest}, ${tx.json(output as never)}, ${error}, ${wait?.deadline ?? null}, ${wait?.key ?? null}, now(), case when ${state} in ('failed', 'succeeded', 'skipped') then now() else null end)
   on conflict (organisation_id, run_id, path) do update set state = excluded.state, input_digest = excluded.input_digest, output = excluded.output, error = excluded.error,
   deadline = coalesce(excluded.deadline, workflow_run_steps.deadline), wait_key = coalesce(excluded.wait_key, workflow_run_steps.wait_key), finished_at = excluded.finished_at`;
  await this.audit(tx, runId, 'workflow.step_' + state, { path, key: step.key, itemIndex });
 }
 async audit(tx: TransactionSql, runId: string, action: string, detail = {}) {
  await tx`insert into audit_events (organisation_id, actor_kind, actor_id, action, subject_type, subject_id, detail)
   values (${this.tenant.organisationId}, 'workflow', coalesce(${this.tenant.userId ?? null}::uuid, nullif(current_setting('app.user_id', true), '')::uuid), ${action}, 'workflow_run', ${runId}, ${tx.json(detail)})`;
 }
}
export async function enabled(tx: TransactionSql, key?: string) {
 return tx<Enabled[]>`select * from workflow_enablements where enabled and enabled_by is not null and (${key ?? null}::text is null or definition_key = ${key ?? null}) order by id for update`;
}
export async function timezone(tx: TransactionSql, organisationId: string) { return String((await tx`select timezone from organisations where id = ${organisationId}`)[0]!.timezone); }
export async function advance(tx: TransactionSql, id: string) { await tx`update workflow_runs set schedule_advanced = true where id = ${id}`; }
export async function scheduled(tx: TransactionSql, enablementId: string) { return tx<Run[]>`select * from workflow_runs where enablement_id = ${enablementId} and schedule_key is not null and not schedule_advanced and state = 'queued' order by id for update`; }
export async function waiting(tx: TransactionSql, key: string, runId: string) { return tx<{ id: string; definitionKey: string }[]>`select r.id, r.definition_key from workflow_runs r where r.id = ${runId} and r.state = 'waiting' and exists
 (select 1 from workflow_run_steps s where s.run_id = r.id and s.state = 'waiting' and s.wait_key = ${key}) order by r.id for update`; }
export async function lastIncomplete(tx: TransactionSql, runId: string) { return (await tx<{ path: string; key: string }[]>`select path, key from workflow_run_steps where run_id = ${runId} and state not in ('succeeded', 'skipped') order by started_at desc limit 1`)[0]; }
export async function exhaust(tx: TransactionSql, runId: string, reason: string) { await tx`update workflow_run_steps set state = 'failed', error = ${reason}, finished_at = now() where run_id = ${runId} and state = 'running'`; }
