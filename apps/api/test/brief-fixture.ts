import type { Harness } from '@captain/db/test';
import { randomUUID } from 'node:crypto';
import { triageFixture } from './triage-fixture.ts';
import { BriefService } from '../src/briefs/service.ts';
import { CommitmentsService } from '../src/commitments/service.ts';
import { PushService } from '../src/push/service.ts';
import { WorkflowService } from '../src/workflows/service.ts';
export async function briefFixture(db: Harness) {
 const f = await triageFixture(db), payloads: { endpoint: string; payload: any }[] = []; let failPush = false;
 try {
 const push = new PushService(db.app, { send: async (device, payload) => { payloads.push({ endpoint: device.endpoint, payload: JSON.parse(payload) }); if (failPush) throw Error('Fixture push failed'); return { statusCode: 201 }; } }, 'fixture-key');
 const briefs = new BriefService(db.app); briefs.register(f.registry, f.inference, push);
 const workflows = new WorkflowService(db.app, push, f.engine);
 await f.engine.boss.updateQueue('workflow_morning-brief', { retryDelay: 1, retryLimit: 1, retryBackoff: false });
 await push.subscribe(f.actor, f.org, { endpoint: 'https://push.example.test/owner', keys: { p256dh: 'fixture', auth: 'fixture' } });
 await f.tx(tx => tx`update organisations set timezone = 'Pacific/Kiritimati' where id = ${f.org}`);
 await f.tx(tx => tx`update connections set scopes = array_append(scopes, 'https://www.googleapis.com/auth/calendar.readonly') where provider = 'google'`);
 const commitments = new CommitmentsService(db.app), clock = await f.tx(tx => commitments.briefTasks(tx, f.org));
 const overdue = await commitments.createTask(f.actor, f.org, { title: 'File the return', due: '2020-01-01' });
 const due = await commitments.createTask(f.actor, f.org, { title: 'Pay the supplier', due: clock.today });
 const suggested = await commitments.createTask(f.actor, f.org, { title: 'Check suggested delivery', status: 'suggested' });
 const thread = await f.mail();
 const draft = await f.outbox.create(f.actor, f.org, { threadId: thread, to: ['supplier@example.test'], subject: 'Delivery update', body: 'PRIVATE DRAFT BODY' });
 const [calendar] = await f.tx(tx => tx`insert into calendars (organisation_id, connection_id, account_email, provider_id, name, is_primary, timezone, access_role, synced_from, synced_to, synced_at)
  values (${f.org}, ${f.conn.id}, ${f.conn.accountEmail}, 'primary', 'Business', true, ${clock.timezone}, 'owner', now() - interval '2 days', now() + interval '3 days', now()) returning id`);
 const [event] = await f.tx(tx => tx`insert into calendar_events (organisation_id, calendar_id, provider_id, status, summary, description, location, starts_at, ends_at, all_day, start_date, end_date, timezone, organiser, attendees, html_link, updated_at)
  values (${f.org}, ${calendar!.id}, 'today', 'confirmed', 'Supplier meeting', 'PRIVATE EVENT DESCRIPTION', '', (${clock.today}::date + time '09:00') at time zone ${clock.timezone}, (${clock.today}::date + time '10:00') at time zone ${clock.timezone}, false, null, null, ${clock.timezone}, '{}', '[]', '', now()) returning id`);
 await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, detail) values (${f.org}, 'system', 'calendar.synced', 'connection', '{"success":true}')`);
 const [xero] = await f.tx(tx => tx`insert into connections (organisation_id, provider, connected_by, status, scopes) values (${f.org}, 'xero', ${f.userId}, 'connected', '{}') returning id`);
 const contact = randomUUID();
 await f.tx(tx => tx`insert into xero_contacts (organisation_id, connection_id, provider_id, name, email, is_customer, is_supplier, updated_at)
  values (${f.org}, ${xero!.id}, ${contact}, 'Customer', 'customer@example.test', true, false, now())`);
 const [invoice] = await f.tx(tx => tx`insert into xero_invoices (organisation_id, connection_id, provider_id, type, contact_provider_id, number, status, date, due_date, currency, total, amount_due, amount_paid, updated_at)
  values (${f.org}, ${xero!.id}, ${randomUUID()}, 'ACCREC', ${contact}, 'INV-42', 'AUTHORISED', '2020-01-01', '2020-01-10', 'AUD', 120, 120, 0, now()) returning id`);
 await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail) values (${f.org}, 'system', 'xero.synced', 'connection', ${xero!.id}, '{}')`);
 const output = { title: 'Your morning at a glance', lines: ['The return is overdue. Pay the supplier today.', 'A draft is waiting for you; the supplier meeting is at 9am.', 'INV-42 has AUD 120 outstanding.'],
  items: [{ kind: 'task', id: overdue.id }, { kind: 'outbox', id: draft.id }, { kind: 'event', id: String(event!.id) }, { kind: 'invoice', id: String(invoice!.id) }] };
 return { ...f, briefs, workflows, push, payloads, output, clock, overdue, due, suggested, eventId: String(event!.id), invoiceId: String(invoice!.id), draft,
  failPush: (value: boolean) => { failPush = value; },
  enable: () => workflows.enable(f.actor, f.org, 'morning-brief', { enabled: true, parameters: { tone: 'Warm, plain and brief.' } }),
  start: () => f.tx(tx => f.engine.start(tx, f.org, 'morning-brief')) };
 } catch (error) { await f.engine.close(); throw error; }
}
