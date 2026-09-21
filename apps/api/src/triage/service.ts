import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { GmailClient } from '@captain/connectors/gmail';
import { Registry, type HandlerContext } from '@captain/engine';
import { classifyNoteInstruction, classifySentInstruction, classifyThreadInstruction, draftReplyInstruction } from '@captain/steps';
import { MIN_OWN_TOKENS, PARENT_CONTEXT_TOKENS, quotedText, tokens } from '@captain/retrieval';
import { activeProjects, projectRule, recordAssociation } from './association.ts';
import type { InferenceService } from '../inference/service.ts';
import type { ConnectionService } from '../connections/service.ts';
import { connection, requireMember } from '../mail/store.ts';
import { audit } from '../audit.ts';
import { badRequest, notFound } from '../errors.ts';
import type { Actor } from '../tenant.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addresses } from '../contacts/addresses.ts';
import { upkeepContacts } from '../contacts/upkeep.ts';
import { suggest, suggestFrom, complete } from '../commitments/triage.ts';
import { DRAFT_TTL_MS, expireDraft, noReplyWanted, remindAt, workflowDraft } from './outbox.ts';
import { draftSchema, noteTriageSchema, triageSchema, journal, type Context, type Note, type SentMessage, type Thread, type ProjectLink } from './data.ts';
import { drafting, gate, ruleWords, type DraftPrior, type Prior, type Rule } from './gate.ts';
import { ownText, trimmedMessages } from './text.ts';

/** One thread as the workflow and the person see it: the latest incoming message's signals, the sender, and the
 *  messages trimmed to their own text. Null when the latest message is the mailbox's own (nothing to answer). */
export async function loadThread(tx: TransactionSql, conn: { id: string; accountEmail: string }, threadId: string): Promise<Thread | null> {
 const [t] = await tx`select id, connection_id, account_email, provider_id from mail_threads where id = ${threadId}`; if (!t) return null;
 const messages = await tx`select id, from_header, body, sent_at, subject, rfc_message_id, label_ids, list_unsubscribe, list_id, precedence, auto_submitted from mail_messages
  where thread_id = ${threadId} order by sent_at desc, provider_id desc limit 20`;
 const latest = messages[0]; if (!latest) return null; const sender = addresses(latest.fromHeader)[0]?.email ?? '';
 if (sender === conn.accountEmail || latest.labelIds.includes('SENT')) return null;
 const [known] = await tx`select 1 from contacts where email = ${sender} and archived_at is null and source <> 'mail'`;
 const sent = await tx`select to_header, cc_header from mail_messages where connection_id = ${conn.id} and sent_at < ${latest.sentAt} and 'SENT' = any(label_ids)`;
 const knownSender = !!known || sent.some(m => addresses(m.toHeader + ',' + m.ccHeader).some(a => a.email === sender));
 // The gate's signals (D20) come from the latest incoming message and the thread's stars; the model sees own text only (§14 trimmed input).
 const signals = { labelIds: latest.labelIds as string[], listUnsubscribe: Boolean(latest.listUnsubscribe), listId: String(latest.listId ?? ''), precedence: String(latest.precedence ?? ''),
  autoSubmitted: String(latest.autoSubmitted ?? ''), sender, knownSender, starred: messages.some(m => (m.labelIds as string[]).includes('STARRED')),
  latestAt: latest.sentAt.toISOString(), repliedByOwner: messages.some(m => m.sentAt > latest.sentAt && ((m.labelIds as string[]).includes('SENT') || addresses(m.fromHeader)[0]?.email === conn.accountEmail)) };
 return { id: t.id, connectionId: t.connectionId, accountEmail: t.accountEmail, providerId: t.providerId,
  sourceMessageId: latest.id, sender, knownSender, subject: latest.subject, rfcMessageId: latest.rfcMessageId, signals,
  messages: trimmedMessages(messages.reverse().map(m => ({ id: m.id, fromHeader: m.fromHeader, body: m.body, sentAt: m.sentAt.toISOString() }))) };
}

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
   const thread = await loadThread(tx, conn, threadId); if (thread) threads.push(thread);
  }
  return threads;
 }
 /** Sent messages since the cursor with at least about 40 tokens of the person's own text (the index's floor, §14), each
  *  with the parent's own text, or the quoted block when the parent is not stored, as context. Acknowledgements cost nothing. */
 async newSent(tx: TransactionSql, enablementId: string): Promise<SentMessage[]> {
  const conn = await connection(tx); if (!conn || conn.status !== 'connected') return [];
  const [e] = await tx`select sent_cursor from workflow_enablements where id = ${enablementId} for update`;
  const batch = await tx`select m.id, m.thread_id, m.subject, m.body, m.to_header, m.sent_at, p.body as parent_body,
    (select pr.name from project_sources ps join projects pr on pr.organisation_id = ps.organisation_id and pr.id = ps.project_id where ps.source_kind = 'mail_thread' and ps.source_id = m.thread_id and pr.state = 'active' order by ps.created_at limit 1) as linked_project
   from mail_messages m join mail_threads t on t.id = m.thread_id
   left join lateral (select body from mail_messages p where p.organisation_id = m.organisation_id and m.in_reply_to <> '' and p.rfc_message_id = m.in_reply_to and p.id <> m.id order by p.sent_at limit 1) p on true
   where t.connection_id = ${conn.id} and t.account_email = ${conn.accountEmail} and not m.body_unavailable
   and ('SENT' = any(m.label_ids) or lower(m.from_header) like ${'%' + conn.accountEmail.toLowerCase() + '%'})
   and (${e!.sentCursor ?? null}::uuid is null or m.id > ${e!.sentCursor ?? null}::uuid) order by m.id limit 50`;
  if (!batch.length) return [];
  await tx`update workflow_enablements set sent_cursor = ${batch.at(-1)!.id} where id = ${enablementId}`;
  const clip = (text: string) => text.trim().slice(0, PARENT_CONTEXT_TOKENS * 4);
  return batch.flatMap((m): SentMessage[] => {
   const own = ownText(String(m.body)); if (tokens(own) < MIN_OWN_TOKENS) return [];
   const context = m.parentBody ? clip(ownText(String(m.parentBody))) : clip(quotedText(String(m.body)));
   return [{ id: String(m.id), threadId: String(m.threadId), subject: String(m.subject), to: String(m.toHeader), sentAt: new Date(m.sentAt).toISOString(), ownText: own.slice(0, 20000), context, linkedProject: m.linkedProject ? String(m.linkedProject) : null }];
  });
 }
 /** The person asked for a reply on a needs-you thread we did not draft: the strongest up signal for the sender's
  *  draft score (plan §6). Drafted on the large tier against the same instruction and style as the workflow, then
  *  placed in the outbox for the person to review and send; no send happens here (D5). */
 async requestDraft(actor: Actor, organisationId: string, threadId: string) {
  const prepared = await withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   await requireMember(tx, actor.userId, organisationId); const conn = await connection(tx);
   if (!conn || conn.status !== 'connected') throw badRequest('reconnect_required', 'Reconnect Google in Settings before drafting a reply.');
   const [existing] = await tx`select id from outbox where thread_id = ${threadId} and state = 'drafted' limit 1`;
   if (existing) throw badRequest('draft_exists', 'A draft is already waiting on this thread.');
   const thread = await loadThread(tx, conn, threadId); if (!thread) throw badRequest('already_replied', 'The latest message on this thread is yours; there is nothing to reply to.');
   const [triage] = await tx`select category, needs_owner, summary, facts from mail_triage where thread_id = ${threadId}`;
   const [enablement] = await tx`select parameters from workflow_enablements where definition_key = 'inbox-triage' order by updated_at desc limit 1`;
   return { thread, triage: triage ?? null, style: String((enablement?.parameters as { replyStyle?: unknown } | null)?.replyStyle ?? '') };
  });
  const draft = await this.inference.infer(actor, { organisationId, step: 'draftReply.requested', tier: 'large', instruction: draftReplyInstruction, schema: draftSchema,
   input: { replyStyle: prepared.style, untrustedMail: { subject: prepared.thread.subject, messages: prepared.thread.messages }, untrustedTriage: prepared.triage } });
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   const { thread } = prepared;
   const [row] = await tx`insert into outbox (organisation_id, thread_id, connection_id, account_email, "to", cc, subject, body, in_reply_to, created_by_person, idempotency_key)
    values (${organisationId}, ${thread.id}, ${thread.connectionId}, ${thread.accountEmail}, ${tx.array(thread.sender ? [thread.sender] : [])}, '{}', ${thread.subject.replace(/[\r\n]/g, ' ').slice(0, 300)}, ${draft.body}, ${thread.rfcMessageId}, ${actor.userId}, ${randomUUID()}) returning *`;
   if (thread.sender) await tx`insert into mail_senders (organisation_id, email, drafts_requested) values (${organisationId}, ${thread.sender}, 1)
    on conflict (organisation_id, email) do update set drafts_requested = mail_senders.drafts_requested + 1, updated_at = now()`;
   await tx`update mail_triage set remind_at = null, updated_at = now() where thread_id = ${thread.id}`;
   await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: 'outbox.requested', subjectType: 'outbox', subjectId: String(row!.id), detail: { threadId } });
   return row!;
  });
 }
 /** On a needs-you thread without a draft: Not needed (no reply wanted) or Remind me later (tomorrow morning or next week). */
 async threadAction(actor: Actor, organisationId: string, threadId: string, action: 'not_needed' | 'remind', when?: 'tomorrow' | 'next_week') {
  return withTenant(this.db, { organisationId, userId: actor.userId }, async tx => {
   await requireMember(tx, actor.userId, organisationId);
   const [triage] = await tx`select thread_id from mail_triage where thread_id = ${threadId}`; if (!triage) throw notFound();
   if (action === 'remind') {
    const [org] = await tx`select timezone from organisations where id = ${organisationId}`;
    await tx`update mail_triage set remind_at = ${remindAt(z.enum(['tomorrow', 'next_week']).parse(when), String(org?.timezone ?? 'UTC'))}, updated_at = now() where thread_id = ${threadId}`;
   } else {
    const [latest] = await tx`select from_header from mail_messages where thread_id = ${threadId} order by sent_at desc, provider_id desc limit 1`;
    await noReplyWanted(tx, threadId, addresses(String(latest?.fromHeader ?? '')).map(a => a.email));
   }
   await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action: action === 'remind' ? 'mail.reminder_set' : 'mail.no_reply_wanted', subjectType: 'mail_thread', subjectId: threadId });
   return (await tx`select * from mail_triage where thread_id = ${threadId}`)[0]!;
  });
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
 /** Sender priors (plan §5 `mail_senders`): counts only, updated by every verdict; a star seen on the thread counts once per verdict. */
 async sender(tx: TransactionSql, organisationId: string, thread: Thread, verdict: { information: boolean; needsOwner: boolean }) {
  if (!thread.sender) return;
  await tx`insert into mail_senders (organisation_id, email, threads_seen, information_verdicts, needs_owner_count, stars)
   values (${organisationId}, ${thread.sender.toLowerCase()}, 1, ${verdict.information ? 1 : 0}, ${verdict.needsOwner ? 1 : 0}, ${thread.signals.starred ? 1 : 0})
   on conflict (organisation_id, email) do update set threads_seen = mail_senders.threads_seen + 1, information_verdicts = mail_senders.information_verdicts + excluded.information_verdicts,
   needs_owner_count = mail_senders.needs_owner_count + excluded.needs_owner_count, stars = mail_senders.stars + excluded.stars, last_seen_at = now(), updated_at = now()`;
 }
 registry() {
  const registry = new Registry();
  registry.registerStep('gmail.newThreads', { kind: 'read', transaction: ctx => this.newThreads(ctx) });
  registry.registerStep('attachments.extractText', { kind: 'read', retrySafe: true, call: (ctx, args) => this.attachments(ctx, args.thread as Thread) });
  registry.registerStep('triage.gate', { kind: 'read', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; const [row] = await ctx.tx<Prior[]>`select threads_seen, information_verdicts, needs_owner_count, replies, stars from mail_senders where email = ${thread.sender}`;
   return gate(thread.signals, row ?? null);
  } });
  registry.registerStep('triage.draftScore', { kind: 'read', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; const verdict = args.triage as { needsOwner: boolean; category: string };
   const threshold = z.number().int().min(0).max(10).catch(3).parse(args.threshold);
   const [prior] = await ctx.tx<DraftPrior[]>`select replies, drafts_sent, drafts_edited, drafts_discarded, drafts_not_needed, drafts_requested from mail_senders where email = ${thread.sender}`;
   const [count] = await ctx.tx`select count(*)::int as drafts from outbox where created_by = ${ctx.runId} and thread_id is not null`;
   return drafting(thread.signals, verdict, prior ?? null, threshold, count?.drafts ?? 0);
  } });
  registry.registerStep('triage.file', { kind: 'write', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; const rule = (args.gate as { rule: Rule }).rule; const { tx } = ctx;
   await tx`insert into mail_triage (organisation_id, thread_id, category, needs_owner, summary, facts, produced_by, model, source_message_id)
    values (${ctx.organisationId}, ${thread.id}, 'information', false, ${'Filed without reading it. ' + ruleWords[rule]}, ${tx.json({ counterparty: null, amounts: [], dates: [], references: [] })}, ${ctx.runId}, ${'gate:' + rule}, ${thread.sourceMessageId})
    on conflict (organisation_id, thread_id) do update set category = excluded.category, needs_owner = excluded.needs_owner, summary = excluded.summary,
    facts = excluded.facts, produced_by = excluded.produced_by, model = excluded.model, source_message_id = excluded.source_message_id, updated_at = now()
    where mail_triage.source_message_id <= excluded.source_message_id`;
   await this.sender(tx, ctx.organisationId, thread, { information: true, needsOwner: false });
   await journal(ctx, 'mail.filed', 'mail_thread', thread.id, { rule }); return null;
  } });
  // Association (D22), rules first: the thread's project when a rule can say, else the model chooses from the active projects.
  registry.registerStep('triage.projectRule', { kind: 'read', transaction: (ctx, args) => projectRule(ctx.tx, args.thread as Thread) });
  registry.registerStep('classifyThread', { kind: 'infer', retrySafe: true, call: async (ctx, args) => {
   const thread = args.thread as Thread;
   // A resumed run may outlive the cache; reacquire allowed text, without retaining it in the journal.
   const notes = await this.attachments(ctx, thread);
   const attachments = await this.tx(ctx, tx => tx`select message_id, attachment_id, text from attachment_text where message_id = any(${tx.array(thread.messages.map(m => m.id))}::uuid[]) and expires_at > now()`);
   const link = args.link as ProjectLink | undefined; const projects = link?.projectId ? [] : await this.tx(ctx, tx => activeProjects(tx));
   const output = await this.inference.infer({ userId: ctx.userId, requestId: ctx.runId }, { organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key,
    tier: 'small', instruction: classifyThreadInstruction, schema: triageSchema, input: { untrustedMail: { subject: thread.subject, messages: thread.messages }, untrustedAttachments: attachments, extractionNotes: notes, projects } });
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
   await this.sender(tx, ctx.organisationId, thread, { information: triage.category === 'information', needsOwner: triage.needsOwner });
   const link = (args.link ?? null) as ProjectLink | null;
   const projectId = await recordAssociation(ctx, { kind: 'mail_thread', id: thread.id, own: false, companyId: link?.companyId ?? null }, link, triage.project);
   await journal(ctx, 'mail.triaged', 'mail_thread', thread.id); return { projectId };
  } });
  registry.registerStep('tasks.suggestFromTriage', { kind: 'write', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; const [linked] = await ctx.tx`select project_id from project_sources where source_kind = 'mail_thread' and source_id = ${thread.id} order by created_at limit 1`;
   return suggest(ctx, thread, triageSchema.parse(args.triage).tasks, linked ? String(linked.projectId) : null);
  } });
  registry.registerStep('tasks.completeFromConfirmations', { kind: 'write', transaction: (ctx, args) => complete(ctx, args.thread as Thread, triageSchema.parse(args.triage)) });
  registry.registerStep('contacts.upsertFromTriage', { kind: 'write', transaction: async (ctx, args) => {
   const thread = args.thread as Thread; await upkeepContacts(ctx.tx, ctx.organisationId, thread.accountEmail, [thread.providerId], { kind: 'workflow', id: ctx.userId });
   await journal(ctx, 'contacts.triaged', 'mail_thread', thread.id); return null;
  } });
  registry.registerStep('draftReply', { kind: 'infer', retrySafe: true, call: (ctx, args) => this.inference.infer({ userId: ctx.userId, requestId: ctx.runId }, {
   organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'large', instruction: draftReplyInstruction, schema: draftSchema,
   input: { replyStyle: args.style ?? '', untrustedMail: { subject: (args.thread as Thread).subject, messages: (args.thread as Thread).messages }, untrustedTriage: args.triage }
  }) });
  registry.registerStep('outbox.create', { kind: 'write', transaction: workflowDraft });
  // The wait ends when a person sends or closes the draft, or when it has sat untouched for seven days and expires
  // with a neutral outcome. Remind me later and edits count as touches, so the seven days start again.
  registry.registerStep('outbox.sent', { kind: 'await', transaction: async ({ tx, organisationId }, args) => {
   const id = (args.draft as { id?: string } | null)?.id; if (!id) return { ready: true, key: 'outbox:none', output: { state: 'skipped' } };
   const row = await expireDraft(tx, organisationId, id); const closed = row?.state === 'sent' || row?.state === 'discarded';
   const wakeAt = row && !closed ? new Date(new Date(row.updatedAt).getTime() + DRAFT_TTL_MS + 1000) : undefined;
   return { ready: !row || closed, key: `outbox:${id}`, output: { state: row ? (row.outcome ?? row.state) : 'missing' }, ...(wakeAt ? { wakeAt } : {}) };
  } });
  // Notes (D23): read like mail, classified with the person as author. A note with under about 40 tokens of text is
  // skipped, and one already read is read again only after an edit beyond a trivial change.
  registry.registerStep('notes.new', { kind: 'read', transaction: async ({ tx }) => {
   const rows = await tx`select n.id, n.title, n.body, n.updated_at, n.event_id, c.name as contact_name, co.name as company_name, p.name as project_name, t.title as task_title,
    md5(n.title || E'\n' || n.body) as digest, length(n.body) as length from notes n
    left join contacts c on c.organisation_id = n.organisation_id and c.id = n.contact_id left join companies co on co.organisation_id = n.organisation_id and co.id = n.company_id
    left join projects p on p.organisation_id = n.organisation_id and p.id = n.project_id left join tasks t on t.organisation_id = n.organisation_id and t.id = n.task_id
    left join note_triage nt on nt.organisation_id = n.organisation_id and nt.note_id = n.id
    where n.archived_at is null and length(n.body) >= 160 and (nt.note_id is null or (nt.body_digest <> md5(n.title || E'\n' || n.body) and abs(length(n.body) - nt.body_length) >= 20))
    order by n.updated_at, n.id limit 50`;
   return rows.map((r): Note => ({ id: String(r.id), title: String(r.title), body: String(r.body), digest: String(r.digest), length: Number(r.length), updatedAt: new Date(r.updatedAt).toISOString(),
    links: { contact: r.contactName ?? null, company: r.companyName ?? null, project: r.projectName ?? null, task: r.taskTitle ?? null, event: Boolean(r.eventId) } }));
  } });
  registry.registerStep('classifyNote', { kind: 'infer', retrySafe: true, call: async (ctx, args) => { const note = args.note as Note;
   // A note the person linked to a project keeps that link; the model names one only when they did not.
   const projects = note.links.project ? [] : await this.tx(ctx, tx => activeProjects(tx));
   return this.inference.infer({ userId: ctx.userId, requestId: ctx.runId }, {
   organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'small', instruction: classifyNoteInstruction, schema: noteTriageSchema,
   input: { untrustedNote: { title: note.title, body: note.body, linkedTo: note.links }, projects } }); } });
  registry.registerStep('notes.record', { kind: 'write', transaction: async (ctx, args) => {
   const note = args.note as Note; const triage = noteTriageSchema.parse(args.triage); const { tx } = ctx;
   const [usage] = await tx`select model from model_usage where run_id = ${ctx.runId} and step_key = 'classifyNote' order by created_at desc, id desc limit 1`;
   await tx`insert into note_triage (organisation_id, note_id, category, summary, facts, produced_by, model, body_digest, body_length)
    values (${ctx.organisationId}, ${note.id}, ${triage.category}, ${triage.summary}, ${tx.json(triage.facts)}, ${ctx.runId}, ${usage?.model ?? 'unknown'}, ${note.digest}, ${note.length})
    on conflict (organisation_id, note_id) do update set category = excluded.category, summary = excluded.summary, facts = excluded.facts, produced_by = excluded.produced_by,
    model = excluded.model, body_digest = excluded.body_digest, body_length = excluded.body_length, updated_at = now()`;
   const [row] = await tx`select project_id, company_id from notes where id = ${note.id}`;
   const own = row?.projectId ? { projectId: String(row.projectId), projectName: note.links.project, rule: 'person_link', companyId: row.companyId ? String(row.companyId) : null } : null;
   const projectId = await recordAssociation(ctx, { kind: 'note', id: note.id, own: true, companyId: own?.companyId ?? (row?.companyId ? String(row.companyId) : null) }, own, triage.project);
   await journal(ctx, 'note.triaged', 'note', note.id); return { projectId };
  } });
  registry.registerStep('tasks.suggestFromNote', { kind: 'write', transaction: async (ctx, args) => {
   const note = args.note as Note; const [linked] = await ctx.tx`select project_id from project_sources where source_kind = 'note' and source_id = ${note.id} order by created_at limit 1`;
   return suggestFrom(ctx, { kind: 'note', id: note.id }, noteTriageSchema.parse(args.triage).tasks, linked ? String(linked.projectId) : null);
  } });
  // Own writing (§14): the person's sent messages with at least about 40 tokens of their own text, read like notes.
  registry.registerStep('mail.newSent', { kind: 'read', transaction: ({ tx, enablementId }) => this.newSent(tx, enablementId) });
  registry.registerStep('classifySent', { kind: 'infer', retrySafe: true, call: async (ctx, args) => { const message = args.message as SentMessage;
   const projects = message.linkedProject ? [] : await this.tx(ctx, tx => activeProjects(tx));
   return this.inference.infer({ userId: ctx.userId, requestId: ctx.runId }, {
   organisationId: ctx.organisationId, runId: ctx.runId, step: ctx.step.key, tier: 'small', instruction: classifySentInstruction, schema: noteTriageSchema,
   input: { untrustedMessage: { subject: message.subject, to: message.to, sentAt: message.sentAt, context: message.context, body: message.ownText, linkedProject: message.linkedProject }, projects } }); } });
  registry.registerStep('sent.record', { kind: 'write', transaction: async (ctx, args) => {
   const message = args.message as SentMessage; const triage = noteTriageSchema.parse(args.triage); const { tx } = ctx;
   const [usage] = await tx`select model from model_usage where run_id = ${ctx.runId} and step_key = 'classifySent' order by created_at desc, id desc limit 1`;
   await tx`insert into sent_triage (organisation_id, message_id, thread_id, category, summary, facts, produced_by, model)
    values (${ctx.organisationId}, ${message.id}, ${message.threadId}, ${triage.category}, ${triage.summary}, ${tx.json(triage.facts)}, ${ctx.runId}, ${usage?.model ?? 'unknown'})
    on conflict (organisation_id, message_id) do update set category = excluded.category, summary = excluded.summary, facts = excluded.facts, produced_by = excluded.produced_by, model = excluded.model, updated_at = now()`;
   // The thread's existing link stands; otherwise the model's name links or becomes a candidate, marked as the person's own writing.
   const [linked] = await tx`select ps.project_id, p.name, ps.company_id from project_sources ps join projects p on p.organisation_id = ps.organisation_id and p.id = ps.project_id
    where ps.source_kind = 'mail_thread' and ps.source_id = ${message.threadId} and p.state = 'active' order by ps.created_at limit 1`;
   const [recipient] = await tx`select c.company_id from contacts c where c.email = any(${tx.array(addresses(message.to).map(a => a.email))}::text[]) and c.archived_at is null and c.company_id is not null limit 1`;
   const link = linked ? { projectId: String(linked.projectId), projectName: String(linked.name), rule: 'existing_link', companyId: linked.companyId ? String(linked.companyId) : null } : null;
   const projectId = await recordAssociation(ctx, { kind: 'mail_thread', id: message.threadId, own: true, companyId: link?.companyId ?? (recipient?.companyId ? String(recipient.companyId) : null) }, link, triage.project);
   await journal(ctx, 'mail.sent_triaged', 'mail_message', message.id, { threadId: message.threadId }); return { projectId };
  } });
  registry.registerStep('tasks.suggestFromSent', { kind: 'write', transaction: async (ctx, args) => {
   const message = args.message as SentMessage; const [linked] = await ctx.tx`select project_id from project_sources where source_kind = 'mail_thread' and source_id = ${message.threadId} order by created_at limit 1`;
   return suggestFrom(ctx, { kind: 'mail', id: message.threadId }, noteTriageSchema.parse(args.triage).tasks, linked ? String(linked.projectId) : null);
  } });
  registry.registerStep('gmail.label', { kind: 'write', retrySafe: true, call: async (ctx, args) => {
   const thread = args.thread as Thread; await this.gmail.label(await this.token(ctx, thread), thread.providerId, 'Captain/Handled');
   await this.tx(ctx, async tx => { await journal({ ...ctx, tx }, 'mail.labelled', 'mail_thread', thread.id); }); return { labelled: true };
  } });
  return registry;
 }
}
