import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { GmailClient } from '@captain/connectors/gmail';
import { Registry, type HandlerContext } from '@captain/engine';
import { classifyThreadInstruction, draftReplyInstruction } from '@captain/steps';
import type { InferenceService } from '../inference/service.ts';
import type { ConnectionService } from '../connections/service.ts';
import { connection } from '../mail/store.ts';
import { addresses } from '../contacts/addresses.ts';
import { upkeepContacts } from '../contacts/upkeep.ts';
import { suggest, complete } from '../commitments/triage.ts';
import { createDraft, createInvoiceDraft } from './outbox.ts';
import { draftSchema, triageSchema, journal, type Context, type Thread } from './data.ts';

export class TriageService {
 readonly db: Sql; readonly connections: Pick<ConnectionService, 'accessToken'>; readonly inference: InferenceService; readonly gmail: GmailClient;
 constructor(db: Sql, connections: Pick<ConnectionService, 'accessToken'>, inference: InferenceService, gmail = new GmailClient()) { this.db = db; this.connections = connections; this.inference = inference; this.gmail = gmail; }
 tx<T>(ctx: HandlerContext, fn: (tx: TransactionSql) => Promise<T>) { return withTenant(this.db, ctx, fn); }
 token(ctx: HandlerContext, thread: Thread) { return this.connections.accessToken({ userId: ctx.userId, requestId: ctx.runId }, ctx.organisationId, thread.connectionId); }
 async newThreads(ctx: Context): Promise<Thread[]> {
  const { tx, enablementId } = ctx; const conn = await connection(tx);
  if (!conn || conn.status !== 'connected') throw Error('Reconnect Google in Settings.');
  const [e] = await tx`select mail_cursor from workflow_enablements where id = ${enablementId} for update`;
  // UUIDv7 is insertion order, so late-arriving old mail is included; label-only syncs do not re-triage.
  const batch = await tx`select m.id, m.thread_id from mail_messages m join mail_threads t on t.id = m.thread_id
   where t.connection_id = ${conn.id} and t.account_email = ${conn.accountEmail} and (${e!.mailCursor ?? null}::uuid is null or m.id > ${e!.mailCursor ?? null}::uuid)
   order by m.id limit 100`;
  if (!batch.length) return [];
  await tx`update workflow_enablements set mail_cursor = ${batch.at(-1)!.id} where id = ${enablementId}`;
  const threads: Thread[] = [];
  for (const threadId of new Set(batch.map(m => String(m.threadId)))) {
   const [t] = await tx`select id, connection_id, account_email, provider_id from mail_threads where id = ${threadId}`;
   const messages = await tx`select id, from_header, body, sent_at, subject, rfc_message_id, label_ids from mail_messages
    where thread_id = ${threadId} order by sent_at desc, provider_id desc limit 20`;
   const latest = messages[0]!; const sender = addresses(latest.fromHeader)[0]?.email ?? '';
   if (sender === conn.accountEmail || latest.labelIds.includes('SENT')) continue;
   const [known] = await tx`select 1 from contacts where email = ${sender} and archived_at is null and source <> 'mail'`;
   const sent = await tx`select to_header, cc_header from mail_messages where connection_id = ${conn.id} and sent_at < ${latest.sentAt} and 'SENT' = any(label_ids)`;
   const knownSender = !!known || sent.some(m => addresses(m.toHeader + ',' + m.ccHeader).some(a => a.email === sender));
   threads.push({ id: t!.id, connectionId: t!.connectionId, accountEmail: t!.accountEmail, providerId: t!.providerId,
    sourceMessageId: latest.id, sender, knownSender, subject: latest.subject, rfcMessageId: latest.rfcMessageId,
    messages: messages.reverse().map(m => ({ id: m.id, fromHeader: m.fromHeader, body: m.body.slice(0, 20000), sentAt: m.sentAt.toISOString() })) });
  }
  return threads;
 }
 async attachments(ctx: HandlerContext, thread: Thread) {
  const metadata = await this.tx(ctx, tx => tx`select a.*, m.provider_id from mail_attachments a join mail_messages m on m.id = a.message_id where m.id = any(${tx.array(thread.messages.map(m => m.id))}::uuid[]) order by a.id limit 100`);
  const notes: { messageId: string; attachmentId: string | null; note: string }[] = [];
  for (const a of metadata) {
   const item = { messageId: String(a.messageId), attachmentId: a.providerAttachmentId as string | null };
   if (a.size > 5_000_000 || !['text/plain', 'text/csv'].includes(a.mediaType) || !a.providerAttachmentId) {
    notes.push({ ...item, note: a.mediaType === 'application/pdf' ? 'PDF text extraction is not installed; read this file in Gmail.' : 'Skipped: type, size or attachment reference is outside the extraction limits.' }); continue;
   }
   const [cached] = await this.tx(ctx, tx => tx`select 1 from attachment_text where message_id = ${a.messageId} and attachment_id = ${a.providerAttachmentId} and expires_at > now()`);
   if (!cached) {
    const text = await this.gmail.attachment(await this.token(ctx, thread), a.providerId, a.providerAttachmentId);
    await this.tx(ctx, tx => tx`insert into attachment_text (organisation_id, message_id, attachment_id, text) values (${ctx.organisationId}, ${a.messageId}, ${a.providerAttachmentId}, ${text})
     on conflict (organisation_id, message_id, attachment_id) do update set text = excluded.text, extracted_at = now(), expires_at = now() + interval '24 hours'`);
   }
   notes.push({ ...item, note: 'Extracted text cached for at most 24 hours.' });
  }
  return notes; // Never put extracted text into a durable step output (D13).
 }
 registry() {
  const registry = new Registry();
  registry.registerStep('gmail.newThreads', { kind: 'read', transaction: ctx => this.newThreads(ctx) });
  registry.registerStep('attachments.extractText', { kind: 'read', retrySafe: true, call: (ctx, args) => this.attachments(ctx, args.thread as Thread) });
  registry.registerStep('classifyThread', { kind: 'infer', retrySafe: true, call: async (ctx, args) => {
   const thread = args.thread as Thread;
   // A resumed run may outlive the cache; reacquire allowed text, without retaining it in the journal.
   const notes = await this.attachments(ctx, thread);
   const attachments = await this.tx(ctx, tx => tx`select message_id, attachment_id, text from attachment_text where message_id = any(${tx.array(thread.messages.map(m => m.id))}::uuid[]) and expires_at > now()`);
   const output = await this.inference.infer({ userId: ctx.userId, requestId: ctx.runId }, { organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key,
    tier: 'small', instruction: classifyThreadInstruction, schema: triageSchema, input: { untrustedMail: { subject: thread.subject, messages: thread.messages }, untrustedAttachments: attachments, extractionNotes: notes } });
   return { ...output, needsOwner: !thread.knownSender || output.needsOwner };
  } });
  registry.registerStep('triage.record', { kind: 'write', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; const triage = triageSchema.parse(args.triage); const { tx } = ctx;
   const [usage] = await tx`select model from model_usage where run_id = ${ctx.runId} and step_key = 'classifyThread' order by created_at desc, id desc limit 1`;
   await tx`insert into mail_triage (organisation_id, thread_id, category, needs_owner, summary, facts, produced_by, model, source_message_id)
    values (${ctx.organisationId}, ${thread.id}, ${triage.category}, ${triage.needsOwner}, ${triage.summary}, ${tx.json(triage.facts)}, ${ctx.runId}, ${usage!.model}, ${thread.sourceMessageId})
    on conflict (organisation_id, thread_id) do update set category = excluded.category, needs_owner = excluded.needs_owner, summary = excluded.summary,
    facts = excluded.facts, produced_by = excluded.produced_by, model = excluded.model, source_message_id = excluded.source_message_id, updated_at = now()
    where mail_triage.source_message_id <= excluded.source_message_id`;
   await journal(ctx, 'mail.triaged', 'mail_thread', thread.id); return null;
  } });
  registry.registerStep('tasks.suggestFromTriage', { kind: 'write', transaction: (ctx, args) => suggest(ctx, args.thread as Thread, triageSchema.parse(args.triage).tasks) });
  registry.registerStep('tasks.completeFromConfirmations', { kind: 'write', transaction: (ctx, args) => complete(ctx, args.thread as Thread, triageSchema.parse(args.triage)) });
  registry.registerStep('contacts.upsertFromTriage', { kind: 'write', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; await upkeepContacts(ctx.tx, ctx.organisationId, thread.accountEmail, [thread.providerId], { kind: 'workflow', id: ctx.userId });
   await journal(ctx, 'contacts.triaged', 'mail_thread', thread.id); return null;
  } });
  registry.registerStep('draftReply', { kind: 'infer', retrySafe: true, call: (ctx, args) => this.inference.infer({ userId: ctx.userId, requestId: ctx.runId }, {
   organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'large', instruction: draftReplyInstruction, schema: draftSchema,
   input: { replyStyle: args.style ?? '', untrustedMail: { subject: (args.thread as Thread).subject, messages: (args.thread as Thread).messages }, untrustedTriage: args.triage }
  }) });
  registry.registerStep('outbox.create', { kind: 'write', transaction: (ctx, args) => args.thread ? createDraft(ctx, args.thread as Thread, draftSchema.parse(args.draft).body) : createInvoiceDraft(ctx, args.invoice, args.to, draftSchema.parse(args.draft).body) });
  registry.registerStep('outbox.sent', { kind: 'await', transaction: async ({ tx }, args) => {
   const id = (args.draft as { id: string }).id; const [row] = await tx`select state from outbox where id = ${id}`;
   return { ready: row?.state === 'sent' || row?.state === 'discarded', key: `outbox:${id}`, output: { state: row?.state ?? 'missing' } };
  } });
  registry.registerStep('gmail.label', { kind: 'write', retrySafe: true, call: async (ctx, args) => {
   const thread = args.thread as Thread; await this.gmail.label(await this.token(ctx, thread), thread.providerId, 'Captain/Handled');
   await this.tx(ctx, async tx => { await journal({ ...ctx, tx }, 'mail.labelled', 'mail_thread', thread.id); }); return { labelled: true };
  } });
  return registry;
 }
}
