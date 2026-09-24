import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, HOUR, scales, geometry, zoomOffset, overlaps, conflicts, mergeMessages, recentMessages, pinnedMessages } from './model.ts';
import { bookings, messages, range } from './fixtures.ts';

test('continuous booking duration survives every scale and clips only at range edges', () => {
  for (const pixels of Object.values(scales)) {
    const long = bookings.find(b => b.id === 'fermentation')!;
    const shape = geometry(long, range, pixels)!;
    assert.equal(shape.height, (long.end - long.start) * pixels);
    assert.equal(shape.clipped, false);
    const clipped = geometry(bookings.find(b => b.id === 'long-maintenance')!, range, pixels)!;
    assert.equal(clipped.top, 0);
    assert.equal(clipped.height, 2 * DAY * pixels);
    assert.equal(clipped.clipped, true);
    assert.equal(geometry({ start: range.end, end: range.end + DAY }, range, pixels), null);
  }
});
test('zoom retains the instant at the gesture anchor except at loaded boundaries', () => {
  for (const previous of Object.values(scales)) for (const next of Object.values(scales)) {
    const anchor = 110, viewport = 240, duration = 60 * DAY;
    const offset = 20 * DAY * previous - anchor;
    const nextOffset = zoomOffset(offset, anchor, previous, next, duration, viewport);
    assert.ok(Math.abs((nextOffset + anchor) / next - 20 * DAY) < 0.01);
  }
  assert.equal(zoomOffset(0, 200, scales.Hours, scales.Weeks, 28 * DAY, 600), 0);
});
test('exclusive half-open intervals allow adjacency, not overlapping cleaning or requests', () => {
  assert.equal(overlaps({ start: 9 * HOUR, end: 12 * HOUR }, { start: 12 * HOUR, end: 13 * HOUR }), false);
  assert.equal(overlaps({ start: 9 * HOUR, end: 12 * HOUR }, { start: 11 * HOUR, end: 13 * HOUR }), true);
  assert.deepEqual([...conflicts(bookings)], ['request']);
});
test('actual duration handles a daylight-saving transition without assuming a 24-hour civil day', () => {
  const interval = { start: Date.parse('2026-10-04T00:00:00+10:00'), end: Date.parse('2026-10-05T00:00:00+11:00') };
  assert.equal(geometry(interval, interval, scales.Hours)!.height, 23 * HOUR * scales.Hours);
});
test('replayed and reordered messages deduplicate by stable ID; older pins remain outside recent six', () => {
  const merged = mergeMessages(messages, [messages[179]!, messages[2]!, messages[178]!]);
  assert.equal(merged.length, 180);
  assert.deepEqual(recentMessages(merged).map(m => m.id), messages.slice(-6).map(m => m.id));
  assert.deepEqual(pinnedMessages(merged).map(m => m.id), ['message-3']);
  assert.equal(recentMessages(merged).some(m => m.id === 'message-3'), false);
  const updated = mergeMessages(merged, [{ ...messages[2]!, text: 'Edited', pinned: false }]);
  assert.equal(pinnedMessages(updated).length, 0);
  assert.equal(updated[2]!.text, 'Edited');
});
