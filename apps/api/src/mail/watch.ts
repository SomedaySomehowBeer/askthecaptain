import { GmailClient } from '@captain/connectors/gmail';
import { withTenant, type Sql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import type { ConnectionService } from '../connections/service.ts';
import { forbidden, HttpError } from '../errors.ts';
import { connection, requireMember } from './store.ts';
export type PushConfig = { topic: string; audience: string };
type Actor = { userId: string; requestId: string };
const storedSchema = z.object({ accountEmail: z.string(), topic: z.string(), expiration: z.number().nullable(), renewedAt: z.number().nullable(), error: z.string().nullable() });
const failed = 'Live mail updates could not be started. Ask the owner to check Google push setup; polling remains available.';
export class GmailWatch {
 readonly db: Sql; readonly connections: Pick<ConnectionService, 'accessToken'>; readonly config?: PushConfig; readonly client: GmailClient; readonly now: () => number;
 constructor(db: Sql, connections: Pick<ConnectionService, 'accessToken'>, config?: PushConfig, client = new GmailClient(), now = Date.now) { this.db = db; this.connections = connections; this.config = config; this.client = client; this.now = now; }
 async status(actor: Actor, org: string, polling: boolean) {
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await requireMember(tx, actor.userId, org); const conn = await connection(tx);
   const [s] = await tx`select cursor from sync_cursors where connection_id = ${conn?.id ?? null} and resource = 'gmail.watch'`;
   const parsed = s ? storedSchema.safeParse(JSON.parse(s.cursor)) : null; const watch = parsed?.success ? parsed.data : null;
   const current = watch?.accountEmail === conn?.accountEmail && watch?.topic === this.config?.topic ? watch : null;
   return { configured: Boolean(this.config), polling, status: !this.config ? 'off' : conn?.status !== 'connected' ? 'disconnected' : current?.error ? 'failed'
    : !current?.expiration ? 'pending' : current.expiration <= this.now() ? 'expired' : 'active', expiresAt: current?.expiration ? new Date(current.expiration).toISOString() : null, error: current?.error ?? null };
  });
 }
 async renew(org: string, actor?: Actor, onlyIfDue = false) {
  const conn = await withTenant(this.db, { organisationId: org, userId: actor?.userId }, async (tx) => {
   if (actor && await requireMember(tx, actor.userId, org) === 'member') throw forbidden('Only an owner or admin can start live mail updates.');
   return connection(tx);
  });
  if (!this.config) throw new HttpError(503, 'push_unavailable', 'Live mail updates are not configured.');
  if (!conn || conn.status !== 'connected') throw new HttpError(400, 'connection_unavailable', 'Connect Google before starting live mail updates.');
  const previous = await withTenant(this.db, { organisationId: org }, async (tx) => { const [s] = await tx`select cursor from sync_cursors where connection_id = ${conn.id} and resource = 'gmail.watch'`; return s ? storedSchema.parse(JSON.parse(s.cursor)) : null; });
  const same = previous?.accountEmail === conn.accountEmail && previous.topic === this.config.topic;
  if (onlyIfDue && same && !previous.error && previous.renewedAt && this.now() - previous.renewedAt < 86_400_000 && (previous.expiration ?? 0) > this.now() + 3_600_000) return;
  let result: { historyId: string; expiration: number } | undefined;
  try {
   const token = await this.connections.accessToken(undefined, org, conn.id);
   if ((await this.client.profile(token)).emailAddress !== conn.accountEmail) throw new Error();
   result = await this.client.watch(token, this.config.topic);
   if (result.expiration <= this.now()) throw new Error();
  } catch { result = undefined; }
  await withTenant(this.db, { organisationId: org, userId: actor?.userId }, async (tx) => {
   if (actor && await requireMember(tx, actor.userId, org) === 'member') throw forbidden();
   const [current] = await tx`select status, account_email from connections where id = ${conn.id} for share`;
   if (current?.status !== 'connected' || current.accountEmail !== conn.accountEmail) throw new HttpError(409, 'connection_changed', 'Google changed during setup. Try again.');
   const value = { accountEmail: conn.accountEmail, topic: this.config!.topic, expiration: result?.expiration ?? (same ? previous.expiration : null),
    renewedAt: result ? this.now() : same ? previous.renewedAt : null, error: result ? null : failed };
   await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org}, ${conn.id}, 'gmail.watch', ${JSON.stringify(value)})
    on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = now()`;
   await audit(tx, { organisationId: org, actor: actor ? { kind: 'person', id: actor.userId } : { kind: 'system' }, requestId: actor?.requestId,
    action: result ? 'mail.watch_renewed' : 'mail.watch_failed', subjectType: 'connection', subjectId: conn.id, detail: { success: Boolean(result), expiration: result?.expiration ?? null } });
  });
  // A watch's historyId is a notification baseline, never a replacement for our persisted sync cursor.
  if (!result) throw new HttpError(503, 'watch_failed', failed);
  return { expiresAt: new Date(result.expiration).toISOString() };
 }
}
