import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, ZoneError, displayTime, localChoices, shiftDate, todayInZone, zoneGate, zonedDay, type ZoneErrorReason } from './zone.ts';

const HOUR = 3_600_000;
/** Asserts a `ZoneError` with `reason` whose message repeats none of `secrets`. */
const refused = (reason: ZoneErrorReason, ...secrets: string[]) => (error: unknown) => {
	assert.ok(error instanceof ZoneError, 'a ZoneError');
	assert.equal(error.reason, reason);
	for (const secret of secrets) assert.ok(!error.message.includes(secret), 'the message repeats no input');
	return true;
};

test('Perth instants use the organisation zone, never the device zone', () => {
	assert.equal(zonedDay('2026-09-28', 'Australia/Perth'), '2026-09-27T16:00:00.000Z');
	assert.equal(todayInZone('Australia/Perth', new Date('2026-09-28T17:00:00Z')), '2026-09-29');
	assert.equal(todayInZone('UTC', new Date('2026-09-28T17:00:00Z')), '2026-09-28');
	assert.match(displayTime('2026-09-28T01:00:45.123Z', 'Australia/Perth'), /\(UTC\+08:00\)$/);
	assert.match(displayTime('2026-09-28T01:00:00.000Z', 'Asia/Kathmandu'), /\(UTC\+05:45\)$/);
	assert.match(displayTime('2026-09-28T01:00:00.000Z', 'America/Santiago'), /\(UTC-03:00\)$/);
});

test('Sydney gaps have no instant, repeated hours have two, and civil days last 23 or 25 hours', () => {
	assert.deepEqual(localChoices('2026-10-04T02:30', 'Australia/Sydney'), []);
	assert.deepEqual(localChoices('2026-04-05T02:30', 'Australia/Sydney'), [
		{ instant: '2026-04-04T15:30:00.000Z', offset: '+11:00' },
		{ instant: '2026-04-04T16:30:00.000Z', offset: '+10:00' },
	]);
	assert.equal(zonedDay('2026-04-05', 'Australia/Sydney'), '2026-04-04T13:00:00.000Z');
	const length = (from: string, to: string) => Date.parse(zonedDay(to, 'Australia/Sydney')) - Date.parse(zonedDay(from, 'Australia/Sydney'));
	assert.equal(length('2026-10-04', '2026-10-05'), 23 * HOUR);
	assert.equal(length('2026-04-05', '2026-04-06'), 25 * HOUR);
	assert.equal(length('2026-06-01', '2026-06-02'), DAY);
});

test('non-hour transitions, days that begin after midnight and skipped dates stay explicit', () => {
	// Santiago's clocks skip midnight, so the day starts at its first existing instant.
	assert.equal(zonedDay('2026-09-06', 'America/Santiago'), '2026-09-06T04:00:00.000Z');
	assert.equal(localChoices('2026-04-05T01:45', 'Australia/Lord_Howe').length, 2);
	// Apia skipped 30 December 2011 entirely.
	assert.deepEqual(localChoices('2011-12-30T12:00', 'Pacific/Apia'), []);
	assert.throws(() => zonedDay('2011-12-30', 'Pacific/Apia'), refused('skipped', '2011-12-30', 'Pacific/Apia'));
	assert.equal(Date.parse(zonedDay('2011-12-31', 'Pacific/Apia')) - Date.parse(zonedDay('2011-12-29', 'Pacific/Apia')), DAY);
});

test('invalid dates and zones are refused without normalising into another day or repeating the input', () => {
	for (const value of ['2026-02-30T09:00', '2026-09-01T25:00', '2026-09-01T09:60', 'tomorrow', '2026-09-01', '1899-12-31T12:00', '2200-01-01T00:00', '2026-9-01T09:00'])
		assert.throws(() => localChoices(value, 'Australia/Perth'), refused('invalid', value));
	for (const date of ['2026-02-29', '2026-13-01', '2026-00-10', '26-01-01']) assert.throws(() => zonedDay(date, 'UTC'), refused('invalid', date));
	assert.throws(() => localChoices('2026-09-01T09:00', 'Bad/Zone'), refused('unsupported', 'Bad/Zone'));
	assert.throws(() => zonedDay('2026-09-01', 'Bad/Zone'), refused('unsupported', 'Bad/Zone'));
	assert.throws(() => displayTime('2026-09-01T00:00:00.000Z', 'Bad/Zone'), refused('unsupported', 'Bad/Zone'));
	assert.throws(() => displayTime('soon', 'UTC'), refused('invalid', 'soon'));
});

test('civil dates shift exactly and stay inside 1900–2200', () => {
	assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
	assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
	assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
	assert.equal(shiftDate('2026-09-28', -28), '2026-08-31');
	assert.throws(() => shiftDate('2199-12-31', 1), refused('invalid'));
	assert.throws(() => shiftDate('1900-01-01', -1), refused('invalid'));
	assert.throws(() => shiftDate('2026-02-30', 0), refused('invalid'));
});

test('the zone gate accepts supported zones, including half-hour, three-quarter-hour and date-line zones', () => {
	for (const zone of ['Australia/Perth', 'Australia/Sydney', 'UTC', 'America/Santiago', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Apia', 'Pacific/Kiritimati'])
		assert.deepEqual(zoneGate(zone), { ok: true }, zone);
});

test('the zone gate refuses a zone the engine cannot format, without repeating it', () => {
	for (const zone of ['', 'x'.repeat(65), 'Bad/Zone', 'Australia/Perth ', 'local'])
		assert.deepEqual(zoneGate(zone), { ok: false, reason: 'unsupported' });
});

// ---- The self-check against a broken engine. These fake `Intl`; they are source guards, not device proof. ----

type Make = (real: Intl.DateTimeFormat, options: Intl.DateTimeFormatOptions | undefined) => unknown;
/** Runs `run` with `Intl.DateTimeFormat` replaced, then restores it and proves the gate recovers. */
function withIntl(make: Make, run: () => void) {
	const Real = Intl.DateTimeFormat;
	function Fake(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
		return make(new Real(locales, options), options);
	}
	Object.defineProperty(Intl, 'DateTimeFormat', { value: Fake, configurable: true, writable: true });
	try {
		run();
	} finally {
		Object.defineProperty(Intl, 'DateTimeFormat', { value: Real, configurable: true, writable: true });
		assert.deepEqual(zoneGate('Australia/Perth'), { ok: true }, 'a real engine passes again');
	}
}
/** An engine whose clock is an hour out. */
const hourOut = (real: Intl.DateTimeFormat) => ({
	formatToParts: (at?: number | Date) => real.formatToParts(Number(at) + HOUR),
	format: (at?: number | Date) => real.format(Number(at) + HOUR),
});

test('the gate refuses an engine whose zone answers are wrong', () => {
	withIntl((real) => hourOut(real), () => {
		assert.deepEqual(zoneGate('UTC'), { ok: false, reason: 'self-check' });
		assert.deepEqual(zoneGate('Australia/Perth'), { ok: false, reason: 'self-check' });
	});
});

test('the fixed vectors apply whatever the organisation zone is', () => {
	// Only Sydney is wrong; a Perth organisation is still refused, because the engine is not trusted.
	withIntl((real, options) => options?.timeZone === 'Australia/Sydney' ? hourOut(real) : real, () => {
		assert.deepEqual(zoneGate('Australia/Perth'), { ok: false, reason: 'self-check' });
	});
});

test('the gate refuses an organisation zone that does not round-trip', () => {
	// Tokyo always reports one fixed civil time, so no civil date maps back to its instants.
	const frozen: Intl.DateTimeFormatPart[] = [
		{ type: 'day', value: '03' }, { type: 'literal', value: '/' }, { type: 'month', value: '02' }, { type: 'literal', value: '/' },
		{ type: 'year', value: '2001' }, { type: 'literal', value: ', ' }, { type: 'hour', value: '04' }, { type: 'literal', value: ':' },
		{ type: 'minute', value: '05' }, { type: 'literal', value: ':' }, { type: 'second', value: '06' },
	];
	withIntl((real, options) => options?.timeZone === 'Asia/Tokyo' ? { formatToParts: () => frozen, format: () => '3 Feb 2001, 4:05 am' } : real, () => {
		assert.deepEqual(zoneGate('Asia/Tokyo'), { ok: false, reason: 'self-check' });
		assert.deepEqual(zoneGate('Australia/Perth'), { ok: true }, 'other zones are unaffected');
	});
});

test('the gate refuses an engine that omits civil parts or cannot construct formatters', () => {
	withIntl((real) => ({ formatToParts: (at?: number | Date) => real.formatToParts(at).filter((part) => part.type !== 'hour'), format: (at?: number | Date) => real.format(at) }), () => {
		assert.deepEqual(zoneGate('UTC'), { ok: false, reason: 'unsupported' });
	});
	withIntl((real) => ({ formatToParts: (at?: number | Date) => real.formatToParts(at).map((part) => part.type === 'hour' ? { ...part, value: '24' } : part), format: (at?: number | Date) => real.format(at) }), () => {
		assert.deepEqual(zoneGate('UTC'), { ok: false, reason: 'unsupported' });
	});
	withIntl(() => {
		throw new RangeError('no time zone data');
	}, () => {
		assert.deepEqual(zoneGate('Australia/Perth'), { ok: false, reason: 'unsupported' });
	});
});
