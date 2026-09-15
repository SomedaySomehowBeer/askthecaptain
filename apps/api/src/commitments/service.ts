import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { badRequest, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { dueFor, monthsPerPeriod, nextPeriod, periodContaining, titleFor, todayIn, type Recurrence, type SeriesRule } from './series.ts';

export type TaskStatus = 'suggested' | 'open' | 'in_progress' | 'done' | 'cancelled';
export type Project = { id: string; name: string; description: string; stages: string[]; ownerId: string | null; systemKind: 'obligations' | null;
	archivedAt: Date | null; createdAt: Date; updatedAt: Date };
export type Task = { id: string; projectId: string; title: string; body: string; status: TaskStatus; ownerId: string | null; ownerName: string | null;
	due: string | null; sourceKind: 'person' | 'mail' | 'series' | 'run'; sourceId: string | null; seriesId: string | null; periodStart: string | null;
	periodEnd: string | null; evidenceRequired: boolean; completedBy: string | null; completedAt: Date | null; createdAt: Date; updatedAt: Date; evidence: Evidence[] };
export type Evidence = { id: string; taskId: string; kind: 'mail' | 'file' | 'url'; reference: string; label: string; attachedBy: string | null; attachedAt: Date };
export type Series = { id: string; projectId: string; title: string; body: string; ownerId: string | null; evidenceRequired: boolean; recurrence: Recurrence;
	everyMonths: number | null; anchor: string; dueOffsetDays: number; pausedAt: Date | null; nextDue: string | null; createdAt: Date; updatedAt: Date };
export type Overview = { projects: Project[]; tasks: Task[]; series: Series[]; today: string; timezone: string };

const projectColumns = 'id, name, description, stages, owner_id, system_kind, archived_at, created_at, updated_at';
const seriesColumns = 'id, project_id, title, body, owner_id, evidence_required, recurrence, every_months, anchor::text as anchor, due_offset_days, paused_at, created_at, updated_at';
const taskSelect = `select t.id, t.project_id, t.title, t.body, t.status, t.owner_id, u.name as owner_name, t.due::text as due, t.source_kind, t.source_id, t.series_id,
	t.period_start::text as period_start, t.period_end::text as period_end, coalesce(s.evidence_required, false) as evidence_required, t.completed_by, t.completed_at, t.created_at, t.updated_at
	from tasks t left join users u on u.id = t.owner_id left join task_series s on s.id = t.series_id`;
const statuses: TaskStatus[] = ['suggested', 'open', 'in_progress', 'done', 'cancelled'];
const person = (actor: Actor) => ({ kind: 'person' as const, id: actor.userId });

/** Projects, tasks, series and evidence: the one list the rest of the product reads (D7). Any active
 *  member may use it; the database keeps it inside the tenant and every write is audited. */
export class CommitmentsService {
	readonly #db: Sql;
	constructor(db: Sql) { this.#db = db; }

	/** Everything the Commitments tab shows. Reading keeps one thing honest: the Obligations project
	 *  exists. Occurrences of series are created by the materialise-series routine (routine.ts) on its
	 *  schedule, and when a series is created or edited, never as a side effect of reading. */
	async overview(actor: Actor, organisationId: string): Promise<Overview> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const timezone = await this.#timezone(tx, organisationId);
			const today = todayIn(timezone);
			await this.#ensureObligations(tx, organisationId, actor);
			const projects = await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where organisation_id = ${organisationId}
				order by system_kind is null, archived_at is not null, name`;
			const tasks = await this.#tasks(tx, organisationId, tx`t.status <> 'cancelled'`);
			const series = await this.#series(tx, organisationId, today);
			return { projects, tasks, series, today, timezone };
		});
	}

	async createProject(actor: Actor, organisationId: string, input: { name: string; description?: string; stages?: string[]; ownerId?: string | null }): Promise<Project> {
		await roleOf(this.#db, actor.userId, organisationId);
		const name = input.name.trim(); if (!name) throw badRequest('name_required', 'the project needs a name');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const [project] = await tx<Project[]>`insert into projects (organisation_id, name, description, stages, owner_id, created_by)
				values (${organisationId}, ${name}, ${input.description?.trim() ?? ''}, ${tx.array(input.stages?.map((s) => s.trim()).filter(Boolean) ?? [])}, ${input.ownerId ?? null}, ${actor.userId})
				returning ${tx.unsafe(projectColumns)}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'project.created', subjectType: 'project', subjectId: project!.id, requestId: actor.requestId, detail: { name } });
			return project!;
		});
	}

	async updateProject(actor: Actor, organisationId: string, projectId: string, input: { name?: string; description?: string; stages?: string[]; ownerId?: string | null; archived?: boolean }): Promise<Project> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.name !== undefined && !input.name.trim()) throw badRequest('name_required', 'the project needs a name');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [current] = await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where id = ${projectId} and organisation_id = ${organisationId}`;
			if (!current) throw notFound('that project does not exist');
			if (current.systemKind && input.archived) throw badRequest('system_project', 'the Obligations project cannot be archived');
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const [project] = await tx<Project[]>`update projects set
				name = coalesce(${input.name?.trim() ?? null}, name), description = coalesce(${input.description?.trim() ?? null}, description),
				stages = coalesce(${input.stages ? tx.array(input.stages.map((s) => s.trim()).filter(Boolean)) : null}, stages),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				archived_at = case when ${input.archived === undefined} then archived_at when ${input.archived === true} then coalesce(archived_at, now()) else null end,
				updated_at = now()
				where id = ${projectId} returning ${tx.unsafe(projectColumns)}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'project.updated', subjectType: 'project', subjectId: projectId, requestId: actor.requestId, detail: input });
			return project!;
		});
	}

	async createTask(actor: Actor, organisationId: string, input: { projectId?: string; title: string; body?: string; ownerId?: string | null; due?: string | null; status?: TaskStatus }): Promise<Task> {
		await roleOf(this.#db, actor.userId, organisationId);
		const title = input.title.trim(); if (!title) throw badRequest('title_required', 'the task needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const projectId = input.projectId ?? (await this.#ensureObligations(tx, organisationId, actor));
			await this.#requireProject(tx, organisationId, projectId);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const status = input.status ?? 'open';
			const [row] = await tx<{ id: string }[]>`insert into tasks (organisation_id, project_id, title, body, status, owner_id, due, source_kind, source_id, completed_by, completed_at, created_by)
				values (${organisationId}, ${projectId}, ${title}, ${input.body?.trim() ?? ''}, ${status}, ${input.ownerId ?? null}, ${input.due ?? null}::date, 'person', ${actor.userId},
					${status === 'done' ? actor.userId : null}, ${status === 'done' ? new Date() : null}, ${actor.userId}) returning id`;
			await audit(tx, { organisationId, actor: person(actor), action: 'task.created', subjectType: 'task', subjectId: row!.id, requestId: actor.requestId, detail: { title, projectId, due: input.due ?? null } });
			return (await this.#tasks(tx, organisationId, tx`t.id = ${row!.id}`))[0]!;
		});
	}

	async updateTask(actor: Actor, organisationId: string, taskId: string, input: { projectId?: string; title?: string; body?: string; ownerId?: string | null; due?: string | null; status?: TaskStatus }): Promise<Task> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.title !== undefined && !input.title.trim()) throw badRequest('title_required', 'the task needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [current] = await tx<{ status: TaskStatus; evidenceRequired: boolean; evidenceCount: number }[]>`select t.status, coalesce(s.evidence_required, false) as evidence_required,
				(select count(*) from evidence e where e.task_id = t.id)::int as evidence_count from tasks t left join task_series s on s.id = t.series_id where t.id = ${taskId} and t.organisation_id = ${organisationId}`;
			if (!current) throw notFound('that task does not exist');
			if (input.projectId) await this.#requireProject(tx, organisationId, input.projectId);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const completing = input.status === 'done' && current.status !== 'done';
			if (completing && current.evidenceRequired && current.evidenceCount === 0) throw badRequest('evidence_required', 'this duty needs evidence attached before it counts as done');
			const reopening = input.status !== undefined && input.status !== 'done' && current.status === 'done';
			await tx`update tasks set
				project_id = coalesce(${input.projectId ?? null}::uuid, project_id), title = coalesce(${input.title?.trim() ?? null}, title), body = coalesce(${input.body?.trim() ?? null}, body),
				status = coalesce(${input.status ?? null}, status),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				due = case when ${input.due === undefined} then due else ${input.due ?? null}::date end,
				completed_by = case when ${completing} then ${actor.userId}::uuid when ${reopening} then null else completed_by end,
				completed_at = case when ${completing} then now() when ${reopening} then null else completed_at end,
				updated_at = now()
				where id = ${taskId}`;
			await audit(tx, { organisationId, actor: person(actor), action: completing ? 'task.completed' : 'task.updated', subjectType: 'task', subjectId: taskId, requestId: actor.requestId, detail: input });
			return (await this.#tasks(tx, organisationId, tx`t.id = ${taskId}`))[0]!;
		});
	}

	async createSeries(actor: Actor, organisationId: string, input: { projectId?: string; title: string; body?: string; ownerId?: string | null; evidenceRequired?: boolean;
		recurrence: Recurrence; everyMonths?: number | null; anchor: string; dueOffsetDays?: number }): Promise<Series> {
		await roleOf(this.#db, actor.userId, organisationId);
		const title = input.title.trim(); if (!title) throw badRequest('title_required', 'the series needs a title');
		const rule: SeriesRule = { recurrence: input.recurrence, everyMonths: input.recurrence === 'custom' ? input.everyMonths ?? null : null, anchor: input.anchor, dueOffsetDays: input.dueOffsetDays ?? 0 };
		try { monthsPerPeriod(rule); nextPeriod(rule, rule.anchor); } catch (error) { throw badRequest('recurrence_invalid', error instanceof Error ? error.message : 'the recurrence is not valid'); }
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const projectId = input.projectId ?? (await this.#ensureObligations(tx, organisationId, actor));
			await this.#requireProject(tx, organisationId, projectId);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const [row] = await tx<{ id: string }[]>`insert into task_series (organisation_id, project_id, title, body, owner_id, evidence_required, recurrence, every_months, anchor, due_offset_days, created_by)
				values (${organisationId}, ${projectId}, ${title}, ${input.body?.trim() ?? ''}, ${input.ownerId ?? null}, ${input.evidenceRequired ?? false}, ${rule.recurrence}, ${rule.everyMonths}, ${rule.anchor}::date, ${rule.dueOffsetDays}, ${actor.userId})
				returning id`;
			await audit(tx, { organisationId, actor: person(actor), action: 'series.created', subjectType: 'task_series', subjectId: row!.id, requestId: actor.requestId, detail: { title, projectId, ...rule } });
			const today = await this.#today(tx, organisationId);
			await this.#materialise(tx, organisationId, today, row!.id);
			return (await this.#series(tx, organisationId, today, row!.id))[0]!;
		});
	}

	async updateSeries(actor: Actor, organisationId: string, seriesId: string, input: { projectId?: string; title?: string; body?: string; ownerId?: string | null; evidenceRequired?: boolean;
		recurrence?: Recurrence; everyMonths?: number | null; anchor?: string; dueOffsetDays?: number; paused?: boolean }): Promise<Series> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.title !== undefined && !input.title.trim()) throw badRequest('title_required', 'the series needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [current] = await tx<{ recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number }[]>`select recurrence, every_months, anchor::text as anchor, due_offset_days from task_series where id = ${seriesId} and organisation_id = ${organisationId}`;
			if (!current) throw notFound('that series does not exist');
			const recurrence = input.recurrence ?? current.recurrence;
			const rule: SeriesRule = { recurrence, everyMonths: recurrence === 'custom' ? (input.everyMonths ?? current.everyMonths) : null, anchor: input.anchor ?? current.anchor, dueOffsetDays: input.dueOffsetDays ?? current.dueOffsetDays };
			try { monthsPerPeriod(rule); nextPeriod(rule, rule.anchor); } catch (error) { throw badRequest('recurrence_invalid', error instanceof Error ? error.message : 'the recurrence is not valid'); }
			if (input.projectId) await this.#requireProject(tx, organisationId, input.projectId);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			// Editing a series changes future occurrences only: existing tasks keep what they have.
			await tx`update task_series set
				project_id = coalesce(${input.projectId ?? null}::uuid, project_id), title = coalesce(${input.title?.trim() ?? null}, title), body = coalesce(${input.body?.trim() ?? null}, body),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				evidence_required = coalesce(${input.evidenceRequired ?? null}, evidence_required),
				recurrence = ${rule.recurrence}, every_months = ${rule.everyMonths}, anchor = ${rule.anchor}::date, due_offset_days = ${rule.dueOffsetDays},
				paused_at = case when ${input.paused === undefined} then paused_at when ${input.paused === true} then coalesce(paused_at, now()) else null end,
				updated_at = now()
				where id = ${seriesId}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'series.updated', subjectType: 'task_series', subjectId: seriesId, requestId: actor.requestId, detail: input });
			const today = await this.#today(tx, organisationId);
			await this.#materialise(tx, organisationId, today, seriesId);
			return (await this.#series(tx, organisationId, today, seriesId))[0]!;
		});
	}

	async addEvidence(actor: Actor, organisationId: string, taskId: string, input: { kind: 'mail' | 'file' | 'url'; reference: string; label?: string }): Promise<Evidence> {
		await roleOf(this.#db, actor.userId, organisationId);
		const reference = input.reference.trim(); if (!reference) throw badRequest('reference_required', 'evidence needs a link or an id');
		if (input.kind === 'url' && !/^https?:\/\//.test(reference)) throw badRequest('url_invalid', 'a URL must start with http:// or https://');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [task] = await tx`select 1 from tasks where id = ${taskId} and organisation_id = ${organisationId}`;
			if (!task) throw notFound('that task does not exist');
			const [row] = await tx<Evidence[]>`insert into evidence (organisation_id, task_id, kind, reference, label, attached_by)
				values (${organisationId}, ${taskId}, ${input.kind}, ${reference}, ${input.label?.trim() ?? ''}, ${actor.userId})
				returning id, task_id, kind, reference, label, attached_by, attached_at`;
			await audit(tx, { organisationId, actor: person(actor), action: 'evidence.attached', subjectType: 'evidence', subjectId: row!.id, requestId: actor.requestId, detail: { taskId, kind: input.kind } });
			return row!;
		});
	}

	async removeEvidence(actor: Actor, organisationId: string, evidenceId: string): Promise<void> {
		await roleOf(this.#db, actor.userId, organisationId);
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const rows = await tx`delete from evidence where id = ${evidenceId} and organisation_id = ${organisationId} returning task_id`;
			if (!rows.length) throw notFound('that evidence does not exist');
			await audit(tx, { organisationId, actor: person(actor), action: 'evidence.removed', subjectType: 'evidence', subjectId: evidenceId, requestId: actor.requestId, detail: { taskId: rows[0]!.taskId } });
		});
	}

	/** Creates the current occurrence of every active series that lacks one (or of one series). The
	 *  materialise-series routine's work: idempotent, journaled as the system, safe to call as often as
	 *  wanted; `today` is the organisation's date unless a caller (a test) says otherwise. */
	async materialise(organisationId: string, today?: string): Promise<number> {
		return withTenant(this.#db, { organisationId }, async (tx) => this.#materialise(tx, organisationId, today ?? (await this.#today(tx, organisationId))));
	}

	async #materialise(tx: TransactionSql, organisationId: string, today: string, seriesId?: string): Promise<number> {
		const active = await tx<{ id: string; projectId: string; title: string; body: string; ownerId: string | null; recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number }[]>`
			select s.id, s.project_id, s.title, s.body, s.owner_id, s.recurrence, s.every_months, s.anchor::text as anchor, s.due_offset_days
			from task_series s join projects p on p.id = s.project_id
			where s.organisation_id = ${organisationId} and s.paused_at is null and p.archived_at is null and (${seriesId ?? null}::uuid is null or s.id = ${seriesId ?? null}::uuid)`;
		let created = 0;
		for (const series of active) {
			const period = periodContaining(series, today);
			if (!period) continue;
			const rows = await tx<{ id: string }[]>`insert into tasks (organisation_id, project_id, title, body, status, owner_id, due, source_kind, source_id, series_id, period_start, period_end)
				values (${organisationId}, ${series.projectId}, ${titleFor(series.title, period)}, ${series.body}, 'open', ${series.ownerId}, ${dueFor(series, period)}::date, 'series', ${series.id}, ${series.id}, ${period.start}::date, ${period.end}::date)
				on conflict (series_id, period_start) where series_id is not null do nothing returning id`;
			if (rows.length) {
				created += 1;
				await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'task.materialised', subjectType: 'task', subjectId: rows[0]!.id, detail: { seriesId: series.id, period } });
			}
		}
		return created;
	}

	/** The Obligations project: created on first touch, never twice. Returns its id. */
	async #ensureObligations(tx: TransactionSql, organisationId: string, actor?: Actor): Promise<string> {
		const [existing] = await tx<{ id: string }[]>`select id from projects where organisation_id = ${organisationId} and system_kind = 'obligations'`;
		if (existing) return existing.id;
		const [created] = await tx<{ id: string }[]>`insert into projects (organisation_id, name, description, system_kind, created_by)
			values (${organisationId}, 'Obligations', 'Returns, renewals and payments the business owes on a date.', 'obligations', ${actor?.userId ?? null})
			on conflict (organisation_id, system_kind) where system_kind is not null do nothing returning id`;
		if (created) { await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'project.created', subjectType: 'project', subjectId: created.id, detail: { name: 'Obligations', system: true } }); return created.id; }
		const [again] = await tx<{ id: string }[]>`select id from projects where organisation_id = ${organisationId} and system_kind = 'obligations'`;
		return again!.id;
	}

	async #tasks(tx: TransactionSql, organisationId: string, where: ReturnType<TransactionSql>): Promise<Task[]> {
		const rows = await tx<Omit<Task, 'evidence'>[]>`${tx.unsafe(taskSelect)} where t.organisation_id = ${organisationId} and ${where}
			order by t.status = 'done', t.due nulls last, t.created_at`;
		if (rows.length === 0) return [];
		const evidence = await tx<Evidence[]>`select id, task_id, kind, reference, label, attached_by, attached_at from evidence
			where organisation_id = ${organisationId} and task_id in ${tx(rows.map((row) => row.id))} order by attached_at`;
		const byTask = new Map<string, Evidence[]>();
		for (const item of evidence) byTask.set(item.taskId, [...(byTask.get(item.taskId) ?? []), item]);
		return rows.map((row) => ({ ...row, evidence: byTask.get(row.id) ?? [] }));
	}

	async #series(tx: TransactionSql, organisationId: string, today: string, seriesId?: string): Promise<Series[]> {
		const rows = await tx<Omit<Series, 'nextDue'>[]>`select ${tx.unsafe(seriesColumns)} from task_series where organisation_id = ${organisationId}
			and (${seriesId ?? null}::uuid is null or id = ${seriesId ?? null}::uuid) order by title`;
		return rows.map((row) => ({ ...row, nextDue: row.pausedAt ? null : dueFor(row, nextPeriod(row, today)) }));
	}

	/** The organisation's timezone, or UTC when the stored one is not a zone this runtime knows. */
	async #timezone(tx: TransactionSql, organisationId: string): Promise<string> {
		const [org] = await tx<{ timezone: string }[]>`select timezone from organisations where id = ${organisationId}`;
		try { todayIn(org?.timezone ?? 'UTC'); return org?.timezone ?? 'UTC'; } catch { return 'UTC'; }
	}
	async #today(tx: TransactionSql, organisationId: string): Promise<string> { return todayIn(await this.#timezone(tx, organisationId)); }

	async #requireProject(tx: TransactionSql, organisationId: string, projectId: string): Promise<void> {
		const [row] = await tx`select 1 from projects where id = ${projectId} and organisation_id = ${organisationId} and archived_at is null`;
		if (!row) throw badRequest('project_invalid', 'that project does not exist or is archived');
	}

	async #requireMember(tx: TransactionSql, organisationId: string, userId: string): Promise<void> {
		const [row] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active'`;
		if (!row) throw badRequest('owner_invalid', 'the owner must be a member of the organisation');
	}
}

export const taskStatuses = statuses;
