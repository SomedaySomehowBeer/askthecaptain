import type { HandlerContext } from '@captain/engine';
import type { TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
export type Context = HandlerContext & { tx: TransactionSql };
export function journal(context: Context, action: string, subjectType: string, subjectId: string, detail: Record<string, unknown> = {}) {
 return audit(context.tx, { organisationId: context.organisationId, actor: { kind: 'workflow', id: context.userId }, requestId: context.runId, action, subjectType, subjectId, detail: { runId: context.runId, ...detail } });
}
