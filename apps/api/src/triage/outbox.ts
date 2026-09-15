import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { GmailClient, GmailError } from '@captain/connectors/gmail';
import type { ConnectionService } from '../connections/service.ts';
import { audit } from '../audit.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { connection } from '../mail/store.ts';
import type { Actor } from '../tenant.ts';
import { journal, type Context, type Thread } from './data.ts';
const address = z.email().max(254).regex(/^[^\r\n<>]+$/);
export const draftInput = z.object({ threadId: z.uuid().nullable().default(null), to: z.array(address).max(20), cc: z.array(address).max(20).default([]),
 subject: z.string().max(300).regex(/^[^\r\n]*$/), body: z.string().min(1).max(20000) }).strict();
const uncertain = () => new HttpError(409, 'send_uncertain', 'Sending has not been confirmed. Check Sent in Gmail, then use Check send again. Captain will not send a second copy.');
type Wake = (tx: TransactionSql, organisationId: string, runId: string, key: string) => Promise<unknown>;
export async function createDraft(ctx: Context, thread: Thread, body: string) {
 const input = draftInput.parse({ threadId: thread.id, to: thread.sender ? [thread.sender] : [], subject: thread.subject.replace(/[\r\n]/g, ' ').slice(0, 300), body });
 const [row] = await ctx.tx`insert into outbox (organisation_id, thread_id, connection_id, account_email, "to", cc, subject, body, in_reply_to, created_by, idempotency_key)
  values (${ctx.organisationId}, ${thread.id}, ${thread.connectionId}, ${thread.accountEmail}, ${ctx.tx.array(input.to)}, '{}', ${input.subject}, ${body}, ${thread.rfcMessageId}, ${ctx.runId}, ${ctx.idempotencyKey})
  on conflict (organisation_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key returning id`;
 await journal(ctx, 'outbox.created', 'outbox', row!.id); return { id: String(row!.id) };
}
export class OutboxService {
 readonly db: Sql; readonly connections: Pick<ConnectionService, 'accessToken'>; readonly wake: Wake; readonly gmail: GmailClient;
 constructor(db: Sql, connections: Pick<ConnectionService, 'accessToken'>, wake: Wake, gmail = new GmailClient()) { this.db = db; this.connections = connections; this.wake = wake; this.gmail = gmail; }
 tx<T>(actor: Actor, organisationId: string, fn: (tx: TransactionSql) => Promise<T>) {
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   const [member] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId} and status = 'active' for share`;
   if (!member) throw notFound();
   return fn(tx);
  });
 }
 list(actor: Actor, org: string) { return this.tx(actor, org, tx => tx`select * from outbox where state = 'drafted' order by created_at limit 100`); }
 create(actor: Actor, org: string, value: unknown) {
  const input = draftInput.parse(value);
  return this.tx(actor, org, async tx => {
   const conn = await connection(tx); if (!conn || conn.status !== 'connected') throw badRequest('reconnect_required', 'Reconnect Google in Settings.');
   let reply = '';
   if (input.threadId) {
    const [m] = await tx`select m.rfc_message_id from mail_messages m join mail_threads t on t.id = m.thread_id
     where t.id = ${input.threadId} and t.connection_id = ${conn.id} and t.account_email = ${conn.accountEmail} order by m.sent_at desc, m.provider_id desc limit 1`;
    if (!m) throw notFound(); reply = m.rfcMessageId;
   }
   const [row] = await tx`insert into outbox (organisation_id, thread_id, connection_id, account_email, "to", cc, subject, body, in_reply_to, created_by_person, idempotency_key)
    values (${org}, ${input.threadId}, ${conn.id}, ${conn.accountEmail}, ${tx.array(input.to)}, ${tx.array(input.cc)}, ${input.subject}, ${input.body}, ${reply}, ${actor.userId}, ${randomUUID()}) returning *`;
   await this.journal(tx, actor, org, row!.id, 'created'); return row!;
  });
 }
 async change(actor: Actor, org: string, id: string, action: 'edit' | 'discard', body?: string) {
  if (action === 'edit') z.string().min(1).max(20000).parse(body);
  return this.tx(actor, org, async tx => {
   const [row] = await tx`select * from outbox where id = ${id} for update`; if (!row) throw notFound();
   if (row.state === 'discarded' && action === 'discard') return row;
   if (row.state !== 'drafted') throw badRequest('draft_closed', 'This draft has already been sent or discarded.');
   if (row.sendStartedAt) throw uncertain();
   const [updated] = action === 'edit' ? await tx`update outbox set body = ${body!}, updated_at = now() where id = ${id} returning *`
    : await tx`update outbox set state = 'discarded', discarded_by = ${actor.userId}, discarded_at = now(), updated_at = now() where id = ${id} returning *`;
   await this.journal(tx, actor, org, id, action === 'edit' ? 'edited' : 'discarded');
   if (action === 'discard' && row.createdBy) await this.wake(tx, org, row.createdBy, `outbox:${id}`);
   return updated!;
  });
 }
 async send(actor: Actor, org: string, id: string) {
  // First read does not start an attempt: token refresh or missing headers must leave the draft editable.
  const initial = await this.tx(actor, org, async tx => {
   const [row] = await tx`select o.*, t.provider_id from outbox o left join mail_threads t on t.id = o.thread_id where o.id = ${id}`;
   if (!row) throw notFound(); return row;
  });
  if (initial.state === 'sent') return initial;
  const token = await this.connections.accessToken(actor, org, initial.connectionId);
  const attempt = await this.tx(actor, org, async tx => {
   const [row] = await tx`select o.*, t.provider_id, coalesce(nullif(o.in_reply_to, ''), m.rfc_message_id, '') as reply_header
    from outbox o left join mail_threads t on t.id = o.thread_id left join lateral
    (select rfc_message_id from mail_messages where thread_id = o.thread_id and sent_at <= o.created_at order by sent_at desc, provider_id desc limit 1) m on true
    where o.id = ${id} for update of o`;
   if (!row) throw notFound(); if (row.state === 'sent') return { row, send: false };
   if (row.state !== 'drafted') throw badRequest('draft_closed', 'This draft was discarded.');
   const conn = await connection(tx);
   if (!conn || conn.status !== 'connected' || conn.accountEmail !== row.accountEmail) throw badRequest('reconnect_required', 'Reconnect the original Google account before sending this draft.');
   row.inReplyTo = row.replyHeader;
   if (!row.to.length) throw badRequest('recipient_missing', 'This draft has no recipient. Reply in Gmail or discard it.');
   draftInput.parse({ threadId: row.threadId, to: row.to, cc: row.cc, subject: row.subject, body: row.body });
   if (row.threadId && !/^<[^<>\s]+@[^<>\s]+>$/.test(row.inReplyTo)) throw badRequest('reply_header_missing', 'Sync this thread again to read its reply header, or send the reply in Gmail.');
   const send = !row.sendStartedAt;
   if (send) { await tx`update outbox set in_reply_to = ${row.inReplyTo}, send_started_at = now(), sent_by = ${actor.userId}, updated_at = now() where id = ${id}`; await this.journal(tx, actor, org, id, 'send_started'); }
   return { row, send };
  });
  const row = attempt.row; if (row.state === 'sent') return row;
  const messageId = `<captain-${id}@${row.accountEmail.split('@')[1]}>`;
  let providerId: string | null;
  try {
   if (!attempt.send) providerId = await this.gmail.sentMessage(token, messageId);
   else {
    const subject = (Array.from(String(row.subject)).join('').match(/.{1,12}/gu) ?? ['']).map(part => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
    const raw = [`From: ${row.accountEmail}`, `To: ${row.to.join(', ')}`, `Cc: ${row.cc.join(', ')}`, `Subject: ${subject}`, `Message-ID: ${messageId}`,
     ...(row.threadId ? [`In-Reply-To: ${row.inReplyTo}`, `References: ${row.inReplyTo}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(row.body).toString('base64').match(/.{1,76}/g)!.join('\r\n')].join('\r\n');
    providerId = await this.tx(actor, org, () => this.gmail.send(token, Buffer.from(raw).toString('base64url'), row.providerId ?? undefined));
   }
  } catch (error) {
   // Only a definitive rejection permits a new attempt. Network errors and 5xx stay ambiguous.
   if (attempt.send && error instanceof GmailError && [400, 401, 403, 404, 429].includes(error.status)) {
    await this.tx(actor, org, async tx => { await tx`update outbox set send_started_at = null, sent_by = null where id = ${id} and state = 'drafted'`; });
    throw badRequest('send_rejected', 'Gmail rejected the send. Check the connection and recipients, then try again.');
   }
   throw uncertain();
  }
  if (!providerId) throw uncertain();
  return this.tx(actor, org, async tx => {
   const [updated] = await tx`update outbox set state = 'sent', provider_message_id = ${providerId}, sent_at = now(), updated_at = now() where id = ${id} and state = 'drafted' returning *`;
   if (updated) { await this.journal(tx, actor, org, id, 'sent'); if (updated.createdBy) await this.wake(tx, org, updated.createdBy, `outbox:${id}`); }
   return updated ?? (await tx`select * from outbox where id = ${id}`)[0]!;
  });
 }
 private journal(tx: TransactionSql, actor: Actor, org: string, id: string, action: string) {
  return audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: `outbox.${action}`, subjectType: 'outbox', subjectId: id });
 }
}

/** Subjects and recipients only: morning inference does not need correspondence bodies. */
export async function waitingDrafts(tx: TransactionSql) {
 const rows = await tx`select o.id, o.thread_id, left(coalesce((select m.subject from mail_messages m where m.thread_id = o.thread_id order by m.sent_at desc, m.id desc limit 1), o.subject), 300) as subject, o."to" as recipients
  from outbox o where o.state = 'drafted' order by o.created_at, o.id limit 101`;
 return { drafts: rows.slice(0, 100), truncated: rows.length > 100 };
}
