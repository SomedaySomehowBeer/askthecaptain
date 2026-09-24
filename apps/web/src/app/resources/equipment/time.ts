/** Local civil time is resolved in the organisation zone, never the browser/server zone.
 * Gaps are refused; repeated hours need an explicit instant selected by the person. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
 let value = formatters.get(zone);
 if (!value) { value = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(zone, value); }
 return value;
}
function parts(at: number, zone: string) {
 return Object.fromEntries(formatter(zone).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function civil(at: number, zone: string) {
 const p = parts(at, zone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function parseLocal(value: string): number {
 const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
 if (!match) throw new Error('Enter a complete local date and time.');
 const [, year, month, date, hour, minute, second = '0', fraction = '0'] = match;
 const ms = Date.UTC(Number(year), Number(month) - 1, Number(date), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')));
 const expected = `${year}-${month}-${date}T${hour}:${minute}:${second.padStart(2, '0')}`;
 if (Number(year) < 1900 || Number(year) >= 2200 || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== expected)
  throw new Error('Enter a valid date and time between 1900 and 2200.');
 return ms;
}
function offsetAt(at: number, zone: string) {
 // Intl emits seconds. Compare equally precise instants to retain historical second offsets.
 return Date.parse(civil(at, zone) + 'Z') - Math.floor(at / 1000) * 1000;
}
function offsetLabel(ms: number) {
 const seconds = Math.abs(ms) / 1000, h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
 return `${ms < 0 ? '-' : '+'}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${s ? ':' + String(s).padStart(2, '0') : ''}`;
}
export function localChoices(local: string, timeZone: string): { instant: string; offset: string }[] {
 const naive = parseLocal(local), offsets = new Set<number>();
 // Sample both sides of nearby transitions, including half-hour and date-line changes.
 for (let h = -36; h <= 36; h += 6) offsets.add(offsetAt(naive + h * 3_600_000, timeZone));
 const target = new Date(naive).toISOString().slice(0, 19);
 return [...offsets].map(offset => ({ instant: new Date(naive - offset).toISOString(), offset: offsetLabel(offset) }))
  .filter(candidate => civil(Date.parse(candidate.instant), timeZone) === target)
  .sort((a, b) => a.instant.localeCompare(b.instant));
}
export function resolveLocal(local: string, timeZone: string, choice?: string): string {
 const options = localChoices(local, timeZone);
 if (!options.length) throw new Error('That local time does not exist because the clocks change. Choose a time before or after the change.');
 if (options.length === 1) return options[0]!.instant;
 const selected = options.find(option => option.instant === choice);
 if (!selected) throw new Error('That local time happens twice. Choose the first or second occurrence and its UTC offset.');
 return selected.instant;
}
/** Retain seconds/milliseconds on edits; datetime-local controls should use step="0.001". */
export function localValue(instant: string, timeZone: string): string {
 const at = Date.parse(instant);
 if (!Number.isFinite(at)) throw new Error('That saved time is invalid.');
 const fraction = new Date(at).getUTCMilliseconds();
 return civil(at, timeZone) + (fraction ? '.' + String(fraction).padStart(3, '0') : '');
}
export function todayInZone(timeZone: string, now = new Date()): string { return civil(now.getTime(), timeZone).slice(0, 10); }
export function shiftDate(date: string, days: number): string {
 const at = parseLocal(date + 'T12:00');
 const result = new Date(at + days * 86_400_000).toISOString().slice(0, 10);
 parseLocal(result + 'T12:00'); return result;
}
export function zonedDay(date: string, timeZone: string): string {
 const choices = localChoices(date + 'T00:00', timeZone);
 if (choices.length) return choices[0]!.instant;
 // Some civil days begin after midnight (for example Santiago). Find the first valid local
 // instant after the midnight gap, rather than rejecting the entire existing day.
 const midnight = parseLocal(date + 'T00:00');
 let low = midnight;
 for (let minute = 15; minute <= 1440; minute += 15) {
  let high = Math.min(midnight + minute * 60_000, midnight + 86_400_000 - 1);
  const local = (at: number) => new Date(at).toISOString().slice(0, -1);
  if (!localChoices(local(high), timeZone).length) { low = high; continue; }
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (localChoices(local(middle), timeZone).length) high = middle; else low = middle; }
  return localChoices(local(high), timeZone)[0]!.instant;
 }
 throw new Error('This whole date is skipped by a clock change. Choose another starting date.');
}
export function displayTime(instant: string, timeZone: string): string {
 const at = Date.parse(instant);
 return new Intl.DateTimeFormat('en-AU', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at) + ` (UTC${offsetLabel(offsetAt(at, timeZone))})`;
}
