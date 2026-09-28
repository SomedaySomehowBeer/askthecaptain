import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampScroll, defaultScale, instantAt, interval, isScale, pixelsAt, scales, zoomScroll } from './geometry.ts';

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≈ ${expected}`);

test('the scales match the web, and Days is the default', () => {
	assert.deepEqual(scales, { hours: 576, days: 84, weeks: 24 });
	assert.equal(defaultScale, 'days');
	for (const value of ['hours', 'days', 'weeks']) assert.ok(isScale(value));
	for (const value of ['Days', 'months', '', 'toString', '__proto__', 'hasOwnProperty']) assert.ok(!isScale(value), value);
});

test('continuous elapsed intervals clip at loaded boundaries without enlarging short occupancy', () => {
	const from = '2026-10-01T00:00:00Z', to = '2026-10-08T00:00:00Z';
	assert.deepEqual(interval('2026-09-30T00:00:00Z', '2026-10-03T12:00:00Z', from, to, 84), { top: 0, height: 210 });
	assert.deepEqual(interval('2026-10-02T00:00:00Z', '2026-10-02T00:01:00Z', from, to, 576), { top: 576, height: 0.4 });
	assert.equal(interval('2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z', from, to, 84), null);
	assert.equal(interval('2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', from, to, 84), null, 'an empty interval draws nothing');
	assert.equal(interval('2026-10-02T00:00:00Z', 'soon', from, to, 84), null, 'an unparseable time draws nothing');
});

test('a clock-change day is drawn at its true length', () => {
	// Sydney, 4 October 2026: 23 hours, from AEST midnight to AEDT midnight.
	const from = '2026-10-03T14:00:00.000Z', to = '2026-10-04T13:00:00.000Z';
	close(interval(from, to, from, to, 84)!.height, 84 * 23 / 24);
	close(interval(from, to, from, to, 576)!.height, 576 * 23 / 24);
});

test('a bar across a day boundary is one continuous interval', () => {
	const from = '2026-10-03T14:00:00.000Z', midnight = '2026-10-04T13:00:00.000Z', to = '2026-10-05T13:00:00.000Z';
	const start = '2026-10-04T08:00:00.000Z', end = '2026-10-04T20:00:00.000Z';
	const whole = interval(start, end, from, to, 84)!, first = interval(start, end, from, midnight, 84)!, second = interval(start, end, midnight, to, 84)!;
	close(whole.height, first.height + second.height, 'the pieces add up to the whole');
	close(whole.top + first.height, pixelsAt(Date.parse(midnight), Date.parse(from), 84), 'no gap at the boundary');
	assert.equal(second.top, 0);
});

test('instants and pixels convert both ways', () => {
	const origin = Date.parse('2026-09-26T00:00:00Z');
	assert.equal(pixelsAt(origin + 36 * 3_600_000, origin, 84), 126);
	assert.equal(instantAt(126, origin, 84), origin + 36 * 3_600_000);
	for (const scale of Object.values(scales)) {
		const at = origin + 12_345_678;
		close(instantAt(pixelsAt(at, origin, scale), origin, scale), at);
	}
});

test('zoom keeps the instant under the focal point, and round-trips', () => {
	const top = 500, anchor = 200, zoomed = zoomScroll(top, anchor, 84, 576, 52);
	close((top + anchor - 52) / 84, (zoomed + anchor - 52) / 576);
	close(zoomScroll(zoomed, anchor, 576, 84, 52), top);
	// Mobile's default has no header before time zero.
	const centre = 300, offset = 1_000, days = zoomScroll(offset, centre, 84, 24);
	close(instantAt(offset + centre, 0, 84), instantAt(days + centre, 0, 24), 'the centre instant is unchanged');
	close(zoomScroll(days, centre, 24, 84), offset);
	assert.equal(zoomScroll(0, 100, 576, 24), 0, 'never before the start');
});

test('scroll offsets stay inside the content', () => {
	assert.equal(clampScroll(-5, 1_000, 400), 0);
	assert.equal(clampScroll(700, 1_000, 400), 600);
	assert.equal(clampScroll(250, 1_000, 400), 250);
	assert.equal(clampScroll(50, 300, 400), 0, 'content shorter than the viewport');
});
