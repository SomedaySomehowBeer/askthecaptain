/** Change lines worded by code, never by a model (versions contract §3, AGENTS "Honest states"). Pure: no React, no
 *  network. Every journalled field (packages/db/src/versions.ts `journalFields`, mirrored in `wordedFields` below and
 *  checked by a test that reads that file) has its own phrase; an unknown field still gets an honest generic one.
 *
 *  Names that a change carries only as ids (an owner, a tag, a step) come from `names`, built by the screen from what
 *  it has loaded. An id it cannot name is said plainly ("another member", "a tag"), never guessed. */
import type { ChangeLine, LineChange } from './contracts.ts';

export type Segment = { readonly text: string; readonly strong?: boolean };
export type Names = {
	person?(id: string): string | null | undefined;
	tag?(id: string): string | null | undefined;
	step?(id: string): string | null | undefined;
	equipment?(id: string): string | null | undefined;
	task?(id: string): string | null | undefined;
};
export type WordingOptions = {
	readonly names?: Names;
	/** The organisation's time zone for booking times; without it the device's zone is used. */
	readonly zone?: string;
	/** The year to leave out of dates (the current one); other years are written. */
	readonly year?: number;
	/** A stock item's unit, written after its counts. */
	readonly unit?: string | null;
};

/** journalFields in camelCase, per table, exactly as the API names a change's field. */
export const wordedFields = {
	tasks: ['title', 'body', 'status', 'ownerId', 'due', 'evidenceRequired', 'completedBy', 'completedAt', 'seriesId', 'periodStart', 'periodEnd'],
	task_series: ['title', 'body', 'ownerId', 'evidenceRequired', 'recurrence', 'everyMonths', 'anchor', 'dueOffsetDays', 'pausedAt'],
	evidence: ['kind', 'reference', 'label'],
	equipment: ['name', 'archivedAt'],
	equipment_reservations: ['equipmentId', 'title', 'kind', 'status', 'startsAt', 'endsAt', 'setupMinutes', 'cleanupMinutes', 'taskId', 'ownerId'],
	stock_items: ['name', 'location', 'unitLabel', 'currentCount', 'countedAt', 'countedBy', 'reorderPoint', 'preferredSupplierId', 'notes', 'archivedAt'],
	tags: ['name', 'ownerId', 'startsOn', 'endsOn', 'archivedAt'],
	thread_tags: [],
	task_series_tags: []
} as const satisfies Record<string, readonly string[]>;
export type Table = keyof typeof wordedFields;

/** Which table a change came from: a record's own fields, or one of its items. */
export function tableOf(change: Pick<LineChange, 'recordKind' | 'itemKind'>): Table | null {
	if (change.itemKind === 'tag') return change.recordKind === 'series' ? 'task_series_tags' : 'thread_tags';
	if (change.itemKind === 'step') return change.recordKind === 'task' ? 'tasks' : null;
	if (change.itemKind === 'evidence') return change.recordKind === 'task' ? 'evidence' : null;
	switch (change.recordKind) {
		case 'task': return 'tasks';
		case 'series': return 'task_series';
		case 'equipment': return 'equipment';
		case 'reservation': return 'equipment_reservations';
		case 'stock_item': return 'stock_items';
		case 'tag': return 'tags';
		default: return null;
	}
}

// ---- values ---------------------------------------------------------------------------------------------------

const strong = (text: string): Segment => ({ text, strong: true });
const plain = (text: string): Segment => ({ text });
const clip = (value: string, max = 80) => { const chars = [...value.trim().replace(/\s+/g, ' ')]; return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
const asText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : null;
/** A full row's field, whichever case the API's JSON transform gave its keys. */
export function rowField(row: unknown, camel: string): unknown {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
	const r = row as Record<string, unknown>;
	if (Object.hasOwn(r, camel)) return r[camel];
	const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
	return Object.hasOwn(r, snake) ? r[snake] : undefined;
}

const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A calendar date as people say it: "Tue 6 Oct", with the year when it is not `year`. Never shifted by a time zone. */
export function wordDate(value: string, year?: number): string {
	const m = dateOnly.exec(value);
	if (!m) return value;
	const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	if (!Number.isFinite(at)) return value;
	const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(at);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const base = `${get('weekday')} ${get('day')} ${get('month')}`;
	return year !== undefined && Number(m[1]) === year ? base : `${base} ${m[1]}`;
}

/** An instant as a date and a clock time in the zone: "Thu 8 Oct, 8:00 am". */
export function wordInstant(value: string, zone?: string, year?: number): { day: string; time: string } | null {
	const at = Date.parse(value);
	if (!Number.isFinite(at)) return null;
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, ...(zone ? { timeZone: zone } : {}) }).formatToParts(at);
	} catch { return null; }
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const y = get('year');
	const day = `${get('weekday')} ${get('day')} ${get('month')}${year !== undefined && y === String(year) ? '' : ` ${y}`}`;
	return { day, time: `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}` };
}

/** Minutes of setup or cleanup: "none", "30 minutes", "1 hour", "1 hour 30 minutes". */
export function wordMinutes(value: unknown): string {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return String(value);
	if (value === 0) return 'none';
	const h = Math.floor(value / 60), m = value % 60;
	const hours = h ? `${h} hour${h === 1 ? '' : 's'}` : '', minutes = m ? `${m} minute${m === 1 ? '' : 's'}` : '';
	return [hours, minutes].filter(Boolean).join(' ');
}

const taskStatus: Record<string, string> = { suggested: 'Suggested', open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const recurrence: Record<string, string> = { monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', weekdays: 'weekdays', custom: 'custom' };
const label = (value: unknown, labels: Record<string, string>) => { const t = asText(value); return t === null ? null : labels[t] ?? t; };

type Formatter = (value: unknown) => string | null;
const asWords: Formatter = (v) => { const t = asText(v); return t === null ? null : clip(t); };

// ---- phrases --------------------------------------------------------------------------------------------------

/** A phrase, or a countable one that merges with others of its `key` ("ticked the steps A and B", "ticked 4 steps"). */
type Phrase = { kind: 'words'; segments: Segment[] } | { kind: 'list'; key: string; singular: string; plural: string; object: Segment };
const words = (...segments: Segment[]): Phrase => ({ kind: 'words', segments });
const listed = (key: string, singular: string, plural: string, object: Segment): Phrase => ({ kind: 'list', key, singular, plural, object });

/** "changed the due date from A to B", "set the due date to B", "cleared the due date". */
function fieldPhrase(what: string, before: unknown, after: unknown, format: Formatter): Phrase {
	const a = before === null || before === undefined ? null : format(before), b = after === null || after === undefined ? null : format(after);
	if (a === null && b === null) return words(plain(`changed the ${what}`));
	if (a === null) return words(plain(`set the ${what} to `), strong(b!));
	if (b === null) return words(plain(`cleared the ${what}`));
	return words(plain(`changed the ${what} from `), strong(a), plain(' to '), strong(b));
}
const generic = (field: string | null) => words(plain(field ? `changed the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}` : 'made a change'));

type Context = { options: WordingOptions; person: Formatter; date: Formatter };

function stepName(change: LineChange, ctx: Context): Segment {
	const fromRow = asText(rowField(change.after, 'title')) ?? asText(rowField(change.before, 'title'));
	const name = fromRow ?? (change.itemId ? ctx.options.names?.step?.(change.itemId) : null);
	return name ? strong(clip(name)) : plain('a step');
}
function tagName(change: LineChange, ctx: Context): Segment {
	const id = change.itemId;
	const name = id ? ctx.options.names?.tag?.(id) : null;
	return name ? strong(clip(name)) : plain('a tag');
}
function rowTitle(row: unknown, ...fields: string[]): Segment | null {
	for (const f of fields) { const t = asText(rowField(row, f)); if (t) return strong(clip(t)); }
	return null;
}

/** Created or removed: a record, a step, a piece of evidence. Attached or detached: a tag. */
function itemPhrase(change: LineChange, ctx: Context): Phrase {
	const row = change.operation === 'create' || change.operation === 'attach' ? change.after : change.before;
	const made = change.operation === 'create';
	if (change.itemKind === 'tag') return change.operation === 'attach' ? listed('tag+', 'added the tag', 'added the tags', tagName(change, ctx)) : listed('tag-', 'removed the tag', 'removed the tags', tagName(change, ctx));
	if (change.itemKind === 'step') return made ? listed('step+', 'added the step', 'added the steps', stepName(change, ctx)) : listed('step-', 'removed the step', 'removed the steps', stepName(change, ctx));
	if (change.itemKind === 'evidence') {
		const what = rowTitle(row, 'label', 'reference');
		return words(plain(made ? 'attached evidence' : 'removed the evidence'), ...(what ? [plain(' '), what] : []));
	}
	const noun: Record<string, [string, string[]]> = {
		task: ['the task', ['title']], reservation: ['the booking', ['title']], stock_item: ['the stock item', ['name']],
		series: ['the recurring task', ['title']], equipment: ['the equipment', ['name']], tag: ['the tag', ['name']], thread: ['the thread', ['title']]
	};
	const [name, fields] = noun[change.recordKind] ?? ['the record', ['title']];
	const title = rowTitle(row, ...fields);
	if (change.recordKind === 'reservation' && made) return title ? words(plain('booked '), title) : words(plain('made this booking'));
	return words(plain(made ? `created ${name}` : `removed ${name}`), ...(title ? [plain(' '), title] : []));
}

/** One booking time phrase from any of its start, end, setup and cleanup changes (they are undone together, §4). */
function timePhrase(changes: LineChange[], ctx: Context): Phrase {
	const get = (f: string) => changes.find((c) => c.field === f);
	const start = get('startsAt'), end = get('endsAt'), setup = get('setupMinutes'), cleanup = get('cleanupMinutes');
	const at = (v: unknown) => typeof v === 'string' ? wordInstant(v, ctx.options.zone, ctx.options.year) : null;
	const range = (s: unknown, e: unknown) => {
		const a = at(s), b = at(e);
		if (!a || !b) return null;
		return a.day === b.day ? `${a.day}, ${a.time}–${b.time}` : `${a.day}, ${a.time} – ${b.day}, ${b.time}`;
	};
	const parts: Segment[][] = [];
	if (start && end) {
		const from = range(start.before, end.before), to = range(start.after, end.after);
		parts.push(from && to ? [plain('changed the time from '), strong(from), plain(' to '), strong(to)] : [plain('changed the time')]);
	} else {
		for (const [c, what] of [[start, 'start'], [end, 'end']] as const) {
			if (!c) continue;
			const a = at(c.before), b = at(c.after);
			parts.push(a && b ? [plain(`changed the ${what} from `), strong(`${a.day}, ${a.time}`), plain(' to '), strong(a.day === b.day ? b.time : `${b.day}, ${b.time}`)] : [plain(`changed the ${what} time`)]);
		}
	}
	for (const [c, what] of [[setup, 'setup'], [cleanup, 'cleanup']] as const) {
		if (!c) continue;
		parts.push([plain(`${parts.length ? '' : 'changed the '}${what} from `), strong(wordMinutes(c.before)), plain(' to '), strong(wordMinutes(c.after))]);
	}
	const segments: Segment[] = [];
	parts.forEach((p, i) => { if (i) segments.push(plain(i === parts.length - 1 ? ' and ' : ', ')); segments.push(...p); });
	return words(...segments);
}

function countPhrase(changes: LineChange[], ctx: Context): Phrase {
	const count = changes.find((c) => c.field === 'currentCount');
	const unit = ctx.options.unit ? ` ${ctx.options.unit}` : '';
	const n = (v: unknown) => asText(v) === null ? null : `${asText(v)}${unit}`;
	if (!count) return words(plain('counted it again, with no change to the count'));
	const a = n(count.before), b = n(count.after);
	if (b === null) return words(plain('cleared the count'));
	if (a === null) return words(plain('counted '), strong(b));
	return words(plain('changed the count from '), strong(a), plain(' to '), strong(b));
}

/** A task's or step's status, with its completion fields (coupled, §4). */
function statusPhrase(changes: LineChange[], ctx: Context, step: boolean): Phrase {
	const status = changes.find((c) => c.field === 'status');
	if (!status) {
		const done = changes.find((c) => c.field === 'completedAt') ?? changes.find((c) => c.field === 'completedBy');
		return words(plain(done && done.after !== null ? 'recorded who completed it' : 'cleared its completion'));
	}
	const before = asText(status.before), after = asText(status.after);
	if (step) {
		const name = changes[0] ? stepName(changes[0], ctx) : plain('a step');
		if (after === 'done') return listed('tick', 'ticked the step', 'ticked the steps', name);
		if (before === 'done') return listed('untick', 'unticked the step', 'unticked the steps', name);
		if (after === 'cancelled') return listed('cancel-step', 'cancelled the step', 'cancelled the steps', name);
		return words(plain('changed the step '), name, plain(' from '), strong(label(before, taskStatus) ?? '?'), plain(' to '), strong(label(after, taskStatus) ?? '?'));
	}
	return fieldPhrase('status', status.before, status.after, (v) => label(v, taskStatus));
}

/** A single field change of a known table. */
function fieldOf(table: Table, change: LineChange, ctx: Context): Phrase {
	const f = change.field!, b = change.before, a = change.after;
	const person = ctx.person, date = ctx.date;
	const onStep = change.itemKind === 'step';
	if (onStep && table === 'tasks') {
		const name = stepName(change, ctx);
		if (f === 'title') return words(plain('renamed the step '), ...(asWords(b) ? [strong(asWords(b)!)] : [plain('')]), plain(' to '), strong(asWords(a) ?? ''));
		const inner = fieldOf(table, { ...change, itemKind: null, itemId: null }, ctx);
		const segs = inner.kind === 'words' ? inner.segments : [plain(inner.singular), plain(' '), inner.object];
		return words(...segs, plain(' on the step '), name);
	}
	switch (table) {
		case 'tasks': case 'task_series':
			switch (f) {
				case 'title': return fieldPhrase('title', b, a, asWords);
				case 'body': return words(plain(a ? 'edited the description' : 'cleared the description'));
				case 'ownerId': return fieldPhrase('owner', b, a, person);
				case 'due': return fieldPhrase('due date', b, a, date);
				case 'evidenceRequired': return words(plain(a === true ? 'required evidence' : 'stopped requiring evidence'));
				case 'seriesId': return words(plain(a ? 'linked it to recurring work' : 'unlinked it from its recurring work'));
				case 'periodStart': return fieldPhrase('period start', b, a, date);
				case 'periodEnd': return fieldPhrase('period end', b, a, date);
				case 'recurrence': return fieldPhrase('repeat', b, a, (v) => label(v, recurrence));
				case 'everyMonths': return fieldPhrase('interval', b, a, (v) => typeof v === 'number' ? `every ${v} month${v === 1 ? '' : 's'}` : null);
				case 'anchor': return fieldPhrase('start date', b, a, date);
				case 'dueOffsetDays': return fieldPhrase('due offset', b, a, (v) => typeof v === 'number' ? `${v} day${Math.abs(v) === 1 ? '' : 's'}` : null);
				case 'pausedAt': return words(plain(a ? 'paused the recurring work' : 'resumed the recurring work'));
			}
			break;
		case 'evidence':
			switch (f) {
				case 'kind': return fieldPhrase('evidence kind', b, a, asWords);
				case 'reference': return words(plain('changed the evidence link'));
				case 'label': return fieldPhrase('evidence label', b, a, asWords);
			}
			break;
		case 'equipment':
			switch (f) {
				case 'name': return words(plain('renamed the equipment from '), strong(asWords(b) ?? ''), plain(' to '), strong(asWords(a) ?? ''));
				case 'archivedAt': return words(plain(a ? 'archived the equipment' : 'restored the equipment'));
			}
			break;
		case 'equipment_reservations':
			switch (f) {
				case 'equipmentId': return fieldPhrase('equipment', b, a, (v) => typeof v === 'string' ? ctx.options.names?.equipment?.(v) ?? 'other equipment' : null);
				case 'title': return fieldPhrase('title', b, a, asWords);
				case 'kind': return fieldPhrase('kind', b, a, (v) => v === 'maintenance' ? 'Maintenance' : v === 'booking' ? 'Booking' : asWords(v));
				case 'status': return words(plain(a === 'cancelled' ? 'cancelled the booking' : a === 'confirmed' ? 'restored the booking' : 'changed the booking status'));
				case 'taskId': return a ? words(plain('linked it to the task '), ...(typeof a === 'string' && ctx.options.names?.task?.(a) ? [strong(clip(ctx.options.names.task(a)!))] : [plain('')])) : words(plain('unlinked it from its task'));
				case 'ownerId': return fieldPhrase('owner', b, a, person);
			}
			break;
		case 'stock_items':
			switch (f) {
				case 'name': return fieldPhrase('name', b, a, asWords);
				case 'location': return fieldPhrase('location', b, a, asWords);
				case 'unitLabel': return fieldPhrase('unit', b, a, asWords);
				case 'reorderPoint': return fieldPhrase('reorder point', b, a, (v) => asText(v) === null ? null : `${asText(v)}${ctx.options.unit ? ` ${ctx.options.unit}` : ''}`);
				case 'preferredSupplierId': return words(plain(a ? 'changed the preferred supplier' : 'cleared the preferred supplier'));
				case 'notes': return words(plain(a ? 'edited the notes' : 'cleared the notes'));
				case 'archivedAt': return words(plain(a ? 'archived the item' : 'restored the item'));
			}
			break;
		case 'tags':
			switch (f) {
				case 'name': return words(plain('renamed the tag from '), strong(asWords(b) ?? ''), plain(' to '), strong(asWords(a) ?? ''));
				case 'ownerId': return fieldPhrase('tag owner', b, a, person);
				case 'startsOn': return fieldPhrase('tag start', b, a, date);
				case 'endsOn': return fieldPhrase('tag end', b, a, date);
				case 'archivedAt': return words(plain(a ? 'archived the tag' : 'restored the tag'));
			}
			break;
	}
	return generic(f);
}

/** The slot a change words in: coupled fields share one phrase at the first one's place. */
function slotOf(change: LineChange, table: Table | null): string {
	const scope = `${change.recordKind}:${change.recordId}:${change.itemKind ?? ''}:${change.itemId ?? ''}`;
	if (change.operation !== 'update' || !table) return `change:${change.id}`;
	const f = change.field!;
	if (table === 'equipment_reservations' && ['startsAt', 'endsAt', 'setupMinutes', 'cleanupMinutes'].includes(f)) return `${scope}:time`;
	if (table === 'tasks' && ['status', 'completedBy', 'completedAt'].includes(f)) return `${scope}:status`;
	if (table === 'stock_items' && ['currentCount', 'countedAt', 'countedBy'].includes(f)) return `${scope}:count`;
	return `change:${change.id}`;
}

function phrasesOf(line: ChangeLine, ctx: Context): Phrase[] {
	const slots = new Map<string, LineChange[]>();
	for (const change of line.changes) {
		const key = slotOf(change, tableOf(change));
		slots.set(key, [...(slots.get(key) ?? []), change]);
	}
	const phrases: Phrase[] = [];
	for (const [key, changes] of slots) {
		const first = changes[0]!, table = tableOf(first);
		if (first.operation !== 'update') phrases.push(itemPhrase(first, ctx));
		else if (!table) phrases.push(generic(first.field));
		else if (key.endsWith(':time')) phrases.push(timePhrase(changes, ctx));
		else if (key.endsWith(':status')) phrases.push(statusPhrase(changes, ctx, first.itemKind === 'step'));
		else if (key.endsWith(':count')) phrases.push(countPhrase(changes, ctx));
		else phrases.push((wordedFields[table] as readonly string[]).includes(first.field!) ? fieldOf(table, first, ctx) : generic(first.field));
	}
	return phrases;
}

/** Countable phrases of one key merge at the first one's place. */
function merged(phrases: Phrase[]): Segment[][] {
	const out: Segment[][] = [];
	const lists = new Map<string, { at: number; singular: string; plural: string; objects: Segment[] }>();
	for (const p of phrases) {
		if (p.kind === 'words') { out.push(p.segments); continue; }
		const known = lists.get(p.key);
		if (known) { known.objects.push(p.object); continue; }
		lists.set(p.key, { at: out.length, singular: p.singular, plural: p.plural, objects: [p.object] });
		out.push([]);
	}
	for (const list of lists.values()) {
		const n = list.objects.length;
		// An object with no name ("a tag") takes the verb alone: "removed a tag", not "removed the tag a tag".
		if (n === 1) out[list.at] = list.objects[0]!.strong ? [plain(`${list.singular} `), list.objects[0]!] : [plain(`${list.singular.replace(/ the \w+$/, '')} `), list.objects[0]!];
		else if (n <= 3) out[list.at] = [plain(`${list.plural} `), ...joined(list.objects.map((o) => [o]))];
		else out[list.at] = [plain(`${list.plural.replace(/^(\w+) the (\w+)$/, `$1 ${n} $2`)}`)];
	}
	return out;
}

function joined(parts: Segment[][], more = false): Segment[] {
	const all = more ? [...parts, [plain('more')]] : parts;
	const segments: Segment[] = [];
	all.forEach((p, i) => { if (i) segments.push(plain(i === all.length - 1 ? ' and ' : ', ')); segments.push(...p); });
	return segments;
}

export function firstNameOf(name: string | null): string | null { return name?.trim().split(/\s+/)[0] || null; }

/** Who acted, named plainly: a person by first name; the system routine as "Captain"; a workflow as its person's. */
export function actorOf(line: Pick<ChangeLine, 'actorKind' | 'actorName'>): string {
	const first = firstNameOf(line.actorName);
	if (line.actorKind === 'system') return 'Captain';
	if (line.actorKind === 'workflow') return first ? `${first}’s workflow` : 'A workflow';
	return first ?? 'A former member';
}

/** The whole line: who, then what, as segments (strong ones are values) and as one plain sentence. */
export function wordChangeLine(line: ChangeLine, options: WordingOptions = {}): { segments: Segment[]; text: string } {
	const ctx: Context = {
		options,
		person: (v) => typeof v === 'string' ? options.names?.person?.(v) ?? 'another member' : null,
		date: (v) => typeof v === 'string' ? wordDate(v, options.year) : null
	};
	const parts = merged(phrasesOf(line, ctx));
	const body = parts.length ? joined(parts, line.truncated) : [plain(line.truncated ? 'made several changes' : 'made a change')];
	const segments: Segment[] = [strong(actorOf(line)), plain(' '), ...body].filter((s) => s.text !== '');
	return { segments, text: segments.map((s) => s.text).join('') };
}
