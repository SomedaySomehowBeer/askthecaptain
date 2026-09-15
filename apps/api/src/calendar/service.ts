import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { badRequest, forbidden, HttpError } from '../errors.ts';
import { connection, requireMember } from './store.ts';
import type { CalendarSync } from './sync.ts';
type Actor = { userId: string; requestId: string };
export class CalendarService {
 readonly db: Sql; readonly syncRoutine?: CalendarSync; readonly automatic: boolean; readonly runnerProblem: () => string | null;
 constructor(db: Sql, syncRoutine?: CalendarSync, automatic = false, runnerProblem: () => string | null = () => null) { this.runnerProblem = runnerProblem; this.db = db; this.syncRoutine = syncRoutine; this.automatic = automatic; }
 async read(actor: Actor, organisationId: string, range?: { from: string; to: string }) {
  return withTenant(this.db, { organisationId, userId: actor.userId }, async (tx) => {
   await requireMember(tx, actor.userId, organisationId);
   return this.readIn(tx, organisationId, range);
  });
 }
 async readIn(tx: TransactionSql, organisationId: string, range?: { from: string; to: string }) {
   const conn = await connection(tx); const [org] = await tx`select timezone from organisations where id = ${organisationId}`; const timezone = org!.timezone as string;
   const calendars = !conn || conn.status === 'disconnected' ? [] : await tx`select id, name, provider_id, is_primary, timezone, access_role, selected, synced_from, synced_to, synced_at
    from calendars where connection_id = ${conn.id} and account_email = ${conn.accountEmail} order by is_primary desc, name, id`;
   const [lastSync] = await tx`select created_at as at, detail from audit_events where action in ('calendar.synced', 'calendar.sync_failed', 'calendar.sync_started') order by created_at desc, id desc limit 1`;
   const base = { connection: conn, timezone, calendars, lastSync: lastSync ?? null, automaticSyncEnabled: this.automatic, preparationNotice: await preparationState(tx) ?? this.runnerProblem() };
   if (!range) return base;
   const bound = (value: string) => value.length === 10 ? tx`(${value}::date::timestamp at time zone ${timezone})` : tx`${value}::timestamptz`;
   const [bounds] = await tx`select ${bound(range.from)} as lower, ${bound(range.to)} as upper`;
   const lower = bounds!.lower as Date; const upper = bounds!.upper as Date;
   if (!(upper > lower) || upper.getTime() - lower.getTime() > 370 * 86_400_000) throw badRequest('invalid_range', 'Choose a date range of up to one year.');
   const selected = calendars.filter((c) => c.selected || c.isPrimary);
   const covered = selected.length > 0 && selected.every((c) => c.syncedAt && c.syncedFrom <= lower && c.syncedTo >= upper);
   const events = !selected.length ? [] : await tx`select e.id, e.status, e.summary, e.description, e.location, e.starts_at, e.ends_at, e.all_day,
    e.start_date::text, e.end_date::text, e.timezone, e.organiser, e.attendees, e.attendees_omitted, jsonb_array_length(e.attendees) as attendee_count, e.recurring_event_id, e.html_link, md5((to_jsonb(e) - array['preparation_note', 'prepared_by_run', 'prepared_at'])::text) as preparation_revision, e.preparation_note, e.prepared_at, e.prepared_by_run,
    c.name as calendar_name, c.id as calendar_id from calendar_events e join calendars c on c.id = e.calendar_id
    where c.id = any(${tx.array(selected.map((c) => c.id))}::uuid[])
    and (case when e.all_day then e.start_date::timestamp at time zone ${timezone} else e.starts_at end) < ${upper.toISOString()}::timestamptz
    and (case when e.all_day then e.end_date::timestamp at time zone ${timezone} else e.ends_at end) > ${lower.toISOString()}::timestamptz
    order by (case when e.all_day then e.start_date::timestamp at time zone ${timezone} else e.starts_at end), e.id`;
   return { ...base, events, covered, from: lower.toISOString(), to: upper.toISOString() };
 }
 async sync(actor: Actor, organisationId: string) {
  await withTenant(this.db, { organisationId, userId: actor.userId }, async (tx) => {
   if (await requireMember(tx, actor.userId, organisationId) === 'member') throw forbidden('Only an owner or admin can sync calendars.');
  });
  if (!this.syncRoutine) throw new HttpError(503, 'calendar_unavailable', 'Calendar sync is not configured. Ask the owner to finish setup.');
  return this.syncRoutine.run(organisationId);
 }
}

async function preparationState(tx: TransactionSql) {
 const [enabled] = await tx`select enabled from workflow_enablements where definition_key = 'calendar-prep'`;
 if (!enabled?.enabled) return 'Calendar preparation is off. Turn on Prepare for tomorrow in Settings → Workflows.';
 const [runtime] = await tx`select status from inference_runtimes`;
 if (runtime?.status !== 'ready') return 'Inference is not ready. Check Settings → Inference, then resume preparation in Workflows.';
 const [run] = await tx`select state, reason from workflow_runs where definition_key = 'calendar-prep'
  and (schedule_key is null or schedule_advanced or state = 'paused') order by coalesce(started_at, created_at) desc, id desc limit 1`;
 return run && ['paused', 'failed', 'cancelled'].includes(run.state) ? `Calendar preparation ${run.state}. ${run.reason ?? 'Check Settings → Workflows.'}` : null;
}
