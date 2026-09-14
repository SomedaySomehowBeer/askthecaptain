import type { TransactionSql } from '@captain/db';

export type AuditActor = { kind: 'person' | 'workflow' | 'system'; id?: string };
export type AuditEntry = { organisationId: string; actor: AuditActor; action: string; subjectType: string; subjectId?: string;
	requestId?: string; detail?: Record<string, unknown> };

/** Every write to tenant data records who did it, in the same transaction, so the log cannot
 *  disagree with the data. */
export async function audit(tx: TransactionSql, entry: AuditEntry): Promise<void> {
	await tx`insert into audit_events (organisation_id, actor_kind, actor_id, action, subject_type, subject_id, request_id, detail)
		values (${entry.organisationId}, ${entry.actor.kind}, ${entry.actor.id ?? null}, ${entry.action}, ${entry.subjectType},
			${entry.subjectId ?? null}, ${entry.requestId ?? null}, ${tx.json((entry.detail ?? {}) as never)})`;
}
