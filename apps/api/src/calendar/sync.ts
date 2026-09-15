import { randomUUID } from 'node:crypto';
import { CalendarClient, CalendarError, type CalendarInfo } from '@captain/connectors/calendar';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import type { ConnectionService } from '../connections/service.ts';
import { HttpError } from '../errors.ts';
import { connection, saveCalendar, saveEvent, type CalendarConnection } from './store.ts';
const cursorSchema = z.object({ syncToken: z.string().min(1), from: z.string().datetime(), to: z.string().datetime(), fullAt: z.number() });
const busy = () => new HttpError(409, 'calendar_sync_running', 'Calendar sync is already running. Check again shortly.');
const failed = 'Calendar could not be synced. Try Sync now again; reconnect Google if access has expired. Any events shown may be incomplete.';
const day = 86_400_000;
export type CalendarSyncResult = { calendars: number; events: number; cancelled: number; full: number };
/** System housekeeping. Fetch outside transactions; a fenced two-minute lease in sync_cursors
 * serialises manual/scheduled runs across API processes, including transaction-pooling databases. */
export class CalendarSync {
 readonly #running = new Set<string>();
 readonly db: Sql; readonly connections: ConnectionService; readonly client: CalendarClient; readonly now: () => number;
 constructor(db: Sql, connections: ConnectionService, client = new CalendarClient(), now = Date.now) { this.db = db; this.connections = connections; this.client = client; this.now = now; }
 async organisations(): Promise<string[]> { return (await this.db`select organisation_id from calendar_sync_organisations()`).map((r) => r.organisationId); }
 async run(organisationId: string): Promise<CalendarSyncResult> {
  if (this.#running.has(organisationId)) throw busy(); this.#running.add(organisationId);
  const runId = randomUUID(); let conn: CalendarConnection | null = null; let acquired = false;
  const counts: CalendarSyncResult = { calendars: 0, events: 0, cancelled: 0, full: 0 };
  const batch = <T>(work: (tx: TransactionSql) => Promise<T>) => withTenant(this.db, { organisationId }, async (tx) => {
   // A replaced lease fences off the old runner; disconnect/reconnect cannot race this page's writes.
   const lock = await tx`update sync_cursors set updated_at = clock_timestamp() where connection_id = ${conn!.id} and resource = 'calendar.sync-lock'
    and cursor = ${runId} and updated_at > clock_timestamp() - interval '2 minutes' returning id`;
   if (!lock.length) throw busy();
   const [current] = await tx`select account_email, status from connections where id = ${conn!.id} for share`;
   if (current?.status !== 'connected' || current.accountEmail !== conn!.accountEmail) throw new CalendarError();
   return work(tx);
  });
  try {
   conn = await withTenant(this.db, { organisationId }, connection);
   if (!conn || conn.status !== 'connected') throw new CalendarError();
   acquired = await withTenant(this.db, { organisationId }, async (tx) => (await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor)
    values (${organisationId}, ${conn!.id}, 'calendar.sync-lock', ${runId}) on conflict (organisation_id, connection_id, resource)
    do update set cursor = excluded.cursor, updated_at = clock_timestamp() where sync_cursors.updated_at < clock_timestamp() - interval '2 minutes' returning id`).length > 0);
   if (!acquired) throw busy();
   await batch((tx) => audit(tx, { organisationId, actor: { kind: 'system' }, action: 'calendar.sync_started', subjectType: 'connection', subjectId: conn!.id,
    detail: { success: false, error: 'Calendar sync has not finished. Events may be incomplete; check again shortly.' } }));
   const token = await this.connections.accessToken(undefined, organisationId, conn.id);
   const listed: CalendarInfo[] = []; let pageToken: string | undefined; const pages = new Set<string>();
   do {
    const page = await this.client.calendars(token, pageToken); listed.push(...page.items); pageToken = page.nextPageToken;
    if (listed.length > 1000 || (pageToken && pages.has(pageToken))) throw new CalendarError();
    if (pageToken) pages.add(pageToken); if (pages.size > 100) throw new CalendarError();
    await batch(async () => {});
   } while (pageToken);
   const selected = await batch(async (tx) => {
    await tx`delete from calendars where connection_id = ${conn!.id} and (account_email <> ${conn!.accountEmail} or not (provider_id = any(${tx.array(listed.map((c) => c.providerId))}::text[])))`;
    const saved = [];
    for (const c of listed) { const row = await saveCalendar(tx, organisationId, conn!, c); if (row.isPrimary || row.selected) saved.push(row); }
    await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'calendar.discovered', subjectType: 'connection', subjectId: conn!.id, detail: { calendars: listed.length } });
    return saved;
   });
   for (const c of selected) {
    const resource = `calendar.events:${c.id}`;
    const previous = await batch(async (tx) => { const [s] = await tx`select cursor from sync_cursors where connection_id = ${conn!.id} and resource = ${resource}`;
     return s ? cursorSchema.parse(JSON.parse(s.cursor)) : null; });
    // Rebase the finite window daily so unchanged recurring occurrences enter the next 90 days.
    let full = !previous || this.now() - previous.fullAt >= day;
    for (let attempt = 0; attempt < 2; attempt++) {
     const window = full ? { from: new Date(this.now() - 30 * day).toISOString(), to: new Date(this.now() + 90 * day).toISOString(), fullAt: this.now() } : previous!;
     let first = true; pageToken = undefined; const seenPages = new Set<string>();
     try {
      do {
       const page = await this.client.events(token, c.providerId, { ...(full ? { timeMin: window.from, timeMax: window.to } : { syncToken: previous!.syncToken }), ...(pageToken ? { pageToken } : {}) });
       if (page.nextPageToken && (seenPages.has(page.nextPageToken) || seenPages.size >= 100)) throw new CalendarError();
       await batch(async (tx) => {
        if (full && first) {
         await tx`delete from calendar_events where calendar_id = ${c.id}`;
         await tx`delete from sync_cursors where connection_id = ${conn!.id} and resource = ${resource}`;
         await tx`update calendars set synced_at = null, synced_from = null, synced_to = null where id = ${c.id}`;
        }
        for (const e of page.items) await saveEvent(tx, organisationId, c.id, c.timezone, e);
        if (!page.nextPageToken) {
         await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${organisationId}, ${conn!.id}, ${resource},
          ${JSON.stringify({ ...window, syncToken: page.nextSyncToken! })}) on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = now()`;
         await tx`update calendars set synced_from = ${window.from}, synced_to = ${window.to}, synced_at = clock_timestamp() where id = ${c.id}`;
        }
        await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'calendar.page_synced', subjectType: 'calendar', subjectId: c.id, detail: { events: page.items.length, full, finalPage: !page.nextPageToken } });
       });
       counts.events += page.items.filter((e) => e.status !== 'cancelled').length; counts.cancelled += page.items.filter((e) => e.status === 'cancelled').length;
       first = false; pageToken = page.nextPageToken; if (pageToken) seenPages.add(pageToken);
      } while (pageToken);
      counts.calendars++; if (full) counts.full++; break;
     } catch (error) { if (error instanceof CalendarError && error.status === 410 && !full) { full = true; continue; } throw error; }
    }
   }
   await batch((tx) => audit(tx, { organisationId, actor: { kind: 'system' }, action: 'calendar.synced', subjectType: 'connection', subjectId: conn!.id, detail: { ...counts, success: true } }));
   return counts;
  } catch (error) {
   if (error instanceof HttpError && error.code === 'calendar_sync_running') throw error;
   await withTenant(this.db, { organisationId }, (tx) => audit(tx, { organisationId, actor: { kind: 'system' }, action: 'calendar.sync_failed', subjectType: 'organisation', subjectId: organisationId,
    detail: { ...counts, success: false, error: error instanceof CalendarError && error.status === 403 ? 'Google Calendar access was refused. Reconnect Google in Settings and allow calendar list and event access.' : failed } }));
   throw new HttpError(503, 'calendar_sync_failed', failed);
  } finally {
   try { if (acquired) await withTenant(this.db, { organisationId }, async (tx) => { await tx`delete from sync_cursors where connection_id = ${conn!.id} and resource = 'calendar.sync-lock' and cursor = ${runId}`; }); }
   finally { this.#running.delete(organisationId); }
  }
 }
}
export function startCalendarSchedule(sync: Pick<CalendarSync, 'organisations' | 'run'>, disabled = false, intervalMs = 300_000): () => Promise<void> {
 if (disabled) return async () => {};
 let active: Promise<void> | undefined;
 const tick = () => { if (active) return;
  active = (async () => { for (const org of await sync.organisations()) await sync.run(org).catch(() => undefined); })()
   .catch(() => { console.error('[calendar] Scheduled sync could not reach its database. Check API database connectivity.'); }).finally(() => { active = undefined; });
 };
 const timer = setInterval(tick, intervalMs); timer.unref(); tick();
 return async () => { clearInterval(timer); await active; };
}
