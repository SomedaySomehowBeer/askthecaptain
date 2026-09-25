import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { definitions, digestOf, requirementWords, requirementsOf, resolveParameters, type Requirement, type WorkflowDefinition } from '@captain/steps';
import { WorkflowProblem, type BossEngine } from '@captain/engine';
import { audit } from '../audit.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import type { PushService } from '../push/service.ts';
import { canManage, roleOf, type Actor } from '../tenant.ts';

export type Enablement = { id: string; enabled: boolean; enabledBy: string | null; enabledByName: string | null; parameters: Record<string, unknown>; updatedAt: Date; definitionVersion: number };
export type Offered = { definition: WorkflowDefinition; requirements: Requirement[]; unmet: { requirement: Requirement; words: string }[]; enablement: Enablement | null; runnerProblem: string | null };
export type Run = { id: string; definitionKey: string; definitionVersion: number; trigger: unknown; state: string; reason: string | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date };
export type RunStep = { id: string; path: string; itemIndex: number | null; kind: string; key: string; state: string; inputDigest: string | null; output: unknown; error: string | null; startedAt: Date | null; finishedAt: Date | null };

const person = (actor: Actor) => ({ kind: 'person' as const, id: actor.userId });

/** The workflow catalogue and what each organisation has enabled (plan §6, D3, D4). Definitions are
 *  code; this syncs them into the table the API exposes, checks parameters and requirements at
 *  enablement, and reads the journal. Running them is the engine's job (D10), not this service's. */
export class WorkflowService {
	readonly #db: Sql; readonly #push: PushService | null; readonly #engine: BossEngine | null;
	constructor(db: Sql, push: PushService | null = null, engine: BossEngine | null = null) { this.#db = db; this.#push = push; this.#engine = engine; }

	runnerProblem(key: string) { const definition = definitions.find(d => d.key === key); return this.#engine && definition ? this.#engine.unavailable(definition) : 'The workflow runner is stopped. Ask the operator to start it.'; }

	/** Upserts the code-defined catalogue. Called at API start; idempotent. */
	async sync(): Promise<number> {
		for (const definition of definitions) {
			await this.#db`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, requirements, digest)
				values (${definition.key}, ${definition.version}, ${definition.name}, ${definition.description}, ${definition.job}, ${this.#db.json(definition.triggers as never)},
					${this.#db.json(definition.parameters as never)}, ${this.#db.json(definition.steps as never)}, array(select jsonb_array_elements_text(${this.#db.json(requirementsOf(definition))}::jsonb)), ${digestOf(definition)})
				on conflict (key) do update set version = excluded.version, name = excluded.name, description = excluded.description, job = excluded.job, triggers = excluded.triggers,
					parameters = excluded.parameters, steps = excluded.steps, requirements = excluded.requirements, digest = excluded.digest, updated_at = now()
				where workflow_definitions.digest is distinct from excluded.digest`;
		}
		return definitions.length;
	}

	async list(actor: Actor, organisationId: string): Promise<Offered[]> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const enablements = await tx<(Enablement & { definitionKey: string })[]>`select e.id, e.definition_key, e.definition_version, e.enabled, e.enabled_by, u.name as enabled_by_name, e.parameters, e.updated_at
				from workflow_enablements e left join users u on u.id = e.enabled_by where e.organisation_id = ${organisationId}`;
			const available = await this.#available(tx, organisationId);
			return Promise.all(definitions.map(async (definition) => {
				const found = enablements.find((e) => e.definitionKey === definition.key);
				const personal = new Set(available);
				if (['chase-due', 'stocktake'].includes(definition.key) && !await this.#push?.available(tx, organisationId, found?.enabled ? found.enabledBy ?? actor.userId : actor.userId)) personal.delete('push');
				const requirements = requirementsOf(definition);
				const unmet = requirements.filter((r) => !personal.has(r)).map((requirement) => ({ requirement, words: requirementWords[requirement] }));
				const enablement = found ? { id: found.id, enabled: found.enabled, enabledBy: found.enabledBy, enabledByName: found.enabledByName, parameters: found.parameters, updatedAt: found.updatedAt, definitionVersion: found.definitionVersion } : null;
				return { definition, requirements, unmet, enablement, runnerProblem: this.#engine?.unavailable(definition) ?? (this.#engine ? null : 'The workflow runner is stopped. Ask the operator to start it.') };
			}));
		});
	}

	/** Enabling is the authorisation (plan §3): the workflow acts in this person's name from now on. */
	async enable(actor: Actor, organisationId: string, key: string, input: { enabled: boolean; parameters?: Record<string, unknown> }): Promise<Enablement> {
		const role = await roleOf(this.#db, actor.userId, organisationId);
		if (!canManage(role)) throw forbidden('only an owner or admin can enable workflows');
		const definition = definitions.find((d) => d.key === key);
		if (!definition) throw notFound('that workflow does not exist');
		const resolved = resolveParameters(definition.parameters, input.parameters ?? {});
		if (resolved.problems.length) throw badRequest('parameters_invalid', resolved.problems.map((p) => `${p.path} ${p.message}`).join('; '));
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [member] = await tx`select role from memberships where user_id = ${actor.userId} and organisation_id = ${organisationId} and status = 'active' for share`;
			if (!member || member.role === 'member') throw forbidden();
			if (input.enabled) {
				if (this.#engine) { const problem = this.#engine.unavailable(definition); if (problem) throw badRequest('runner_unavailable', problem); }
				const available = await this.#available(tx, organisationId);
				if (['chase-due', 'stocktake'].includes(key) && !await this.#push?.available(tx, organisationId, actor.userId)) available.delete('push');
				const unmet = requirementsOf(definition).filter((r) => !available.has(r));
				if (unmet.length) throw badRequest('requirements_unmet', `${definition.name} needs ${unmet.map((r) => requirementWords[r]).join(' and ')} before it can run`);
			}
			const [row] = await tx<{ id: string; enabled: boolean; enabledBy: string | null; parameters: Record<string, unknown>; updatedAt: Date; definitionVersion: number }[]>`
				insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, enabled_by, parameters)
				values (${organisationId}, ${key}, ${definition.version}, ${input.enabled}, ${actor.userId}, ${tx.json(resolved.values as never)})
				on conflict (organisation_id, definition_key) do update set enabled = excluded.enabled, enabled_by = excluded.enabled_by, parameters = excluded.parameters,
					definition_version = excluded.definition_version, updated_at = now()
				returning id, enabled, enabled_by, parameters, updated_at, definition_version`;
			await audit(tx, { organisationId, actor: person(actor), action: input.enabled ? 'workflow.enabled' : 'workflow.disabled', subjectType: 'workflow_enablement', subjectId: row!.id, requestId: actor.requestId, detail: { key, parameters: resolved.values } });
			if (this.#engine) await this.#engine.configure(tx, organisationId, row!.id, key);
			const [user] = await tx<{ name: string }[]>`select name from users where id = ${actor.userId}`;
			return { ...row!, enabledByName: user?.name ?? null };
		});
	}

 async control(actor: Actor, organisationId: string, keyOrId: string, action: 'run' | 'resume' | 'cancel', parameters?: Record<string, unknown>) {
  if (!canManage(await roleOf(this.#db, actor.userId, organisationId))) throw forbidden('Only an owner or admin can run, resume or cancel workflows.');
  if (!this.#engine) throw badRequest('runner_unavailable', 'The workflow runner is stopped. Ask the operator to start it.');
  return withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
   // Role is checked again in the write transaction, including concurrent membership removal.
   const [member] = await tx`select role from memberships where user_id = ${actor.userId} and organisation_id = ${organisationId} and status = 'active' for share`;
   if (!member || member.role === 'member') throw forbidden();
   let runId = keyOrId;
   if (action === 'run') runId = await this.#engine!.start(tx, organisationId, keyOrId, { kind: 'manual' }, parameters);
   else { const [run] = await tx`select id from workflow_runs where id = ${keyOrId}`; if (!run) throw notFound(); await this.#engine!.control(tx, organisationId, keyOrId, action); }
   await audit(tx, { organisationId, actor: person(actor), action: `workflow.${action}_requested`, subjectType: 'workflow_run', subjectId: runId, requestId: actor.requestId });
   return { runId };
  }).catch(error => { if (error instanceof WorkflowProblem) throw badRequest('workflow_unavailable', error.message); throw error; });
 }

	async runs(actor: Actor, organisationId: string, options: { key?: string; limit?: number } = {}): Promise<Run[]> {
		await roleOf(this.#db, actor.userId, organisationId);
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, (tx) => tx<Run[]>`select id, definition_key, definition_version, trigger, state, reason, started_at, finished_at, created_at
			from workflow_runs where organisation_id = ${organisationId} and (${options.key ?? null}::text is null or definition_key = ${options.key ?? null}) order by created_at desc limit ${limit}`);
	}

	async run(actor: Actor, organisationId: string, runId: string): Promise<Run & { steps: RunStep[] }> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [run] = await tx<Run[]>`select id, definition_key, definition_version, trigger, state, reason, started_at, finished_at, created_at from workflow_runs where id = ${runId} and organisation_id = ${organisationId}`;
			if (!run) throw notFound('that run does not exist');
			const steps = await tx<RunStep[]>`select id, path, item_index, kind, key, state, input_digest, output, error, started_at, finished_at from workflow_run_steps
				where organisation_id = ${organisationId} and run_id = ${runId} order by started_at nulls last, path, item_index`;
			return { ...run, steps };
		});
	}

	/** What this organisation can offer a workflow today: connected providers, a ready inference
	 *  runtime, and a device subscribed to push. A workflow that needs something missing says so
	 *  instead of pretending to run. */
	async #available(tx: TransactionSql, organisationId: string): Promise<Set<Requirement>> {
		const available = new Set<Requirement>();
		const connections = await tx<{ provider: string }[]>`select provider from connections where organisation_id = ${organisationId} and status = 'connected'`;
		for (const c of connections) if (c.provider === 'xero' || c.provider === 'shopify') available.add(`connection:${c.provider}` as Requirement);
		const [runtime] = await tx<{ status: string }[]>`select status from inference_runtimes where organisation_id = ${organisationId}`;
		if (runtime?.status === 'ready') available.add('inference');
		if (this.#push && (await this.#push.available(tx, organisationId))) available.add('push');
		return available;
	}
}
