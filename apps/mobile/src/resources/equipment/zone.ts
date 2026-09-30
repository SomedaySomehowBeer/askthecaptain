/** Organisation-zone civil time for the equipment schedule (contract §4.1).
 *
 *  The shared client's read-only time conversion logic (ported from the retired Next.js schedule). Every conversion names the
 *  organisation zone explicitly; nothing here reads or falls back to the device's own zone. Pure: no React, no native
 *  module and no workspace package.
 *
 *  `zoneGate` is a runtime source guard. It refuses a zone this JavaScript engine cannot format, or an engine whose
 *  fixed Perth/Sydney answers are wrong. Passing it is not device proof: Hermes `Intl` remains a device gate. */

export const DAY = 86_400_000;
const HOUR = 3_600_000;

/** `invalid`: not a real civil date/time inside 1900–2200. `skipped`: a clock change removes it.
 *  `unsupported`: the engine cannot format this zone. */
export type ZoneErrorReason = 'invalid' | 'skipped' | 'unsupported';
const zoneErrorText: Record<ZoneErrorReason, string> = {
	invalid: 'That date or time is not valid between 1900 and 2200.',
	skipped: 'That date is skipped by a clock change.',
	unsupported: 'That time zone cannot be shown on this device.',
};
/** A fixed message that never repeats the date, time or zone it was given. */
export class ZoneError extends Error {
	readonly reason: ZoneErrorReason;
	constructor(reason: ZoneErrorReason) {
		super(zoneErrorText[reason]);
		this.name = 'ZoneError';
		this.reason = reason;
	}
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const displayFormats = new Map<string, Intl.DateTimeFormat>();
const cacheLimit = 64;
function cached(cache: Map<string, Intl.DateTimeFormat>, zone: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
	let value = cache.get(zone);
	if (!value) {
		try {
			value = make();
		} catch {
			throw new ZoneError('unsupported');
		}
		if (cache.size >= cacheLimit) cache.clear();
		cache.set(zone, value);
	}
	return value;
}
function formatter(zone: string): Intl.DateTimeFormat {
	return cached(formatters, zone, () => new Intl.DateTimeFormat('en-GB', {
		timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
	}));
}

/** The exact shape `civil` must produce; anything else means the engine's `Intl` is not usable. */
const civilPattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
/** `YYYY-MM-DDTHH:mm:ss` in the zone. */
function civil(at: number, zone: string): string {
	let text: string;
	try {
		const p: Partial<Record<string, string>> = {};
		for (const part of formatter(zone).formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
		text = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
	} catch (error) {
		if (error instanceof ZoneError) throw error;
		throw new ZoneError('unsupported');
	}
	if (!civilPattern.test(text)) throw new ZoneError('unsupported');
	return text;
}

const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
/** A civil date-time read as if it were UTC, refusing anything that would normalise into another day. */
function parseLocal(value: string): number {
	const match = localPattern.exec(value);
	if (!match) throw new ZoneError('invalid');
	const [, year, month, date, hour, minute, second = '0', fraction = '0'] = match;
	const ms = Date.UTC(Number(year), Number(month) - 1, Number(date), Number(hour), Number(minute), Number(second),
		Number(fraction.padEnd(3, '0')));
	const expected = `${year}-${month}-${date}T${hour}:${minute}:${second.padStart(2, '0')}`;
	if (Number(year) < 1900 || Number(year) >= 2200 || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== expected)
		throw new ZoneError('invalid');
	return ms;
}
/** The zone's offset from UTC at an instant. `Intl` emits whole seconds, so compare equally precise instants. */
function offsetAt(at: number, zone: string): number {
	return Date.parse(civil(at, zone) + 'Z') - Math.floor(at / 1000) * 1000;
}
function offsetLabel(ms: number): string {
	const seconds = Math.abs(ms) / 1000, h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
	return `${ms < 0 ? '-' : '+'}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${s ? ':' + String(s).padStart(2, '0') : ''}`;
}

/** Every instant whose civil time in the zone is `local`: none in a gap, two in a repeated hour. */
export function localChoices(local: string, zone: string): { instant: string; offset: string }[] {
	const naive = parseLocal(local), offsets = new Set<number>();
	// Sample both sides of nearby transitions, including half-hour and date-line changes.
	for (let h = -36; h <= 36; h += 6) offsets.add(offsetAt(naive + h * HOUR, zone));
	const target = new Date(naive).toISOString().slice(0, 19);
	return [...offsets].map((offset) => ({ instant: new Date(naive - offset).toISOString(), offset: offsetLabel(offset) }))
		.filter((candidate) => civil(Date.parse(candidate.instant), zone) === target)
		.sort((a, b) => a.instant.localeCompare(b.instant));
}

/** The civil date (`YYYY-MM-DD`) in the zone at `now`. */
export function todayInZone(zone: string, now = new Date()): string {
	return civil(now.getTime(), zone).slice(0, 10);
}

/** A civil date `days` later (or earlier); refused outside 1900–2200. */
export function shiftDate(date: string, days: number): string {
	const at = parseLocal(date + 'T12:00');
	const result = new Date(at + days * DAY).toISOString().slice(0, 10);
	parseLocal(result + 'T12:00');
	return result;
}

/** The first instant of a civil date in the zone, as a canonical `…Z` string. A day that begins after a midnight
 *  gap (for example Santiago) starts at its first existing instant; a date skipped entirely throws `skipped`. */
export function zonedDay(date: string, zone: string): string {
	const choices = localChoices(date + 'T00:00', zone);
	if (choices.length) return choices[0]!.instant;
	const midnight = parseLocal(date + 'T00:00');
	const local = (at: number) => new Date(at).toISOString().slice(0, -1);
	let low = midnight;
	for (let minute = 15; minute <= 1440; minute += 15) {
		let high = Math.min(midnight + minute * 60_000, midnight + DAY - 1);
		if (!localChoices(local(high), zone).length) {
			low = high;
			continue;
		}
		while (high - low > 1) {
			const middle = Math.floor((low + high) / 2);
			if (localChoices(local(middle), zone).length) high = middle;
			else low = middle;
		}
		return localChoices(local(high), zone)[0]!.instant;
	}
	throw new ZoneError('skipped');
}

/** A reservation time for people: the civil date and time in the zone, with its UTC offset. */
export function displayTime(instant: string, zone: string): string {
	const at = Date.parse(instant);
	if (!Number.isFinite(at)) throw new ZoneError('invalid');
	const format = cached(displayFormats, zone, () => new Intl.DateTimeFormat('en-AU', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }));
	let text: string;
	try {
		text = format.format(at);
	} catch {
		throw new ZoneError('unsupported');
	}
	return `${text} (UTC${offsetLabel(offsetAt(at, zone))})`;
}

// ---- The zone gate ---------------------------------------------------------------------------------------------

export type ZoneGate = { ok: true } | { ok: false; reason: 'unsupported' | 'self-check' };
const perth = 'Australia/Perth', sydney = 'Australia/Sydney';

/** Known answers for a fixed-offset zone and a daylight-saving zone. They hold on any engine with correct zone data,
 *  whatever the organisation's zone is. */
function fixedVectorsHold(): boolean {
	const repeated = localChoices('2026-04-05T02:30', sydney);
	const length = (from: string, to: string) => Date.parse(zonedDay(to, sydney)) - Date.parse(zonedDay(from, sydney));
	return zonedDay('2026-09-28', perth) === '2026-09-27T16:00:00.000Z'
		&& todayInZone(perth, new Date('2026-09-28T17:00:00.000Z')) === '2026-09-29'
		&& displayTime('2026-09-28T01:00:45.123Z', perth).endsWith('(UTC+08:00)')
		&& zonedDay('2026-04-05', sydney) === '2026-04-04T13:00:00.000Z'
		&& repeated.length === 2
		&& repeated[0]!.instant === '2026-04-04T15:30:00.000Z' && repeated[0]!.offset === '+11:00'
		&& repeated[1]!.instant === '2026-04-04T16:30:00.000Z' && repeated[1]!.offset === '+10:00'
		&& localChoices('2026-10-04T02:30', sydney).length === 0
		&& length('2026-04-05', '2026-04-06') === 25 * HOUR
		&& length('2026-10-04', '2026-10-05') === 23 * HOUR;
}

/** The first instant of the next existing civil date after `date`, or null if none within two days. */
function nextDayStart(date: string, zone: string): number | null {
	for (let days = 1; days <= 2; days++) {
		try {
			return Date.parse(zonedDay(shiftDate(date, days), zone));
		} catch (error) {
			if (!(error instanceof ZoneError && error.reason === 'skipped')) throw error;
		}
	}
	return null;
}

const displayPattern = /\(UTC[+-]\d{2}:\d{2}(?::\d{2})?\)$/;
/** The organisation zone round-trips a fixed instant: the civil date containing it starts at or before it, maps back
 *  to the same date, and the next existing date starts after it. */
function roundTrips(at: number, zone: string): boolean {
	const date = todayInZone(zone, new Date(at));
	const start = Date.parse(zonedDay(date, zone));
	const next = nextDayStart(date, zone);
	return Number.isFinite(start) && start <= at && todayInZone(zone, new Date(start)) === date
		&& next !== null && next > at
		&& displayPattern.test(displayTime(new Date(at).toISOString(), zone));
}
const roundTripInstants = [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12)];

/** Whether the schedule may show times in `zone` on this engine (contract §4.1). Formatters are rebuilt, so a gate
 *  run always exercises this engine afresh. `unsupported`: the zone can't be formatted with the expected parts.
 *  `self-check`: the fixed vectors or the zone's own round trip gave a wrong answer. */
export function zoneGate(zone: string): ZoneGate {
	formatters.clear();
	displayFormats.clear();
	if (typeof zone !== 'string' || zone.length < 1 || zone.length > 64) return { ok: false, reason: 'unsupported' };
	try {
		civil(0, zone);
	} catch {
		return { ok: false, reason: 'unsupported' };
	}
	try {
		if (!fixedVectorsHold()) return { ok: false, reason: 'self-check' };
		for (const at of roundTripInstants) if (!roundTrips(at, zone)) return { ok: false, reason: 'self-check' };
	} catch {
		return { ok: false, reason: 'self-check' };
	}
	return { ok: true };
}
