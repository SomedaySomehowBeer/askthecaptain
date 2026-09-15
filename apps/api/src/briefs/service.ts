import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import type { HandlerContext, Registry } from '@captain/engine';
import { morningBriefInstruction } from '@captain/steps';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { CalendarService } from '../calendar/service.ts';
import { XeroService } from '../xero/service.ts';
import { waitingDrafts } from '../triage/outbox.ts';
import type { InferenceService } from '../inference/service.ts';
import type { PushService } from '../push/service.ts';

const itemSchema = z.object({ kind: z.enum(['task', 'outbox', 'event', 'invoice']), id: z.uuid() }).strict();
export const briefSchema = z.object({ title: z.string().trim().min(1).max(120), lines: z.array(z.string().trim().min(1).max(400)).min(1).max(6), items: z.array(itemSchema).max(12) }).strict();
type Item = z.infer<typeof itemSchema> & { label: string; href: string };
type Tasks = Awaited<ReturnType<CommitmentsService['briefTasks']>>;
type Drafts = Awaited<ReturnType<typeof waitingDrafts>>;
type Events = { connected: boolean; complete: boolean; events: { id: string; summary: string }[]; truncated: boolean };
type Receivables = { connected: boolean; complete: boolean; invoices: { id: string; number: string }[]; truncated: boolean };
type Sources = { tasks: Tasks; outbox: Drafts; events: Events; receivables: Receivables };
export type Brief = { runId: string; forDate: string; title: string; lines: string[]; items: Item[]; producedAt: Date };

function links(s: Sources): Item[] {
 return [
  ...s.tasks.tasks.map(t => ({ kind: 'task' as const, id: String(t.id), label: String(t.title), href: '/commitments' })),
  ...s.outbox.drafts.map(d => ({ kind: 'outbox' as const, id: String(d.id), label: `Draft: ${d.subject}`, href: d.threadId ? `/inbox/${d.threadId}` : '/inbox' })),
  ...s.events.events.map(e => ({ kind: 'event' as const, id: e.id, label: e.summary || 'Calendar event', href: `/calendar?week=${s.tasks.today}` })),
  ...s.receivables.invoices.map(i => ({ kind: 'invoice' as const, id: i.id, label: `Xero invoice ${i.number}`, href: '/settings/connections' }))
 ];
}
export function warnings(s: Sources): string[] {
 return [
  !s.events.connected ? 'Google calendar is not connected. Connect Google in Settings.' : !s.events.complete ? 'Calendar data may be incomplete or stale. Check sync status in Calendar.' : null,
  !s.receivables.connected ? 'Xero is not connected. Connect Xero in Settings.' : !s.receivables.complete ? 'Xero data may be incomplete or stale. Check sync status in Settings.' : null,
  s.tasks.truncated || s.outbox.truncated || s.events.truncated || s.receivables.truncated ? 'This brief uses the first 100 items from each source. Open the source tabs for the full lists.' : null
 ].filter((s): s is string => !!s);
}
export class BriefService {
 readonly db: Sql;
 constructor(db: Sql) { this.db = db; }
 register(registry: Registry, inference: InferenceService, push: PushService) {
  const commitments = new CommitmentsService(this.db), calendar = new CalendarService(this.db), xero = new XeroService(this.db);
  registry.registerStep('tasks.overdueAndThisWeek', { kind: 'read', transaction: ctx => commitments.briefTasks(ctx.tx, ctx.organisationId) });
  registry.registerStep('outbox.waiting', { kind: 'read', transaction: ctx => waitingDrafts(ctx.tx) });
  registry.registerStep('calendar.today', { kind: 'read', transaction: async (ctx, args) => {
   const value = await calendar.readIn(ctx.tx, ctx.organisationId, { from: z.iso.date().parse(args.today), to: z.iso.date().parse(args.tomorrow) });
   const events = ('events' in value ? value.events : []).filter(e => e.status !== 'cancelled');
   const connected = value.connection?.status === 'connected';
   const hasAccess = value.connection?.scopes.some((scope: string) => ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'].includes(scope));
   return { connected, complete: connected && !!hasAccess && 'covered' in value && value.covered && value.lastSync?.detail.success === true,
    lastSyncedAt: value.lastSync?.at ?? null, truncated: events.length > 100,
    events: events.slice(0, 100).map(e => ({ id: e.id, summary: e.summary.slice(0, 300), startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.allDay, startDate: e.startDate, endDate: e.endDate })) };
  } });
  registry.registerStep('xero.overdueReceivables', { kind: 'read', transaction: async (ctx, args) => {
   const value = await xero.readIn(ctx.tx, ctx.organisationId, z.number().int().min(0).max(365).parse(args.overdueDays ?? 0), 0, z.iso.date().optional().parse(args.today));
   const invoices = 'invoices' in value ? value.invoices : [];
   return { connected: value.connected, complete: value.complete, lastSyncedAt: value.lastSyncedAt, truncated: invoices.length > 100 || ('nextOffset' in value && value.nextOffset !== null),
    invoices: invoices.slice(0, 100).map(i => ({ id: i.id, number: (i.number ?? 'without a number').slice(0, 200), dueDate: i.dueDate, daysOverdue: i.daysOverdue, currency: i.currency, amountDue: i.amountDue, contactName: i.contactName.slice(0, 200), contactEmail: i.contactEmail })) };
  } });
  registry.registerStep('writeBrief', { kind: 'infer', retrySafe: true, call: (ctx, args) => {
   const sources = args as unknown as Sources, allowed = new Set(links(sources).map(i => `${i.kind}:${i.id}`));
   const schema = briefSchema.superRefine((brief, validation) => {
    for (const item of brief.items) if (!allowed.has(`${item.kind}:${item.id}`)) validation.addIssue({ code: 'custom', path: ['items'], message: 'Use only kind/id pairs present in the supplied sources.' });
   });
   return inference.infer({ userId: ctx.userId, requestId: ctx.runId }, { organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'large',
    instruction: morningBriefInstruction, schema, input: { tone: args.tone, today: sources.tasks.today, timezone: sources.tasks.timezone, sourceWarnings: warnings(sources), untrustedContent: sources } });
  } });
  registry.registerStep('briefs.record', { kind: 'write', transaction: (ctx, args) => this.record(ctx, args as unknown as Sources & { brief: unknown }) });
  registry.registerStep('push.owner', { kind: 'notify', retrySafe: true, call: async (ctx, args) => {
   const deliveries = await push.send(ctx.organisationId, ctx.userId, { title: (args.brief as Brief).title, body: 'Open Captain for your morning brief.', url: '/', tag: ctx.idempotencyKey }, { runId: ctx.runId, actor: { userId: ctx.userId, requestId: ctx.runId } });
   if (!deliveries.some(d => d.state === 'sent')) throw Error('The brief is saved in Today, but push could not be sent. Check your devices in Settings → Notifications, then retry the run.');
   return { sent: deliveries.filter(d => d.state === 'sent').length, failed: deliveries.filter(d => d.state !== 'sent').length };
  } });
  return registry;
 }
 async record(ctx: HandlerContext & { tx: TransactionSql }, sources: Sources & { brief: unknown }) {
  const brief = briefSchema.parse(sources.brief), allowed = links(sources);
  const items = brief.items.map(item => { const link = allowed.find(i => i.kind === item.kind && i.id === item.id); if (!link) throw Error('Brief refers to an item outside its sources.'); return link; });
  const lines = [...new Set([...brief.lines, ...warnings(sources)])];
  const [row] = await ctx.tx<Brief[]>`insert into briefs (organisation_id, run_id, for_date, title, lines, items)
   values (${ctx.organisationId}, ${ctx.runId}, ${sources.tasks.today}::date, ${brief.title}, ${ctx.tx.json(lines)}, ${ctx.tx.json(items)})
   on conflict (organisation_id, run_id) do nothing returning run_id, for_date::text, title, lines, items, produced_at`;
  if (row) await audit(ctx.tx, { organisationId: ctx.organisationId, actor: { kind: 'workflow', id: ctx.userId }, action: 'brief.produced', subjectType: 'brief', subjectId: ctx.runId, requestId: ctx.runId });
  return row ?? (await ctx.tx<Brief[]>`select run_id, for_date::text, title, lines, items, produced_at from briefs where run_id = ${ctx.runId}`)[0]!;
 }
 async latest(actor: Actor, org: string, runnerProblem: string | null) {
  await roleOf(this.db, actor.userId, org);
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async tx => {
   const [clock] = await tx`select timezone, (now() at time zone timezone)::date::text as today from organisations where id = ${org}`;
   const [brief] = await tx<Brief[]>`select run_id, for_date::text, title, lines, items, produced_at from briefs order by for_date desc, produced_at desc, run_id desc limit 1`;
   const [enablement] = await tx`select enabled from workflow_enablements where definition_key = 'morning-brief'`;
   const [run] = await tx`select state, reason from workflow_runs where definition_key = 'morning-brief'
    and (schedule_key is null or schedule_advanced or state = 'paused') order by coalesce(started_at, created_at) desc, id desc limit 1`;
   const notice = !enablement?.enabled ? 'Morning brief is off. Turn it on in Settings → Workflows after setting up inference and notifications.' : runnerProblem
    ?? (run && ['paused', 'failed', 'cancelled'].includes(run.state) ? `Morning brief ${run.state}. ${run.reason ?? 'Open Settings → Workflows to inspect the run.'}`
     : run && ['running', 'queued'].includes(run.state) ? 'A morning brief is being prepared. Refresh shortly.' : !brief || brief.forDate !== clock!.today ? 'No brief has been produced for today. It runs at 06:30; check the run in Settings → Workflows.' : null);
   return { brief: brief ?? null, today: clock!.today, timezone: clock!.timezone, notice };
  });
 }
}
