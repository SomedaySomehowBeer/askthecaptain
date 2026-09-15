import { type Sql, type TransactionSql } from '@captain/db';
import { WorkflowPause, type HandlerContext, type Registry } from '@captain/engine';
import { calendarPrepInstruction } from '@captain/steps';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { CalendarService } from '../calendar/service.ts';
import { addresses } from '../contacts/addresses.ts';
import type { InferenceService } from '../inference/service.ts';

export const noteSchema = z.object({ note: z.string().trim().min(1).max(2000).regex(/^[^\r\n]+$/) }).strict();
const eventSchema = z.object({ id: z.uuid(), revision: z.string().regex(/^[a-f0-9]{32}$/), readAt: z.iso.datetime(), attendees: z.array(z.object({ email: z.string().optional(), name: z.string().optional(), response: z.string().optional() }).passthrough()) });
type Event = z.infer<typeof eventSchema>;
export class CalendarPrepService {
 readonly db: Sql; readonly now: () => Date;
 constructor(db: Sql, now = () => new Date()) { this.db = db; this.now = now; }
 register(registry: Registry, inference: InferenceService) {
  registry.registerStep('calendar.tomorrow', { kind: 'read', transaction: async ctx => {
   const readAt = this.now().toISOString();
   const [day] = await ctx.tx`select (((${readAt}::timestamptz at time zone timezone)::date) + 1)::text as tomorrow,
    (((${readAt}::timestamptz at time zone timezone)::date) + 2)::text as after from organisations where id = ${ctx.organisationId}`;
   const value = await new CalendarService(this.db).readIn(ctx.tx, ctx.organisationId, { from: day!.tomorrow, to: day!.after });
   const hasAccess = value.connection?.scopes.some((s: string) => ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'].includes(s));
   if (value.connection?.status !== 'connected' || !hasAccess || !('covered' in value) || !value.covered || value.lastSync?.detail.success !== true)
    throw new WorkflowPause('Tomorrow’s calendar is unavailable or incompletely synced. Connect Google and sync in Calendar, then Resume.');
   if (value.events.length > 100 || value.events.some(e => e.attendees.length > 100)) throw new WorkflowPause('Preparation supports up to 100 events and 100 attendees per event. Review your selected calendars, then start a new run.');
   return value.events.map(e => ({ id: e.id, summary: e.summary.slice(0, 300), location: e.location.slice(0, 300), startsAt: e.startsAt, endsAt: e.endsAt,
    allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, timezone: value.timezone, attendees: e.attendees.map((a: Record<string, unknown>) => ({ email: typeof a.email === 'string' ? a.email.slice(0, 254) : undefined, name: typeof a.name === 'string' ? a.name.slice(0, 200) : '', response: typeof a.response === 'string' ? a.response.slice(0, 30) : '' })),
    attendeesOmitted: e.attendeesOmitted, revision: e.preparationRevision, readAt }));
  } });
  registry.registerStep('contacts.forEvent', { kind: 'read', transaction: (ctx, args) => this.people(ctx.tx, eventSchema.parse(args.event)) });
  registry.registerStep('mail.relatedThreads', { kind: 'read', transaction: (ctx, args) => this.threads(ctx.tx, eventSchema.parse(args.event), z.array(z.string()).parse((args.people as { emails: unknown }).emails)) });
  registry.registerStep('prepareEventNote', { kind: 'infer', retrySafe: true, call: (ctx, args) => inference.infer({ userId: ctx.userId, requestId: ctx.runId }, {
   organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'large', instruction: calendarPrepInstruction, schema: noteSchema, input: { untrustedContent: args }
  }) });
  registry.registerStep('calendar.writeNote', { kind: 'write', transaction: (ctx, args) => this.record(ctx, eventSchema.parse(args.event), noteSchema.parse(args.note).note) });
  return registry;
 }
 async people(tx: TransactionSql, event: Event) {
  const [connection] = await tx`select account_email from connections where provider = 'google'`;
  const emails = [...new Set(event.attendees.flatMap(a => addresses(a.email ?? '').map(a => a.email)))].filter(email => email !== connection?.accountEmail?.toLowerCase());
  const contacts = await tx`select c.id, c.email, left(c.name, 200) as name, left(c.role, 200) as role,
   co.id as company_id, left(co.name, 200) as company_name from contacts c left join companies co on co.id = c.company_id and co.archived_at is null
   where c.email = any(${tx.array(emails)}::text[]) and c.archived_at is null order by c.email`;
  return { emails, contacts, unmatched: emails.filter(email => !contacts.some(c => c.email === email)) };
 }
 async threads(tx: TransactionSql, event: Event, emails: string[]) {
  const [sync] = await tx`select action, detail, created_at from audit_events where action in ('mail.synced', 'mail.sync_failed', 'mail.sync_started') order by created_at desc, id desc limit 1`;
  const [conn] = await tx`select id, status, account_email from connections where provider = 'google'`;
  if (conn?.status !== 'connected' || sync?.action !== 'mail.synced' || sync.detail.success !== true)
   throw new WorkflowPause('Recent mail is unavailable or incompletely synced. Connect Google and sync in Inbox, then Resume.');
  if (!emails.length) return { threads: [], warning: 'No other attendee email addresses are available to match recent mail.', lastSyncedAt: sync.createdAt };
  // SQL narrows candidates; the mailbox parser performs exact matching (including quoted names).
  const patterns = emails.map(email => `%${email.replace(/[\\%_]/g, '\\$&')}%`);
  const candidates = await tx`select m.thread_id, m.subject, m.snippet, m.sent_at, m.from_header, m.to_header, m.cc_header, m.bcc_header
   from mail_messages m join mail_threads t on t.id = m.thread_id
   where t.connection_id = ${conn.id} and t.account_email = ${conn.accountEmail}
   and m.sent_at >= ${event.readAt}::timestamptz - interval '30 days' and m.sent_at <= ${event.readAt}::timestamptz
   and (m.from_header ilike any(${tx.array(patterns)}::text[]) or m.to_header ilike any(${tx.array(patterns)}::text[])
    or m.cc_header ilike any(${tx.array(patterns)}::text[]) or m.bcc_header ilike any(${tx.array(patterns)}::text[]))
   order by m.sent_at desc, m.id desc limit 1001`;
  const threads = new Map<string, { id: string; subject: string; snippet: string; sentAt: Date }>();
  for (const m of candidates.slice(0, 1000)) {
   if (![m.fromHeader, m.toHeader, m.ccHeader, m.bccHeader].some(h => addresses(h).some(a => emails.includes(a.email)))) continue;
   if (!threads.has(m.threadId)) threads.set(m.threadId, { id: m.threadId, subject: m.subject.slice(0, 300), snippet: m.snippet.slice(0, 1000), sentAt: m.sentAt });
   if (threads.size === 10) break;
  }
  return { threads: [...threads.values()], lastSyncedAt: sync.createdAt, warning: candidates.length > 1000 ? 'Only the newest 1000 candidate messages were searched. Older matching threads may be missing.' : 'At most 10 recent threads, using subjects and snippets only; absence is not proof that nothing is owed.' };
 }
 async record(ctx: HandlerContext & { tx: TransactionSql }, event: Event, note: string) {
  // Sync invalidation and this update take the same row lock. Compare first execution time: scheduled runs are created in advance.
  const [saved] = await ctx.tx`update calendar_events e set preparation_note = ${note}, prepared_by_run = ${ctx.runId}, prepared_at = now()
   from calendars c, connections cn where e.id = ${event.id} and c.id = e.calendar_id and cn.id = c.connection_id
   and c.account_email = cn.account_email and cn.status = 'connected' and (c.selected or c.is_primary)
   and md5((to_jsonb(e) - array['preparation_note', 'prepared_by_run', 'prepared_at'])::text) = ${event.revision}
   and (e.prepared_by_run is null or (select (coalesce(r.started_at, r.created_at), r.id) from workflow_runs r where r.id = e.prepared_by_run)
    <= (select (coalesce(r.started_at, r.created_at), r.id) from workflow_runs r where r.id = ${ctx.runId})) returning e.id, e.prepared_at`;
  if (!saved) return { skipped: 'The event changed, was removed or has newer preparation. Start a new run to prepare the current calendar.' };
  await audit(ctx.tx, { organisationId: ctx.organisationId, actor: { kind: 'workflow', id: ctx.userId }, action: 'calendar.prepared', subjectType: 'calendar_event', subjectId: event.id, requestId: ctx.runId });
  return saved;
 }
}
