import { withTenant, type Sql } from '@captain/db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { badRequest, HttpError } from '../errors.ts';
import { GooglePushVerifier } from './oidc.ts';
import { connection } from './store.ts';
import type { MailSync } from './sync.ts';
import type { GmailWatch, PushConfig } from './watch.ts';
const payloadSchema = z.object({ emailAddress: z.string().email().max(254).transform((s) => s.toLowerCase()), historyId: z.string().regex(/^\d{1,100}$/) });
const envelopeSchema = z.object({ message: z.object({ messageId: z.string().regex(/^\d{1,200}$/), data: z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/_-]+={0,2}$/) }), subscription: z.string().max(512) });
/** Durable receipt first, then a bounded asynchronous drain. Failed/overlapping work stays pending
 * for the maintenance routine; MailSync's database fence serialises workers across API processes. */
export class GmailPush {
 readonly db: Sql; readonly sync: Pick<MailSync, 'run' | 'organisations'>; readonly config: PushConfig; readonly verifier: Pick<GooglePushVerifier, 'verify'>;
 private running = new Map<string, { promise: Promise<void>; again: boolean }>(); private closing = false;
 constructor(db: Sql, sync: Pick<MailSync, 'run' | 'organisations'>, config: PushConfig, verifier?: Pick<GooglePushVerifier, 'verify'>) {
  this.db = db; this.sync = sync; this.config = config;
  this.verifier = verifier ?? new GooglePushVerifier(config.audience, `gmail-pubsub@${config.topic.split('/')[1]}.iam.gserviceaccount.com`);
 }
 async receive(authorization: string | undefined, body: () => Promise<unknown>) {
  if (this.closing) throw new HttpError(503, 'push_stopping', 'Retry this delivery shortly.');
  await this.verifier.verify(authorization);
  let envelope: z.infer<typeof envelopeSchema>; let payload: z.infer<typeof payloadSchema>;
  try { envelope = envelopeSchema.parse(await body()); payload = payloadSchema.parse(JSON.parse(Buffer.from(envelope.message.data, 'base64').toString('utf8'))); }
  catch { throw badRequest('push_invalid', 'The Gmail push notification was not understood.'); }
  if (!envelope.subscription.startsWith(`projects/${this.config.topic.split('/')[1]}/subscriptions/`)) throw badRequest('push_invalid', 'Unexpected push subscription project.');
  // Reuse the narrow scheduler discovery seam. All account matching remains under tenant RLS;
  // never grant the webhook route a broad cross-tenant connection/token lookup.
  const matches: { org: string; connectionId: string }[] = [];
  for (const org of await this.sync.organisations()) {
   const conn = await withTenant(this.db, { organisationId: org }, connection);
   if (conn?.status === 'connected' && conn.accountEmail === payload.emailAddress) matches.push({ org, connectionId: conn.id });
   if (matches.length > 1) break;
  }
  // A shared mailbox attached to multiple organisations is ambiguous; each still gets polling.
  if (matches.length !== 1) return;
  const { org, connectionId } = matches[0]!;
  const inserted = await withTenant(this.db, { organisationId: org }, async (tx) => {
   const [current] = await tx`select status, account_email from connections where id = ${connectionId} for share`;
   if (current?.status !== 'connected' || current.accountEmail !== payload.emailAddress) return false;
   const rows = await tx`insert into webhook_events (organisation_id, connection_id, provider, provider_event_id, payload)
    values (${org}, ${connectionId}, 'gmail', ${envelope.message.messageId}, ${tx.json(payload)}) on conflict (provider, provider_event_id) do nothing returning id`;
   if (rows.length) await audit(tx, { organisationId: org, actor: { kind: 'system' }, action: 'mail.push_received', subjectType: 'connection', subjectId: connectionId, detail: { events: 1 } });
   return rows.length > 0;
  });
  if (inserted) this.enqueue(org);
 }
 enqueue(org: string) {
  if (this.closing) return;
  const current = this.running.get(org); if (current) { current.again = true; return; }
  const state = { promise: Promise.resolve(), again: false };
  state.promise = (async () => {
   // One follow-up catches mail arriving during the first sync; further backlog stays durable.
   for (let pass = 0; pass < 2; pass++) { state.again = false; await this.process(org); if (!state.again) break; }
  })().catch(() => { console.error('[gmail-push] Queued delivery could not be processed; it will retry.'); }).finally(() => { this.running.delete(org); });
  this.running.set(org, state);
 }
 private async process(org: string) {
  const attempts = await withTenant(this.db, { organisationId: org }, async (tx) => {
   const conn = await connection(tx);
   const events = await tx`select id, connection_id, payload from webhook_events where provider = 'gmail' and processed_at is null order by received_at, id limit 100`;
   const pending: { eventId: string; attemptId: string }[] = [];
   for (const event of events) {
    const valid = conn?.status === 'connected' && event.connectionId === conn.id && event.payload.emailAddress === conn.accountEmail;
    const [attempt] = await tx`insert into webhook_attempts (organisation_id, connection_id, webhook_event_id, completed_at, error)
     values (${org}, ${event.connectionId}, ${event.id}, ${valid ? null : new Date()}, ${valid ? null : 'Account disconnected or replaced; notification ignored.'}) returning id`;
    if (valid) pending.push({ eventId: event.id, attemptId: attempt!.id });
    else await tx`update webhook_events set processed_at = now() where id = ${event.id}`;
   }
   if (events.length) await audit(tx, { organisationId: org, actor: { kind: 'system' }, action: 'mail.push_processing', subjectType: 'organisation', subjectId: org, detail: { events: events.length, pending: pending.length, ignored: events.length - pending.length } });
   return pending;
  });
  if (!attempts.length) return;
  let error: string | null = null;
  try { await this.sync.run(org); }
  catch (e) { error = e instanceof HttpError && e.code === 'sync_running' ? 'Mail sync is already running; retry queued.' : 'Mail sync failed; retry queued. Check Inbox and the Google connection.'; }
  await withTenant(this.db, { organisationId: org }, async (tx) => {
   await tx`update webhook_attempts set completed_at = now(), error = ${error} where id = any(${tx.array(attempts.map((a) => a.attemptId))}::uuid[])`;
   if (!error) await tx`update webhook_events set processed_at = now() where id = any(${tx.array(attempts.map((a) => a.eventId))}::uuid[])`;
   await audit(tx, { organisationId: org, actor: { kind: 'system' }, action: 'mail.push_processed', subjectType: 'organisation', subjectId: org, detail: { events: attempts.length, success: !error } });
  });
 }
 async idle() { await Promise.all([...this.running.values()].map((s) => s.promise)); }
 async stop() { this.closing = true; await this.idle(); }
}
export function gmailPushRoutes(push?: GmailPush) {
 const routes = new Hono();
 routes.post('/webhooks/gmail', bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'Gmail push body is too large.' }, 413) }), async (c) => {
  if (!push) throw new HttpError(503, 'push_unavailable', 'Gmail push is not configured.');
  await push.receive(c.req.header('authorization'), () => c.req.json()); return c.body(null, 204);
 });
 return routes;
}
/** Watch freshness is checked each minute, renewed daily; the same housekeeping tick retries
 * durable webhook receipts left by errors, overlap or process restarts. Polling is independent. */
export function startGmailPushSchedule(push: GmailPush | undefined, watch: GmailWatch, intervalMs = 60_000) {
 if (!push) return async () => {};
 let active: Promise<void> | undefined;
 const tick = () => { if (active) return;
  active = (async () => { for (const org of await push.sync.organisations()) { await watch.renew(org, undefined, true).catch(() => undefined); push.enqueue(org); } })()
   .catch(() => { console.error('[gmail-push] Watch maintenance could not reach its database.'); }).finally(() => { active = undefined; });
 };
 const timer = setInterval(tick, intervalMs); timer.unref(); tick();
 return async () => { clearInterval(timer); await active; await push.stop(); };
}
