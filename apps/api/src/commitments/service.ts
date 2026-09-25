import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { dueFor, monthsPerPeriod, nextPeriod, periodContaining, titleFor, todayIn, type Recurrence, type SeriesRule } from './series.ts';

export type TaskStatus = 'suggested' | 'open' | 'in_progress' | 'done' | 'cancelled';
/** One line of a brief, citing the thread or note it rests on when it has one (plan §2). */
export type BriefLine = { text: string; evidence: { kind: 'mail_thread' | 'note'; id: string } | null };
export type Brief = { what: BriefLine[]; standing: BriefLine[]; people: BriefLine[]; questions: BriefLine[] };
export const briefSections = ['what', 'standing', 'people', 'questions'] as const;
export type Project = { id: string; name: string; description: string; stages: string[]; stage: 'idea' | 'underway'; state: 'proposed' | 'active' | 'archived'; brief: Brief; briefUpdatedAt: Date | null; ownerId: string | null;
	archivedAt: Date | null; revision: number; createdAt: Date; updatedAt: Date };
/** `evidence` is one bounded page (the first, unless a detail read asks for another); `evidenceCount` is the total.
 *  Checklist items listed under a task carry `evidence: []`; open the item itself for its evidence. */
export type Task = { id: string; projectId: string | null; parentId: string | null; title: string; body: string; status: TaskStatus; ownerId: string | null; ownerName: string | null;
	due: string | null; sourceKind: 'person' | 'mail' | 'series' | 'run'; sourceId: string | null; seriesId: string | null; periodStart: string | null;
	periodEnd: string | null; evidenceRequired: boolean; completedBy: string | null; completedAt: Date | null; revision: number; createdAt: Date; updatedAt: Date;
	evidenceCount: number; evidence: Evidence[] };
export type Evidence = { id: string; taskId: string; kind: 'mail' | 'file' | 'url'; reference: string; label: string; attachedBy: string | null; attachedAt: Date };
export type Series = { id: string; projectId: string | null; title: string; body: string; ownerId: string | null; evidenceRequired: boolean; recurrence: Recurrence;
	everyMonths: number | null; anchor: string; dueOffsetDays: number; pausedAt: Date | null; nextDue: string | null; revision: number; createdAt: Date; updatedAt: Date };
/** A thread or note that belongs to a project (D22): the ten most recent links per project, with the project's total. */
export type ProjectSource = { projectId: string; kind: 'mail_thread' | 'note'; id: string; title: string; at: Date | null; linkedBy: 'rule' | 'model' | 'person'; total: number };
export type Overview = { projects: Project[]; tasks: Task[]; series: Series[]; links: ProjectSource[]; today: string; timezone: string };
export type Page = { offset: number; limit: number };
export type TaskDetail = { task: Task; project: Project | null; parent: { id: string; title: string } | null; series: { id: string; title: string } | null;
	checklist: { tasks: Task[]; nextOffset: number | null }; evidenceNextOffset: number | null; tags: { items: { id: string; name: string }[]; nextOffset: number | null };
	today: string; timezone: string };
export type WorkOptions = { projects: { items: { id: string; label: string }[]; nextOffset: number | null }; tasks: { items: { id: string; label: string; projectId: string | null }[]; nextOffset: number | null } };

const projectColumns = 'id, name, description, stages, stage, state, brief, brief_updated_at, owner_id, archived_at, revision, created_at, updated_at';
const seriesColumns = 'id, project_id, title, body, owner_id, evidence_required, recurrence, every_months, anchor::text as anchor, due_offset_days, paused_at, revision, created_at, updated_at';
const taskSelect = `select t.id, t.project_id, t.parent_id, t.title, t.body, t.status, t.owner_id, u.name as owner_name, t.due::text as due, t.source_kind, t.source_id, t.series_id,
	t.period_start::text as period_start, t.period_end::text as period_end, t.evidence_required, t.completed_by, t.completed_at, t.revision, t.created_at, t.updated_at,
	(select count(*) from evidence e where e.organisation_id = t.organisation_id and e.task_id = t.id)::int as evidence_count
	from tasks t left join users u on u.id = t.owner_id`;
const evidenceColumns = 'id, task_id, kind, reference, label, attached_by, attached_at';
const statuses: TaskStatus[] = ['suggested', 'open', 'in_progress', 'done', 'cancelled'];
const person = (actor: Actor) => ({ kind: 'person' as const, id: actor.userId });
const stale = () => new HttpError(409, 'stale_revision', 'This changed since you opened it. Reload it before saving again.');
/** A bounded, case-insensitive substring match; `%`, `_` and `\` in the search are literal. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const paged = <T>(rows: T[], page: Page) => ({ items: rows.slice(0, page.limit), nextOffset: rows.length > page.limit ? page.offset + page.limit : null });

/** Projects, tasks, series and evidence: the one work record (D7). Any active member may use it; the
 *  database keeps it inside the tenant, every write is audited, and every edit of an existing record
 *  names the revision it was based on. */
export class CommitmentsService {
	readonly #db: Sql;
	constructor(db: Sql) { this.#db = db; }

 /** Bounded, read-only snapshot for the morning brief; dates follow the organisation's clock. */
 async briefTasks(tx: TransactionSql, organisationId: string) {
  const [clock] = await tx`select timezone, (now() at time zone timezone)::date::text as today,
   ((now() at time zone timezone)::date + 1)::text as tomorrow,
   (date_trunc('week', now() at time zone timezone)::date + 7)::text as week_end from organisations where id = ${organisationId}`;
  const today = clock!.today as string;
  const rows = await tx<Pick<Task, 'id' | 'title' | 'status' | 'due' | 'ownerId' | 'ownerName'>[]>`select t.id, left(t.title, 300) as title, t.status, t.due::text, t.owner_id, left(u.name, 200) as owner_name
   from tasks t left join users u on u.id = t.owner_id where t.parent_id is null and (t.status = 'suggested'
   or (t.status in ('open', 'in_progress') and t.due < ${clock!.weekEnd}::date))
   order by t.due nulls last, t.id limit 101`;
  const tasks = rows.slice(0, 100).map(t => ({ ...t, period: t.status === 'suggested' ? 'suggested' : t.due && t.due < today ? 'overdue' : t.due === today ? 'today' : 'this_week' }));
  return { today, tomorrow: clock!.tomorrow as string, timezone: clock!.timezone as string, tasks, truncated: rows.length > 100 };
 }

	/** Test helper only: the whole legacy overview. No route serves it (`GET /commitments` is retired). */
	async overview(actor: Actor, organisationId: string): Promise<Overview> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const timezone = await this.#timezone(tx, organisationId);
			const today = todayIn(timezone);
			const projects = await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where organisation_id = ${organisationId}
				order by archived_at is not null, name, id`;
			const tasks = await this.#tasks(tx, organisationId, tx`t.status <> 'cancelled'`);
			const series = (await tx<Omit<Series, 'nextDue'>[]>`select ${tx.unsafe(seriesColumns)} from task_series where organisation_id = ${organisationId} order by title`).map((row) => this.#next(row, today));
			return { projects, tasks, series, links: [], today, timezone };
		});
	}

	// Reads. Any active member; another tenant's or a removed member's request is 404.

	/** One task with bounded context: its project, parent, series, a page of its checklist, a page of its
	 *  evidence (in `task.evidence`) and a page of its tags. Cancelled tasks and tasks in archived projects are readable. */
	async task(actor: Actor, organisationId: string, taskId: string, pages: { checklistOffset: number; evidenceOffset: number; tagOffset: number; limit: number }): Promise<TaskDetail> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [row] = await tx<Omit<Task, 'evidence'>[]>`${tx.unsafe(taskSelect)} where t.organisation_id = ${organisationId} and t.id = ${taskId}`;
			if (!row) throw notFound('That task is not available.');
			const { limit } = pages;
			const evidence = await tx<Evidence[]>`select ${tx.unsafe(evidenceColumns)} from evidence where organisation_id = ${organisationId} and task_id = ${taskId}
				order by attached_at, id limit ${limit + 1} offset ${pages.evidenceOffset}`;
			const checklist = await tx<Omit<Task, 'evidence'>[]>`${tx.unsafe(taskSelect)} where t.organisation_id = ${organisationId} and t.parent_id = ${taskId}
				order by t.created_at, t.id limit ${limit + 1} offset ${pages.checklistOffset}`;
			const tags = await tx<{ id: string; name: string }[]>`select tag.id, tag.name from task_tags tt join tags tag on tag.organisation_id = tt.organisation_id and tag.id = tt.tag_id
				where tt.organisation_id = ${organisationId} and tt.task_id = ${taskId} order by lower(tag.name), tag.id limit ${limit + 1} offset ${pages.tagOffset}`;
			const [project] = row.projectId ? await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where organisation_id = ${organisationId} and id = ${row.projectId}` : [];
			const [parent] = row.parentId ? await tx<{ id: string; title: string }[]>`select id, title from tasks where organisation_id = ${organisationId} and id = ${row.parentId}` : [];
			const [series] = row.seriesId ? await tx<{ id: string; title: string }[]>`select id, title from task_series where organisation_id = ${organisationId} and id = ${row.seriesId}` : [];
			const timezone = await this.#timezone(tx, organisationId);
			const evidencePage = paged(evidence, { offset: pages.evidenceOffset, limit });
			const checklistPage = paged(checklist, { offset: pages.checklistOffset, limit });
			return {
				task: { ...row, evidence: evidencePage.items }, project: project ?? null, parent: parent ?? null, series: series ?? null,
				checklist: { tasks: checklistPage.items.map((item) => ({ ...item, evidence: [] })), nextOffset: checklistPage.nextOffset },
				evidenceNextOffset: evidencePage.nextOffset, tags: paged(tags, { offset: pages.tagOffset, limit }), today: todayIn(timezone), timezone
			};
		});
	}

	/** Projects by state (active by default; proposed projects are never listed), optionally matching `q`. */
	async projects(actor: Actor, organisationId: string, query: Page & { state: 'active' | 'archived'; q?: string }): Promise<{ projects: Project[]; nextOffset: number | null }> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const rows = await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where organisation_id = ${organisationId} and state = ${query.state}
				and (${query.q ?? null}::text is null or name ilike ${query.q ? like(query.q) : null}) order by lower(name), id limit ${query.limit + 1} offset ${query.offset}`;
			const page = paged(rows, query); return { projects: page.items, nextOffset: page.nextOffset };
		});
	}

	async project(actor: Actor, organisationId: string, projectId: string): Promise<Project> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [project] = await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where organisation_id = ${organisationId} and id = ${projectId}`;
			if (!project) throw notFound('That project is not available.');
			return project;
		});
	}

	/** Series, optionally in one project and by paused state, in title order. */
	async seriesList(actor: Actor, organisationId: string, query: Page & { projectId?: string; paused?: boolean }): Promise<{ series: Series[]; nextOffset: number | null }> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const today = await this.#today(tx, organisationId);
			const rows = await tx<Omit<Series, 'nextDue'>[]>`select ${tx.unsafe(seriesColumns)} from task_series where organisation_id = ${organisationId}
				and (${query.projectId ?? null}::uuid is null or project_id = ${query.projectId ?? null}::uuid)
				and (${query.paused ?? null}::boolean is null or (paused_at is not null) = ${query.paused ?? null}::boolean)
				order by lower(title), id limit ${query.limit + 1} offset ${query.offset}`;
			const page = paged(rows, query); return { series: page.items.map((row) => this.#next(row, today)), nextOffset: page.nextOffset };
		});
	}

	async seriesDetail(actor: Actor, organisationId: string, seriesId: string): Promise<Series> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [series] = await this.#series(tx, organisationId, await this.#today(tx, organisationId), seriesId);
			if (!series) throw notFound('That recurring work is not available.');
			return series;
		});
	}

	/** Choices for task creation, task editing and equipment links: active projects, and top-level tasks that
	 *  are not cancelled and either stand alone or sit in an active project. Both lists page independently.
	 *  `projectId` narrows the tasks only: undefined is every eligible task, null standalone tasks, a UUID that project's. */
	async workOptions(actor: Actor, organisationId: string, query: { projectOffset: number; taskOffset: number; limit: number; q?: string; projectId?: string | null }): Promise<WorkOptions> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const pattern = query.q ? like(query.q) : null;
			const projects = await tx<{ id: string; label: string }[]>`select id, name as label from projects where organisation_id = ${organisationId} and state = 'active'
				and (${pattern}::text is null or name ilike ${pattern}) order by lower(name), id limit ${query.limit + 1} offset ${query.projectOffset}`;
			const tasks = await tx<{ id: string; label: string; projectId: string | null }[]>`select t.id, t.title as label, t.project_id from tasks t
				left join projects p on p.organisation_id = t.organisation_id and p.id = t.project_id
				where t.organisation_id = ${organisationId} and t.parent_id is null and t.status <> 'cancelled' and (t.project_id is null or p.state = 'active')
				and (${query.projectId === undefined} or t.project_id is not distinct from ${query.projectId ?? null}::uuid)
				and (${pattern}::text is null or t.title ilike ${pattern}) order by lower(t.title), t.id limit ${query.limit + 1} offset ${query.taskOffset}`;
			return { projects: paged(projects, { offset: query.projectOffset, limit: query.limit }), tasks: paged(tasks, { offset: query.taskOffset, limit: query.limit }) };
		});
	}

	// Writes. Creating needs no revision; changing an existing record names the revision it was based on.

	async createProject(actor: Actor, organisationId: string, input: { name: string; description?: string; stages?: string[]; ownerId?: string | null }): Promise<Project> {
		await roleOf(this.#db, actor.userId, organisationId);
		const name = input.name.trim(); if (!name) throw badRequest('name_required', 'the project needs a name');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const [project] = await tx<Project[]>`insert into projects (organisation_id, name, description, stages, owner_id, created_by)
				values (${organisationId}, ${name}, ${input.description?.trim() ?? ''}, ${tx.array(input.stages?.map((s) => s.trim()).filter(Boolean) ?? [])}, ${input.ownerId ?? null}, ${actor.userId})
				returning ${tx.unsafe(projectColumns)}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'project.created', subjectType: 'project', subjectId: project!.id, requestId: actor.requestId, detail: { name } });
			return project!;
		});
	}

	async updateProject(actor: Actor, organisationId: string, projectId: string, input: { expectedRevision: number; name?: string; description?: string; stages?: string[]; ownerId?: string | null; archived?: boolean; stage?: 'idea' | 'underway'; brief?: Brief }): Promise<Project> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.name !== undefined && !input.name.trim()) throw badRequest('name_required', 'the project needs a name');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const [current] = await tx<Project[]>`select ${tx.unsafe(projectColumns)} from projects where id = ${projectId} and organisation_id = ${organisationId} for update`;
			if (!current) throw notFound('that project does not exist');
			if (current.revision !== input.expectedRevision) throw stale();
			if (input.ownerId && input.ownerId !== current.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			if (input.brief) this.#checkBrief(input.brief, current.brief);
			const [project] = await tx<Project[]>`update projects set
				name = coalesce(${input.name?.trim() ?? null}, name), description = coalesce(${input.description?.trim() ?? null}, description),
				stages = coalesce(${input.stages ? tx.array(input.stages.map((s) => s.trim()).filter(Boolean)) : null}, stages),
				stage = coalesce(${input.stage ?? null}, stage),
				brief = coalesce(${input.brief ? tx.json(input.brief as never) : null}, brief),
				brief_updated_at = case when ${input.brief !== undefined} then now() else brief_updated_at end,
				brief_updated_by = case when ${input.brief !== undefined} then ${actor.userId}::uuid else brief_updated_by end,
				brief_run_id = case when ${input.brief !== undefined} then null else brief_run_id end,
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				archived_at = case when ${input.archived === undefined} then archived_at when ${input.archived === true} then coalesce(archived_at, now()) else null end,
				updated_at = now()
				where id = ${projectId} returning ${tx.unsafe(projectColumns)}`;
			const { brief, expectedRevision: _, ...rest } = input;
			await audit(tx, { organisationId, actor: person(actor), action: brief ? 'project.brief_updated' : 'project.updated', subjectType: 'project', subjectId: projectId, requestId: actor.requestId,
				detail: { ...(brief ? { ...rest, lines: Object.fromEntries(briefSections.map((k) => [k, brief[k].length])) } : rest), revision: project!.revision } });
			return project!;
		});
	}

	/** A task, in a project or in none, or with `parentId` a checklist item: in exactly the parent's project
	 *  (including none), one level deep (D7). Adding an item names the parent's revision and moves it on. */
	async createTask(actor: Actor, organisationId: string, input: { projectId?: string | null; parentId?: string; expectedParentRevision?: number; title: string; body?: string; ownerId?: string | null; due?: string | null; status?: TaskStatus }): Promise<Task> {
		await roleOf(this.#db, actor.userId, organisationId);
		const title = input.title.trim(); if (!title) throw badRequest('title_required', 'the task needs a title');
		if (input.parentId && input.expectedParentRevision === undefined) throw badRequest('revision_required', 'adding a checklist item needs the task revision it was based on');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			let projectId = input.projectId ?? null;
			if (input.parentId) {
				// Lock the parent: a concurrent move or edit either happens first (and this is stale) or waits.
				const [parent] = await tx<{ projectId: string | null; parentId: string | null; revision: number }[]>`select project_id, parent_id, revision from tasks where id = ${input.parentId} and organisation_id = ${organisationId} for update`;
				if (!parent) throw notFound('that task does not exist');
				if (parent.revision !== input.expectedParentRevision) throw stale();
				if (parent.parentId) throw badRequest('step_depth', 'a step cannot have steps of its own');
				if (input.projectId !== undefined && input.projectId !== parent.projectId) throw badRequest('step_project', "a step stays in its task's project");
				projectId = parent.projectId;
			}
			if (projectId) await this.#requireProject(tx, organisationId, projectId);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const status = input.status ?? 'open';
			const [row] = await tx<{ id: string }[]>`insert into tasks (organisation_id, project_id, parent_id, title, body, status, owner_id, due, source_kind, source_id, completed_by, completed_at, created_by)
				values (${organisationId}, ${projectId}, ${input.parentId ?? null}, ${title}, ${input.body?.trim() ?? ''}, ${status}, ${input.ownerId ?? null}, ${input.due ?? null}::date, 'person', ${actor.userId},
					${status === 'done' ? actor.userId : null}, ${status === 'done' ? new Date() : null}, ${actor.userId}) returning id`;
			if (input.parentId) await tx`update tasks set updated_at = now() where organisation_id = ${organisationId} and id = ${input.parentId}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'task.created', subjectType: 'task', subjectId: row!.id, requestId: actor.requestId, detail: { title, projectId, parentId: input.parentId ?? null, due: input.due ?? null } });
			return (await this.#tasks(tx, organisationId, tx`t.id = ${row!.id}`))[0]!;
		});
	}

	/** `projectId: null` takes the task out of its project; its checklist and confirmed bookings follow it. */
	async updateTask(actor: Actor, organisationId: string, taskId: string, input: { expectedRevision: number; projectId?: string | null; title?: string; body?: string; ownerId?: string | null; due?: string | null; status?: TaskStatus }): Promise<Task> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.title !== undefined && !input.title.trim()) throw badRequest('title_required', 'the task needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const [current] = await tx<{ status: TaskStatus; projectId: string | null; parentId: string | null; ownerId: string | null; evidenceRequired: boolean; revision: number }[]>`select t.status, t.project_id, t.parent_id, t.owner_id, t.revision, t.evidence_required
				from tasks t where t.id = ${taskId} and t.organisation_id = ${organisationId} for update`;
			if (!current) throw notFound('that task does not exist');
			if (current.revision !== input.expectedRevision) throw stale();
			const moving = input.projectId !== undefined && input.projectId !== current.projectId;
			if (moving && current.parentId) throw badRequest('step_project', "a step stays in its task's project");
			if (moving && input.projectId) await this.#requireProject(tx, organisationId, input.projectId);
			// Only a new owner must be an active member: resending a removed member who already owns the task keeps it editable.
			if (input.ownerId && input.ownerId !== current.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const completing = input.status === 'done' && current.status !== 'done';
			// Counted after the task lock: evidence writes take the same lock, so the count cannot change underneath.
			if (completing && current.evidenceRequired && (await this.#evidenceCount(tx, organisationId, taskId)) === 0)
				throw badRequest('evidence_required', 'this duty needs evidence attached before it counts as done');
			const reopening = input.status !== undefined && input.status !== 'done' && current.status === 'done';
			await tx`update tasks set
				project_id = case when ${moving} then ${input.projectId ?? null}::uuid else project_id end,
				title = coalesce(${input.title?.trim() ?? null}, title), body = coalesce(${input.body?.trim() ?? null}, body),
				status = coalesce(${input.status ?? null}, status),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				due = case when ${input.due === undefined} then due else ${input.due ?? null}::date end,
				completed_by = case when ${completing} then ${actor.userId}::uuid when ${reopening} then null else completed_by end,
				completed_at = case when ${completing} then now() when ${reopening} then null else completed_at end,
				updated_at = now()
				where id = ${taskId}`;
			// Steps follow their task: into its project or out of any, done when a person completes it, cancelled with it, accepted with it.
			if (moving) {
				await tx`update tasks set project_id = ${input.projectId ?? null}::uuid, updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId}`;
				// Confirmed equipment reservations that link this task follow it too, so a reservation's project is
				// always its task's. Each moves to a new revision (a stale edit then conflicts) and is audited.
				// Cancelled reservations are history and cannot be edited; they keep the project they had.
				const followed = await tx<{ id: string; revision: number }[]>`update equipment_reservations set project_id = ${input.projectId ?? null}::uuid, revision = revision + 1, updated_at = now()
					where organisation_id = ${organisationId} and task_id = ${taskId} and status = 'confirmed' and project_id is distinct from ${input.projectId ?? null}::uuid
					returning id, revision`;
				for (const reservation of followed) await audit(tx, { organisationId, actor: person(actor), action: 'equipment.reservation_updated', subjectType: 'equipment_reservation', subjectId: reservation.id,
					requestId: actor.requestId, detail: { cause: 'task.moved', taskId, before: { projectId: current.projectId }, after: { projectId: input.projectId ?? null, revision: reservation.revision } } });
			}
			if (completing) await tx`update tasks set status = 'done', completed_by = ${actor.userId}, completed_at = now(), updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId} and status in ('suggested', 'open', 'in_progress')`;
			else if (input.status === 'cancelled') await tx`update tasks set status = 'cancelled', updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId} and status in ('suggested', 'open', 'in_progress')`;
			else if (input.status === 'open' && current.status === 'suggested') await tx`update tasks set status = 'open', updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId} and status = 'suggested'`;
			const [task] = await this.#tasks(tx, organisationId, tx`t.id = ${taskId}`);
			const { expectedRevision: _, ...change } = input;
			await audit(tx, { organisationId, actor: person(actor), action: completing ? 'task.completed' : 'task.updated', subjectType: 'task', subjectId: taskId, requestId: actor.requestId, detail: { ...change, revision: task!.revision } });
			return task!;
		});
	}

	async createSeries(actor: Actor, organisationId: string, input: { projectId?: string | null; title: string; body?: string; ownerId?: string | null; evidenceRequired?: boolean;
		recurrence: Recurrence; everyMonths?: number | null; anchor: string; dueOffsetDays?: number }): Promise<Series> {
		await roleOf(this.#db, actor.userId, organisationId);
		const title = input.title.trim(); if (!title) throw badRequest('title_required', 'the series needs a title');
		const rule: SeriesRule = { recurrence: input.recurrence, everyMonths: input.recurrence === 'custom' ? input.everyMonths ?? null : null, anchor: input.anchor, dueOffsetDays: input.dueOffsetDays ?? 0 };
		try { monthsPerPeriod(rule); nextPeriod(rule, rule.anchor); } catch (error) { throw badRequest('recurrence_invalid', error instanceof Error ? error.message : 'the recurrence is not valid'); }
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const projectId = input.projectId ?? null;
			if (projectId) await this.#requireProject(tx, organisationId, projectId);
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

	/** `projectId: null` takes future occurrences out of any project; existing occurrences keep theirs. */
	async updateSeries(actor: Actor, organisationId: string, seriesId: string, input: { expectedRevision: number; projectId?: string | null; title?: string; body?: string; ownerId?: string | null; evidenceRequired?: boolean;
		recurrence?: Recurrence; everyMonths?: number | null; anchor?: string; dueOffsetDays?: number; paused?: boolean }): Promise<Series> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.title !== undefined && !input.title.trim()) throw badRequest('title_required', 'the series needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const [current] = await tx<{ projectId: string | null; ownerId: string | null; recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number; revision: number }[]>`select project_id, owner_id, recurrence, every_months, anchor::text as anchor, due_offset_days, revision from task_series where id = ${seriesId} and organisation_id = ${organisationId} for update`;
			if (!current) throw notFound('that series does not exist');
			if (current.revision !== input.expectedRevision) throw stale();
			const recurrence = input.recurrence ?? current.recurrence;
			const rule: SeriesRule = { recurrence, everyMonths: recurrence === 'custom' ? (input.everyMonths ?? current.everyMonths) : null, anchor: input.anchor ?? current.anchor, dueOffsetDays: input.dueOffsetDays ?? current.dueOffsetDays };
			try { monthsPerPeriod(rule); nextPeriod(rule, rule.anchor); } catch (error) { throw badRequest('recurrence_invalid', error instanceof Error ? error.message : 'the recurrence is not valid'); }
			const moving = input.projectId !== undefined && input.projectId !== current.projectId;
			if (moving && input.projectId) await this.#requireProject(tx, organisationId, input.projectId);
			if (input.ownerId && input.ownerId !== current.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			// Editing a series changes future occurrences only: existing tasks keep what they have, including
			// whether they need evidence (copied onto each occurrence when it was created).
			await tx`update task_series set
				project_id = case when ${moving} then ${input.projectId ?? null}::uuid else project_id end,
				title = coalesce(${input.title?.trim() ?? null}, title), body = coalesce(${input.body?.trim() ?? null}, body),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				evidence_required = coalesce(${input.evidenceRequired ?? null}, evidence_required),
				recurrence = ${rule.recurrence}, every_months = ${rule.everyMonths}, anchor = ${rule.anchor}::date, due_offset_days = ${rule.dueOffsetDays},
				paused_at = case when ${input.paused === undefined} then paused_at when ${input.paused === true} then coalesce(paused_at, now()) else null end,
				updated_at = now()
				where id = ${seriesId}`;
			const today = await this.#today(tx, organisationId);
			await this.#materialise(tx, organisationId, today, seriesId);
			const [series] = await this.#series(tx, organisationId, today, seriesId);
			const { expectedRevision: _, ...change } = input;
			await audit(tx, { organisationId, actor: person(actor), action: 'series.updated', subjectType: 'task_series', subjectId: seriesId, requestId: actor.requestId, detail: { ...change, revision: series!.revision } });
			return series!;
		});
	}

	/** Evidence is part of its task: adding it names the task's revision, locks the task and moves it on, so a
	 *  retried request after an uncertain response is refused instead of attaching a second copy. */
	async addEvidence(actor: Actor, organisationId: string, taskId: string, input: { expectedRevision: number; kind: 'mail' | 'file' | 'url'; reference: string; label?: string }): Promise<Evidence> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (input.kind === 'mail') throw badRequest('evidence_kind_retired', 'Mail evidence is no longer supported. Attach a file reference or a link.');
		const reference = input.reference.trim(); if (!reference) throw badRequest('reference_required', 'evidence needs a link or an id');
		if (input.kind === 'url' && !/^https?:\/\//.test(reference)) throw badRequest('url_invalid', 'a URL must start with http:// or https://');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			await this.#lockTask(tx, organisationId, taskId, input.expectedRevision);
			const [row] = await tx<Evidence[]>`insert into evidence (organisation_id, task_id, kind, reference, label, attached_by)
				values (${organisationId}, ${taskId}, ${input.kind}, ${reference}, ${input.label?.trim() ?? ''}, ${actor.userId})
				returning ${tx.unsafe(evidenceColumns)}`;
			await tx`update tasks set updated_at = now() where organisation_id = ${organisationId} and id = ${taskId}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'evidence.attached', subjectType: 'evidence', subjectId: row!.id, requestId: actor.requestId, detail: { taskId, kind: input.kind } });
			return row!;
		});
	}

	/** Removing evidence names its task's revision. The last evidence of a done task that requires it cannot
	 *  be removed: reopen the task first. */
	async removeEvidence(actor: Actor, organisationId: string, evidenceId: string, input: { expectedRevision: number }): Promise<void> {
		await roleOf(this.#db, actor.userId, organisationId);
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const [found] = await tx<{ taskId: string }[]>`select task_id from evidence where id = ${evidenceId} and organisation_id = ${organisationId}`;
			if (!found) throw notFound('that evidence does not exist');
			const task = await this.#lockTask(tx, organisationId, found.taskId, input.expectedRevision);
			if (task.status === 'done' && task.evidenceRequired && (await this.#evidenceCount(tx, organisationId, found.taskId)) <= 1)
				throw new HttpError(409, 'evidence_required', 'This duty is done and needs its evidence. Reopen it before removing the last piece.');
			const rows = await tx`delete from evidence where id = ${evidenceId} and organisation_id = ${organisationId} returning task_id`;
			if (!rows.length) throw notFound('that evidence does not exist');
			await tx`update tasks set updated_at = now() where organisation_id = ${organisationId} and id = ${found.taskId}`;
			await audit(tx, { organisationId, actor: person(actor), action: 'evidence.removed', subjectType: 'evidence', subjectId: evidenceId, requestId: actor.requestId, detail: { taskId: found.taskId } });
		});
	}

	/** Creates the current occurrence of every active series that lacks one (or of one series). The
	 *  materialise-series routine's work: idempotent, journaled as the system, safe to call as often as
	 *  wanted; `today` is the organisation's date unless a caller (a test) says otherwise. */
	async materialise(organisationId: string, today?: string): Promise<number> {
		return withTenant(this.#db, { organisationId }, async (tx) => this.#materialise(tx, organisationId, today ?? (await this.#today(tx, organisationId))));
	}

	async #materialise(tx: TransactionSql, organisationId: string, today: string, seriesId?: string): Promise<number> {
		const active = await tx<{ id: string; projectId: string | null; title: string; body: string; ownerId: string | null; evidenceRequired: boolean; recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number }[]>`
			select s.id, s.project_id, s.title, s.body, s.owner_id, s.evidence_required, s.recurrence, s.every_months, s.anchor::text as anchor, s.due_offset_days
			from task_series s left join projects p on p.organisation_id = s.organisation_id and p.id = s.project_id
				where s.organisation_id = ${organisationId} and s.paused_at is null and (s.project_id is null or p.archived_at is null) and (${seriesId ?? null}::uuid is null or s.id = ${seriesId ?? null}::uuid)
				for share of s`;
		// Share-locked: a concurrent pause or edit either commits first (and the locked row is re-checked, so a
		// just-paused series is skipped) or waits until this occurrence exists. A concurrent project archive is
		// not locked here; at worst it gets this period's occurrence, as it would a moment earlier.
		let created = 0;
		for (const series of active) {
			const period = periodContaining(series, today);
			if (!period) continue;
			const rows = await tx<{ id: string }[]>`insert into tasks (organisation_id, project_id, title, body, status, owner_id, due, source_kind, source_id, series_id, period_start, period_end, evidence_required)
				values (${organisationId}, ${series.projectId}, ${titleFor(series.title, period)}, ${series.body}, 'open', ${series.ownerId}, ${dueFor(series, period)}::date, 'series', ${series.id}, ${series.id}, ${period.start}::date, ${period.end}::date, ${series.evidenceRequired})
				on conflict (series_id, period_start) where series_id is not null do nothing returning id`;
			if (rows.length) {
				created += 1;
				await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'task.materialised', subjectType: 'task', subjectId: rows[0]!.id, detail: { seriesId: series.id, period } });
			}
		}
		return created;
	}

	/** Preserve an unchanged historical citation, but do not accept a new personal source link. */
 #checkBrief(brief: Brief, previous: Brief) {
  const identity = (line: BriefLine) => JSON.stringify([line.text, line.evidence?.kind, line.evidence?.id]);
  const existing = new Set(briefSections.flatMap(k => previous[k].map(identity)));
  if (briefSections.some(k => brief[k].some(line => line.evidence && !existing.has(identity(line)))))
   throw badRequest('evidence_retired', 'New mail and note citations are no longer supported. Remove the citation from the changed line.');
 }

	/** Lock a task for an evidence change and check the revision the change was based on. */
	async #lockTask(tx: TransactionSql, organisationId: string, taskId: string, expectedRevision: number) {
		const [task] = await tx<{ status: TaskStatus; revision: number; evidenceRequired: boolean }[]>`select t.status, t.revision, t.evidence_required
			from tasks t where t.organisation_id = ${organisationId} and t.id = ${taskId} for update`;
		if (!task) throw notFound('that task does not exist');
		if (task.revision !== expectedRevision) throw stale();
		return task;
	}

	async #evidenceCount(tx: TransactionSql, organisationId: string, taskId: string): Promise<number> {
		const [row] = await tx<{ n: number }[]>`select count(*)::int as n from evidence where organisation_id = ${organisationId} and task_id = ${taskId}`;
		return row!.n;
	}

	/** Tasks with the first page of each one's evidence (at most 50) and its evidence total. */
	async #tasks(tx: TransactionSql, organisationId: string, where: ReturnType<TransactionSql>): Promise<Task[]> {
		const rows = await tx<Omit<Task, 'evidence'>[]>`${tx.unsafe(taskSelect)} where t.organisation_id = ${organisationId} and ${where}
			order by t.status = 'done', t.due nulls last, t.created_at`;
		if (rows.length === 0) return [];
		const evidence = await tx<Evidence[]>`select ${tx.unsafe(evidenceColumns)} from (select *, row_number() over (partition by task_id order by attached_at, id) as n from evidence
			where organisation_id = ${organisationId} and task_id in ${tx(rows.map((row) => row.id))}) e where n <= 50 order by attached_at, id`;
		const byTask = new Map<string, Evidence[]>();
		for (const item of evidence) byTask.set(item.taskId, [...(byTask.get(item.taskId) ?? []), item]);
		return rows.map((row) => ({ ...row, evidence: byTask.get(row.id) ?? [] }));
	}

	#next(row: Omit<Series, 'nextDue'>, today: string): Series { return { ...row, nextDue: row.pausedAt ? null : dueFor(row, nextPeriod(row, today)) }; }

	async #series(tx: TransactionSql, organisationId: string, today: string, seriesId: string): Promise<Series[]> {
		const rows = await tx<Omit<Series, 'nextDue'>[]>`select ${tx.unsafe(seriesColumns)} from task_series where organisation_id = ${organisationId} and id = ${seriesId}`;
		return rows.map((row) => this.#next(row, today));
	}

	/** The organisation's timezone, or UTC when the stored one is not a zone this runtime knows. */
	async #timezone(tx: TransactionSql, organisationId: string): Promise<string> {
		const [org] = await tx<{ timezone: string }[]>`select timezone from organisations where id = ${organisationId}`;
		try { todayIn(org?.timezone ?? 'UTC'); return org?.timezone ?? 'UTC'; } catch { return 'UTC'; }
	}
	async #today(tx: TransactionSql, organisationId: string): Promise<string> { return todayIn(await this.#timezone(tx, organisationId)); }

	/** The acting person is still an active member, held for the write so a removal cannot race it. */
	async #activeMember(tx: TransactionSql, organisationId: string, actor: Actor): Promise<void> {
		const [row] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId} and status = 'active' for share`;
		if (!row) throw notFound();
	}

	async #requireProject(tx: TransactionSql, organisationId: string, projectId: string): Promise<void> {
		const [row] = await tx`select 1 from projects where id = ${projectId} and organisation_id = ${organisationId} and state = 'active' for share`;
		if (!row) throw badRequest('project_invalid', 'that project does not exist or is archived');
	}

	async #requireMember(tx: TransactionSql, organisationId: string, userId: string): Promise<void> {
		const [row] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active' for share`;
		if (!row) throw badRequest('owner_invalid', 'the owner must be a member of the organisation');
	}
}

export const taskStatuses = statuses;
