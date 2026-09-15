import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { CalendarClient } from '@captain/connectors/calendar';
import { GoogleConnector } from '@captain/connectors';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { ConnectionService } from '../connections/service.ts';
import { newDataKey, seal } from '../connections/encryption.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CalendarSync, startCalendarSchedule } from './sync.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
const fixture = JSON.parse(await readFile(new URL('../../../../packages/connectors/test/fixtures/calendar-events.json', import.meta.url), 'utf8'));
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
async function setup() {
 const master = randomBytes(32); const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
 const [user, member, stranger] = await db.owner`insert into users (email) values (${`${randomBytes(8).toString('hex')}@test.com`}), (${`${randomBytes(8).toString('hex')}@test.com`}), (${`${randomBytes(8).toString('hex')}@test.com`}) returning id`;
 const org = await new OrganisationService(db.app).create({ userId: user!.id, requestId: 'test' }, { name: 'Calendar', timezone: 'Australia/Perth' });
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org.id}, ${member!.id}, 'member')`;
 const data = newDataKey(master, org.id); await db.owner`update organisations set data_key_wrapped = ${data.wrapped} where id = ${org.id}`;
 const [conn] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status, access_token_encrypted, access_token_expires_at)
  values (${org.id}, 'google', ${user!.id}, 'business@example.test', '{}', 'connected', ${seal(data.key, Buffer.from('test-access'), org.id, 'access_token')}, now() + interval '1 hour') returning id`;
 let mode = 'initial'; let failure = false; let hold: (() => Promise<void>) | undefined; let instant = Date.parse('2026-09-15T00:00:00Z'); let includeShared = true;
 const calls: URL[] = [];
 const client = new CalendarClient(async (input, init) => {
  assert.equal(init!.method, 'GET', 'sync never writes to Google');
  const url = new URL(String(input)); calls.push(url);
  if (url.pathname.endsWith('/calendarList')) return Response.json(url.searchParams.has('pageToken')
   ? { items: includeShared ? [{ id: 'shared', summary: 'Shared', timeZone: 'America/New_York', accessRole: 'reader', selected: true }, { id: 'ignored', summary: 'Ignored', timeZone: 'UTC', accessRole: 'reader' }] : [] }
   : { items: [{ id: 'primary', summary: mode === 'changed' ? 'Work renamed' : 'Work', timeZone: 'Australia/Perth', accessRole: 'owner', primary: true }], nextPageToken: 'cal-next' });
  const shared = url.pathname.includes('/shared/');
  if (hold) await hold();
  const incremental = url.searchParams.has('syncToken');
  if (incremental) { assert.equal(url.searchParams.has('timeMin'), false); assert.equal(url.searchParams.has('timeMax'), false); }
  if (incremental && mode === 'expired') return new Response('private', { status: 410 });
  if (failure && url.searchParams.has('pageToken')) return new Response('private-provider-content', { status: 500 });
  if (url.searchParams.has('pageToken')) return Response.json({ items: shared ? [] : [fixture.items[1]], nextSyncToken: mode === 'changed' ? 'sync-2' : 'sync-1' });
  if (!incremental) { assert.equal(url.searchParams.get('timeMin'), new Date(instant - 30 * 86400000).toISOString()); assert.equal(url.searchParams.get('timeMax'), new Date(instant + 90 * 86400000).toISOString()); }
  const event = structuredClone(fixture.items[0]); if (shared) { event.id = 'shared-event'; event.summary = 'Shared meeting'; event.start = { dateTime: '2026-09-15T09:00:00', timeZone: 'America/New_York' }; event.end = { dateTime: '2026-09-15T10:00:00', timeZone: 'America/New_York' }; }
  if (mode === 'changed') { event.summary = 'Updated'; event.attendees = []; }
  return Response.json({ items: incremental && mode === 'changed' && !shared ? [{ id: 'meeting', status: 'cancelled' }] : [event], nextPageToken: 'events-next' });
 });
 const connections = new ConnectionService(db.app, new GoogleConnector('test', 'test', 'https://api.test/cb'), master, 'https://app.test');
 const sync = new CalendarSync(db.app, connections, client, () => instant);
 const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), connections, calendarSync: sync });
 const ownerToken = (await auth.issueSessionFor(user!.id)).token; const memberToken = (await auth.issueSessionFor(member!.id)).token; const strangerToken = (await auth.issueSessionFor(stranger!.id)).token;
 const request = (path: string, token = ownerToken, method = 'GET') => app.request(`/v1/organisations/${org.id}/calendar/${path}`, { method, headers: { authorization: `Bearer ${token}` } });
 return { org: org.id, conn: conn!.id, sync, request, connections, client, ownerToken, memberToken, strangerToken, calls,
  mode: (v: string) => { mode = v; }, fail: (v: boolean) => { failure = v; }, hold: (fn: () => Promise<void>) => { hold = fn; }, advance: () => { instant += 86400000; }, removeShared: () => { includeShared = false; } };
}
it('primary and selected calendars paginate, persist recurrence/all-day dates, and member reads overlap the organisation week', async () => {
 const s = await setup(); const result = await s.sync.run(s.org); assert.equal(result.calendars, 2); assert.equal(result.full, 2);
 assert.ok(!s.calls.some((u) => u.pathname.includes('/ignored/')));
 const list = await (await s.request('events?from=2026-09-14&to=2026-09-21', s.memberToken)).json();
 assert.equal(list.events.length, 3); assert.equal(list.covered, true); assert.equal(list.from, '2026-09-13T16:00:00.000Z');
 assert.equal(list.events[0].summary, 'Supplier meeting'); assert.equal(list.events[0].attendeeCount, 1); assert.equal(list.events[0].recurringEventId, 'weekly-supplier');
 assert.equal(list.events[1].startsAt, '2026-09-15T13:00:00.000Z'); assert.equal(list.events[2].startDate, '2026-09-16'); assert.equal(list.events[2].endDate, '2026-09-18');
 const overlap = await (await s.request('events?from=2026-09-15&to=2026-09-16')).json(); assert.equal(overlap.events.length, 2);
 const afterHoliday = await (await s.request('events?from=2026-09-18&to=2026-09-19')).json(); assert.equal(afterHoliday.events.length, 0);
 const outside = await (await s.request('events?from=2027-09-14&to=2027-09-21')).json(); assert.equal(outside.covered, false);
 const ids = await db.owner`select id from calendar_events where organisation_id = ${s.org} order by id`;
 await s.sync.run(s.org); assert.deepEqual(await db.owner`select id from calendar_events where organisation_id = ${s.org} order by id`, ids);
 const audit = await db.owner`select actor_kind, detail from audit_events where organisation_id = ${s.org} and action = 'calendar.synced'`;
 assert.ok(audit.every((a) => a.actorKind === 'system')); assert.ok(!JSON.stringify(audit).includes('Supplier'));
});
it('incremental cancellation and metadata rename; 410 resync replaces cache and daily full sync advances the window', async () => {
 const s = await setup(); await s.sync.run(s.org); s.mode('changed'); await s.sync.run(s.org);
 let list = await (await s.request('events?from=2026-09-14&to=2026-09-21')).json(); assert.equal(list.events.length, 2); assert.equal(list.calendars[0].name, 'Work renamed');
 assert.equal(list.events.find((e: any) => !e.allDay).attendeeCount, 0);
 s.mode('expired'); assert.equal((await s.sync.run(s.org)).full, 2);
 s.mode('initial'); s.advance(); assert.equal((await s.sync.run(s.org)).full, 2);
 s.removeShared(); await s.sync.run(s.org); list = await (await s.request('events?from=2026-09-14&to=2026-09-21')).json(); assert.equal(list.calendars.length, 1); assert.equal(list.events.length, 2);
});
it('page failure commits completed pages but never advances cursor; retry is idempotent and no provider call holds a DB transaction', async () => {
 const s = await setup(); s.fail(true);
 s.hold(async () => {
  const open = await db.owner`select pid from pg_stat_activity where datname = current_database() and usename = 'app' and xact_start is not null`;
  assert.equal(open.length, 0, 'provider fetch is outside tenant transactions');
 });
 await assert.rejects(s.sync.run(s.org), { code: 'calendar_sync_failed' });
 assert.equal((await db.owner`select id from calendar_events where organisation_id = ${s.org}`).length, 1);
 assert.equal((await db.owner`select id from sync_cursors where organisation_id = ${s.org}`).length, 0);
 let list = await (await s.request('events?from=2026-09-14&to=2026-09-21')).json(); assert.equal(list.covered, false); assert.equal(list.lastSync.detail.success, false); assert.ok(!JSON.stringify(list).includes('private-provider-content'));
 s.fail(false); await s.sync.run(s.org); s.mode('changed'); s.fail(true); await assert.rejects(s.sync.run(s.org));
 const [cursor] = await db.owner`select cursor from sync_cursors where organisation_id = ${s.org} and resource like 'calendar.events:%' order by resource limit 1`;
 assert.equal(JSON.parse(cursor!.cursor).syncToken, 'sync-1');
 s.fail(false); await s.sync.run(s.org); list = await (await s.request('events?from=2026-09-14&to=2026-09-21')).json(); assert.equal(list.events.length, 2);
});
it('API permissions and invalid ranges; disconnected or replaced accounts hide old events', async () => {
 const s = await setup(); assert.equal((await s.request('sync', s.memberToken, 'POST')).status, 403);
 for (const p of ['calendars', 'events?from=2026-09-14&to=2026-09-21']) assert.equal((await s.request(p, s.strangerToken)).status, 404);
 for (const query of ['', '?from=no&to=no', '?from=2026-09-21&to=2026-09-14', '?from=2026-02-30&to=2026-03-01']) assert.equal((await s.request('events' + query)).status, 400);
 assert.equal((await s.request('sync', s.ownerToken, 'POST')).status, 200);
 assert.equal((await s.request('events', s.ownerToken, 'POST')).status, 404);
 await db.owner`update connections set status = 'revoked' where id = ${s.conn}`; assert.equal((await s.request('sync', s.ownerToken, 'POST')).status, 503);
 await db.owner`update connections set status = 'disconnected' where id = ${s.conn}`; assert.equal((await (await s.request('calendars')).json()).calendars.length, 0);
 await db.owner`update connections set status = 'connected', account_email = 'new@example.test' where id = ${s.conn}`;
 assert.equal((await (await s.request('events?from=2026-09-14&to=2026-09-21')).json()).events.length, 0);
});
it('overlap guard works across processes; account replacement fences writes after a provider response', async () => {
 const s = await setup(); let release!: () => void; let entered!: () => void;
 const reached = new Promise<void>((resolve) => { entered = resolve; }); const held = new Promise<void>((resolve) => { release = resolve; });
 s.hold(async () => { entered(); await held; }); const first = s.sync.run(s.org); await reached;
 await assert.rejects(s.sync.run(s.org), { code: 'calendar_sync_running' });
 await assert.rejects(new CalendarSync(db.app, s.connections, s.client).run(s.org), { code: 'calendar_sync_running' });
 await db.owner`update connections set account_email = 'replacement@example.test' where id = ${s.conn}`;
 release(); await assert.rejects(first, { code: 'calendar_sync_failed' });
 assert.equal((await db.owner`select id from calendar_events where organisation_id = ${s.org}`).length, 0);
});
it('expired leases are recoverable and a replaced lease cannot commit an old provider page', async () => {
 const s = await setup(); await db.owner`insert into sync_cursors (organisation_id, connection_id, resource, cursor, updated_at) values (${s.org}, ${s.conn}, 'calendar.sync-lock', 'dead', now() - interval '3 minutes')`;
 await s.sync.run(s.org);
 let changed = false; s.hold(async () => { if (!changed) { changed = true; await db.owner`update sync_cursors set cursor = 'replacement' where organisation_id = ${s.org} and resource = 'calendar.sync-lock'`; } });
 await assert.rejects(s.sync.run(s.org), { code: 'calendar_sync_running' });
 const [lock] = await db.owner`select cursor from sync_cursors where organisation_id = ${s.org} and resource = 'calendar.sync-lock'`; assert.equal(lock!.cursor, 'replacement');
});
test('calendar schedule has an explicit disable switch and waits for its active tick on shutdown', async () => {
 let runs = 0; let release!: () => void; const held = new Promise<void>((r) => { release = r; });
 const sync = { async organisations() { return ['org']; }, async run() { runs++; await held; return { calendars: 0, events: 0, cancelled: 0, full: 0 }; } };
 await startCalendarSchedule(sync, true, 5)(); assert.equal(runs, 0);
 const stop = startCalendarSchedule(sync, false, 5); await new Promise((r) => setTimeout(r, 30)); assert.equal(runs, 1); release(); await stop();
});
