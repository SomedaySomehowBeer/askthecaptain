import { z } from 'zod';
/** What a discovery call starts from (plan §6): a candidate name past its threshold, a thread or note a person chose,
 *  suggested duties sharing a counterparty and a reference, or a cluster of the backlog on the first run. */
export type Seed = { id: string; kind: 'candidate' | 'thread' | 'note' | 'tasks' | 'cluster'; key: string; reason: string; name: string | null;
	sourceKind: 'mail_thread' | 'note' | null; sourceId: string | null };
/** One thread or note the model may cite, by an opaque id that is valid for this call only. */
export type Candidate = { id: string; kind: 'thread' | 'note'; sourceId: string; title: string; date: string; counterparty: string | null; text: string; why: string[] };
export type Evidence = { seed: { kind: Seed['kind']; name: string | null; reason: string; text: string }; candidates: Candidate[]; indexed: boolean };
const line = z.object({ text: z.string().min(1).max(500), evidence: z.string().max(12).nullable() }).strict();
const lines = z.array(line).max(20);
/** The model's answer for one seed (D22): what it is, which candidates belong, and for a project its brief and tasks. */
export const discoverySchema = z.object({
	kind: z.enum(['project', 'task', 'relationship', 'nothing']),
	belongs: z.array(z.string().max(12)).max(50),
	name: z.string().max(200).nullable(), description: z.string().max(2000).nullable(), stage: z.enum(['idea', 'underway']).nullable(),
	brief: z.object({ what: lines, standing: lines, people: lines, questions: lines }).strict(),
	tasks: z.array(z.object({ title: z.string().min(1).max(300), reference: z.string().max(300), due: z.iso.date().nullable(),
		steps: z.array(z.string().min(1).max(300)).max(10).default([]), evidence: z.string().max(12).nullable() }).strict()).max(20)
}).strict();
export type Discovery = z.infer<typeof discoverySchema>;
