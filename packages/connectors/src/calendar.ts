/** First-party Calendar REST client. Provider content and credentials never enter an error. */
import { backoffMs, fetchReason, googleReason, shouldRetry, type GoogleClientOptions } from './gmail.ts';
export class CalendarError extends Error {
 readonly status: number; readonly reason: string;
 /** `status` 502 with reason `unreadable` is Captain's own verdict on an answer it could not parse. */
 constructor(status = 502, reason = status === 502 ? 'unreadable' : '') { super('Google Calendar could not be read. Try syncing again.'); this.status = status; this.reason = reason; }
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CalendarError(); return v as Obj; };
const text = (v: unknown): string => { if (v === undefined) return ''; if (typeof v !== 'string') throw new CalendarError(); return v; };
const id = (v: unknown) => { const s = text(v); if (!s) throw new CalendarError(); return s; };
const array = (v: unknown): unknown[] => { if (v === undefined) return []; if (!Array.isArray(v)) throw new CalendarError(); return v; };
const bool = (v: unknown) => { if (v === undefined) return false; if (typeof v !== 'boolean') throw new CalendarError(); return v; };
export type CalendarInfo = { providerId: string; name: string; primary: boolean; timezone: string; accessRole: string; selected: boolean };
export type EventTime = { date: string; dateTime?: never; timeZone?: string } | { dateTime: string; date?: never; timeZone?: string };
export type EventWrite = { summary: string; start: EventTime; end: EventTime; description?: string; location?: string; attendees?: { email: string; displayName?: string }[] };
export type CalendarEvent = { providerId: string; status: 'cancelled' } | {
 providerId: string; status: 'confirmed' | 'tentative'; summary: string; description: string; location: string; start: EventTime; end: EventTime;
 organiser: { email: string; name: string }; attendees: { email: string; name: string; response: string }[]; attendeesOmitted: boolean; recurringEventId: string | null; htmlLink: string; updatedAt: string;
};
function time(value: unknown): EventTime {
 const v = obj(value); const zone = text(v.timeZone) || undefined;
 if (zone) { try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { throw new CalendarError(); } }
 if (v.date !== undefined) {
  const d = id(v.date); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw new CalendarError();
  return { date: d, timeZone: zone };
 }
 const d = id(v.dateTime); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(d) || !Number.isFinite(Date.parse(d)) || (!/(Z|[+-]\d{2}:\d{2})$/.test(d) && !zone)) throw new CalendarError();
 return { dateTime: d, timeZone: zone };
}
export function parseEvent(value: unknown): CalendarEvent {
 const v = obj(value); const providerId = id(v.id); if (v.status === 'cancelled') return { providerId, status: 'cancelled' };
 if (v.status !== 'confirmed' && v.status !== 'tentative') throw new CalendarError();
 const start = time(v.start); const end = time(v.end); if (Boolean(start.date) !== Boolean(end.date)) throw new CalendarError();
 const organiser = v.organizer === undefined ? {} : obj(v.organizer); const updatedAt = id(v.updated); if (!Number.isFinite(Date.parse(updatedAt))) throw new CalendarError();
 return { providerId, status: v.status, summary: text(v.summary), description: text(v.description), location: text(v.location), start, end,
  organiser: { email: text(organiser.email), name: text(organiser.displayName) }, attendees: array(v.attendees).map((a) => { const p = obj(a); return { email: text(p.email), name: text(p.displayName), response: text(p.responseStatus) }; }),
  attendeesOmitted: bool(v.attendeesOmitted), recurringEventId: text(v.recurringEventId) || null, htmlLink: text(v.htmlLink), updatedAt };
}
export class CalendarClient {
 readonly fetcher: typeof fetch; readonly #sleep: (ms: number) => Promise<void>; readonly #retries: number;
 constructor(fetcher: typeof fetch = fetch, options: GoogleClientOptions = {}) {
  this.fetcher = fetcher; this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); this.#retries = options.retries ?? 4;
 }
 async calendars(token: string, pageToken?: string) {
  const data = await this.request('users/me/calendarList', token, { showHidden: 'true', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
  return { items: array(data.items).map((value): CalendarInfo => { const c = obj(value); const timezone = id(c.timeZone);
   try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new CalendarError(); }
   return { providerId: id(c.id), name: text(c.summaryOverride) || text(c.summary), primary: bool(c.primary), timezone, accessRole: id(c.accessRole), selected: bool(c.selected) }; }), nextPageToken: text(data.nextPageToken) || undefined };
 }
 async events(token: string, calendarId: string, options: { syncToken?: string; timeMin?: string; timeMax?: string; pageToken?: string }) {
  if (options.syncToken && (options.timeMin || options.timeMax)) throw new CalendarError();
  const params: Record<string, string> = { singleEvents: 'true', showDeleted: 'true', maxResults: '250' };
  for (const [key, value] of Object.entries(options)) if (value) params[key] = value;
  const data = await this.request(`calendars/${encodeURIComponent(calendarId)}/events`, token, params);
  const nextPageToken = text(data.nextPageToken) || undefined; const nextSyncToken = text(data.nextSyncToken) || undefined;
  if (!nextPageToken && !nextSyncToken) throw new CalendarError();
  return { items: array(data.items).map(parseEvent), nextPageToken, nextSyncToken };
 }
 async event(token: string, calendarId: string, eventId: string) { return parseEvent(await this.request(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, token)); }
 // Explicit notification choice belongs to the future person-initiated service. No route calls these.
 async insert(token: string, calendarId: string, event: EventWrite, sendUpdates: 'all' | 'externalOnly' | 'none') {
  return parseEvent(await this.request(`calendars/${encodeURIComponent(calendarId)}/events`, token, { sendUpdates }, 'POST', event));
 }
 async patch(token: string, calendarId: string, eventId: string, event: Partial<EventWrite>, sendUpdates: 'all' | 'externalOnly' | 'none') {
  return parseEvent(await this.request(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, token, { sendUpdates }, 'PATCH', event));
 }
 private async request(path: string, token: string, params: Record<string, string> = {}, method = 'GET', body?: Partial<EventWrite>): Promise<Obj> {
  for (let n = 0; ; n++) {
   try {
    const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`); url.search = new URLSearchParams(params).toString();
    const response = await this.fetcher(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
     ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new CalendarError(response.status, await googleReason(response)); return obj(await response.json());
   } catch (error) {
    const failure = error instanceof CalendarError ? error : new CalendarError(502, fetchReason(error));
    // Only rate limits are retried on writes; a GET may also retry a Google 5xx (502 is Captain's own unreadable verdict).
    if (n >= this.#retries || !shouldRetry(failure.status, failure.reason, method === 'GET' ? 'GET' : 'POST')) throw failure;
    await this.#sleep(backoffMs(n));
   }
  }
 }
}
