/** The record writes behind a thread's card (versions contract §5, §6): a task's fields and steps, a booking's time and
 *  cancellation, a stock count. Each write carries a client change set id and answers with it; the parsers check the
 *  answer is the record asked about and the change set sent. Shapes follow apps/api/src/{commitments,equipment,stock}. */
import { isCanonicalInstant, isCanonicalUuid, organisationPath } from '../../api/paths.ts';
import type { ReadScope } from '../../account/contracts.ts';
import type { Result, ThreadCalls } from '../api.ts';
import { queryPath } from '../api.ts';
import { array, integer, keys, object, text, uuid } from '../parse.ts';

const bad = (): never => { throw new TypeError('record: unexpected response'); };
const nullable = <T>(x: unknown, parse: (x: unknown) => T): T | null => x === null ? null : parse(x);
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();
const bool = (x: unknown): boolean => typeof x === 'boolean' ? x : bad();
const date = (x: unknown): string => { const s = text(x, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && isCanonicalInstant(`${s}T00:00:00.000Z`) ? s : bad(); };
const decimal = (x: unknown): string => { const s = text(x, 100); return /^\d+(?:\.\d+)?$/.test(s) ? s : bad(); };

export type TaskStatus = 'suggested' | 'open' | 'in_progress' | 'done' | 'cancelled';
export const taskStatuses = ['suggested', 'open', 'in_progress', 'done', 'cancelled'] as const;
export type Task = { id: string; parentId: string | null; title: string; body: string; status: TaskStatus; ownerId: string | null; ownerName: string | null; due: string | null;
	evidenceRequired: boolean; evidenceCount: number; revision: number };
export type TaskDetail = { task: Task; steps: Task[]; stepsNext: number | null; today: string; timezone: string };
const taskKeys = ['id', 'parentId', 'title', 'body', 'status', 'ownerId', 'ownerName', 'due', 'sourceKind', 'sourceId', 'seriesId', 'periodStart', 'periodEnd', 'evidenceRequired',
	'completedBy', 'completedAt', 'revision', 'createdAt', 'updatedAt', 'evidenceCount', 'evidence'];
const evidenceKeys = ['id', 'taskId', 'kind', 'reference', 'label', 'attachedBy', 'attachedAt'];

export function parseTask(raw: unknown, extra: string[] = []): Task {
	const x = object(raw); keys(x, taskKeys, extra);
	const t = (v: unknown) => text(v, 16000);
	array(x.evidence, (e) => { const r = object(e); keys(r, evidenceKeys); uuid(r.id); return null; }, 50);
	for (const k of ['sourceId']) if (x[k] !== null) text(x[k], 200);
	for (const k of ['seriesId', 'completedBy']) nullable(x[k], uuid);
	for (const k of ['periodStart', 'periodEnd']) nullable(x[k], date);
	nullable(x.completedAt, instant); instant(x.createdAt); instant(x.updatedAt); text(x.sourceKind, 20);
	const status = typeof x.status === 'string' && (taskStatuses as readonly string[]).includes(x.status) ? x.status as TaskStatus : bad();
	return { id: uuid(x.id), parentId: nullable(x.parentId, uuid), title: text(x.title, 500), body: t(x.body), status, ownerId: nullable(x.ownerId, uuid),
		ownerName: nullable(x.ownerName, (v) => text(v, 500)), due: nullable(x.due, date), evidenceRequired: bool(x.evidenceRequired), evidenceCount: integer(x.evidenceCount), revision: integer(x.revision, 1) };
}
/** `GET …/tasks/:id?limit=50`: the task, its first page of steps, the organisation's today and zone. */
export function parseTaskDetail(raw: unknown, taskId: string): TaskDetail {
	const x = object(raw); keys(x, ['task', 'parent', 'series', 'checklist', 'evidenceNextOffset', 'tags', 'today', 'timezone']);
	const task = parseTask(x.task); if (task.id !== taskId || task.parentId !== null) bad();
	const c = object(x.checklist); keys(c, ['tasks', 'nextOffset']);
	const steps = array(c.tasks, (s) => parseTask(s), 50);
	if (steps.some((s) => s.parentId !== taskId) || new Set(steps.map((s) => s.id)).size !== steps.length) bad();
	return { task, steps, stepsNext: nullable(c.nextOffset, (v) => integer(v, 1)), today: date(x.today), timezone: text(x.timezone, 64) };
}
/** A task write's answer: the task (or step) asked about, with the change set that was sent. */
export function parseTaskWrite(raw: unknown, expected: { id?: string; parentId?: string; changeSetId: string }): Task & { changeSetId: string } {
	const x = object(raw); const task = parseTask(x, ['changeSetId']);
	if (uuid(x.changeSetId) !== expected.changeSetId || (expected.id && task.id !== expected.id) || (expected.parentId && task.parentId !== expected.parentId)) bad();
	return { ...task, changeSetId: expected.changeSetId };
}

export type Booking = { id: string; equipmentId: string; title: string; kind: 'booking' | 'maintenance'; status: 'confirmed' | 'cancelled'; startsAt: string; endsAt: string;
	setupMinutes: number; cleanupMinutes: number; taskId: string | null; ownerId: string | null; revision: number };
const bookingKeys = ['id', 'equipmentId', 'title', 'kind', 'status', 'startsAt', 'endsAt', 'setupMinutes', 'cleanupMinutes', 'occupiedStartsAt', 'occupiedEndsAt', 'taskId', 'ownerId',
	'createdBy', 'revision', 'createdAt', 'updatedAt', 'tagIds'];
export function parseBooking(raw: unknown, expected: { id: string; equipmentId: string; changeSetId?: string }): Booking {
	const x = object(raw); keys(x, bookingKeys, expected.changeSetId ? ['changeSetId'] : []);
	if (expected.changeSetId && uuid(x.changeSetId) !== expected.changeSetId) bad();
	const minutes = (v: unknown) => integer(v, 0, 10080);
	const b: Booking = { id: uuid(x.id), equipmentId: uuid(x.equipmentId), title: text(x.title, 200), kind: x.kind === 'booking' || x.kind === 'maintenance' ? x.kind : bad(),
		status: x.status === 'confirmed' || x.status === 'cancelled' ? x.status : bad(), startsAt: instant(x.startsAt), endsAt: instant(x.endsAt), setupMinutes: minutes(x.setupMinutes),
		cleanupMinutes: minutes(x.cleanupMinutes), taskId: nullable(x.taskId, uuid), ownerId: nullable(x.ownerId, uuid), revision: integer(x.revision, 1) };
	instant(x.occupiedStartsAt); instant(x.occupiedEndsAt); uuid(x.createdBy); instant(x.createdAt); instant(x.updatedAt); array(x.tagIds, uuid, 100);
	if (b.id !== expected.id || b.equipmentId !== expected.equipmentId) bad();
	return b;
}
export type Count = { id: string; itemId: string; count: string; note: string; countedAt: string; changeSetId: string };
/** `POST …/stock/:id/count`: the observation it recorded (a retry answers with the same one). */
export function parseCount(raw: unknown, expected: { itemId: string; changeSetId: string }): Count {
	const x = object(raw); keys(x, ['id', 'organisationId', 'itemId', 'countedAt', 'countedBy', 'count', 'note', 'changeSetId']);
	uuid(x.organisationId); uuid(x.countedBy);
	const c = { id: uuid(x.id), itemId: uuid(x.itemId), count: decimal(x.count), note: text(x.note, 1000), countedAt: instant(x.countedAt), changeSetId: uuid(x.changeSetId) };
	if (c.itemId !== expected.itemId || c.changeSetId !== expected.changeSetId) bad();
	return c;
}
export const parseZone = (raw: unknown, organisationId: string): string => { const x = object(raw); if (x.id !== organisationId) bad(); return text(x.timezone, 64); };

export type TaskChanges = { title?: string; status?: TaskStatus; ownerId?: string | null; due?: string | null };
export type BookingTime = { title: string; kind: 'booking' | 'maintenance'; startsAt: string; endsAt: string; setupMinutes: number; cleanupMinutes: number; taskId: string | null; ownerId: string | null };
/** One record write: its method, path, exact body (the retry rule compares it) and parser. */
export type Write<T> = { method: 'POST' | 'PATCH'; path: ReturnType<typeof organisationPath>; body: Record<string, unknown> & { changeSetId: string }; parse: (raw: unknown) => T };

export const writes = {
	task: (scope: ReadScope, taskId: string, changeSetId: string, expectedRevision: number, changes: TaskChanges): Write<Task & { changeSetId: string }> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'tasks', uuid(taskId)), body: { changeSetId, expectedRevision, ...changes }, parse: (v) => parseTaskWrite(v, { id: taskId, changeSetId }) }),
	step: (scope: ReadScope, stepId: string, changeSetId: string, expectedRevision: number, done: boolean): Write<Task & { changeSetId: string }> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'tasks', uuid(stepId)), body: { changeSetId, expectedRevision, status: done ? 'done' : 'open' }, parse: (v) => parseTaskWrite(v, { id: stepId, changeSetId }) }),
	addStep: (scope: ReadScope, taskId: string, changeSetId: string, expectedParentRevision: number, title: string): Write<Task & { changeSetId: string }> =>
		({ method: 'POST', path: organisationPath(scope.organisationId, 'tasks'), body: { changeSetId, parentId: uuid(taskId), expectedParentRevision, title }, parse: (v) => parseTaskWrite(v, { parentId: taskId, changeSetId }) }),
	booking: (scope: ReadScope, equipmentId: string, bookingId: string, changeSetId: string, expectedRevision: number, time: BookingTime): Write<Booking> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'equipment', uuid(equipmentId), 'reservations', uuid(bookingId)), body: { changeSetId, expectedRevision, ...time },
			parse: (v) => parseBooking(v, { id: bookingId, equipmentId, changeSetId }) }),
	cancelBooking: (scope: ReadScope, equipmentId: string, bookingId: string, changeSetId: string, expectedRevision: number): Write<Booking> =>
		({ method: 'POST', path: organisationPath(scope.organisationId, 'equipment', uuid(equipmentId), 'reservations', uuid(bookingId), 'cancel'), body: { changeSetId, expectedRevision },
			parse: (v) => parseBooking(v, { id: bookingId, equipmentId, changeSetId }) }),
	count: (scope: ReadScope, itemId: string, changeSetId: string, count: string, note: string): Write<Count> =>
		({ method: 'POST', path: organisationPath(scope.organisationId, 'stock', uuid(itemId), 'count'), body: { changeSetId, count, ...(note.trim() ? { note: note.trim() } : {}) },
			parse: (v) => parseCount(v, { itemId, changeSetId }) })
};
export const send = <T>(calls: ThreadCalls, scope: ReadScope, write: Write<T>): Promise<Result<T>> => calls.request(scope, write.method, write.path, write.body, write.parse);

export const reads = {
	task: (calls: ThreadCalls, scope: ReadScope, taskId: string) => calls.request(scope, 'GET', queryPath(organisationPath(scope.organisationId, 'tasks', uuid(taskId)), { limit: 50 }), undefined, (v) => parseTaskDetail(v, taskId)),
	booking: (calls: ThreadCalls, scope: ReadScope, equipmentId: string, bookingId: string) => calls.request(scope, 'GET', organisationPath(scope.organisationId, 'equipment', uuid(equipmentId), 'reservations', uuid(bookingId)), undefined, (v) => parseBooking(v, { id: bookingId, equipmentId })),
	zone: (calls: ThreadCalls, scope: ReadScope) => calls.request(scope, 'GET', organisationPath(scope.organisationId), undefined, (v) => parseZone(v, scope.organisationId))
};

export const isUuid = isCanonicalUuid;
