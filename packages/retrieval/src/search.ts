import type { TransactionSql } from '@captain/db';
import { toSql } from './vectors.ts';
export type Similar = { kind: 'thread' | 'note'; id: string; score: number; best: number };
/** Threads and notes nearest a seed vector, under the tenant's RLS: the thread or note similarity plus the best single
 *  message similarity for a thread (plan: retrieval). Deterministic widening by counterparty, references, reply chain and
 *  dates comes with association; this is the similarity half. */
export type EncoderId = { encoder: string; version: string };
/** The tag kept on a thread or note vector: encoder name and version. */
export const encoderTag = (id: EncoderId): string => `${id.encoder}@${id.version}`;
export async function similar(tx: TransactionSql, seed: number[], id: EncoderId, { limit = 50, minScore = 0.2 }: { limit?: number; minScore?: number } = {}): Promise<Similar[]> {
	const vector = toSql(seed); const tag = encoderTag(id);
	const threads = await tx<{ id: string; score: number; best: number }[]>`
		with near as (select id, 1 - (vector <=> ${vector}::vector) as score from mail_threads where vector is not null and vector_encoder = ${tag} order by vector <=> ${vector}::vector limit ${limit})
		select near.id, near.score, coalesce((select max(1 - (v.vector <=> ${vector}::vector)) from content_vectors v join mail_messages m on m.id = v.source_id and m.organisation_id = v.organisation_id
			where v.source_kind = 'mail_message' and m.thread_id = near.id and v.encoder = ${id.encoder} and v.encoder_version = ${id.version}), near.score) as best from near`;
	const notes = await tx<{ id: string; score: number }[]>`
		select id, 1 - (vector <=> ${vector}::vector) as score from notes where archived_at is null and vector is not null and vector_encoder = ${tag} order by vector <=> ${vector}::vector limit ${limit}`;
	return [...threads.map((t) => ({ kind: 'thread' as const, id: String(t.id), score: Number(t.score), best: Number(t.best) })), ...notes.map((n) => ({ kind: 'note' as const, id: String(n.id), score: Number(n.score), best: Number(n.score) }))]
		.map((row) => ({ ...row, score: (row.score + row.best) / 2 })).filter((row) => row.score >= minScore).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
