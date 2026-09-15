import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CalendarClient, CalendarError, parseEvent } from '../src/calendar.ts';
const fixture = JSON.parse(await readFile(new URL('./fixtures/calendar-events.json', import.meta.url), 'utf8'));
test('calendar pagination and events preserve instants, all-day dates, recurrence, attendees and sparse cancellation', async () => {
 const calls: URL[] = []; const client = new CalendarClient(async (input) => { const url = new URL(String(input)); calls.push(url);
  return Response.json(url.pathname.endsWith('calendarList') ? { items: [{ id: 'a/b@example.test', summary: 'Work', timeZone: 'Australia/Perth', primary: true, accessRole: 'owner' }], nextPageToken: 'page-2' } : fixture); });
 const calendars = await client.calendars('test', 'next'); assert.equal(calendars.nextPageToken, 'page-2'); assert.equal(calendars.items[0]!.primary, true);
 const page = await client.events('test', calendars.items[0]!.providerId, { timeMin: '2026-08-16T00:00:00Z', timeMax: '2026-12-14T00:00:00Z' });
 assert.equal(page.nextSyncToken, 'sync-1'); assert.match(calls[1]!.pathname, /a%2Fb%40example.test/); assert.equal(calls[1]!.searchParams.get('singleEvents'), 'true');
 const event = page.items[0]!; assert.notEqual(event.status, 'cancelled'); if (event.status === 'cancelled') return;
 assert.equal(event.start.dateTime, '2026-09-14T15:30:00Z'); assert.equal(event.recurringEventId, 'weekly-supplier'); assert.equal(event.attendees[0]!.response, 'accepted');
 assert.deepEqual(page.items[2], { providerId: 'deleted', status: 'cancelled' });
 await client.events('test', 'primary', { syncToken: 'sync-1', pageToken: 'next' }); assert.equal(calls[2]!.searchParams.has('timeMin'), false);
 await assert.rejects(client.events('test', 'primary', { syncToken: 'x', timeMin: 'x' }), CalendarError);
});
test('get/insert/patch encode ids and require an explicit notification choice; errors never expose content or tokens', async () => {
 const calls: { url: URL; init?: RequestInit }[] = []; const client = new CalendarClient(async (input, init) => { calls.push({ url: new URL(String(input)), init }); return Response.json(fixture.items[0]); });
 await client.event('test', 'a/b', 'x/y'); await client.insert('test', 'a/b', { summary: 'New', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } }, 'all');
 await client.patch('test', 'a/b', 'x/y', { location: 'Changed' }, 'none');
 assert.match(calls[0]!.url.pathname, /x%2Fy$/); assert.equal(calls[1]!.init!.method, 'POST'); assert.equal(calls[1]!.url.searchParams.get('sendUpdates'), 'all'); assert.equal(calls[2]!.init!.method, 'PATCH');
 for (const status of [410, 403, 500]) await assert.rejects(new CalendarClient(async () => new Response('private-body', { status })).events('secret-token', 'primary', {}), (e: unknown) => e instanceof CalendarError && e.status === status && !/private|secret/.test(e.message));
 assert.throws(() => parseEvent({ ...fixture.items[0], start: { date: '2026-02-30' } }), CalendarError);
 assert.throws(() => parseEvent({ ...fixture.items[0], attendees: 'invalid' }), CalendarError);
});
