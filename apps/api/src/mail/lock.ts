import { randomUUID } from 'node:crypto';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { GmailError } from '@captain/connectors/gmail';
import { HttpError } from '../errors.ts';
import type { MailConnection } from './store.ts';
export const syncBusy = () => new HttpError(409, 'sync_running', 'Mail sync is already running. Check again shortly.');

/** A fenced lease survives transaction-pooling proxies, unlike a session advisory lock. Retake
 * the advisory lock and validate the original history cursor in each short transaction. Renew
 * after every provider request (15s timeout), so even a slow 25-thread fetch keeps the lease. */
export async function mailLock(db: Sql, organisationId: string, conn: MailConnection) {
 const runId = randomUUID(); const key = `gmail.sync:${organisationId}`;
 const previous = await withTenant(db, { organisationId }, async (tx) => {
  if (!(await tx`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`)[0]!.acquired) throw syncBusy();
  const lock = await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor)
   values (${organisationId}, ${conn.id}, 'gmail.sync-lock', ${runId}) on conflict (organisation_id, connection_id, resource)
   do update set cursor = excluded.cursor, updated_at = clock_timestamp() where sync_cursors.updated_at < clock_timestamp() - interval '2 minutes' returning id`;
  if (!lock.length) throw syncBusy();
  const [stored] = await tx`select cursor from sync_cursors where connection_id = ${conn.id} and resource = 'gmail.history'`;
  return (stored?.cursor ?? null) as string | null;
 });
 return {
  previous,
  batch: <T>(work: (tx: TransactionSql) => Promise<T>) => withTenant(db, { organisationId }, async (tx) => {
   if (!(await tx`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`)[0]!.acquired) throw syncBusy();
   const lock = await tx`update sync_cursors set updated_at = clock_timestamp() where connection_id = ${conn.id} and resource = 'gmail.sync-lock'
    and cursor = ${runId} and updated_at > clock_timestamp() - interval '2 minutes' returning id`;
   if (!lock.length) throw syncBusy();
   const [current] = await tx`select account_email, status from connections where id = ${conn.id} for share`;
   if (current?.status !== 'connected' || current.accountEmail !== conn.accountEmail) throw new GmailError(0, 'account_changed');
   const [stored] = await tx`select cursor from sync_cursors where connection_id = ${conn.id} and resource = 'gmail.history'`;
   if ((stored?.cursor ?? null) !== previous) throw syncBusy();
   return work(tx);
  }),
  release: () => withTenant(db, { organisationId }, async (tx) => {
   await tx`delete from sync_cursors where connection_id = ${conn.id} and resource = 'gmail.sync-lock' and cursor = ${runId}`;
  })
 };
}
