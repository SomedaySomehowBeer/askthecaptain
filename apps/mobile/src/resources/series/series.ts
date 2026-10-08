/** Recurring work (H4 contract §3): "Repeat this task" on a task's card makes a series from the task, which becomes its
 *  occurrence for the period it falls in (`fromTask`, T-A); an occurrence's card opens the series to edit, pause or
 *  resume it. Every write is revision-checked and carries a client change set id (versions contract §5). Strict parsers;
 *  shapes follow apps/api/src/commitments/service.ts. Pure: no React Native import, so Node tests import it. */
import type { ReadScope } from '../../account/contracts.ts';
import { isCanonicalInstant, organisationPath } from '../../api/paths.ts';
import type { Write } from '../../threads/cards/records.ts';
import { array, integer, keys, object, text, uuid } from '../../threads/parse.ts';

const bad = (): never => { throw new TypeError('series: unexpected response'); };
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();
export const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isCanonicalInstant(`${v}T00:00:00.000Z`);
const date = (x: unknown): string => typeof x === 'string' && isDate(x) ? x : bad();

export type Recurrence = 'monthly' | 'quarterly' | 'yearly' | 'weekdays' | 'custom';
export const recurrences: readonly Recurrence[] = ['monthly', 'quarterly', 'yearly', 'weekdays', 'custom'];
export type Series = { readonly id: string; readonly tagIds: readonly string[]; readonly title: string; readonly body: string; readonly ownerId: string | null;
	readonly evidenceRequired: boolean; readonly recurrence: Recurrence; readonly everyMonths: number | null; readonly anchor: string; readonly dueOffsetDays: number;
	readonly pausedAt: string | null; readonly nextDue: string | null; readonly revision: number };
const seriesKeys = ['id', 'tagIds', 'title', 'body', 'ownerId', 'evidenceRequired', 'recurrence', 'everyMonths', 'anchor', 'dueOffsetDays', 'pausedAt', 'nextDue', 'revision', 'createdAt', 'updatedAt'];
export function parseSeries(raw: unknown, expected: { id?: string; changeSetId?: string } = {}): Series {
	const x = object(raw); keys(x, seriesKeys, expected.changeSetId ? ['changeSetId'] : []);
	if (expected.changeSetId && uuid(x.changeSetId) !== expected.changeSetId) bad();
	instant(x.createdAt); instant(x.updatedAt);
	const recurrence = recurrences.includes(x.recurrence as Recurrence) ? x.recurrence as Recurrence : bad();
	const everyMonths = x.everyMonths === null ? null : integer(x.everyMonths, 1, 120);
	if ((recurrence === 'custom') !== (everyMonths !== null)) bad();
	const tagIds = array(x.tagIds, uuid, 20);
	if (new Set(tagIds).size !== tagIds.length || typeof x.evidenceRequired !== 'boolean') bad();
	const s: Series = { id: uuid(x.id), tagIds, title: text(x.title, 200), body: text(x.body, 5000), ownerId: x.ownerId === null ? null : uuid(x.ownerId), evidenceRequired: x.evidenceRequired as boolean,
		recurrence, everyMonths, anchor: date(x.anchor), dueOffsetDays: integer(x.dueOffsetDays, -366, 366), pausedAt: x.pausedAt === null ? null : instant(x.pausedAt),
		nextDue: x.nextDue === null ? null : date(x.nextDue), revision: integer(x.revision, 1) };
	if (expected.id && s.id !== expected.id) bad();
	if ((s.pausedAt === null) === (s.nextDue === null)) bad();
	return Object.freeze(s);
}
export const seriesPath = (scope: ReadScope, id?: string) => id ? organisationPath(scope.organisationId, 'series', uuid(id)) : organisationPath(scope.organisationId, 'series');

// ---- Words ------------------------------------------------------------------------------------------------------------
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1 Oct 2026". */
export const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${months[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
export const recurrenceWords = (r: Recurrence, everyMonths: number | null): string => r === 'custom' ? `every ${everyMonths} ${everyMonths === 1 ? 'month' : 'months'}`
	: r === 'weekdays' ? 'every weekday' : r;
/** The due rule in plain words: "due 5 days after the period ends", "due 10 days before the period ends". */
export function dueWords(offset: number, recurrence: Recurrence): string {
	if (recurrence === 'weekdays') return offset === 0 ? 'due on the day' : offset > 0 ? `due ${offset} ${offset === 1 ? 'day' : 'days'} after the day` : `due ${-offset} ${offset === -1 ? 'day' : 'days'} before the day`;
	if (offset === 0) return 'due when the period ends';
	const n = Math.abs(offset);
	return `due ${n} ${n === 1 ? 'day' : 'days'} ${offset > 0 ? 'after' : 'before'} the period ends`;
}
/** "Repeats monthly from 1 Oct 2026, due 10 days before the period ends." The card's line after "Repeat this task". */
export const repeatsWords = (s: Pick<Series, 'recurrence' | 'everyMonths' | 'anchor' | 'dueOffsetDays' | 'pausedAt'>) =>
	s.pausedAt ? `Paused. It repeats ${recurrenceWords(s.recurrence, s.everyMonths)} when resumed.` : `Repeats ${recurrenceWords(s.recurrence, s.everyMonths)} from ${shortDate(s.anchor)}, ${dueWords(s.dueOffsetDays, s.recurrence)}.`;

// ---- The form ---------------------------------------------------------------------------------------------------------
export type RepeatForm = { recurrence: Recurrence; everyMonths: string; anchor: string; dueDays: string; dueWhen: 'after' | 'before'; ownerId: string; evidenceRequired: boolean };
const addDays = (d: string, n: number) => { const v = new Date(`${d}T00:00:00Z`); v.setUTCDate(v.getUTCDate() + n); return v.toISOString().slice(0, 10); };
const addMonths = (d: string, n: number) => { const v = new Date(`${d}T00:00:00Z`); const day = v.getUTCDate(); v.setUTCDate(1); v.setUTCMonth(v.getUTCMonth() + n);
	v.setUTCDate(Math.min(day, new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth() + 1, 0)).getUTCDate())); return v.toISOString().slice(0, 10); };
const span = (r: Recurrence, every: number) => r === 'monthly' ? 1 : r === 'quarterly' ? 3 : r === 'yearly' ? 12 : r === 'custom' ? every : 0;
/** The form "Repeat this task" opens with: monthly, from the first of the month the task is due in (or today's), due as
 *  many days before that month ends as the task is, its owner and evidence rule. */
export function repeatForm(task: { due: string | null; ownerId: string | null; evidenceRequired: boolean }, today: string): RepeatForm {
	const base = task.due ?? today, anchor = `${base.slice(0, 7)}-01`;
	const end = addDays(addMonths(anchor, 1), -1);
	const offset = task.due ? Math.round((Date.parse(`${task.due}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / 86_400_000) : 0;
	return { recurrence: 'monthly', everyMonths: '2', anchor, dueDays: String(Math.abs(offset)), dueWhen: offset > 0 ? 'after' : 'before', ownerId: task.ownerId ?? '', evidenceRequired: task.evidenceRequired };
}
export const seriesForm = (s: Series): RepeatForm => ({ recurrence: s.recurrence, everyMonths: String(s.everyMonths ?? 2), anchor: s.anchor, dueDays: String(Math.abs(s.dueOffsetDays)),
	dueWhen: s.dueOffsetDays > 0 ? 'after' : 'before', ownerId: s.ownerId ?? '', evidenceRequired: s.evidenceRequired });
export type SeriesRule = { recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number; ownerId: string | null; evidenceRequired: boolean };
/** The rule the form asks for, or what is wrong with it, in words. */
export function repeatRule(form: RepeatForm): SeriesRule | { error: string } {
	const every = form.recurrence === 'custom' ? Number(form.everyMonths) : null;
	if (every !== null && (!/^\d{1,3}$/.test(form.everyMonths.trim()) || every < 1 || every > 120)) return { error: 'Repeat every 1 to 120 months.' };
	if (!isDate(form.anchor)) return { error: 'Choose the date the series starts from.' };
	if (!/^\d{1,3}$/.test(form.dueDays.trim()) || Number(form.dueDays) > 366) return { error: 'Enter 0 to 366 days for when it falls due.' };
	const days = Number(form.dueDays);
	return { recurrence: form.recurrence, everyMonths: every, anchor: form.anchor, dueOffsetDays: form.dueWhen === 'before' ? -days : days, ownerId: form.ownerId || null, evidenceRequired: form.evidenceRequired };
}
/** The first period's dates for the form's preview ("This task is the October 2026 occurrence"): its start and end. */
export function firstPeriod(rule: Pick<SeriesRule, 'recurrence' | 'everyMonths' | 'anchor'>, today: string): { start: string; end: string } {
	if (rule.recurrence === 'weekdays') { let d = today < rule.anchor ? rule.anchor : today; for (let i = 0; i < 7; i++) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) break; d = addDays(d, 1); } return { start: d, end: d }; }
	const n = span(rule.recurrence, rule.everyMonths ?? 1);
	let start = rule.anchor;
	if (today >= start) for (;;) { const next = addMonths(start, n); if (today < next) break; start = next; }
	return { start, end: addDays(addMonths(start, n), -1) };
}
/** Only what changed for a series' PATCH; null when nothing did. A change of recurrence sends `everyMonths` with it. */
export function seriesChanges(s: Series, rule: SeriesRule, title: string): Record<string, unknown> | null {
	const p: Record<string, unknown> = {};
	if (title.trim() !== s.title) p.title = title.trim();
	if (rule.recurrence !== s.recurrence || rule.everyMonths !== s.everyMonths) { p.recurrence = rule.recurrence; p.everyMonths = rule.everyMonths; }
	if (rule.anchor !== s.anchor) p.anchor = rule.anchor;
	if (rule.dueOffsetDays !== s.dueOffsetDays) p.dueOffsetDays = rule.dueOffsetDays;
	if (rule.ownerId !== s.ownerId) p.ownerId = rule.ownerId;
	if (rule.evidenceRequired !== s.evidenceRequired) p.evidenceRequired = rule.evidenceRequired;
	return Object.keys(p).length ? p : null;
}

export const seriesWrites = {
	/** "Repeat this task": the task's title, body and tags, the form's rule, and the task itself as `fromTask`. */
	repeat: (scope: ReadScope, task: { id: string; title: string; body: string; revision: number }, tagIds: readonly string[], rule: SeriesRule, changeSetId: string): Write<Series> =>
		({ method: 'POST', path: seriesPath(scope), body: { changeSetId, title: task.title, body: task.body, tagIds: [...tagIds], ownerId: rule.ownerId, evidenceRequired: rule.evidenceRequired,
			recurrence: rule.recurrence, everyMonths: rule.everyMonths, anchor: rule.anchor, dueOffsetDays: rule.dueOffsetDays, fromTask: { id: uuid(task.id), expectedRevision: task.revision } },
			parse: (v) => parseSeries(v, { changeSetId }) }),
	update: (scope: ReadScope, s: Series, changeSetId: string, patch: Record<string, unknown>): Write<Series> =>
		({ method: 'PATCH', path: seriesPath(scope, s.id), body: { changeSetId, expectedRevision: s.revision, ...patch }, parse: (v) => parseSeries(v, { id: s.id, changeSetId }) })
};
export const seriesRefusals: Readonly<Record<string, string>> = Object.freeze({
	task_in_series: 'This task is already part of recurring work. Edit the series instead.',
	task_is_step: 'A step repeats with its task. Repeat the task instead.',
	task_cancelled: 'A cancelled task can’t repeat. Reopen it first.',
	tag_archived: 'One of this task’s tags is archived. Restore it, or remove it from the task, then repeat it.',
	recurrence_invalid: 'That repeat rule isn’t valid. Check the months and the start date.',
	owner_invalid: 'The owner must be an active member of this organisation.'
});
export const seriesCopy = {
	open: 'Repeat this task', heading: 'Repeat this task', recurrence: 'Repeats', every: 'Every how many months', anchor: 'Starting from', due: 'Falls due',
	dueDays: 'Days from the end', after: 'After the period ends', before: 'Before the period ends', owner: 'Owner', evidence: 'Evidence required', save: 'Repeat it', cancel: 'Cancel',
	write: { saving: 'Saving…', saved: 'Saved. The task is now part of recurring work.', confirmed: 'Change confirmed.', refusals: seriesRefusals },
	edit: 'Edit the series', partOf: (title: string) => `Part of ${title}`, loadingSeries: 'Loading the series…', seriesFailed: 'Couldn’t load the series.',
	thisOccurrence: (start: string, end: string) => start === end ? `This task becomes the ${shortDate(start)} occurrence.` : `This task becomes the occurrence for ${shortDate(start)} to ${shortDate(end)}.`,
	pageHeading: 'Recurring work', title: 'Title', pause: 'Pause', resume: 'Resume', paused: 'Paused: no new occurrences are made until it is resumed.',
	nextDue: (d: string) => `Next due ${shortDate(d)}.`, lost: 'This recurring work is no longer available.', futureOnly: 'Changes apply to occurrences made from now on; existing tasks keep what they have.',
	seriesSaved: { saving: 'Saving…', saved: 'Saved. The change is in the series’ history.', confirmed: 'Change confirmed.', refusals: seriesRefusals }
} as const;
export const recurrenceOptions = [{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'yearly', label: 'Yearly' },
	{ value: 'weekdays', label: 'Weekdays' }, { value: 'custom', label: 'Every n months' }] as const;
