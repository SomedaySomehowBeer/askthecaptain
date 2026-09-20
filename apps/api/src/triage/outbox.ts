import { addresses } from '../contacts/addresses.ts';
import { WorkflowPause } from '@captain/engine';
import { XeroService } from '../xero/service.ts';
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
export type Outcome = 'sent' | 'edited_sent' | 'discarded' | 'not_needed' | 'expired';
/** No reply wanted: the thread leaves Needs you, and the sender's prior learns it (an information verdict, one less needs-owner). */
export async function noReplyWanted(tx: TransactionSql, threadId: string | null, emails: Iterable<string>) {
 for (const email of new Set(emails)) await tx`insert into mail_senders (organisation_id, email, information_verdicts) select organisation_id, ${email}, 1 from mail_threads where id = ${threadId} limit 1
  on conflict (organisation_id, email) do update set information_verdicts = mail_senders.information_verdicts + 1, needs_owner_count = greatest(0, mail_senders.needs_owner_count - 1), updated_at = now()`;
 if (threadId) await tx`update mail_triage set needs_owner = false, remind_at = null, updated_at = now() where thread_id = ${threadId}`;
}
/** A draft untouched for seven days expires with a neutral outcome (plan §6). */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export async function expireDraft(tx: TransactionSql, org: string, id: string) {
 const [row] = await tx`select * from outbox where id = ${id}`; if (!row) return null;
 if (row.state !== 'drafted' || row.sendStartedAt || Date.now() - new Date(row.updatedAt).getTime() < DRAFT_TTL_MS) return row;
 const [expired] = await tx`update outbox set state = 'discarded', outcome = 'expired', discarded_at = now(), updated_at = now() where id = ${id} and state = 'drafted' returning *`;
 if (expired) await audit(tx, { organisationId: org, actor: { kind: 'system' }, action: 'outbox.expired', subjectType: 'outbox', subjectId: id });
 return expired ?? row;
}
/** Tomorrow morning or next week at seven in the organisation's own time zone. */
export function remindAt(when: 'tomorrow' | 'next_week', timeZone: string, now = new Date()): Date {
 const parts = (date: Date) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date).map(x => [x.type, Number(x.value)])); return p as Record<string, number>; };
 const local = parts(now); const days = when === 'tomorrow' ? 1 : 7;
 const guess = Date.UTC(local.year!, local.month! - 1, local.day! + days, 7, 0, 0);
 const at = parts(new Date(guess)); const asUtc = Date.UTC(at.year!, at.month! - 1, at.day!, at.hour!, at.minute!, at.second!);
 return new Date(guess - (asUtc - guess));
}
export async function createDraft(ctx: Context, destination: Thread | { to: string; subject: string }, body: string, invoiceProviderId: string | null = null) {
 const thread = 'id' in destination ? destination : null;
 const conn = thread ? { id: thread.connectionId, accountEmail: thread.accountEmail } : await connection(ctx.tx);
 if (!conn || ('status' in conn && conn.status !== 'connected')) throw new WorkflowPause('Reconnect Google in Settings before creating a chaser draft, then Resume.');
 const input = draftInput.parse({ threadId: thread?.id ?? null, to: thread ? thread.sender ? [thread.sender] : [] : [(destination as { to: string }).to],
  subject: destination.subject.replace(/[\r\n]/g, ' ').slice(0, 300), body });
 const [row] = await ctx.tx`insert into outbox (organisation_id, thread_id, connection_id, account_email, "to", cc, subject, body, in_reply_to, created_by, idempotency_key, invoice_provider_id)
  values (${ctx.organisationId}, ${input.threadId}, ${conn.id}, ${conn.accountEmail}, ${ctx.tx.array(input.to)}, '{}', ${input.subject}, ${body}, ${thread?.rfcMessageId ?? ''}, ${ctx.runId}, ${ctx.idempotencyKey}, ${invoiceProviderId})
  on conflict (organisation_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key returning id`;
 await journal(ctx, 'outbox.created', 'outbox', row!.id); return { id: String(row!.id) };
}
/** A changed/paid invoice cannot turn a saved inference response into an obsolete demand. */
export async function createInvoiceDraft(ctx: Context, invoice: unknown, to: unknown, body: string, chaseAgainAfterDays: unknown = 7) {
 const expected = z.object({ id: z.uuid(), number: z.string(), amountDue: z.string(), currency: z.string(), dueDate: z.iso.date(), contactEmail: address }).parse(invoice);
 const spacing = z.number().int().min(1).max(365).parse(chaseAgainAfterDays);
 if (to !== expected.contactEmail) throw Error('Recipient differs from the invoice snapshot');
 const current = await XeroService.currentReceivable(ctx.tx, ctx.organisationId, expected.id);
 if (!current || current.status !== 'AUTHORISED' || Number(current.amountDue) <= 0) return { skipped: 'The invoice is no longer outstanding.' };
 if (current.connectionStatus !== 'connected') throw new WorkflowPause('Reconnect Xero in Settings, then Resume.');
 if (current.contactEmail !== expected.contactEmail || current.amountDue !== expected.amountDue || current.currency !== expected.currency || current.dueDate !== expected.dueDate || (current.number ?? 'without a number').slice(0, 200) !== expected.number)
  return { skipped: 'The invoice or recipient changed. The next daily run will use its current details.' };
 // Serialize concurrent runs before checking history and creating the destination row.
 await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${ctx.organisationId + ':invoice-chaser:' + current.providerId}, 0))`;
 const [replay] = await ctx.tx`select id from outbox where idempotency_key = ${ctx.idempotencyKey}`;
 if (replay) return { id: String(replay.id) };
 const [pending] = await ctx.tx`select id from outbox where invoice_provider_id = ${current.providerId} and state = 'drafted' limit 1`;
 if (pending) return { skipped: `A chaser for ${expected.number} is already waiting in the outbox.` };
 const [recent] = await ctx.tx`select sent_at from outbox where invoice_provider_id = ${current.providerId} and state = 'sent'
  and sent_at + ${spacing} * interval '24 hours' > now() order by sent_at desc limit 1`;
 if (recent) return { skipped: `A chaser for ${expected.number} was sent recently. Wait ${spacing} days after sending before chasing again.` };
 return createDraft(ctx, { to: expected.contactEmail, subject: `Invoice ${expected.number} — payment follow-up` }, body, String(current.providerId));
}
/** Shared destination for triage replies, invoice chasers and supplier drafts. */
export async function workflowDraft(ctx: Context, args: Record<string, unknown>) {
 if (args.thread) return createDraft(ctx, args.thread as Thread, draftInput.shape.body.parse((args.draft as { body: unknown }).body));
 if (args.invoice) return createInvoiceDraft(ctx, args.invoice, args.to, draftInput.shape.body.parse((args.draft as { body: unknown }).body), args.chaseAgainAfterDays);
 const supplier = z.object({ name: z.string(), email: z.string().nullable() }).nullable().parse(args.supplier ?? null);
 if (!supplier?.email || !address.safeParse(supplier.email).success) {
  const note = 'No unambiguous supplier email. Add one active contact to the supplier company in People and companies; the reorder task is ready.';
  await journal(ctx, 'outbox.skipped', 'workflow_run', ctx.runId, { note, step: ctx.path, itemIndex: ctx.itemIndex }); return { skipped: true, note };
 }
 const conn = await connection(ctx.tx); if (!conn || conn.status !== 'connected') throw Object.assign(Error('Google unavailable'), { code: 'stocktake_google' });
 return createDraft(ctx, { to: supplier.email, subject: `Order enquiry: ${z.string().parse(args.subject)}` }, draftInput.shape.body.parse((args.draft as { body: unknown }).body));
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
 /** How a draft ended feeds the sender's draft outcomes (plan §6): sent up, discarded or not needed down. Not needed also
  *  says no reply was wanted, a down signal on needs-owner. Recorded once, when the draft closes. */
 static async recordOutcome(tx: TransactionSql, org: string, draft: { to: unknown; threadId: unknown }, outcome: Outcome) {
  const row = { to: draft.to as string[], threadId: (draft.threadId ?? null) as string | null };
  const columns = { sent: 'drafts_sent', edited_sent: 'drafts_edited', discarded: 'drafts_discarded', not_needed: 'drafts_not_needed', expired: null }[outcome];
  if (columns) for (const email of new Set(addresses(row.to.join(',')).map(a => a.email))) {
   await tx.unsafe(`insert into mail_senders (organisation_id, email, ${columns}) values ($1, $2, 1)
    on conflict (organisation_id, email) do update set ${columns} = mail_senders.${columns} + 1, updated_at = now()`, [org, email]);
  }
  if (outcome === 'not_needed') await noReplyWanted(tx, row.threadId, addresses(row.to.join(',')).map(a => a.email));
 }
 async change(actor: Actor, org: string, id: string, action: 'edit' | 'discard' | 'not_needed' | 'remind', body?: string, when?: 'tomorrow' | 'next_week') {
  if (action === 'edit') z.string().min(1).max(20000).parse(body);
  if (action === 'remind') z.enum(['tomorrow', 'next_week']).parse(when);
  return this.tx(actor, org, async tx => {
   const [row] = await tx`select * from outbox where id = ${id} for update`; if (!row) throw notFound();
   if (row.state === 'discarded' && (action === 'discard' || action === 'not_needed')) return row;
   if (row.state !== 'drafted') throw badRequest('draft_closed', 'This draft has already been sent or discarded.');
   if (row.sendStartedAt) throw uncertain();
   let updated;
   if (action === 'edit') [updated] = await tx`update outbox set body = ${body!}, edited = true, updated_at = now() where id = ${id} returning *`;
   else if (action === 'remind') {
    const [org_] = await tx`select timezone from organisations where id = ${org}`;
    [updated] = await tx`update outbox set remind_at = ${remindAt(when!, String(org_?.timezone ?? 'UTC'))}, updated_at = now() where id = ${id} returning *`;
   } else {
    const outcome: Outcome = action === 'discard' ? 'discarded' : 'not_needed';
    [updated] = await tx`update outbox set state = 'discarded', outcome = ${outcome}, discarded_by = ${actor.userId}, discarded_at = now(), updated_at = now() where id = ${id} returning *`;
    await OutboxService.recordOutcome(tx, org, row as unknown as { to: unknown; threadId: unknown }, outcome);
   }
   await this.journal(tx, actor, org, id, action === 'edit' ? 'edited' : action === 'remind' ? 'reminder_set' : action === 'discard' ? 'discarded' : 'not_needed');
   if ((action === 'discard' || action === 'not_needed') && row.createdBy) await this.wake(tx, org, row.createdBy, `outbox:${id}`);
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
   const [updated] = await tx`update outbox set state = 'sent', outcome = case when edited then 'edited_sent' else 'sent' end, provider_message_id = ${providerId}, sent_at = now(), updated_at = now() where id = ${id} and state = 'drafted' returning *`;
   if (updated) {
    await this.journal(tx, actor, org, id, 'sent'); if (updated.createdBy) await this.wake(tx, org, updated.createdBy, `outbox:${id}`);
    await OutboxService.recordOutcome(tx, org, updated as unknown as { to: unknown; threadId: unknown }, updated.outcome as Outcome);
    // A reply from a person resets the sender's prior (D20): from now on their mail always reaches the model.
    for (const email of new Set(addresses((updated.to as string[]).join(',')).map(a => a.email))) await tx`insert into mail_senders (organisation_id, email, replies) values (${org}, ${email}, 1)
     on conflict (organisation_id, email) do update set replies = mail_senders.replies + 1, updated_at = now()`;
   }
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
