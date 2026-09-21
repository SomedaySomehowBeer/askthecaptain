import { createHash } from 'node:crypto';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { EmbedUnavailable, MAX_UNITS_PER_REQUEST, chunk, encoderTag, mean, messageUnit, noteUnit, parseVector, quotedText, threadWeight, toSql, weightedMean, type EmbedClient, type EncoderId } from '@captain/retrieval';
import { ownText } from '../triage/text.ts';
export type FillResult = { messages: number; notes: number; threads: number; unavailable: boolean };
export type FillOptions = { budget?: number; messages?: boolean; notes?: boolean };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type PendingMessage = { id: string; threadId: string; subject: string; body: string; parentId: string | null; parentBody: string | null };
type PendingNote = { id: string; title: string; body: string; linked: (string | null)[]; digest: string | null };
type Planned = { kind: 'mail_message' | 'note'; id: string; digest: string; tokens: number; chunks: string[]; vectors: number[][]; inherited: boolean };
/** The retrieval index (D21): embeds what mail sync and notes saved, outside their transactions, and fills what an
 *  outage left behind on the hourly tick. Housekeeping, never a workflow; a service that is down leaves rows
 *  unembedded and this returns `unavailable`. Text is read under the tenant's RLS and never logged. */
export class IndexService {
	readonly #db: Sql; readonly #client: EmbedClient | null; readonly #running = new Set<string>();
	constructor(db: Sql, client: EmbedClient | null) { this.#db = db; this.#client = client; }
	get available(): boolean { return this.#client !== null; }
	async organisations(): Promise<string[]> {
		return (await this.#db<{ organisationId: string }[]>`select organisation_id from index_organisations()`).map((row) => String(row.organisationId));
	}
	run(organisationId: string) { return this.fill(organisationId, { budget: 4096 }); }
	/** One text embedded with the live encoder, for a discovery seed; null when the service is absent or down. */
	async embedText(text: string): Promise<{ vector: number[]; id: EncoderId } | null> {
		if (!this.#client) return null;
		try {
			const id = await this.#client.identity(); const { vectors } = await this.#client.embed([text.slice(0, 8000)]);
			return vectors[0] ? { vector: vectors[0], id: { encoder: id.encoder, version: id.version } } : null;
		} catch (error) { if (error instanceof EmbedUnavailable) return null; throw error; }
	}
	/** Embeds up to `budget` units for the organisation: messages oldest first (parents before the replies that
	 *  inherit them), then notes new or edited since they were embedded. Each page commits on its own. A note's
	 *  save hook asks for notes only, so a mail backlog cannot starve it. */
	async fill(organisationId: string, { budget = 512, messages = true, notes = true }: FillOptions = {}): Promise<FillResult> {
		const result: FillResult = { messages: 0, notes: 0, threads: 0, unavailable: false };
		if (!this.#client || this.#running.has(organisationId)) return { ...result, unavailable: !this.#client };
		this.#running.add(organisationId);
		try {
			const id = await this.#client.identity();
			let left = budget;
			while (messages && left > 0) {
				const page = await withTenant(this.#db, { organisationId }, (tx) => this.#messages(tx, id, Math.min(left, MAX_UNITS_PER_REQUEST)));
				if (page.messages === 0) break;
				result.messages += page.messages; result.threads += page.threads; left -= page.units;
			}
			while (notes && left > 0) {
				const page = await withTenant(this.#db, { organisationId }, (tx) => this.#notes(tx, id, Math.min(left, MAX_UNITS_PER_REQUEST)));
				if (page.notes === 0) break;
				result.notes += page.notes; left -= page.units;
			}
		} catch (error) {
			if (!(error instanceof EmbedUnavailable)) throw error;
			result.unavailable = true;
		} finally { this.#running.delete(organisationId); }
		return result;
	}
	async #embed(planned: Planned[]) {
		const texts = planned.flatMap((p) => (p.inherited ? [] : p.chunks));
		let vectors: number[][] = [];
		for (let start = 0; start < texts.length; start += MAX_UNITS_PER_REQUEST) vectors = vectors.concat((await this.#client!.embed(texts.slice(start, start + MAX_UNITS_PER_REQUEST))).vectors);
		let at = 0;
		for (const p of planned) if (!p.inherited) { p.vectors = vectors.slice(at, at + p.chunks.length); at += p.chunks.length; }
	}
	async #messages(tx: TransactionSql, id: EncoderId, limit: number): Promise<{ messages: number; threads: number; units: number }> {
		const rows = await tx<PendingMessage[]>`select m.id, m.thread_id, m.subject, m.body, p.id as parent_id, p.body as parent_body from mail_messages m
			left join lateral (select id, body from mail_messages p where p.organisation_id = m.organisation_id and m.in_reply_to <> '' and p.rfc_message_id = m.in_reply_to and p.id <> m.id order by p.sent_at limit 1) p on true
			where not m.body_unavailable and not exists (select 1 from content_vectors v where v.organisation_id = m.organisation_id and v.source_kind = 'mail_message' and v.source_id = m.id and v.encoder = ${id.encoder} and v.encoder_version = ${id.version})
			order by m.sent_at, m.id limit ${limit}`;
		if (rows.length === 0) return { messages: 0, threads: 0, units: 0 };
		const planned: Planned[] = []; const known = new Map<string, number[]>();
		const parentVector = async (parentId: string) => {
			if (known.has(parentId)) return known.get(parentId)!;
			const chunks = await tx<{ vector: string }[]>`select vector::text from content_vectors where source_kind = 'mail_message' and source_id = ${parentId} and encoder = ${id.encoder} and encoder_version = ${id.version} order by chunk_index`;
			const vector = mean(chunks.map((c) => parseVector(c.vector)!)); if (vector) known.set(parentId, vector); return vector;
		};
		// Messages with their own vector first, so a short reply in the same page finds its parent embedded.
		const replies: { m: PendingMessage; unit: ReturnType<typeof messageUnit> }[] = [];
		const plan = (m: PendingMessage, unit: ReturnType<typeof messageUnit>, inheritedVector: number[] | null) => {
			const chunks = inheritedVector ? [] : chunk(unit.text);
			if (!inheritedVector && chunks.length === 0) chunks.push(m.subject.trim() || '(no subject)');
			planned.push({ kind: 'mail_message', id: String(m.id), digest: digest(unit.text), tokens: unit.ownTokens, chunks, vectors: inheritedVector ? [inheritedVector] : [], inherited: Boolean(inheritedVector) });
		};
		for (const m of rows) {
			const own = ownText(m.body); const parentText = m.parentBody ? ownText(m.parentBody) : undefined;
			const unit = messageUnit({ subject: m.subject, ownText: own, parentText, quotedText: parentText ? undefined : quotedText(m.body) });
			if (unit.inherit && m.parentId) replies.push({ m, unit }); else plan(m, unit, null);
		}
		await this.#embed(planned);
		for (const p of planned) { await this.#store(tx, id, p); known.set(p.id, mean(p.vectors)!); }
		const first = planned.length;
		for (const { m, unit } of replies) plan(m, unit, await parentVector(m.parentId!));
		await this.#embed(planned.slice(first).filter((p) => !p.inherited));
		for (const p of planned.slice(first)) { await this.#store(tx, id, p); known.set(p.id, mean(p.vectors)!); }
		const threads = [...new Set(rows.map((m) => String(m.threadId)))];
		for (const threadId of threads) await this.#thread(tx, id, threadId);
		return { messages: planned.length, threads: threads.length, units: planned.reduce((n, p) => n + Math.max(p.chunks.length, 1), 0) };
	}
	async #notes(tx: TransactionSql, id: EncoderId, limit: number): Promise<{ notes: number; units: number }> {
		const rows = await tx<PendingNote[]>`select n.id, n.title, n.body, array[e.summary, c.name, co.name, p.name, t.title] as linked, v.digest from notes n
			left join calendar_events e on e.organisation_id = n.organisation_id and e.id = n.event_id left join contacts c on c.organisation_id = n.organisation_id and c.id = n.contact_id
			left join companies co on co.organisation_id = n.organisation_id and co.id = n.company_id left join projects p on p.organisation_id = n.organisation_id and p.id = n.project_id
			left join tasks t on t.organisation_id = n.organisation_id and t.id = n.task_id
			left join content_vectors v on v.organisation_id = n.organisation_id and v.source_kind = 'note' and v.source_id = n.id and v.chunk_index = 0 and v.encoder = ${id.encoder} and v.encoder_version = ${id.version}
			where n.archived_at is null and (v.digest is null or n.updated_at > v.embedded_at) order by n.updated_at, n.id limit ${limit}`;
		if (rows.length === 0) return { notes: 0, units: 0 };
		const planned: Planned[] = [];
		for (const n of rows) {
			const unit = noteUnit({ title: n.title, body: n.body, linked: n.linked.map((name) => name ?? '') }); const sum = digest(unit.text);
			// Edited without a change to what is embedded (a link to the same name, say): mark it seen and move on.
			if (sum === n.digest) { await tx`update content_vectors set embedded_at = now() where source_kind = 'note' and source_id = ${n.id} and encoder = ${id.encoder} and encoder_version = ${id.version}`; continue; }
			planned.push({ kind: 'note', id: String(n.id), digest: sum, tokens: unit.tokens, chunks: chunk(unit.text), vectors: [], inherited: false });
		}
		await this.#embed(planned);
		for (const p of planned) { await this.#store(tx, id, p); await tx`update notes set vector = ${toSql(mean(p.vectors)!)}::vector, vector_encoder = ${encoderTag(id)} where id = ${p.id}`; }
		return { notes: rows.length, units: planned.reduce((n, p) => n + p.chunks.length, 0) };
	}
	async #store(tx: TransactionSql, id: EncoderId, p: Planned) {
		for (const [index, vector] of p.vectors.entries()) await tx`insert into content_vectors (organisation_id, source_kind, source_id, chunk_index, encoder, encoder_version, digest, tokens, inherited, vector)
			values (current_organisation_id(), ${p.kind}, ${p.id}, ${index}, ${id.encoder}, ${id.version}, ${p.digest}, ${p.tokens}, ${p.inherited}, ${toSql(vector)}::vector)
			on conflict (organisation_id, source_kind, source_id, chunk_index) do update set encoder = excluded.encoder, encoder_version = excluded.encoder_version, digest = excluded.digest, tokens = excluded.tokens, inherited = excluded.inherited, vector = excluded.vector, embedded_at = now()`;
		await tx`delete from content_vectors where source_kind = ${p.kind} and source_id = ${p.id} and chunk_index >= ${p.vectors.length}`;
	}
	/** The thread vector: the mean of its message vectors weighted by min(1, tokens ÷ 300). */
	async #thread(tx: TransactionSql, id: EncoderId, threadId: string) {
		const rows = await tx<{ sourceId: string; tokens: number; vector: string }[]>`select v.source_id, v.tokens, v.vector::text from content_vectors v join mail_messages m on m.organisation_id = v.organisation_id and m.id = v.source_id
			where v.source_kind = 'mail_message' and m.thread_id = ${threadId} and v.encoder = ${id.encoder} and v.encoder_version = ${id.version} order by v.source_id, v.chunk_index`;
		const byMessage = new Map<string, { tokens: number; chunks: number[][] }>();
		for (const row of rows) { const entry = byMessage.get(String(row.sourceId)) ?? { tokens: Number(row.tokens), chunks: [] }; entry.chunks.push(parseVector(row.vector)!); byMessage.set(String(row.sourceId), entry); }
		const vector = weightedMean([...byMessage.values()].map((m) => ({ vector: mean(m.chunks)!, weight: threadWeight(m.tokens) })));
		if (vector) await tx`update mail_threads set vector = ${toSql(vector)}::vector, vector_encoder = ${encoderTag(id)} where id = ${threadId}`;
	}
}
/** Hourly: fills whatever an outage or a cold start left unembedded. */
export function startIndexSchedule(index: Pick<IndexService, 'organisations' | 'run'>, disabled = false, intervalMs = 3_600_000): () => Promise<void> {
	if (disabled) return async () => {};
	let active: Promise<void> | undefined;
	const tick = () => {
		if (active) return;
		active = (async () => { for (const org of await index.organisations()) await index.run(org).catch(() => undefined); })()
			.catch(() => { console.error('[index] Scheduled fill could not reach its database. Check API database connectivity.'); })
			.finally(() => { active = undefined; });
	};
	const timer = setInterval(tick, intervalMs); timer.unref(); tick();
	return async () => { clearInterval(timer); await active; };
}
