import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClampedClock, laterWait, remaining, waitFor } from './clock.ts';

test('the clamped clock never goes backwards and ignores readings that are not finite numbers', () => {
	const readings = [10, 20, 5, Number.NaN, Number.POSITIVE_INFINITY, 25, -1];
	let i = 0;
	const clock = createClampedClock(() => readings[i++]!);
	assert.deepEqual(readings.map(() => clock.now()), [10, 20, 20, 20, 20, 25, 25]);
});

test('a wait is fixed on the clamped clock when the answer arrives; its wall-clock "about" is wording only', () => {
	let raw = 1_000;
	const clock = createClampedClock(() => raw);
	clock.now();
	raw = 400; // backwards: the wait still runs from 1 000
	assert.deepEqual(waitFor(5_000, clock, () => Date.UTC(2030, 0, 1)), { until: 6_000, about: '2030-01-01T00:00:05.000Z' });
	for (const none of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(waitFor(none, clock, () => 0), null, String(none));
});

test('the later wait always wins; remaining time ends exactly at the deadline', () => {
	const a = { until: 100, about: 'a' }; const b = { until: 50, about: 'b' };
	assert.equal(laterWait(a, b), a); assert.equal(laterWait(b, a), a);
	assert.equal(laterWait(null, b), b); assert.equal(laterWait(a, null), a); assert.equal(laterWait(null, null), null);
	assert.equal(remaining(a, 99), 1); assert.equal(remaining(a, 100), 0); assert.equal(remaining(null, 0), 0);
});
