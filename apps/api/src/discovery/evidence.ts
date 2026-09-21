import type { TransactionSql } from '@captain/db';
import { similar } from '@captain/retrieval';
import { addresses } from '../contacts/addresses.ts';
import { ownText } from '../triage/text.ts';
import type { IndexService } from '../retrieval/service.ts';
import type { Candidate, Evidence, Seed } from './data.ts';
export const MAX_CANDIDATES = 50; const WINDOW_DAYS = 60; const MIN_SIMILARITY = 0.25;
const normalSubject = (s: string) => s.toLowerCase().replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim();
type Found = { kind: 'thread' | 'note'; id: string; why: string; score: number };
/** The evidence for one seed (plan: retrieval): its own sources first, the threads and notes nearest it in the index,
 *  then deterministic widening from its sources by counterparty company, shared references, the reply chain, the
 *  normalised subject and links a note shares, within sixty days either side of the seed; at most fifty, each with an
 *  opaque id valid for this call only. Every query runs under the tenant's RLS like any other read. */
export async function assemble(tx: TransactionSql, index: Pick<IndexService, 'embedText'>, seed: Seed): Promise<Evidence> {
	const own = await seedSources(tx, seed);
	const threads = own.filter((s) => s.kind === 'thread').map((s) => s.id), notes = own.filter((s) => s.kind === 'note').map((s) => s.id);
	const text = await seedText(tx, seed, threads, notes);
	const found: Found[] = own.map((s) => ({ ...s, why: 'seed', score: 2 }));
	const embedded = await index.embedText(text);
	if (embedded) for (const near of await similar(tx, embedded.vector, embedded.id, { limit: MAX_CANDIDATES, minScore: MIN_SIMILARITY })) found.push({ kind: near.kind, id: near.id, why: 'similar', score: near.score });
	// Widening from the seed's own threads and notes, within the window.
	const [when] = threads.length ? await tx`select min(last_message_at) as first, max(last_message_at) as last from mail_threads where id = any(${tx.array(threads)}::uuid[])`
		: notes.length ? await tx`select min(updated_at) as first, max(updated_at) as last from notes where id = any(${tx.array(notes)}::uuid[])` : [];
	const first = when?.first ? new Date(new Date(when.first as string).getTime() - WINDOW_DAYS * 86_400_000) : null, last = when?.last ? new Date(new Date(when.last as string).getTime() + WINDOW_DAYS * 86_400_000) : null;
	if (threads.length && first && last) {
		const messages = await tx`select from_header, rfc_message_id, in_reply_to, subject from mail_messages where thread_id = any(${tx.array(threads)}::uuid[])`;
		const senders = [...new Set(messages.flatMap((m) => addresses(String(m.fromHeader)).map((a) => a.email)))];
		const companies = (await tx`select distinct company_id from contacts where email = any(${tx.array(senders)}::text[]) and company_id is not null`).map((c) => String(c.companyId));
		const rfcs = messages.map((m) => String(m.rfcMessageId)).filter(Boolean), replies = messages.map((m) => String(m.inReplyTo)).filter(Boolean);
		const subjects = [...new Set(messages.map((m) => normalSubject(String(m.subject))).filter(Boolean))];
		const references = (await tx`select facts->'references' as refs from mail_triage where thread_id = any(${tx.array(threads)}::uuid[])`).flatMap((r) => (r.refs as string[]) ?? []).filter((r) => r.length >= 3);
		const widened = await tx`select distinct t.id, case
				when ${companies.length > 0} and exists (select 1 from mail_messages m join contacts c on c.organisation_id = m.organisation_id and c.company_id = any(${tx.array(companies)}::uuid[]) where m.thread_id = t.id and position(c.email in lower(m.from_header)) > 0) then 'company'
				when ${references.length > 0} and exists (select 1 from mail_triage mt where mt.thread_id = t.id and mt.facts->'references' ?| ${tx.array(references)}::text[]) then 'reference'
				when exists (select 1 from mail_messages m where m.thread_id = t.id and (m.in_reply_to = any(${tx.array(rfcs)}::text[]) or m.rfc_message_id = any(${tx.array(replies)}::text[]))) then 'reply'
				when exists (select 1 from mail_messages m where m.thread_id = t.id and lower(regexp_replace(m.subject, '^\\s*((re|fwd?|fw)\\s*:\\s*)+', '', 'i')) = any(${tx.array(subjects)}::text[])) then 'subject'
				else null end as why
			from mail_threads t where t.id <> all(${tx.array(threads)}::uuid[]) and t.last_message_at between ${first} and ${last}`;
		for (const w of widened) if (w.why) found.push({ kind: 'thread', id: String(w.id), why: String(w.why), score: 1 });
		if (companies.length) for (const n of await tx`select id from notes where archived_at is null and company_id = any(${tx.array(companies)}::uuid[]) and updated_at between ${first} and ${last}`) found.push({ kind: 'note', id: String(n.id), why: 'company', score: 1 });
	}
	if (notes.length && first && last) {
		const linked = await tx`select distinct n.id from notes n join notes s on s.id = any(${tx.array(notes)}::uuid[]) and n.organisation_id = s.organisation_id
			where n.archived_at is null and n.id <> s.id and n.updated_at between ${first} and ${last}
			and ((n.event_id is not null and n.event_id = s.event_id) or (n.company_id is not null and n.company_id = s.company_id) or (n.project_id is not null and n.project_id = s.project_id) or (n.task_id is not null and n.task_id = s.task_id))`;
		for (const n of linked) found.push({ kind: 'note', id: String(n.id), why: 'linked', score: 1 });
	}
	// Merge: the seed's sources, then by similarity, then widened; one entry per thread or note, at most fifty.
	const merged = new Map<string, { kind: 'thread' | 'note'; id: string; why: string[]; score: number }>();
	for (const f of found.sort((a, b) => b.score - a.score)) {
		const key = `${f.kind}:${f.id}`; const have = merged.get(key);
		if (have) { if (!have.why.includes(f.why)) have.why.push(f.why); } else merged.set(key, { kind: f.kind, id: f.id, why: [f.why], score: f.score });
	}
	const chosen = [...merged.values()].slice(0, MAX_CANDIDATES);
	const candidates = await describe(tx, chosen);
	return { seed: { kind: seed.kind, name: seed.name, reason: seed.reason, text: text.slice(0, 2000) }, candidates, indexed: embedded !== null };
}
/** The threads and notes a seed stands on. */
async function seedSources(tx: TransactionSql, seed: Seed): Promise<{ kind: 'thread' | 'note'; id: string }[]> {
	if (seed.kind === 'candidate') {
		const rows = await tx`select source_kind, source_id from project_candidate_sources where normalised = ${seed.key} order by seen_at limit 10`;
		return rows.map((r) => ({ kind: r.sourceKind === 'note' ? 'note' as const : 'thread' as const, id: String(r.sourceId) }));
	}
	if (seed.kind === 'tasks') {
		const rows = await tx`select distinct t.source_id from tasks t join projects p on p.organisation_id = t.organisation_id and p.id = t.project_id
			where p.system_kind = 'obligations' and t.source_kind = 'mail' and t.parent_id is null and t.body = ${seed.name ?? ''} limit 10`;
		return rows.map((r) => ({ kind: 'thread' as const, id: String(r.sourceId) }));
	}
	return seed.sourceId ? [{ kind: seed.sourceKind === 'note' ? 'note' : 'thread', id: seed.sourceId }] : [];
}
/** What is embedded to find neighbours: the seed's name and the gist of its sources, in the index's own unit style. */
async function seedText(tx: TransactionSql, seed: Seed, threads: string[], notes: string[]): Promise<string> {
	const parts: string[] = seed.name ? [seed.name] : [];
	if (threads.length) for (const m of await tx`select distinct on (thread_id) subject, body from mail_messages where thread_id = any(${tx.array(threads)}::uuid[]) order by thread_id, sent_at desc`) parts.push(`${String(m.subject)}\n${ownText(String(m.body)).slice(0, 600)}`);
	if (notes.length) for (const n of await tx`select title, body from notes where id = any(${tx.array(notes)}::uuid[])`) parts.push(`${String(n.title)}\n${String(n.body).slice(0, 600)}`);
	return parts.join('\n\n').slice(0, 4000);
}
/** Each candidate trimmed for the model: a thread's subject, counterparty and last three messages' own text; a note's title and body. */
async function describe(tx: TransactionSql, chosen: { kind: 'thread' | 'note'; id: string; why: string[] }[]): Promise<Candidate[]> {
	const threadIds = chosen.filter((c) => c.kind === 'thread').map((c) => c.id), noteIds = chosen.filter((c) => c.kind === 'note').map((c) => c.id);
	const messages = threadIds.length ? await tx`select thread_id, from_header, subject, body, sent_at, label_ids from mail_messages where thread_id = any(${tx.array(threadIds)}::uuid[]) order by thread_id, sent_at desc` : [];
	const notes = noteIds.length ? await tx`select id, title, body, updated_at from notes where id = any(${tx.array(noteIds)}::uuid[])` : [];
	const byThread = new Map<string, (typeof messages)[number][]>(); for (const m of messages) byThread.set(String(m.threadId), [...(byThread.get(String(m.threadId)) ?? []), m]);
	return chosen.map((c, i): Candidate | null => {
		const id = `c${i + 1}`;
		if (c.kind === 'note') {
			const n = notes.find((row) => String(row.id) === c.id); if (!n) return null;
			return { id, kind: 'note', sourceId: c.id, title: String(n.title).slice(0, 200), date: new Date(n.updatedAt as string).toISOString().slice(0, 10), counterparty: null, text: String(n.body).slice(0, 1200), why: c.why };
		}
		const rows = byThread.get(c.id); if (!rows?.length) return null;
		const latest = rows[0]!; const counterparty = rows.find((m) => !(m.labelIds as string[]).includes('SENT'));
		const text = rows.slice(0, 3).reverse().map((m, j, all) => `${(m.labelIds as string[]).includes('SENT') ? 'us' : addresses(String(m.fromHeader))[0]?.email ?? 'them'}: ${ownText(String(m.body)).slice(0, j === all.length - 1 ? 800 : 300)}`).join('\n');
		return { id, kind: 'thread', sourceId: c.id, title: String(latest.subject).slice(0, 200), date: new Date(latest.sentAt as string).toISOString().slice(0, 10),
			counterparty: counterparty ? (addresses(String(counterparty.fromHeader))[0]?.name || addresses(String(counterparty.fromHeader))[0]?.email || null) : null, text, why: c.why };
	}).filter((c): c is Candidate => c !== null);
}
