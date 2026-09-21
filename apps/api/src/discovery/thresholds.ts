import type { TransactionSql } from '@captain/db';
import { cosine, parseVector } from '@captain/retrieval';
/** Constants until a second tenant shows they should be settings (plan §6). */
export const THRESHOLDS = { underwaySources: 3, underwayDays: 14, ideaSources: 2, ownItems: 2, sharedReference: 2, clusterMin: 3, clusterSimilarity: 0.6, clusterThreads: 200, maxSeeds: 10 };
type Pending = { kind: 'candidate' | 'thread' | 'note' | 'tasks' | 'cluster'; key: string; reason: string; name: string | null; sourceKind: 'mail_thread' | 'note' | null; sourceId: string | null };
const day = 86_400_000;
/** The deterministic thresholds that make a discovery call worth its cost. Each rule writes pending seeds, never twice
 *  while one is open; a candidate is seeded again only when it has gathered sources since it was last seeded. */
export async function findSeeds(tx: TransactionSql, organisationId: string): Promise<number> {
	const seeds: Pending[] = [];
	// Candidate names the triage model proposed, with the dates of the threads and notes that proposed them.
	const rows = await tx`select c.normalised, c.name, c.stage, s.source_kind, s.source_id, s.own, coalesce(t.last_message_at, n.updated_at) as at,
			(t.id is not null and exists (select 1 from mail_messages m where m.thread_id = t.id and 'SENT' = any(m.label_ids))
				and exists (select 1 from mail_messages m where m.thread_id = t.id and not ('SENT' = any(m.label_ids)))) as both_wrote
		from project_candidates c join project_candidate_sources s on s.organisation_id = c.organisation_id and s.normalised = c.normalised
		left join mail_threads t on s.source_kind = 'mail_thread' and t.organisation_id = s.organisation_id and t.id = s.source_id
		left join notes n on s.source_kind = 'note' and n.organisation_id = s.organisation_id and n.id = s.source_id
		where c.closed_at is null and (c.seeded_at is null or c.last_seen_at > c.seeded_at) order by c.normalised, at`;
	const byName = new Map<string, (typeof rows)[number][]>();
	for (const row of rows) byName.set(String(row.normalised), [...(byName.get(String(row.normalised)) ?? []), row]);
	for (const [normalised, sources] of byName) {
		const dated = sources.filter((s) => s.at).map((s) => new Date(s.at as string).getTime());
		const span = dated.length ? (Math.max(...dated) - Math.min(...dated)) / day : 0;
		const own = sources.filter((s) => s.own).length; const stage = String(sources[0]!.stage); const first = sources[0]!;
		const reason = stage === 'underway' && sources.length >= THRESHOLDS.underwaySources && span >= THRESHOLDS.underwayDays ? 'underway_three_sources_fourteen_days'
			: stage === 'idea' && sources.length >= THRESHOLDS.ideaSources ? 'idea_two_sources'
			: stage === 'idea' && sources.some((s) => s.bothWrote) ? 'idea_both_wrote'
			: own >= THRESHOLDS.ownItems ? 'two_own_items' : null;
		if (reason) seeds.push({ kind: 'candidate', key: normalised, reason, name: String(first.name), sourceKind: first.sourceKind as 'mail_thread' | 'note', sourceId: String(first.sourceId) });
	}
	// Suggested duties in Obligations that share a counterparty and a reference: the concrete symptom of a missing project.
	const shared = await tx`select t.body as reference, mt.facts->>'counterparty' as counterparty, (array_agg(t.source_id order by t.created_at))[1] as thread_id
		from tasks t join projects p on p.organisation_id = t.organisation_id and p.id = t.project_id
		join mail_triage mt on t.source_kind = 'mail' and mt.organisation_id = t.organisation_id and mt.thread_id::text = t.source_id
		where p.system_kind = 'obligations' and t.status = 'suggested' and t.parent_id is null and length(t.body) >= 4 and coalesce(mt.facts->>'counterparty', '') <> ''
		group by t.body, mt.facts->>'counterparty' having count(distinct t.source_id) >= ${THRESHOLDS.sharedReference}`;
	for (const row of shared) seeds.push({ kind: 'tasks', key: `${String(row.counterparty).slice(0, 150)}|${String(row.reference).slice(0, 200)}`, reason: 'shared_reference', name: String(row.reference), sourceKind: 'mail_thread', sourceId: String(row.threadId) });
	// On the first run, and only then, the clusters of the synced backlog: greedy, by thread vector, newest first.
	const [ever] = await tx`select 1 from discovery_seeds limit 1`;
	if (!ever && seeds.length < THRESHOLDS.maxSeeds) {
		const threads = await tx`select id, vector::text as vector from mail_threads where vector is not null order by last_message_at desc limit ${THRESHOLDS.clusterThreads}`;
		const vectors = threads.map((t) => ({ id: String(t.id), vector: parseVector(String(t.vector))! })); const taken = new Set<string>();
		for (const seed of vectors) {
			if (taken.has(seed.id)) continue;
			const members = vectors.filter((v) => !taken.has(v.id) && (v.id === seed.id || cosine(seed.vector, v.vector) >= THRESHOLDS.clusterSimilarity));
			if (members.length < THRESHOLDS.clusterMin) continue;
			for (const m of members) taken.add(m.id);
			seeds.push({ kind: 'cluster', key: seed.id, reason: 'backlog_cluster', name: null, sourceKind: 'mail_thread', sourceId: seed.id });
			if (seeds.length >= THRESHOLDS.maxSeeds) break;
		}
	}
	let added = 0;
	for (const seed of seeds) {
		const rows = await tx`insert into discovery_seeds (organisation_id, kind, key, reason, name, source_kind, source_id) values (${organisationId}, ${seed.kind}, ${seed.key}, ${seed.reason}, ${seed.name}, ${seed.sourceKind}, ${seed.sourceId})
			on conflict do nothing returning id`;
		added += rows.length;
	}
	return added;
}
