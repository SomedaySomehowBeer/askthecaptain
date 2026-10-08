import { openChangeSet, withTenant, type Sql, type TransactionSql } from '@captain/db';
import { createdItem, createdRecord, personChangeSet } from '../changes.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { attachSeriesTags, requireTags } from '../threads/tags.ts';
import { dueFor, monthsPerPeriod, nextPeriod, periodContaining, titleFor, todayIn, type Recurrence, type SeriesRule } from './series.ts';

export type TaskStatus = 'suggested' | 'open' | 'in_progress' | 'done' | 'cancelled';
/** `evidence` is one bounded page (the first, unless a detail read asks for another); `evidenceCount` is the total.
 *  Checklist items listed under a task carry `evidence: []`; open the item itself for its evidence. */
export type Task = { id: string; parentId: string | null; title: string; body: string; status: TaskStatus; ownerId: string | null; ownerName: string | null;
	due: string | null; sourceKind: 'person' | 'mail' | 'series' | 'run'; sourceId: string | null; seriesId: string | null; periodStart: string | null;
	periodEnd: string | null; evidenceRequired: boolean; completedBy: string | null; completedAt: Date | null; revision: number; createdAt: Date; updatedAt: Date;
	evidenceCount: number; evidence: Evidence[] };
export type Evidence = { id: string; taskId: string; kind: 'mail' | 'file' | 'url'; reference: string; label: string; attachedBy: string | null; attachedAt: Date };
/** `tagIds` are the series' tags, which each new occurrence receives on its thread (threads contract §3). */
export type Series = { id: string; tagIds: string[]; title: string; body: string; ownerId: string | null; evidenceRequired: boolean; recurrence: Recurrence;
	everyMonths: number | null; anchor: string; dueOffsetDays: number; pausedAt: Date | null; nextDue: string | null; revision: number; createdAt: Date; updatedAt: Date };
/** A journalled write answers with its change set (versions contract §5). */
export type Changed<T> = T & { changeSetId: string };
export type Overview = { tasks: Task[]; series: Series[]; today: string; timezone: string };
export type Page = { offset: number; limit: number };
/** `tags` are the tags on the task's thread (threads contract §5): tagging is a thread write. */
export type TaskDetail = { task: Task; parent: { id: string; title: string } | null; series: { id: string; title: string } | null;
	checklist: { tasks: Task[]; nextOffset: number | null }; evidenceNextOffset: number | null; tags: { items: { id: string; name: string }[]; nextOffset: number | null };
	today: string; timezone: string };
export type WorkOptions = { tasks: { items: { id: string; label: string }[]; nextOffset: number | null } };

const seriesColumns = 'id, title, body, owner_id, evidence_required, recurrence, every_months, anchor::text as anchor, due_offset_days, paused_at, revision, created_at, updated_at';
const taskSelect = `select t.id, t.parent_id, t.title, t.body, t.status, t.owner_id, u.name as owner_name, t.due::text as due, t.source_kind, t.source_id, t.series_id,
	t.period_start::text as period_start, t.period_end::text as period_end, t.evidence_required, t.completed_by, t.completed_at, t.revision, t.created_at, t.updated_at,
	(select count(*) from evidence e where e.organisation_id = t.organisation_id and e.task_id = t.id)::int as evidence_count
	from tasks t left join users u on u.id = t.owner_id`;
const evidenceColumns = 'id, task_id, kind, reference, label, attached_by, attached_at';
const statuses: TaskStatus[] = ['suggested', 'open', 'in_progress', 'done', 'cancelled'];
const stale = () => new HttpError(409, 'stale_revision', 'This changed since you opened it. Reload it before saving again.');
/** A bounded, case-insensitive substring match; `%`, `_` and `\` in the search are literal. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const paged = <T>(rows: T[], page: Page) => ({ items: rows.slice(0, page.limit), nextOffset: rows.length > page.limit ? page.offset + page.limit : null });

/** Tasks, series and evidence: the one work record (D7; a project is a tag since 0046). Any active member may use it; the
 *  database keeps it inside the tenant, every write opens a change set that the database journals (0047; it is the
 *  write's audit record), and every edit of an existing record names the revision it was based on. */
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
			const tasks = await this.#tasks(tx, organisationId, tx`t.status <> 'cancelled'`);
			const series = await this.#withTags(tx, organisationId, await tx<Omit<Series, 'nextDue' | 'tagIds'>[]>`select ${tx.unsafe(seriesColumns)} from task_series where organisation_id = ${organisationId} order by title`, today);
			return { tasks, series, today, timezone };
		});
	}

	// Reads. Any active member; another tenant's or a removed member's request is 404.

	/** One task with bounded context: its parent, series, a page of its checklist, a page of its evidence (in
	 *  `task.evidence`) and a page of its thread's tags. Cancelled tasks are readable. */
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
			// A step has no thread of its own: it is part of its task's thread, so its tags are its task's.
			const tags = await tx<{ id: string; name: string }[]>`select tag.id, tag.name from threads th join thread_tags tt on tt.thread_id = th.id
				join tags tag on tag.organisation_id = tt.organisation_id and tag.id = tt.tag_id
				where th.organisation_id = ${organisationId} and th.task_id = ${row.parentId ?? taskId} order by lower(tag.name), tag.id limit ${limit + 1} offset ${pages.tagOffset}`;
			const [parent] = row.parentId ? await tx<{ id: string; title: string }[]>`select id, title from tasks where organisation_id = ${organisationId} and id = ${row.parentId}` : [];
			const [series] = row.seriesId ? await tx<{ id: string; title: string }[]>`select id, title from task_series where organisation_id = ${organisationId} and id = ${row.seriesId}` : [];
			const timezone = await this.#timezone(tx, organisationId);
			const evidencePage = paged(evidence, { offset: pages.evidenceOffset, limit });
			const checklistPage = paged(checklist, { offset: pages.checklistOffset, limit });
			return {
				task: { ...row, evidence: evidencePage.items }, parent: parent ?? null, series: series ?? null,
				checklist: { tasks: checklistPage.items.map((item) => ({ ...item, evidence: [] })), nextOffset: checklistPage.nextOffset },
				evidenceNextOffset: evidencePage.nextOffset, tags: paged(tags, { offset: pages.tagOffset, limit }), today: todayIn(timezone), timezone
			};
		});
	}

	/** Series, optionally carrying one tag and by paused state, in title order. */
	async seriesList(actor: Actor, organisationId: string, query: Page & { tagId?: string; paused?: boolean }): Promise<{ series: Series[]; nextOffset: number | null }> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const today = await this.#today(tx, organisationId);
			const rows = await tx<Omit<Series, 'nextDue' | 'tagIds'>[]>`select ${tx.unsafe(seriesColumns)} from task_series s where organisation_id = ${organisationId}
				and (${query.tagId ?? null}::uuid is null or exists (select 1 from task_series_tags st where st.series_id = s.id and st.tag_id = ${query.tagId ?? null}::uuid))
				and (${query.paused ?? null}::boolean is null or (paused_at is not null) = ${query.paused ?? null}::boolean)
				order by lower(title), id limit ${query.limit + 1} offset ${query.offset}`;
			const page = paged(rows, query); return { series: await this.#withTags(tx, organisationId, page.items, today), nextOffset: page.nextOffset };
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

	/** Choices for equipment links: top-level tasks that are not cancelled, optionally matching `q`. */
	async workOptions(actor: Actor, organisationId: string, query: { taskOffset: number; limit: number; q?: string }): Promise<WorkOptions> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const pattern = query.q ? like(query.q) : null;
			const tasks = await tx<{ id: string; label: string }[]>`select t.id, t.title as label from tasks t
				where t.organisation_id = ${organisationId} and t.parent_id is null and t.status <> 'cancelled'
				and (${pattern}::text is null or t.title ilike ${pattern}) order by lower(t.title), t.id limit ${query.limit + 1} offset ${query.taskOffset}`;
			return { tasks: paged(tasks, { offset: query.taskOffset, limit: query.limit }) };
		});
	}

	// Writes. Creating needs no revision; changing an existing record names the revision it was based on.

	/** A task, or with `parentId` a checklist item, one level deep (D7). Adding an item names the parent's revision and
	 *  moves it on. A top-level task gets its thread from its insert (0046); its tags are thread writes. */
	async createTask(actor: Actor, organisationId: string, raw: { changeSetId?: string; parentId?: string; expectedParentRevision?: number; title: string; body?: string; ownerId?: string | null; due?: string | null; status?: TaskStatus }): Promise<Changed<Task>> {
		await roleOf(this.#db, actor.userId, organisationId);
		const { changeSetId, ...input } = raw;
		const title = input.title.trim(); if (!title) throw badRequest('title_required', 'the task needs a title');
		if (input.parentId && input.expectedParentRevision === undefined) throw badRequest('revision_required', 'adding a checklist item needs the task revision it was based on');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const changeSet = await personChangeSet(tx, actor, 'task.create', input, changeSetId);
			if (changeSet.matched) {
				const id = input.parentId ? (await createdItem(tx, changeSet.id, 'step'))?.itemId : await createdRecord(tx, changeSet.id, 'task');
				const [task] = id ? await this.#tasks(tx, organisationId, tx`t.id = ${id}`) : [];
				if (!task) throw notFound('That task is not available.');
				return { ...task, changeSetId: changeSet.id };
			}
			if (input.parentId) {
				// Lock the parent: a concurrent edit either happens first (and this is stale) or waits.
				const [parent] = await tx<{ parentId: string | null; revision: number }[]>`select parent_id, revision from tasks where id = ${input.parentId} and organisation_id = ${organisationId} for update`;
				if (!parent) throw notFound('that task does not exist');
				if (parent.revision !== input.expectedParentRevision) throw stale();
				if (parent.parentId) throw badRequest('step_depth', 'a step cannot have steps of its own');
			}
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const status = input.status ?? 'open';
			const [row] = await tx<{ id: string }[]>`insert into tasks (organisation_id, parent_id, title, body, status, owner_id, due, source_kind, source_id, completed_by, completed_at, created_by)
				values (${organisationId}, ${input.parentId ?? null}, ${title}, ${input.body?.trim() ?? ''}, ${status}, ${input.ownerId ?? null}, ${input.due ?? null}::date, 'person', ${actor.userId},
					${status === 'done' ? actor.userId : null}, ${status === 'done' ? new Date() : null}, ${actor.userId}) returning id`;
			if (input.parentId) await tx`update tasks set updated_at = now() where organisation_id = ${organisationId} and id = ${input.parentId}`;
			return { ...(await this.#tasks(tx, organisationId, tx`t.id = ${row!.id}`))[0]!, changeSetId: changeSet.id };
		});
	}

	/** Fields of a task, with `expectedRevision`. Its checklist follows its status. Tags are thread writes. */
	async updateTask(actor: Actor, organisationId: string, taskId: string, raw: { changeSetId?: string; expectedRevision: number; title?: string; body?: string; ownerId?: string | null; due?: string | null; status?: TaskStatus }): Promise<Changed<Task>> {
		await roleOf(this.#db, actor.userId, organisationId);
		const { changeSetId, ...input } = raw;
		if (input.title !== undefined && !input.title.trim()) throw badRequest('title_required', 'the task needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const changeSet = await personChangeSet(tx, actor, 'task.update', { taskId, ...input }, changeSetId);
			if (changeSet.matched) {
				const [task] = await this.#tasks(tx, organisationId, tx`t.id = ${taskId}`);
				if (!task) throw notFound('that task does not exist');
				return { ...task, changeSetId: changeSet.id };
			}
			const [current] = await tx<{ status: TaskStatus; parentId: string | null; ownerId: string | null; evidenceRequired: boolean; revision: number }[]>`select t.status, t.parent_id, t.owner_id, t.revision, t.evidence_required
				from tasks t where t.id = ${taskId} and t.organisation_id = ${organisationId} for update`;
			if (!current) throw notFound('that task does not exist');
			if (current.revision !== input.expectedRevision) throw stale();
			// Only a new owner must be an active member: resending a removed member who already owns the task keeps it editable.
			if (input.ownerId && input.ownerId !== current.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const completing = input.status === 'done' && current.status !== 'done';
			// Counted after the task lock: evidence writes take the same lock, so the count cannot change underneath.
			if (completing && current.evidenceRequired && (await this.#evidenceCount(tx, organisationId, taskId)) === 0)
				throw badRequest('evidence_required', 'this duty needs evidence attached before it counts as done');
			const reopening = input.status !== undefined && input.status !== 'done' && current.status === 'done';
			await tx`update tasks set
				title = coalesce(${input.title?.trim() ?? null}, title), body = coalesce(${input.body?.trim() ?? null}, body),
				status = coalesce(${input.status ?? null}, status),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				due = case when ${input.due === undefined} then due else ${input.due ?? null}::date end,
				completed_by = case when ${completing} then ${actor.userId}::uuid when ${reopening} then null else completed_by end,
				completed_at = case when ${completing} then now() when ${reopening} then null else completed_at end,
				updated_at = now()
				where id = ${taskId}`;
			// Steps follow their task: done when a person completes it, cancelled with it, accepted with it.
			if (completing) await tx`update tasks set status = 'done', completed_by = ${actor.userId}, completed_at = now(), updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId} and status in ('suggested', 'open', 'in_progress')`;
			else if (input.status === 'cancelled') await tx`update tasks set status = 'cancelled', updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId} and status in ('suggested', 'open', 'in_progress')`;
			else if (input.status === 'open' && current.status === 'suggested') await tx`update tasks set status = 'open', updated_at = now() where organisation_id = ${organisationId} and parent_id = ${taskId} and status = 'suggested'`;
			const [task] = await this.#tasks(tx, organisationId, tx`t.id = ${taskId}`);
			return { ...task!, changeSetId: changeSet.id };
		});
	}

	async createSeries(actor: Actor, organisationId: string, raw: { changeSetId?: string; tagIds?: string[]; title: string; body?: string; ownerId?: string | null; evidenceRequired?: boolean;
		recurrence: Recurrence; everyMonths?: number | null; anchor: string; dueOffsetDays?: number; fromTask?: { id: string; expectedRevision: number } }): Promise<Changed<Series>> {
		await roleOf(this.#db, actor.userId, organisationId);
		const { changeSetId, ...input } = raw;
		const title = input.title.trim(); if (!title) throw badRequest('title_required', 'the series needs a title');
		const rule: SeriesRule = { recurrence: input.recurrence, everyMonths: input.recurrence === 'custom' ? input.everyMonths ?? null : null, anchor: input.anchor, dueOffsetDays: input.dueOffsetDays ?? 0 };
		try { monthsPerPeriod(rule); nextPeriod(rule, rule.anchor); } catch (error) { throw badRequest('recurrence_invalid', error instanceof Error ? error.message : 'the recurrence is not valid'); }
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const changeSet = await personChangeSet(tx, actor, 'series.create', input, changeSetId);
			if (changeSet.matched) {
				const id = await createdRecord(tx, changeSet.id, 'series');
				const [series] = id ? await this.#series(tx, organisationId, await this.#today(tx, organisationId), id) : [];
				if (!series) throw notFound('That recurring work is not available.');
				return { ...series, changeSetId: changeSet.id };
			}
			const tagIds = [...new Set(input.tagIds ?? [])].sort();
			await requireTags(tx, tagIds);
			if (input.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			const [row] = await tx<{ id: string }[]>`insert into task_series (organisation_id, title, body, owner_id, evidence_required, recurrence, every_months, anchor, due_offset_days, created_by)
				values (${organisationId}, ${title}, ${input.body?.trim() ?? ''}, ${input.ownerId ?? null}, ${input.evidenceRequired ?? false}, ${rule.recurrence}, ${rule.everyMonths}, ${rule.anchor}::date, ${rule.dueOffsetDays}, ${actor.userId})
				returning id`;
			for (const tagId of tagIds) await tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${organisationId}, ${row!.id}, ${tagId})`;
			const today = await this.#today(tx, organisationId);
			// "Repeat this task" (H4 contract §3): the task becomes the series' occurrence for the period it falls in (today's
			// period, or the first one when the series starts later), so the series never makes a second copy of it. The task
			// keeps its own title, due date and tags; linking it is a journalled change to the task in this change set.
			if (input.fromTask) {
				const [task] = await tx<{ parentId: string | null; seriesId: string | null; status: TaskStatus; revision: number }[]>`select parent_id, series_id, status, revision
					from tasks where organisation_id = ${organisationId} and id = ${input.fromTask.id} for update`;
				if (!task) throw notFound('That task is not available.');
				if (task.revision !== input.fromTask.expectedRevision) throw stale();
				if (task.parentId) throw badRequest('task_is_step', 'A step repeats with its task. Repeat the task instead.');
				if (task.seriesId) throw new HttpError(409, 'task_in_series', 'This task is already part of recurring work. Edit the series instead.');
				if (task.status === 'cancelled') throw new HttpError(409, 'task_cancelled', 'A cancelled task cannot repeat. Reopen it first.');
				const period = periodContaining(rule, today) ?? nextPeriod(rule, today);
				await tx`update tasks set series_id = ${row!.id}, period_start = ${period.start}::date, period_end = ${period.end}::date, updated_at = now()
					where organisation_id = ${organisationId} and id = ${input.fromTask.id}`;
			}
			await this.#materialise(tx, organisationId, today, actor, row!.id);
			return { ...(await this.#series(tx, organisationId, today, row!.id))[0]!, changeSetId: changeSet.id };
		});
	}

	/** `tagIds` replaces the series' tags for future occurrences; existing occurrences keep their thread's tags. */
	async updateSeries(actor: Actor, organisationId: string, seriesId: string, raw: { changeSetId?: string; expectedRevision: number; tagIds?: string[]; title?: string; body?: string; ownerId?: string | null; evidenceRequired?: boolean;
		recurrence?: Recurrence; everyMonths?: number | null; anchor?: string; dueOffsetDays?: number; paused?: boolean }): Promise<Changed<Series>> {
		await roleOf(this.#db, actor.userId, organisationId);
		const { changeSetId, ...input } = raw;
		if (input.title !== undefined && !input.title.trim()) throw badRequest('title_required', 'the series needs a title');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const changeSet = await personChangeSet(tx, actor, 'series.update', { seriesId, ...input }, changeSetId);
			if (changeSet.matched) {
				const [series] = await this.#series(tx, organisationId, await this.#today(tx, organisationId), seriesId);
				if (!series) throw notFound('that series does not exist');
				return { ...series, changeSetId: changeSet.id };
			}
			const [current] = await tx<{ ownerId: string | null; recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number; revision: number }[]>`select owner_id, recurrence, every_months, anchor::text as anchor, due_offset_days, revision from task_series where id = ${seriesId} and organisation_id = ${organisationId} for update`;
			if (!current) throw notFound('that series does not exist');
			if (current.revision !== input.expectedRevision) throw stale();
			const recurrence = input.recurrence ?? current.recurrence;
			const rule: SeriesRule = { recurrence, everyMonths: recurrence === 'custom' ? (input.everyMonths ?? current.everyMonths) : null, anchor: input.anchor ?? current.anchor, dueOffsetDays: input.dueOffsetDays ?? current.dueOffsetDays };
			try { monthsPerPeriod(rule); nextPeriod(rule, rule.anchor); } catch (error) { throw badRequest('recurrence_invalid', error instanceof Error ? error.message : 'the recurrence is not valid'); }
			const tagIds = input.tagIds === undefined ? undefined : [...new Set(input.tagIds)].sort();
			if (tagIds) await requireTags(tx, tagIds);
			if (input.ownerId && input.ownerId !== current.ownerId) await this.#requireMember(tx, organisationId, input.ownerId);
			// Editing a series changes future occurrences only: existing tasks keep what they have, including
			// whether they need evidence (copied onto each occurrence when it was created).
			await tx`update task_series set
				title = coalesce(${input.title?.trim() ?? null}, title), body = coalesce(${input.body?.trim() ?? null}, body),
				owner_id = case when ${input.ownerId === undefined} then owner_id else ${input.ownerId ?? null}::uuid end,
				evidence_required = coalesce(${input.evidenceRequired ?? null}, evidence_required),
				recurrence = ${rule.recurrence}, every_months = ${rule.everyMonths}, anchor = ${rule.anchor}::date, due_offset_days = ${rule.dueOffsetDays},
				paused_at = case when ${input.paused === undefined} then paused_at when ${input.paused === true} then coalesce(paused_at, now()) else null end,
				updated_at = now()
				where id = ${seriesId}`;
			if (tagIds) {
				await tx`delete from task_series_tags where series_id = ${seriesId} and not (tag_id = any(${tagIds}::uuid[]))`;
				for (const tagId of tagIds) await tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${organisationId}, ${seriesId}, ${tagId}) on conflict do nothing`;
			}
			const today = await this.#today(tx, organisationId);
			await this.#materialise(tx, organisationId, today, actor, seriesId);
			const [series] = await this.#series(tx, organisationId, today, seriesId);
			return { ...series!, changeSetId: changeSet.id };
		});
	}

	/** Evidence is part of its task: adding it names the task's revision, locks the task and moves it on, so a
	 *  retried request after an uncertain response is refused instead of attaching a second copy. */
	async addEvidence(actor: Actor, organisationId: string, taskId: string, raw: { changeSetId?: string; expectedRevision: number; kind: 'mail' | 'file' | 'url'; reference: string; label?: string }): Promise<Changed<Evidence>> {
		await roleOf(this.#db, actor.userId, organisationId);
		const { changeSetId, ...input } = raw;
		if (input.kind === 'mail') throw badRequest('evidence_kind_retired', 'Mail evidence is no longer supported. Attach a file reference or a link.');
		const reference = input.reference.trim(); if (!reference) throw badRequest('reference_required', 'evidence needs a link or an id');
		if (input.kind === 'url' && !/^https?:\/\//.test(reference)) throw badRequest('url_invalid', 'a URL must start with http:// or https://');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const changeSet = await personChangeSet(tx, actor, 'evidence.add', { taskId, ...input }, changeSetId);
			if (changeSet.matched) {
				// The evidence row exactly as the first request attached it, even if it has been removed since.
				const made = await createdItem(tx, changeSet.id, 'evidence');
				if (!made) throw notFound('that evidence does not exist');
				const a = made.after as { id: string; taskId: string; kind: Evidence['kind']; reference: string; label: string; attachedBy: string | null; attachedAt: string };
				return { id: a.id, taskId: a.taskId, kind: a.kind, reference: a.reference, label: a.label, attachedBy: a.attachedBy, attachedAt: new Date(a.attachedAt), changeSetId: changeSet.id };
			}
			await this.#lockTask(tx, organisationId, taskId, input.expectedRevision);
			const [row] = await tx<Evidence[]>`insert into evidence (organisation_id, task_id, kind, reference, label, attached_by)
				values (${organisationId}, ${taskId}, ${input.kind}, ${reference}, ${input.label?.trim() ?? ''}, ${actor.userId})
				returning ${tx.unsafe(evidenceColumns)}`;
			await tx`update tasks set updated_at = now() where organisation_id = ${organisationId} and id = ${taskId}`;
			return { ...row!, changeSetId: changeSet.id };
		});
	}

	/** Removing evidence names its task's revision. The last evidence of a done task that requires it cannot
	 *  be removed: reopen the task first. */
	async removeEvidence(actor: Actor, organisationId: string, evidenceId: string, raw: { changeSetId?: string; expectedRevision: number }): Promise<{ changeSetId: string }> {
		await roleOf(this.#db, actor.userId, organisationId);
		const { changeSetId, ...input } = raw;
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await this.#activeMember(tx, organisationId, actor);
			const changeSet = await personChangeSet(tx, actor, 'evidence.remove', { evidenceId, ...input }, changeSetId);
			if (changeSet.matched) return { changeSetId: changeSet.id };
			const [found] = await tx<{ taskId: string }[]>`select task_id from evidence where id = ${evidenceId} and organisation_id = ${organisationId}`;
			if (!found) throw notFound('that evidence does not exist');
			const task = await this.#lockTask(tx, organisationId, found.taskId, input.expectedRevision);
			if (task.status === 'done' && task.evidenceRequired && (await this.#evidenceCount(tx, organisationId, found.taskId)) <= 1)
				throw new HttpError(409, 'evidence_required', 'This duty is done and needs its evidence. Reopen it before removing the last piece.');
			const rows = await tx`delete from evidence where id = ${evidenceId} and organisation_id = ${organisationId} returning task_id`;
			if (!rows.length) throw notFound('that evidence does not exist');
			await tx`update tasks set updated_at = now() where organisation_id = ${organisationId} and id = ${found.taskId}`;
			return { changeSetId: changeSet.id };
		});
	}

	/** Creates the current occurrence of every active series that lacks one (or of one series). The
	 *  materialise-series routine's work: idempotent, journalled as the system (a `routine` change set, opened only
	 *  when an occurrence is missing), safe to call as often as wanted; `today` is the organisation's date unless a
	 *  caller (a test) says otherwise. */
	async materialise(organisationId: string, today?: string): Promise<number> {
		return withTenant(this.#db, { organisationId }, async (tx) => this.#materialise(tx, organisationId, today ?? (await this.#today(tx, organisationId)), null));
	}

	/** Each new occurrence receives its series' tags on its own thread, in the same transaction (threads contract §3).
	 *  With a person acting (a series create or edit) it is part of their change set; the routine opens its own. */
	async #materialise(tx: TransactionSql, organisationId: string, today: string, actor: Actor | null, seriesId?: string): Promise<number> {
		const active = await tx<{ id: string; title: string; body: string; ownerId: string | null; evidenceRequired: boolean; recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number }[]>`
			select s.id, s.title, s.body, s.owner_id, s.evidence_required, s.recurrence, s.every_months, s.anchor::text as anchor, s.due_offset_days
			from task_series s
				where s.organisation_id = ${organisationId} and s.paused_at is null and (${seriesId ?? null}::uuid is null or s.id = ${seriesId ?? null}::uuid)
				for share of s`;
		// Share-locked: a concurrent pause or edit either commits first (and the locked row is re-checked, so a
		// just-paused series is skipped) or waits until this occurrence exists. Tags never stop a series.
		let created = 0, journalled = actor !== null;
		for (const series of active) {
			const period = periodContaining(series, today);
			if (!period) continue;
			if (!journalled) {
				const [exists] = await tx`select 1 from tasks where organisation_id = ${organisationId} and series_id = ${series.id} and period_start = ${period.start}::date`;
				if (exists) continue;
				await openChangeSet(tx, { actorKind: 'system', causeKind: 'routine', causeId: 'series.materialise' });
				journalled = true;
			}
			const rows = await tx<{ id: string }[]>`insert into tasks (organisation_id, title, body, status, owner_id, due, source_kind, source_id, series_id, period_start, period_end, evidence_required)
				values (${organisationId}, ${titleFor(series.title, period)}, ${series.body}, 'open', ${series.ownerId}, ${dueFor(series, period)}::date, 'series', ${series.id}, ${series.id}, ${period.start}::date, ${period.end}::date, ${series.evidenceRequired})
				on conflict (series_id, period_start) where series_id is not null do nothing returning id`;
			if (rows.length) {
				created += 1;
				await attachSeriesTags(tx, organisationId, actor, rows[0]!.id, series.id);
			}
		}
		return created;
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

	/** The series' tag ids (in id order), then its next due date. */
	async #withTags(tx: TransactionSql, organisationId: string, rows: Omit<Series, 'nextDue' | 'tagIds'>[], today: string): Promise<Series[]> {
		const tags = rows.length ? await tx<{ seriesId: string; tagId: string }[]>`select series_id, tag_id from task_series_tags
			where organisation_id = ${organisationId} and series_id in ${tx(rows.map((row) => row.id))} order by tag_id` : [];
		return rows.map((row) => this.#next({ ...row, tagIds: tags.filter((t) => t.seriesId === row.id).map((t) => t.tagId) }, today));
	}

	async #series(tx: TransactionSql, organisationId: string, today: string, seriesId: string): Promise<Series[]> {
		const rows = await tx<Omit<Series, 'nextDue' | 'tagIds'>[]>`select ${tx.unsafe(seriesColumns)} from task_series where organisation_id = ${organisationId} and id = ${seriesId}`;
		return this.#withTags(tx, organisationId, rows, today);
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

	async #requireMember(tx: TransactionSql, organisationId: string, userId: string): Promise<void> {
		const [row] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active' for share`;
		if (!row) throw badRequest('owner_invalid', 'the owner must be a member of the organisation');
	}
}

export const taskStatuses = statuses;
