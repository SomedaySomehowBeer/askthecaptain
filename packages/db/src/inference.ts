import type { TransactionSql } from 'postgres';
export type Runtime = { id: string; organisationId: string; provider: 'claude' | 'codex' | 'anthropic_api'; spriteName: string | null; region: string | null; status: 'provisioning' | 'needs_login' | 'ready' | 'failed' | 'removed'; loginHint: string | null; loginUrl: string | null; addedBy: string; connectionEncrypted: Buffer | null; lastVerifiedAt: Date | null; error: string | null };
export type Budget = { month: string; limitTokens: number; costLimitMicros: number | null; usedTokens: number };
export async function inferenceAudit(tx: TransactionSql, organisationId: string, action: string, detail: Record<string, unknown> = {}) {
 await tx`insert into audit_events (organisation_id, actor_kind, actor_id, action, subject_type, detail)
 values (${organisationId}, 'person', current_user_id(), ${action}, 'inference', ${tx.json(detail as never)})`;
}
export async function getRuntime(tx: TransactionSql, organisationId: string, lock = false) {
 // A row UPDATE lock applies the owner-only write policy even to a member's read.
 // Coordinate calls and owner changes without granting members runtime writes.
 if (lock) await tx`select pg_advisory_xact_lock(hashtextextended(${'inference:' + organisationId}, 0))`;
 const rows = await tx<Runtime[]>`select * from inference_runtimes where organisation_id = ${organisationId}`;
 return rows[0];
}
export async function createRuntime(tx: TransactionSql, organisationId: string, userId: string, provider: Runtime['provider']) {
 const [row] = await tx<Runtime[]>`insert into inference_runtimes (organisation_id, added_by, provider, status) values (${organisationId}, ${userId}, ${provider}, 'provisioning')
 on conflict (organisation_id) do update set provider = excluded.provider, added_by = excluded.added_by, status = 'provisioning', sprite_name = null, region = null, connection_encrypted = null, login_hint = null, login_url = null, last_verified_at = null, error = null, updated_at = now()
 where inference_runtimes.status = 'removed' returning *`;
 if (row) await inferenceAudit(tx, organisationId, 'inference.runtime_requested', { provider }); return row;
}
export async function configureRuntime(tx: TransactionSql, organisationId: string, input: { encrypted: Buffer; spriteName: string; region: string; loginHint: string | null; loginUrl: string | null; status?: 'provisioning' | 'needs_login' }) {
 await tx`update inference_runtimes set connection_encrypted = ${input.encrypted}, sprite_name = ${input.spriteName}, region = ${input.region}, login_hint = ${input.loginHint}, login_url = ${input.loginUrl}, status = ${input.status ?? 'needs_login'}, updated_at = now() where organisation_id = ${organisationId}`;
 await inferenceAudit(tx, organisationId, 'inference.runtime_configured');
}
export async function runtimeState(tx: TransactionSql, organisationId: string, status: Runtime['status'], error: string | null = null) {
 await tx`update inference_runtimes set status = ${status}, error = ${error}, last_verified_at = now(), updated_at = now(),
 connection_encrypted = case when ${status} = 'removed' then null else connection_encrypted end,
 login_url = case when ${status} in ('removed', 'ready') then null else login_url end,
 login_hint = case when ${status} = 'removed' then null else login_hint end where organisation_id = ${organisationId}`;
 await inferenceAudit(tx, organisationId, `inference.${status}`, error ? { code: error } : {});
}
export async function dataKey(tx: TransactionSql, organisationId: string, create?: Buffer) {
 const [row] = create
  ? await tx<{ dataKeyWrapped: Buffer | null }[]>`select data_key_wrapped from organisations where id = ${organisationId} for update`
  : await tx<{ dataKeyWrapped: Buffer | null }[]>`select data_key_wrapped from organisations where id = ${organisationId}`;
 if (!row) throw new Error('organisation missing');
 if (!row.dataKeyWrapped && create) {
  await tx`update organisations set data_key_wrapped = ${create} where id = ${organisationId}`;
  await inferenceAudit(tx, organisationId, 'inference.data_key_created'); return create;
 }
 return row.dataKeyWrapped;
}
/** UTC month; lazy creation and row lock serialize calls without token reservations. */
export async function budget(tx: TransactionSql, organisationId: string): Promise<Budget> {
 const inserted = await tx`insert into model_budgets (organisation_id, month, limit_tokens)
 select id, date_trunc('month', now() at time zone 'UTC')::date, coalesce((settings->>'inferenceLimitTokens')::bigint, 0) from organisations where id = ${organisationId}
 on conflict (organisation_id, month) do nothing returning id`;
 if (inserted.length) await inferenceAudit(tx, organisationId, 'inference.month_created');
 const [row] = await tx<Budget[]>`select month::text, limit_tokens::float8, cost_limit_micros::float8, used_tokens::float8 from model_budgets where organisation_id = ${organisationId} and month = date_trunc('month', now() at time zone 'UTC')::date for update`;
 return row!;
}
export async function setBudget(tx: TransactionSql, organisationId: string, limit: number) {
 await tx`update organisations set settings = jsonb_set(settings, '{inferenceLimitTokens}', ${tx.json(limit)}) where id = ${organisationId}`;
 await budget(tx, organisationId);
 await tx`update model_budgets set limit_tokens = ${limit} where organisation_id = ${organisationId} and month = date_trunc('month', now() at time zone 'UTC')::date`;
 await inferenceAudit(tx, organisationId, 'inference.budget_changed', { limitTokens: limit });
}
export async function usageByTier(tx: TransactionSql, organisationId: string) {
 return tx<{ tier: 'small' | 'large'; inputTokens: number; outputTokens: number; calls: number }[]>`select tier, sum(input_tokens)::float8 as input_tokens, sum(output_tokens)::float8 as output_tokens, count(*)::int as calls from model_usage
 where organisation_id = ${organisationId} and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' group by tier`;
}
export async function settle(tx: TransactionSql, organisationId: string, month: string, input: { runId?: string; step: string; tier: string; provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number }) {
 await tx`update model_budgets set used_tokens = used_tokens + ${input.inputTokens + input.outputTokens} where organisation_id = ${organisationId} and month = ${month}`;
 await tx`insert into model_usage (organisation_id, run_id, step_key, tier, provider, model, input_tokens, output_tokens, latency_ms)
 values (${organisationId}, ${input.runId ?? null}, ${input.step}, ${input.tier}, ${input.provider}, ${input.model}, ${input.inputTokens}, ${input.outputTokens}, ${input.latencyMs})`;
 await inferenceAudit(tx, organisationId, 'inference.usage_recorded', { step: input.step, runId: input.runId ?? null });
}
