import { z } from 'zod';
import type { HandlerContext } from '@captain/engine';
import type { TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import type { Signals } from './gate.ts';
/** The project a thread or note belongs to (D22): an existing project's name, none, or a proposed name with its stage.
 *  Code links only to a name that exists; a proposed name goes to project_candidates. */
export const projectField = z.object({ name: z.string().max(200).nullable(), stage: z.enum(['idea', 'underway']).nullable() }).strict().default({ name: null, stage: null });
export const triageSchema = z.object({
 category: z.enum(['request', 'confirmation', 'information', 'spam', 'other']), needsOwner: z.boolean(), summary: z.string().max(2000),
 facts: z.object({ counterparty: z.string().max(300).nullable(), amounts: z.array(z.string().max(100)).max(20), dates: z.array(z.string().max(100)).max(20), references: z.array(z.string().max(300)).max(20) }).strict(),
 tasks: z.array(z.object({ title: z.string().min(1).max(300), reference: z.string().max(300), due: z.iso.date().nullable(), steps: z.array(z.string().min(1).max(300)).max(10).default([]) }).strict()).max(20),
 project: projectField,
 confirmations: z.array(z.object({ title: z.string().min(1).max(300), reference: z.string().min(1).max(300) }).strict()).max(20)
}).strict();
/** A note's triage: the person is the author, so no needs-owner and no draft; category, summary, facts and tasks only. */
export const noteTriageSchema = z.object({
 category: z.enum(['plan', 'request', 'information', 'other']), summary: z.string().max(2000),
 facts: z.object({ counterparty: z.string().max(300).nullable(), amounts: z.array(z.string().max(100)).max(20), dates: z.array(z.string().max(100)).max(20), references: z.array(z.string().max(300)).max(20) }).strict(),
 tasks: z.array(z.object({ title: z.string().min(1).max(300), reference: z.string().max(300), due: z.iso.date().nullable(), steps: z.array(z.string().min(1).max(300)).max(10).default([]) }).strict()).max(20),
 project: projectField
}).strict();
export type Note = { id: string; title: string; body: string; digest: string; length: number; updatedAt: string; links: { contact: string | null; company: string | null; project: string | null; task: string | null; event: boolean } };
/** What the rules decided before the model saw a thread (D22): the project it already belongs to, or none. */
export type ProjectLink = { projectId: string | null; projectName: string | null; rule: string | null; companyId: string | null };
export const normaliseProjectName = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 200);
export const draftSchema = z.object({ body: z.string().min(1).max(20000) }).strict();
export type Triage = z.infer<typeof triageSchema>;
export type Thread = { id: string; connectionId: string; accountEmail: string; providerId: string; sourceMessageId: string; knownSender: boolean;
 sender: string; subject: string; rfcMessageId: string; signals: Signals; messages: { id: string; fromHeader: string; body: string; sentAt: string }[] };
export type Context = HandlerContext & { tx: TransactionSql };
export function journal(context: Context, action: string, subjectType: string, subjectId: string, detail: Record<string, unknown> = {}) {
 return audit(context.tx, { organisationId: context.organisationId, actor: { kind: 'workflow', id: context.userId }, requestId: context.runId, action, subjectType, subjectId, detail: { runId: context.runId, ...detail } });
}
