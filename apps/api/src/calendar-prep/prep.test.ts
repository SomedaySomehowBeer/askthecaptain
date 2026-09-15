import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { definitionByKey } from '@captain/steps';
import { calendarPrepFixture } from '../../test/calendar-prep-fixture.ts';
import { result, until } from '../../test/triage-fixture.ts';
import { saveEvent } from '../calendar/store.ts';
import type { CalendarEvent } from '@captain/connectors/calendar';
import { noteSchema } from './service.ts';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
const note = 'Alex Supplier is the account manager at Supply Co. You owe a delivery date and have asked for a revised quote. Another attendee has no matched contact.';
it('a scheduled real run prepares tomorrow in the tenant timezone, validates one paragraph and journals/audits a local write; replay is inert', async () => {
 const f = await calendarPrepFixture(db); try {
  assert.deepEqual(f.registry.missing(definitionByKey('calendar-prep')!), []);
  assert.match((await f.read()).preparationNotice!, /is off/);
  await f.tx(tx => tx`insert into calendar_events (organisation_id, calendar_id, provider_id, status, summary, description, location, starts_at, ends_at, all_day, timezone, organiser, attendees, html_link, updated_at)
   select organisation_id, calendar_id, 'today', status, 'Today only', description, location, starts_at - interval '1 day', ends_at - interval '1 day', all_day, timezone, organiser, attendees, html_link, updated_at from calendar_events where id = ${f.eventId}`);
  await f.enable(); f.provider.responses.push(result({ note: 'Bad\nparagraph' }), result({ note }));
  const [scheduled] = await f.tx(tx => tx`select id from workflow_runs where definition_key = 'calendar-prep' and schedule_key is not null and state = 'queued'`);
  const run = String(scheduled!.id); await f.engine.boss.send('workflow_calendar-prep', { runId: run });
  const completed = await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  assert.equal(completed.steps.filter(s => s.key === 'calendar.writeNote').length, 1);
  const view = await f.read(); assert.equal(view.preparationNotice, null); assert.ok('events' in view); assert.equal(view.events[0]!.preparationNote, note); assert.ok(view.events[0]!.preparedAt); assert.equal(view.events[0]!.preparedByRun, run);
  assert.equal((await f.tx(tx => tx`select preparation_note from calendar_events where provider_id = 'today'`))[0]!.preparationNote, null);
  const request = f.provider.requests.at(-1)!; assert.match(request.instruction, /UNTRUSTED DATA/); assert.match(request.input, /Supply Co/); assert.match(request.input, /new@example.test/); assert.match(request.input, /revised quote/);
  assert.ok(!request.input.includes('PRIVATE')); assert.ok(!request.input.includes('fixture-token')); assert.match(request.input, /untrustedContent/);
  assert.equal((await f.tx(tx => tx`select * from model_usage where run_id = ${run}`)).length, 2);
  const [audit] = await f.tx(tx => tx`select actor_kind, actor_id from audit_events where action = 'calendar.prepared'`); assert.equal(audit!.actorKind, 'workflow'); assert.equal(audit!.actorId, f.userId);
  assert.deepEqual(f.calls, []); assert.equal(f.sends(), 0);
  const requests = f.provider.requests.length; await f.engine.boss.send('workflow_calendar-prep', { runId: run }); await new Promise(r => setTimeout(r, 1200));
  assert.equal(f.provider.requests.length, requests); assert.equal((await f.tx(tx => tx`select * from audit_events where action = 'calendar.prepared'`)).length, 1);
  await f.workflows.enable(f.actor, f.org, 'calendar-prep', { enabled: false }); assert.match((await f.read()).preparationNotice!, /is off/);
  assert.equal((await f.tx(tx => tx`select preparation_note from calendar_events where id = ${f.eventId}`))[0]!.preparationNote, note);
 } finally { await f.engine.close(); }
});
it('mail matches exact addresses, excludes old/future messages and bounds unique threads to ten; all-day overlap is prepared', async () => {
 const f = await calendarPrepFixture(db); try {
  for (let n = 0; n < 12; n++) await f.mail(`recent-${n}`, 'supplier@example.test');
  for (const [id, sender] of [['false-match', 'xsupplier@example.test'], ['old', 'supplier@example.test'], ['future', 'supplier@example.test']] as const) await f.mail(id, sender);
  await f.tx(tx => tx`update mail_messages set sent_at = now() - interval '31 days', subject = 'TOO OLD' where provider_id = 'old-message'`);
  await f.tx(tx => tx`update mail_messages set sent_at = now() + interval '1 day', subject = 'FUTURE' where provider_id = 'future-message'`);
  await f.tx(tx => tx`update mail_messages set subject = 'SUBSTRING MATCH' where provider_id = 'false-match-message'`);
  await f.tx(tx => tx`update calendar_events set all_day = true, start_date = ${f.clock.today}::date, end_date = ${f.clock.after}::date,
   starts_at = ${f.clock.today}::date::timestamp at time zone ${f.clock.timezone}, ends_at = ${f.clock.after}::date::timestamp at time zone ${f.clock.timezone} where id = ${f.eventId}`);
  await f.enable(); f.provider.responses.push(result({ note })); const run = await f.start();
  const completed = await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  const output = completed.steps.find(s => s.key === 'mail.relatedThreads')!.output as { threads: { id: string; subject: string; snippet: string; sentAt: string }[] };
  assert.equal(output.threads.length, 10); assert.equal(new Set(output.threads.map(t => t.id)).size, 10);
  assert.ok(output.threads.every(t => t.subject === 'Delivery update')); assert.deepEqual(Object.keys(output.threads[0]!).sort(), ['id', 'sentAt', 'snippet', 'subject']);
  assert.equal(noteSchema.safeParse({ note: 'two\nparagraphs' }).success, false);
 } finally { await f.engine.close(); }
});
it('sync gaps and budget exhaustion pause honestly; an event changed while paused cannot receive stale preparation', async () => {
 const f = await calendarPrepFixture(db); try {
  await f.enable(); await f.tx(tx => tx`update calendars set synced_to = now() - interval '1 day'`);
  const run = await f.start(); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused'); assert.match((await f.read()).preparationNotice!, /sync in Calendar/);
  await f.tx(tx => tx`update calendars set synced_to = now() + interval '90 days'`);
  await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, detail) values (${f.org}, 'system', 'mail.sync_failed', 'connection', '{}')`);
  await f.tx(tx => f.engine.control(tx, f.org, run, 'resume')); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused' && !!r.reason?.includes('sync in Inbox'));
  await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, detail) values (${f.org}, 'system', 'mail.synced', 'connection', '{"success":true}')`);
  await f.inference.setBudget(f.actor, f.org, 0); await f.tx(tx => f.engine.control(tx, f.org, run, 'resume'));
  await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'paused' && !!r.reason?.includes('allowance'));
  await f.tx(tx => tx`update calendar_events set summary = 'Moved meeting' where id = ${f.eventId}`);
  f.provider.responses.push(result({ note })); await f.inference.setBudget(f.actor, f.org, 1_000_000); await f.tx(tx => f.engine.control(tx, f.org, run, 'resume'));
  const completed = await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  assert.match(JSON.stringify(completed.steps.find(s => s.key === 'calendar.writeNote')!.output), /event changed/);
  assert.equal((await f.tx(tx => tx`select preparation_note from calendar_events where id = ${f.eventId}`))[0]!.preparationNote, null);
 } finally { await f.engine.close(); }
});
it('unchanged sync preserves notes; provider changes clear them; older paused runs cannot replace newer notes', async () => {
 const f = await calendarPrepFixture(db); try {
  await f.enable(); await f.inference.setBudget(f.actor, f.org, 0); const old = await f.start(); await until(() => f.workflows.run(f.actor, f.org, old), r => r.state === 'paused');
  await f.inference.setBudget(f.actor, f.org, 1_000_000); f.provider.responses.push(result({ note })); const run = await f.start(); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  f.provider.responses.push(result({ note: 'Older preparation.' })); await f.tx(tx => f.engine.control(tx, f.org, old, 'resume')); await until(() => f.workflows.run(f.actor, f.org, old), r => r.state === 'succeeded');
  assert.equal((await f.tx(tx => tx`select preparation_note from calendar_events where id = ${f.eventId}`))[0]!.preparationNote, note);
  const [scheduled] = await f.tx(tx => tx`select id from workflow_runs where definition_key = 'calendar-prep' and schedule_key is not null and state = 'queued' order by created_at limit 1`);
  f.provider.responses.push(result({ note: 'Fresh scheduled preparation.' })); await f.engine.boss.send('workflow_calendar-prep', { runId: String(scheduled!.id) });
  await until(() => f.workflows.run(f.actor, f.org, String(scheduled!.id)), r => r.state === 'succeeded');
  const [source] = await f.tx(tx => tx`select * from calendar_events where id = ${f.eventId}`);
  assert.equal(source!.preparationNote, 'Fresh scheduled preparation.', 'a schedule created before a manual run can execute later with fresh data');
  const event: CalendarEvent = { providerId: source!.providerId, status: 'confirmed', summary: source!.summary, description: source!.description, location: source!.location,
   start: { dateTime: source!.startsAt.toISOString(), timeZone: source!.timezone }, end: { dateTime: source!.endsAt.toISOString() }, organiser: source!.organiser,
   attendees: source!.attendees, attendeesOmitted: false, recurringEventId: null, htmlLink: '', updatedAt: source!.updatedAt.toISOString() };
  await withTenant(db.app, { organisationId: f.org }, tx => saveEvent(tx, f.org, f.calendarId, f.clock.timezone, event));
  assert.equal((await f.tx(tx => tx`select preparation_note from calendar_events where id = ${f.eventId}`))[0]!.preparationNote, 'Fresh scheduled preparation.');
  await withTenant(db.app, { organisationId: f.org }, tx => saveEvent(tx, f.org, f.calendarId, f.clock.timezone, { ...event, attendees: [] }));
  const [row] = await f.tx(tx => tx`select preparation_note, prepared_at, prepared_by_run from calendar_events where id = ${f.eventId}`);
  assert.deepEqual({ ...row }, { preparationNote: null, preparedAt: null, preparedByRun: null });
 } finally { await f.engine.close(); }
});
it('tenant RLS, composite provenance keys and removed membership protect notes; API reads require membership', async () => {
 const f = await calendarPrepFixture(db); try {
  await f.enable(); f.provider.responses.push(result({ note })); const run = await f.start(); await until(() => f.workflows.run(f.actor, f.org, run), r => r.state === 'succeeded');
  const other = await calendarPrepFixture(db); try {
   assert.equal((await other.tx(tx => tx`select * from calendar_events where id = ${f.eventId}`)).length, 0);
   assert.equal((await other.tx(tx => tx`update calendar_events set preparation_note = 'stolen' where id = ${f.eventId} returning id`)).length, 0);
   await assert.rejects(other.tx(tx => tx`update calendar_events set preparation_note = 'wrong run', prepared_at = now(), prepared_by_run = ${run} where id = ${other.eventId}`), { code: '23503' });
  } finally { await other.engine.close(); }
  const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), workflows: f.workflows });
  const path = `/v1/organisations/${f.org}/calendar/events?from=${f.clock.tomorrow}&to=${f.clock.after}`;
  assert.equal((await app.request(path)).status, 401);
  const stranger = await auth.issueSessionFor(f.stranger.userId), member = await auth.issueSessionFor(f.member.userId);
  assert.equal((await app.request(path, { headers: { authorization: `Bearer ${stranger.token}` } })).status, 404);
  const response = await app.request(path, { headers: { authorization: `Bearer ${member.token}` } }); assert.equal(response.status, 200); assert.equal((await response.json()).events[0].preparationNote, note);
  await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.userId}`;
  assert.equal((await f.tx(tx => tx`update calendar_events set preparation_note = 'revoked' returning id`)).length, 0);
 } finally { await f.engine.close(); }
});
