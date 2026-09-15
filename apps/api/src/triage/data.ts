import { z } from 'zod';
import type { HandlerContext } from '@captain/engine';
import type { TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
export const triageSchema = z.object({
 category: z.enum(['request', 'confirmation', 'information', 'spam', 'other']), needsOwner: z.boolean(), summary: z.string().max(2000),
 facts: z.object({ counterparty: z.string().max(300).nullable(), amounts: z.array(z.string().max(100)).max(20), dates: z.array(z.string().max(100)).max(20), references: z.array(z.string().max(300)).max(20) }).strict(),
 tasks: z.array(z.object({ title: z.string().min(1).max(300), reference: z.string().max(300), due: z.iso.date().nullable() }).strict()).max(20),
 confirmations: z.array(z.object({ title: z.string().min(1).max(300), reference: z.string().min(1).max(300) }).strict()).max(20)
}).strict();
export const draftSchema = z.object({ body: z.string().min(1).max(20000) }).strict();
export type Triage = z.infer<typeof triageSchema>;
export type Thread = { id: string; connectionId: string; accountEmail: string; providerId: string; sourceMessageId: string; knownSender: boolean;
 sender: string; subject: string; rfcMessageId: string; messages: { id: string; fromHeader: string; body: string; sentAt: string }[] };
export type Context = HandlerContext & { tx: TransactionSql };
export function journal(context: Context, action: string, subjectType: string, subjectId: string, detail: Record<string, unknown> = {}) {
 return audit(context.tx, { organisationId: context.organisationId, actor: { kind: 'workflow', id: context.userId }, requestId: context.runId, action, subjectType, subjectId, detail: { runId: context.runId, ...detail } });
}
