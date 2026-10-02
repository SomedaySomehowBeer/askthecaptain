import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ChangeLine, LineChange } from './contracts.ts';
import { parseChangeLine, parseLineChange, parseMessage } from './parse.ts';
import { actorOf, tableOf, wordChangeLine, wordDate, wordInstant, wordMinutes, wordedFields, type Table } from './wording.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = id(1), step = id(2), tag = id(3), maya = id(4), tom = id(5), booking = id(6), item = id(7), tank = id(8);
let n = 100;
const change = (c: Partial<LineChange>): LineChange => ({ id: id(n++), recordKind: 'task', recordId: task, operation: 'update', field: null, itemKind: null, itemId: null, before: null, after: null, ...c });
const line = (changes: LineChange[], extra: Partial<ChangeLine> = {}): ChangeLine => ({ actorKind: 'person', actorId: maya, actorName: 'Maya Chen', causeKind: 'request', createdAt: '2026-10-01T06:40:00.000Z', changes, truncated: false, ...extra });
const names = { person: (v: string) => ({ [maya]: 'Maya Chen', [tom]: 'Tom Reilly' })[v], tag: (v: string) => v === tag ? 'Production' : null, step: (v: string) => v === step ? 'Book the canning line' : null, equipment: (v: string) => v === tank ? 'Canning line' : null };
const say = (l: ChangeLine, unit?: string) => wordChangeLine(l, { names, year: 2026, zone: 'Australia/Sydney', unit }).text;

test('the reviewed lines (design board 4) are worded exactly', () => {
	assert.equal(say(line([change({ field: 'due', before: '2026-10-06', after: '2026-10-08' }), change({ operation: 'attach', itemKind: 'tag', itemId: tag, after: { threadId: id(9), tagId: tag } })])),
		'Maya changed the due date from Tue 6 Oct to Thu 8 Oct and added the tag Production');
	assert.equal(say(line([change({ field: 'ownerId', before: maya, after: tom })], { actorId: tom, actorName: 'Tom Reilly' })), 'Tom changed the owner from Maya Chen to Tom Reilly');
	assert.equal(say(line([change({ itemKind: 'step', itemId: step, field: 'status', before: 'open', after: 'done' }), change({ itemKind: 'step', itemId: step, field: 'completedBy', before: null, after: tom }),
		change({ itemKind: 'step', itemId: step, field: 'completedAt', before: null, after: '2026-10-02T09:20:00+00:00' })], { actorName: 'Tom Reilly' })), 'Tom ticked the step Book the canning line');
	const bold = wordChangeLine(line([change({ field: 'due', before: '2026-10-06', after: '2026-10-08' })]), { year: 2026 }).segments.filter((s) => s.strong).map((s) => s.text);
	assert.deepEqual(bold, ['Maya', 'Tue 6 Oct', 'Thu 8 Oct']);
});

test('creation, removal, steps, evidence, tags and a status with its completion fields', () => {
	assert.equal(say(line([change({ operation: 'create', after: { id: task, title: 'Order cans', status: 'open' } })])), 'Maya created the task Order cans');
	assert.equal(say(line([change({ operation: 'create', itemKind: 'step', itemId: id(20), after: { title: 'Weigh the malt' } })])), 'Maya added the step Weigh the malt');
	assert.equal(say(line([change({ operation: 'remove', itemKind: 'step', itemId: id(20), before: { title: 'Weigh the malt' } })])), 'Maya removed the step Weigh the malt');
	assert.equal(say(line([change({ itemKind: 'step', itemId: step, field: 'status', before: 'done', after: 'open' })])), 'Maya unticked the step Book the canning line');
	assert.equal(say(line([change({ itemKind: 'step', itemId: id(21), field: 'title', before: 'Wrap', after: 'Order pallet wrap' })])), 'Maya renamed the step Wrap to Order pallet wrap');
	assert.equal(say(line([change({ operation: 'create', itemKind: 'evidence', itemId: id(22), after: { kind: 'url', reference: 'https://example.test/r', label: 'Recipe' } })])), 'Maya attached evidence Recipe');
	assert.equal(say(line([change({ operation: 'detach', itemKind: 'tag', itemId: id(23), before: { tagId: id(23) } })])), 'Maya removed a tag', 'an unknown tag is said plainly');
	const done = line([change({ field: 'status', before: 'in_progress', after: 'done' }), change({ field: 'completedBy', before: null, after: maya }), change({ field: 'completedAt', before: null, after: '2026-10-02T00:00:00+00:00' }),
		...[30, 31, 32, 33].map((s) => change({ itemKind: 'step', itemId: id(s), field: 'status', before: 'open', after: 'done' }))]);
	assert.equal(say(done), 'Maya changed the status from In progress to Done and ticked 4 steps');
	assert.equal(say(line([change({ field: 'title', before: 'Pack', after: 'Package summer lager' }), change({ field: 'ownerId', before: null, after: id(77) }), change({ field: 'due', before: '2026-10-06', after: null })])),
		'Maya changed the title from Pack to Package summer lager, set the owner to another member and cleared the due date');
	assert.equal(say(line([change({ operation: 'attach', itemKind: 'tag', itemId: tag, after: {} }), change({ operation: 'attach', itemKind: 'tag', itemId: id(24), after: {} })])), 'Maya added the tags Production and a tag');
});

test('a booking time is one phrase; setup and cleanup join it; status, title and equipment', () => {
	const r = (c: Partial<LineChange>) => change({ recordKind: 'reservation', recordId: booking, ...c });
	assert.equal(say(line([r({ field: 'startsAt', before: '2026-10-07T21:00:00+00:00', after: '2026-10-07T22:00:00+00:00' }), r({ field: 'endsAt', before: '2026-10-08T01:00:00+00:00', after: '2026-10-08T02:00:00+00:00' }),
		r({ field: 'setupMinutes', before: 0, after: 30 })])), 'Maya changed the time from Thu 8 Oct, 8:00 am–12:00 pm to Thu 8 Oct, 9:00 am–1:00 pm and setup from none to 30 minutes');
	assert.equal(say(line([r({ field: 'cleanupMinutes', before: 30, after: 60 })])), 'Maya changed the cleanup from 30 minutes to 1 hour');
	assert.equal(say(line([r({ field: 'endsAt', before: '2026-10-08T01:00:00+00:00', after: '2026-10-08T03:30:00+00:00' })])), 'Maya changed the end from Thu 8 Oct, 12:00 pm to 2:30 pm');
	assert.equal(say(line([r({ field: 'status', before: 'confirmed', after: 'cancelled' })])), 'Maya cancelled the booking');
	assert.equal(say(line([r({ operation: 'create', after: { title: 'Summer lager canning run' } })])), 'Maya booked Summer lager canning run');
	assert.equal(say(line([r({ field: 'equipmentId', before: id(40), after: tank })])), 'Maya changed the equipment from other equipment to Canning line');
	assert.equal(say(line([r({ field: 'title', before: 'Canning', after: 'Summer lager canning run' })])), 'Maya changed the title from Canning to Summer lager canning run');
});

test('a stock count words its count with the unit, and a recount at the same value says so', () => {
	const s = (c: Partial<LineChange>) => change({ recordKind: 'stock_item', recordId: item, ...c });
	assert.equal(say(line([s({ field: 'currentCount', before: null, after: '4.5' }), s({ field: 'countedAt', before: null, after: '2026-10-02T00:00:00+00:00' }), s({ field: 'countedBy', before: null, after: maya })]), 'kg'), 'Maya counted 4.5 kg');
	assert.equal(say(line([s({ field: 'currentCount', before: '4.5', after: '3' }), s({ field: 'countedAt', before: 'a', after: 'b' })]), 'kg'), 'Maya changed the count from 4.5 kg to 3 kg');
	assert.equal(say(line([s({ field: 'countedAt', before: 'a', after: 'b' })])), 'Maya counted it again, with no change to the count');
});

test('actors are named plainly; a missing name, an empty or truncated line and an unknown field never crash', () => {
	assert.equal(actorOf({ actorKind: 'system', actorName: null }), 'Captain');
	assert.equal(actorOf({ actorKind: 'workflow', actorName: 'Tom Reilly' }), 'Tom’s workflow');
	assert.equal(actorOf({ actorKind: 'person', actorName: null }), 'A former member');
	assert.equal(say(line([], { actorKind: 'system', actorId: null, actorName: null })), 'Captain made a change');
	assert.equal(say(line([change({ field: 'mysteryField', before: 1, after: 2 })])), 'Maya changed the mystery field');
	assert.equal(say(line([change({ recordKind: 'thread', field: 'title', before: 'a', after: 'b' })])), 'Maya changed the title', 'a field of a table with no wording');
	const many = line(Array.from({ length: 50 }, (_, i) => change({ itemKind: 'step', itemId: id(200 + i), field: 'status', before: 'open', after: 'done' })), { truncated: true });
	assert.equal(say(many), 'Maya ticked 50 steps and more');
});

test('dates, instants and minutes are formatted without shifting a calendar date', () => {
	assert.equal(wordDate('2026-10-06', 2026), 'Tue 6 Oct'); assert.equal(wordDate('2031-05-01', 2026), 'Thu 1 May 2031'); assert.equal(wordDate('soon'), 'soon');
	assert.deepEqual(wordInstant('2026-10-07T21:00:00.000Z', 'Australia/Sydney', 2026), { day: 'Thu 8 Oct', time: '8:00 am' });
	assert.equal(wordInstant('nope'), null);
	assert.deepEqual([0, 1, 30, 60, 90, 120].map(wordMinutes), ['none', '1 minute', '30 minutes', '1 hour', '1 hour 30 minutes', '2 hours']);
});

/** The mirror: every field the database journals has a phrase. Reads the API's list as text (the client may not import
 *  across the package boundary); a field added there and not here fails this test. */
test('every journalled field in packages/db/src/versions.ts is worded, and nothing worded is unknown to it', () => {
	const source = readFileSync(new URL('../../../../packages/db/src/versions.ts', import.meta.url), 'utf8');
	const block = /export const journalFields = \{([\s\S]*?)\} as const/.exec(source)?.[1];
	assert.ok(block, 'journalFields is where this test expects it');
	const camel = (f: string) => f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
	const tables = Object.fromEntries([...block.matchAll(/(\w+): \[([^\]]*)\]/g)].map((m) => [m[1]!, [...m[2]!.matchAll(/'([a-z_]+)'/g)].map((f) => camel(f[1]!))]));
	assert.deepEqual(Object.keys(tables).sort(), Object.keys(wordedFields).sort());
	for (const [table, fields] of Object.entries(tables)) assert.deepEqual([...wordedFields[table as Table]].sort(), [...fields].sort(), table);
	// Each one words without falling back to the generic phrase.
	const recordOf: Record<Table, Partial<LineChange>> = { tasks: {}, task_series: { recordKind: 'series' }, evidence: { itemKind: 'evidence', itemId: id(50) }, equipment: { recordKind: 'equipment' },
		equipment_reservations: { recordKind: 'reservation' }, stock_items: { recordKind: 'stock_item' }, tags: { recordKind: 'tag' }, thread_tags: {}, task_series_tags: {} };
	for (const [table, fields] of Object.entries(wordedFields) as [Table, readonly string[]][]) for (const field of fields) {
		const c = change({ ...recordOf[table], field, before: 'x', after: 'y' });
		assert.equal(tableOf(c), table);
		const text = say(line([c]));
		assert.notEqual(text, `Maya changed the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}`, `${table}.${field} fell back to the generic phrase`);
		assert.ok(text.startsWith('Maya ') && text.length > 'Maya '.length, `${table}.${field}`);
	}
});

test('change lines parse strictly: shape rules, no body, a system actor has no id, and anything unknown is refused', () => {
	const message = { id: id(60), threadId: id(61), kind: 'change', seq: 3, changeSeq: 3, authorId: maya, authorName: 'Maya Chen', body: null, createdAt: '2026-10-01T06:40:00.000Z', editedAt: null, deletedAt: null, deletedBy: null, revision: 1,
		changeSetId: id(62), change: line([change({ field: 'due', before: '2026-10-06', after: '2026-10-08' })]) };
	const parsed = parseMessage(message);
	assert.equal(parsed.kind, 'change'); assert.equal(parsed.changeSetId, id(62)); assert.equal(parsed.change?.changes[0]?.field, 'due');
	for (const bad of [{ ...message, body: 'text' }, { ...message, changeSetId: undefined }, { ...message, change: undefined }, { ...message, kind: 'approval' }, { ...message, deletedAt: message.createdAt },
		{ ...message, extra: 1 }, { ...message, change: { ...message.change, actorKind: 'agent' } }, { ...message, change: { ...message.change, actorKind: 'system', actorId: maya } },
		{ ...message, change: { ...message.change, truncated: true } }])
		assert.throws(() => parseMessage(bad));
	assert.throws(() => parseMessage({ ...message, kind: 'message' }), 'a plain message has no change set');
	const good = { id: id(63), recordKind: 'task', recordId: task, operation: 'update', field: 'due', itemKind: null, itemId: null, before: null, after: '2026-10-08' };
	assert.equal(parseLineChange(good).field, 'due');
	for (const bad of [{ ...good, field: null }, { ...good, field: 'due_date' }, { ...good, operation: 'create' }, { ...good, operation: 'attach', field: null, after: {} }, { ...good, itemKind: 'step' },
		{ ...good, recordKind: 'booking' }, { ...good, operation: 'remove', field: null, before: null }, { ...good, after: 'x'.repeat(20001) }, { ...good, before: undefined }])
		assert.throws(() => parseLineChange(bad), JSON.stringify(bad).slice(0, 80));
	assert.throws(() => parseChangeLine({ ...line([]), causeKind: 'message' }), 'a cause this client does not know');
});
