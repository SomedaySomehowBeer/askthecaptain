import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import type { Registry } from '@captain/engine';
import { discoverProjectInstruction } from '@captain/steps';
import { audit } from '../audit.ts';
import { badRequest, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import type { InferenceService } from '../inference/service.ts';
import type { IndexService } from '../retrieval/service.ts';
import type { PushService } from '../push/service.ts';
import { journal, normaliseProjectName, type Context } from '../triage/data.ts';
import { suggestFrom } from '../commitments/triage.ts';
import { addresses } from '../contacts/addresses.ts';
import { discoverySchema, type Candidate, type Discovery, type Evidence, type Seed } from './data.ts';
import { assemble } from './evidence.ts';
import { findSeeds, THRESHOLDS } from './thresholds.ts';
type Emit = (tx: TransactionSql, organisationId: string, event: string, data: unknown) => Promise<unknown>;
const toSeed = (r: Record<string, unknown>): Seed => ({ id: String(r.id), kind: r.kind as Seed['kind'], key: String(r.key), reason: String(r.reason), name: r.name ? String(r.name) : null,
	sourceKind: (r.sourceKind as Seed['sourceKind']) ?? null, sourceId: r.sourceId ? String(r.sourceId) : null });
/** Discovery (D22): Captain proposes projects from evidence and a person makes them real. The workflow's steps live here
 *  with the person's three actions: ask for a thread or note to be looked at, accept a proposal, discard it. */
export class DiscoveryService {
	readonly #db: Sql; readonly #inference: InferenceService; readonly #index: Pick<IndexService, 'embedText'>; readonly #push: PushService | null; readonly #emit: Emit | null;
	constructor(db: Sql, inference: InferenceService, index: Pick<IndexService, 'embedText'>, push: PushService | null = null, emit: Emit | null = null) { this.#db = db; this.#inference = inference; this.#index = index; this.#push = push; this.#emit = emit; }
	register(registry: Registry): Registry {
		registry.registerStep('discovery.seeds', { kind: 'read', transaction: async (ctx) => {
			await findSeeds(ctx.tx, ctx.organisationId);
			// A person's request runs first; a seed claimed by this run stays claimed if the run fails, so it is never repeated blindly.
			const rows = await ctx.tx`update discovery_seeds set state = 'running', run_id = ${ctx.runId} where id in (select id from discovery_seeds where state = 'pending' order by requested_by is null, created_at limit ${THRESHOLDS.maxSeeds}) returning id, kind, key, reason, name, source_kind, source_id, requested_by, created_at`;
			rows.sort((a, b) => Number(!a.requestedBy) - Number(!b.requestedBy) || new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime() || String(a.id).localeCompare(String(b.id)));
			const candidates = rows.filter((r) => r.kind === 'candidate').map((r) => String(r.key));
			if (candidates.length) await ctx.tx`update project_candidates set seeded_at = now() where normalised = any(${ctx.tx.array(candidates)}::text[])`;
			return rows.map(toSeed);
		} });
		registry.registerStep('discovery.evidence', { kind: 'read', transaction: (ctx, args) => assemble(ctx.tx, this.#index, args.seed as Seed) });
		registry.registerStep('discoverProject', { kind: 'infer', retrySafe: true, call: (ctx, args) => {
			const evidence = args.evidence as Evidence;
			return this.#inference.infer({ userId: ctx.userId, requestId: ctx.runId }, { organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'large', instruction: discoverProjectInstruction, schema: discoverySchema,
				input: { seed: evidence.seed, indexed: evidence.indexed, untrustedEvidence: evidence.candidates.map(({ why: _why, ...c }) => c) } });
		} });
		registry.registerStep('discovery.record', { kind: 'write', transaction: (ctx, args) => this.record(ctx, args.seed as Seed, args.evidence as Evidence, discoverySchema.parse(args.answer)) });
		registry.registerStep('discovery.notify', { kind: 'notify', retrySafe: true, call: async (ctx) => {
			const proposed = await withTenant(this.#db, { organisationId: ctx.organisationId, userId: ctx.userId }, (tx) => tx`select name from projects where proposed_by = ${ctx.runId} order by name`);
			if (!proposed.length || !this.#push) return { sent: 0, proposed: proposed.length };
			const names = proposed.map((p) => String(p.name)); const title = proposed.length === 1 ? `Captain proposes a project: ${names[0]}` : `Captain proposes ${proposed.length} projects`;
			const deliveries = await this.#push.send(ctx.organisationId, ctx.userId, { title: title.slice(0, 120), body: 'Open Commitments to accept or discard.', url: '/commitments', tag: ctx.idempotencyKey }, { runId: ctx.runId, actor: { userId: ctx.userId, requestId: ctx.runId } });
			return { sent: deliveries.filter((d) => d.state === 'sent').length, proposed: proposed.length };
		} });
		return registry;
	}
	/** Writes what the model decided, using only ids from this call's candidates; anything else is dropped, never guessed. */
	async record(ctx: Context, seed: Seed, evidence: Evidence, answer: Discovery) {
		const { tx } = ctx; const known = new Map(evidence.candidates.map((c) => [c.id, c]));
		const cite = (id: string | null) => { const c = id ? known.get(id) : undefined; return c ? { kind: c.kind === 'thread' ? 'mail_thread' as const : 'note' as const, id: c.sourceId } : null; };
		const belongs = [...new Map([...answer.belongs].map((id) => [id, known.get(id)]).filter((e): e is [string, Candidate] => !!e[1])).values()];
		let outcome: Discovery['kind'] = answer.kind, projectId: string | null = null;
		const name = answer.name?.trim() ?? '';
		if (answer.kind === 'project' && name) {
			const brief = Object.fromEntries((['what', 'standing', 'people', 'questions'] as const).map((k) => [k, answer.brief[k].map((l) => ({ text: l.text, evidence: cite(l.evidence) }))]));
			const [project] = await tx`insert into projects (organisation_id, name, description, stage, brief, brief_updated_at, brief_run_id, proposed_at, proposed_by, created_by)
				values (${ctx.organisationId}, ${name.slice(0, 200)}, ${(answer.description ?? '').slice(0, 2000)}, ${answer.stage ?? 'underway'}, ${tx.json(brief as never)}, now(), ${ctx.runId}, now(), ${ctx.runId}, ${ctx.userId}) returning id`;
			projectId = String(project!.id);
			for (const c of belongs) await tx`insert into project_sources (organisation_id, project_id, source_kind, source_id, linked_by, linked_by_id) values (${ctx.organisationId}, ${projectId}, ${c.kind === 'thread' ? 'mail_thread' : 'note'}, ${c.sourceId}, 'model', ${ctx.runId}) on conflict do nothing`;
			for (const task of answer.tasks) {
				const [row] = await tx`insert into tasks (organisation_id, project_id, title, body, due, status, source_kind, source_id, created_by) values (${ctx.organisationId}, ${projectId}, ${task.title}, ${task.reference}, ${task.due}::date, 'suggested', 'run', ${ctx.runId}, ${ctx.userId}) returning id`;
				for (const step of task.steps) await tx`insert into tasks (organisation_id, project_id, parent_id, title, body, status, source_kind, source_id, created_by) values (${ctx.organisationId}, ${projectId}, ${row!.id}, ${step}, '', 'suggested', 'run', ${ctx.runId}, ${ctx.userId})`;
				const ev = cite(task.evidence);
				if (ev) await tx`insert into evidence (organisation_id, task_id, kind, reference, label) values (${ctx.organisationId}, ${row!.id}, ${ev.kind === 'mail_thread' ? 'mail' : 'note'}, ${ev.id}, ${(known.get(task.evidence!)?.title ?? '').slice(0, 200)})`;
			}
			await journal(ctx, 'project.proposed', 'project', projectId, { seed: seed.kind, reason: seed.reason, sources: belongs.length, tasks: answer.tasks.length });
		} else if (answer.kind === 'task' && answer.tasks[0]) {
			// One suggested task with its steps, in the seed's linked project or Obligations, from the seed's own thread or note.
			const source = seed.sourceKind && seed.sourceId ? { kind: seed.sourceKind === 'note' ? 'note' as const : 'mail' as const, id: seed.sourceId } : belongs[0] ? { kind: belongs[0].kind === 'note' ? 'note' as const : 'mail' as const, id: belongs[0].sourceId } : null;
			if (source) {
				const [linked] = await tx`select project_id from project_sources where source_kind = ${source.kind === 'mail' ? 'mail_thread' : 'note'} and source_id = ${source.id} order by created_at limit 1`;
				const { evidence: _e, ...task } = answer.tasks[0];
				await suggestFrom(ctx, source, [task], linked ? String(linked.projectId) : null);
			} else outcome = 'nothing';
		} else if (answer.kind === 'relationship') {
			// A relationship links the company and creates nothing: the counterparty's company from the seed's threads.
			const sender = evidence.candidates.find((c) => c.kind === 'thread' && c.why.includes('seed')); let companyId: string | null = null;
			if (sender) {
				const [contact] = await tx`select c.company_id from mail_messages m join contacts c on c.organisation_id = m.organisation_id and position(c.email in lower(m.from_header)) > 0
					where m.thread_id = ${sender.sourceId} and not ('SENT' = any(m.label_ids)) and c.company_id is not null order by m.sent_at desc limit 1`;
				companyId = contact?.companyId ? String(contact.companyId) : null;
			}
			await journal(ctx, 'discovery.relationship', seed.sourceKind ?? 'discovery_seed', seed.sourceId ?? seed.id, { companyId, sources: belongs.length });
		} else if (answer.kind !== 'nothing') outcome = 'nothing';
		if (outcome === 'nothing') await journal(ctx, 'discovery.nothing', 'discovery_seed', seed.id, { reason: seed.reason, sources: belongs.length });
		await tx`update discovery_seeds set state = 'done', outcome = ${outcome}, project_id = ${projectId}, finished_at = now() where id = ${seed.id}`;
		return { outcome, projectId };
	}
	/** Make this a project: a person chooses a thread or note; the next run starts from it. */
	async request(actor: Actor, organisationId: string, source: { kind: 'mail_thread' | 'note'; id: string }) {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [row] = source.kind === 'note' ? await tx`select id from notes where id = ${source.id} and archived_at is null` : await tx`select id from mail_threads where id = ${source.id}`;
			if (!row) throw notFound(source.kind === 'note' ? 'That note is not here.' : 'That mail thread is not available.');
			const [seed] = await tx`insert into discovery_seeds (organisation_id, kind, key, reason, source_kind, source_id, requested_by) values (${organisationId}, ${source.kind === 'note' ? 'note' : 'thread'}, ${source.id}, 'person', ${source.kind}, ${source.id}, ${actor.userId})
				on conflict do nothing returning id`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'discovery.requested', subjectType: source.kind, subjectId: source.id, requestId: actor.requestId, detail: { queued: !!seed } });
			if (seed) await this.#emit?.(tx, organisationId, 'discovery.requested', { seedId: String(seed.id) });
			return { queued: !!seed };
		});
	}
	/** Accepting sets the proposal active and its suggested tasks open; discarding archives it and closes its candidate. */
	async decide(actor: Actor, organisationId: string, projectId: string, decision: 'accept' | 'discard') {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [project] = await tx`select id, name, state from projects where id = ${projectId} for update`;
			if (!project) throw notFound('that project does not exist');
			if (project.state !== 'proposed') throw badRequest('not_proposed', 'only a proposed project can be accepted or discarded');
			if (decision === 'accept') {
				await tx`update projects set accepted_at = now(), accepted_by = ${actor.userId}, updated_at = now() where id = ${projectId}`;
				await tx`update tasks set status = 'open', updated_at = now() where project_id = ${projectId} and status = 'suggested' and source_kind = 'run'`;
			} else {
				await tx`update projects set archived_at = now(), updated_at = now() where id = ${projectId}`;
				await tx`update tasks set status = 'cancelled', updated_at = now() where project_id = ${projectId} and status = 'suggested'`;
				const normalised = normaliseProjectName(String(project.name)); if (normalised) await tx`update project_candidates set closed_at = now() where normalised = ${normalised}`;
			}
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: decision === 'accept' ? 'project.accepted' : 'project.discarded', subjectType: 'project', subjectId: projectId, requestId: actor.requestId });
			return { projectId, state: decision === 'accept' ? 'active' : 'archived' };
		});
	}
}
