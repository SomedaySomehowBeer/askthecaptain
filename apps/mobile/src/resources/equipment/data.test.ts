import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	equipmentPageParser, occupancyParser, organisationZoneParser, parseEquipmentPage, parseOccupancy, parseOrganisationZone,
	type OccupancyRequest
} from './data.ts';

const org = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const eid = '0190c0de-0000-7000-8000-00000000e001';
const uuid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const message = 'Equipment schedule response is not valid';
const secretish = 'sess_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
/** Refused with the one fixed message, which never repeats a value. */
const refuses = (run: () => unknown, label: string) =>
	assert.throws(run, (error: unknown) => error instanceof TypeError && error.message === message, label);
/** Every own key, recursively: proves nothing but the kept fields reaches state. */
const keys = (value: unknown): string[] => value === null || typeof value !== 'object' ? []
	: Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
const deepFrozen = (value: unknown): boolean => value === null || typeof value !== 'object'
	|| (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

test('organisation zone: only the timezone of the organisation asked for is kept', () => {
	const answer = parseOrganisationZone({ id: org, name: 'Brewery', timezone: 'Australia/Perth', locale: 'en-AU', createdAt: '2026-01-01T00:00:00.000Z', role: 'owner' }, org);
	assert.deepEqual(answer, { timezone: 'Australia/Perth' });
	assert.ok(Object.isFrozen(answer));
	assert.deepEqual(organisationZoneParser(org)({ id: org, timezone: 'x'.repeat(64) }), { timezone: 'x'.repeat(64) }, 'a free 1–64 character name; the zone gate decides');
	for (const [value, label] of [
		[{ id: uuid(9), timezone: 'UTC' }, 'another organisation'], [{ id: org.toUpperCase(), timezone: 'UTC' }, 'non-canonical id'],
		[{ timezone: 'UTC' }, 'no id'], [{ id: org }, 'no zone'], [{ id: org, timezone: '' }, 'empty zone'], [{ id: org, timezone: 'x'.repeat(65) }, '65 characters'],
		[{ id: org, timezone: 8 }, 'number zone'], [null, 'null'], [[{ id: org, timezone: 'UTC' }], 'array'], ['UTC', 'string'], [{ id: org, timezone: secretish.repeat(2) }, 'long secret-ish']
	] as [unknown, string][]) refuses(() => parseOrganisationZone(value, org), label);
	refuses(() => parseOrganisationZone({ id: 'x', timezone: 'UTC' }, 'x'), 'a non-canonical expected organisation');
});

const item = (n: number, extra: Record<string, unknown> = {}) => ({
	id: uuid(n), name: `Fermenter ${n}`, archivedAt: null, revision: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra
});
const page = (count: number, from = 1) => Array.from({ length: count }, (_, i) => item(from + i));

test('equipment page: active equipment in API order, id and raw name only, frozen', () => {
	const answer = parseEquipmentPage({ equipment: [item(3, { name: '  Bright tank ' }), item(1), item(2)], nextOffset: null }, { offset: 0, limit: 100 });
	assert.deepEqual(answer, { equipment: [{ id: uuid(3), name: '  Bright tank ' }, { id: uuid(1), name: 'Fermenter 1' }, { id: uuid(2), name: 'Fermenter 2' }], nextOffset: null });
	assert.ok(deepFrozen(answer));
	assert.deepEqual([...new Set(keys(answer))].sort(), ['0', '1', '2', 'equipment', 'id', 'name', 'nextOffset']);
	assert.deepEqual(parseEquipmentPage({ equipment: [], nextOffset: null }, { offset: 0, limit: 100 }), { equipment: [], nextOffset: null }, 'a successful empty page');
	assert.equal(parseEquipmentPage({ equipment: [item(1, { name: 'n'.repeat(100) })], nextOffset: null }, { offset: 0, limit: 100 }).equipment[0]!.name.length, 100);
	assert.equal(parseEquipmentPage({ equipment: [item(1, { name: '🍺'.repeat(50) })], nextOffset: null }, { offset: 0, limit: 100 }).equipment[0]!.name.length, 100, 'UTF-16 length, as zod');
	assert.deepEqual(equipmentPageParser({ offset: 0, limit: 100 })({ equipment: [item(1)], nextOffset: null }), { equipment: [{ id: uuid(1), name: 'Fermenter 1' }], nextOffset: null });
});

test('equipment page: nextOffset is null or exactly offset + limit with the page full', () => {
	assert.equal(parseEquipmentPage({ equipment: page(100), nextOffset: 100 }, { offset: 0, limit: 100 }).nextOffset, 100);
	assert.equal(parseEquipmentPage({ equipment: page(100, 201), nextOffset: 300 }, { offset: 200, limit: 100 }).nextOffset, 300);
	assert.equal(parseEquipmentPage({ equipment: page(100), nextOffset: null }, { offset: 0, limit: 100 }).nextOffset, null, 'a full last page');
	assert.equal(parseEquipmentPage({ equipment: page(100), nextOffset: 1_000_100 }, { offset: 1_000_000, limit: 100 }).nextOffset, 1_000_100, 'past the API ceiling is still an honest answer; the screen words the stop');
	for (const [value, label] of [
		[{ equipment: page(99), nextOffset: 100 }, 'more claimed after a short page'], [{ equipment: page(100), nextOffset: 200 }, 'skips a page'],
		[{ equipment: page(100), nextOffset: 99 }, 'overlaps'], [{ equipment: page(100), nextOffset: 100.5 }, 'fractional'], [{ equipment: page(100), nextOffset: '100' }, 'string'],
		[{ equipment: page(100), nextOffset: -1 }, 'negative'], [{ equipment: page(1) }, 'missing nextOffset'], [{ equipment: page(101), nextOffset: null }, 'more rows than the limit'],
		[{ equipment: null, nextOffset: null }, 'no list'], [{ nextOffset: null }, 'no equipment key'], [[], 'array body']
	] as [unknown, string][]) refuses(() => parseEquipmentPage(value, { offset: 0, limit: 100 }), label);
});

test('equipment page: one bad item refuses the page', () => {
	for (const [bad, label] of [
		[{ id: uuid(1).toUpperCase() }, 'upper-case id'], [{ id: 'fermenter' }, 'not a uuid'], [{ id: undefined }, 'no id'], [{ name: '   ' }, 'blank name'],
		[{ name: 'n'.repeat(101) }, '101 characters'], [{ name: 7 }, 'number name'], [{ archivedAt: '2026-09-01T00:00:00.000Z' }, 'archived'], [{ archivedAt: undefined }, 'archivedAt missing']
	] as [Record<string, unknown>, string][]) refuses(() => parseEquipmentPage({ equipment: [item(2), item(1, bad)], nextOffset: null }, { offset: 0, limit: 100 }), label);
	refuses(() => parseEquipmentPage({ equipment: [item(1), item(1)], nextOffset: null }, { offset: 0, limit: 100 }), 'duplicate id within the page');
	refuses(() => parseEquipmentPage({ equipment: [item(1), null], nextOffset: null }, { offset: 0, limit: 100 }), 'a null row');
	for (const request of [{ offset: -1, limit: 100 }, { offset: 0, limit: 101 }, { offset: 0, limit: 0 }, { offset: 1.5, limit: 100 }, { offset: 1_000_001, limit: 100 }])
		refuses(() => parseEquipmentPage({ equipment: [], nextOffset: null }, request), `request ${JSON.stringify(request)}`);
});

const from = '2026-08-31T16:00:00.000Z', to = '2026-09-28T16:00:00.000Z';
const request: OccupancyRequest = { equipmentId: eid, from, to, zone: 'Australia/Perth' };
/** A booking 09:00–13:00 Perth on 2 September, with 30 minutes' setup and 60 minutes' cleanup. */
const row = (n = 1, extra: Record<string, unknown> = {}) => ({
	id: uuid(n), equipmentId: eid, title: 'Pale ale brew', kind: 'booking', status: 'confirmed',
	startsAt: '2026-09-02T01:00:00.000Z', endsAt: '2026-09-02T05:00:00.000Z', setupMinutes: 30, cleanupMinutes: 60,
	occupiedStartsAt: '2026-09-02T00:30:00.000Z', occupiedEndsAt: '2026-09-02T06:00:00.000Z',
	projectId: uuid(90), taskId: uuid(91), ownerId: uuid(92), createdBy: uuid(93), revision: 3,
	createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', ...extra
});
const answer = (reservations: unknown[], extra: Record<string, unknown> = {}) => ({ reservations, nextOffset: null, coverage: 'complete', from, to, timezone: 'Australia/Perth', ...extra });
const kept = { id: uuid(1), title: 'Pale ale brew', kind: 'booking', startsAt: '2026-09-02T01:00:00.000Z', endsAt: '2026-09-02T05:00:00.000Z',
	occupiedStartsAt: '2026-09-02T00:30:00.000Z', occupiedEndsAt: '2026-09-02T06:00:00.000Z', setupMinutes: 30, cleanupMinutes: 60, revision: 3 };
const rows = (count: number) => Array.from({ length: count }, (_, i) => row(i + 1));

test('occupancy: a complete read keeps only the drawn fields, frozen, in API order; no person or project data', () => {
	const read = parseOccupancy(answer([row(1), row(2, { title: ' Clean ', kind: 'maintenance', setupMinutes: 0, cleanupMinutes: 0, occupiedStartsAt: '2026-09-02T01:00:00.000Z', occupiedEndsAt: '2026-09-02T05:00:00.000Z' })]), request);
	assert.equal(read.kind, 'read');
	assert.ok(read.kind === 'read');
	assert.equal(read.coverage, 'complete');
	assert.deepEqual(read.reservations[0], kept);
	assert.equal(read.reservations[1]!.title, ' Clean ', 'kept raw');
	assert.equal(read.reservations[1]!.kind, 'maintenance');
	assert.ok(deepFrozen(read));
	for (const leaked of ['projectId', 'taskId', 'ownerId', 'createdBy', 'createdAt', 'updatedAt', 'status', 'equipmentId', 'timezone', 'from', 'to', 'nextOffset'])
		assert.ok(!keys(read).includes(leaked), leaked);
	assert.deepEqual(parseOccupancy(answer([]), request), { kind: 'read', coverage: 'complete', reservations: [] }, 'an empty complete read');
	assert.deepEqual(occupancyParser(request)(answer([row(1)])), { kind: 'read', coverage: 'complete', reservations: [kept] });
});

test('occupancy page facts: exactly two valid combinations; anything else is refused, never partial', () => {
	const partial = parseOccupancy(answer(rows(200), { coverage: 'partial', nextOffset: 200 }), request);
	assert.ok(partial.kind === 'read' && partial.coverage === 'partial' && partial.reservations.length === 200);
	const full = parseOccupancy(answer(rows(200)), request);
	assert.ok(full.kind === 'read' && full.coverage === 'complete', 'exactly 200 with nothing more is complete');
	for (const [value, label] of [
		[answer(rows(200), { coverage: 'complete', nextOffset: 200 }), 'complete with more'], [answer(rows(200), { coverage: 'partial', nextOffset: null }), 'partial with no more'],
		[answer(rows(199), { coverage: 'partial', nextOffset: 200 }), 'partial with a short page'], [answer(rows(200), { coverage: 'partial', nextOffset: 400 }), 'a second page offset'],
		[answer(rows(200), { coverage: 'partial', nextOffset: 200.5 }), 'fractional'], [answer(rows(200), { coverage: 'partial', nextOffset: '200' }), 'string'],
		[answer(rows(1), { nextOffset: -1 }), 'negative'], [answer(rows(1), { nextOffset: undefined }), 'missing nextOffset'], [answer(rows(1), { coverage: 'unknown' }), 'unknown coverage'],
		[answer(rows(1), { coverage: undefined }), 'missing coverage'], [answer(rows(201)), 'more than 200 rows'], [answer(rows(201), { coverage: 'partial', nextOffset: 200 }), '201 partial'],
		[answer(null as never), 'no list'], [[], 'array body'], [null, 'null body']
	] as [unknown, string][]) refuses(() => parseOccupancy(value, request), label);
});

test('occupancy answers must echo the exact window asked for', () => {
	for (const [extra, label] of [
		[{ from: '2026-08-31T16:00:00Z' }, 'non-canonical from'], [{ to: '2026-09-29T00:00:00.000+08:00' }, 'offset to'], [{ from: '2026-08-31T16:00:00.001Z' }, 'another from'],
		[{ to: from }, 'another to'], [{ from: undefined }, 'missing from']
	] as [Record<string, unknown>, string][]) refuses(() => parseOccupancy(answer([row(1)], extra), request), label);
});

test('timestamps: every instant is exactly the API serialisation', () => {
	for (const key of ['startsAt', 'endsAt', 'occupiedStartsAt', 'occupiedEndsAt']) {
		for (const bad of ['2026-09-02T01:00:00Z', '2026-09-02T09:00:00.000+08:00', '2026-09-02T01:00:00.000z', '2026-09-02 01:00:00.000Z', '2026-02-30T01:00:00.000Z', 1_788_310_800_000, null, ''])
			refuses(() => parseOccupancy(answer([row(1, { [key]: bad })]), request), `${key} ${String(bad)}`);
	}
});

test('actual time is inside 1900–2200 and at most 366 days; occupied buffers may extend beyond the bounds', () => {
	const early: OccupancyRequest = { equipmentId: eid, from: '1900-01-01T00:00:00.000Z', to: '1900-01-29T00:00:00.000Z', zone: 'UTC' };
	const atStart = { startsAt: '1900-01-01T00:00:00.000Z', endsAt: '1900-01-01T02:00:00.000Z', setupMinutes: 10_080, cleanupMinutes: 0,
		occupiedStartsAt: '1899-12-25T00:00:00.000Z', occupiedEndsAt: '1900-01-01T02:00:00.000Z' };
	const read = parseOccupancy({ ...answer([row(1, atStart)]), from: early.from, to: early.to, timezone: 'UTC' }, early);
	assert.ok(read.kind === 'read');
	assert.equal(read.reservations[0]!.occupiedStartsAt, '1899-12-25T00:00:00.000Z', 'setup before 1900 is kept, neither clamped nor refused');

	const late: OccupancyRequest = { equipmentId: eid, from: '2199-12-10T00:00:00.000Z', to: '2199-12-31T12:00:00.000Z', zone: 'UTC' };
	const atEnd = { startsAt: '2199-12-31T20:00:00.000Z', endsAt: '2199-12-31T23:59:59.999Z', setupMinutes: 0, cleanupMinutes: 10_080,
		occupiedStartsAt: '2199-12-31T20:00:00.000Z', occupiedEndsAt: '2200-01-07T23:59:59.999Z' };
	refuses(() => parseOccupancy({ ...answer([row(1, atEnd)]), from: late.from, to: late.to, timezone: 'UTC' }, late), 'occupied time starting after the window');
	const lateRow = { ...atEnd, startsAt: '2199-12-31T10:00:00.000Z', occupiedStartsAt: '2199-12-31T10:00:00.000Z' };
	const lateRead = parseOccupancy({ ...answer([row(1, lateRow)]), from: late.from, to: late.to, timezone: 'UTC' }, late);
	assert.ok(lateRead.kind === 'read');
	assert.equal(lateRead.reservations[0]!.occupiedEndsAt, '2200-01-07T23:59:59.999Z', 'cleanup after 2200 is kept');

	const span = (startsAt: string, endsAt: string) => ({ startsAt, endsAt, setupMinutes: 0, cleanupMinutes: 0, occupiedStartsAt: startsAt, occupiedEndsAt: endsAt });
	const year: OccupancyRequest = { ...request, from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
	const echo = { from: year.from, to: year.to };
	assert.ok(parseOccupancy(answer([row(1, span('2026-09-01T12:00:00.000Z', '2027-09-02T12:00:00.000Z'))], echo), year).kind === 'read', 'exactly 366 days');
	for (const [times, label] of [
		[span('2026-09-01T12:00:00.000Z', '2027-09-02T12:00:00.001Z'), 'longer than 366 days'], [span('2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z'), 'zero length'],
		[span('2026-09-01T13:00:00.000Z', '2026-09-01T12:00:00.000Z'), 'ends before it starts']
	] as [Record<string, unknown>, string][]) refuses(() => parseOccupancy(answer([row(1, times)], echo), year), label);
	refuses(() => parseOccupancy({ ...answer([row(1, span('1899-12-31T23:59:59.999Z', '1900-01-01T01:00:00.000Z'))]), from: early.from, to: early.to, timezone: 'UTC' }, early), 'actual start before 1900');
	refuses(() => parseOccupancy({ ...answer([row(1, span('2199-12-31T11:00:00.000Z', '2200-01-01T00:00:00.000Z'))]), from: late.from, to: late.to, timezone: 'UTC' }, late), 'actual end at 2200');
});

test('occupied time equals actual time widened by exactly its buffers, and intersects the window', () => {
	for (const [extra, label] of [
		[{ occupiedStartsAt: '2026-09-02T00:30:00.001Z' }, 'setup off by 1 ms'], [{ occupiedEndsAt: '2026-09-02T05:59:59.999Z' }, 'cleanup off by 1 ms'],
		[{ occupiedStartsAt: '2026-09-02T01:00:00.000Z' }, 'setup omitted from occupancy'], [{ setupMinutes: 10_081 }, 'setup over a week'], [{ cleanupMinutes: -1 }, 'negative cleanup'],
		[{ setupMinutes: 1.5 }, 'fractional setup'], [{ cleanupMinutes: '60' }, 'string cleanup'], [{ setupMinutes: undefined }, 'missing setup']
	] as [Record<string, unknown>, string][]) refuses(() => parseOccupancy(answer([row(1, extra)]), request), label);
	const at = (startsAt: string, endsAt: string) => ({ startsAt, endsAt, setupMinutes: 0, cleanupMinutes: 0, occupiedStartsAt: startsAt, occupiedEndsAt: endsAt });
	refuses(() => parseOccupancy(answer([row(1, at('2026-08-31T15:00:00.000Z', from))]), request), 'ends exactly at from (half-open)');
	refuses(() => parseOccupancy(answer([row(1, at(to, '2026-09-28T17:00:00.000Z'))]), request), 'starts exactly at to');
	assert.ok(parseOccupancy(answer([row(1, at('2026-08-31T15:00:00.000Z', '2026-08-31T16:00:00.001Z'))]), request).kind === 'read', 'overlaps from by 1 ms');
	assert.ok(parseOccupancy(answer([row(1, at('2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'))]), request).kind === 'read', 'spans the whole window');
});

test('one bad reservation refuses the whole answer', () => {
	for (const [extra, label] of [
		[{ id: uuid(1).toUpperCase() }, 'upper-case id'], [{ id: 'booking-1' }, 'not a uuid'], [{ equipmentId: uuid(7) }, 'another equipment'], [{ status: 'cancelled' }, 'cancelled'],
		[{ kind: 'cleaning' }, 'unknown kind'], [{ title: '  ' }, 'blank title'], [{ title: 't'.repeat(201) }, '201-character title'], [{ title: 3 }, 'number title'],
		[{ revision: 0 }, 'revision 0'], [{ revision: 1.5 }, 'fractional revision'], [{ revision: 2 ** 53 }, 'unsafe revision'], [{ revision: '3' }, 'string revision']
	] as [Record<string, unknown>, string][]) refuses(() => parseOccupancy(answer([row(2), row(1, extra)]), request), label);
	refuses(() => parseOccupancy(answer([row(1), row(1)]), request), 'duplicate id within the answer');
	refuses(() => parseOccupancy(answer([row(1), 'row']), request), 'a non-object row');
	assert.equal((parseOccupancy(answer([row(1, { title: 't'.repeat(200) })]), request) as unknown as { reservations: { title: string }[] }).reservations[0]!.title.length, 200);
});

test('a well-formed answer in another zone is zone-changed, carries no rows, and is distinguishable from invalid', () => {
	const changed = parseOccupancy(answer([row(1)], { timezone: 'Australia/Sydney' }), request);
	assert.deepEqual(changed, { kind: 'zone-changed' });
	assert.ok(Object.isFrozen(changed));
	assert.deepEqual(parseOccupancy(answer(rows(200), { timezone: 'UTC', coverage: 'partial', nextOffset: 200 }), request), { kind: 'zone-changed' });
	// Every row is validated first, so a malformed answer is never reported as a zone change.
	refuses(() => parseOccupancy(answer([row(1, { status: 'cancelled' })], { timezone: 'UTC' }), request), 'malformed in another zone');
	refuses(() => parseOccupancy(answer([row(1)], { timezone: '' }), request), 'empty zone');
	refuses(() => parseOccupancy(answer([row(1)], { timezone: 'x'.repeat(65) }), request), '65-character zone');
});

test('a bad request is a client bug: the answer is refused rather than trusted', () => {
	for (const [bad, label] of [
		[{ equipmentId: eid.toUpperCase() }, 'upper-case equipment'], [{ from: '2026-08-31T16:00:00Z' }, 'non-canonical from'], [{ to: from }, 'empty window'],
		[{ from: '2026-01-01T00:00:00.000Z', to: '2026-04-04T00:00:00.001Z' }, 'longer than 93 days'], [{ zone: '' }, 'no zone'],
		[{ from: '1899-12-31T00:00:00.000Z', to: '1900-01-02T00:00:00.000Z' }, 'before 1900']
	] as [Partial<OccupancyRequest>, string][]) {
		const asked = { ...request, ...bad };
		refuses(() => parseOccupancy(answer([], { from: asked.from, to: asked.to }), asked), label);
	}
	refuses(() => parseOccupancy(answer([]), null as never), 'no request');
});
