import { addresses } from '../contacts/addresses.ts';
import { withTenant, type Sql } from '@captain/db';
import { forbidden, HttpError, notFound } from '../errors.ts';
import { connection, requireMember } from './store.ts';
import type { MailSync } from './sync.ts';
async function triageState(tx: import('@captain/db').TransactionSql) {
 const [e] = await tx`select enabled from workflow_enablements where definition_key = 'inbox-triage'`;
 if (!e?.enabled) return 'Inbox triage is not enabled. Ask an owner or admin to enable it in Settings → Workflows.';
 const [r] = await tx`select status from inference_runtimes`;
 if (r?.status !== 'ready') return 'Inference is not ready. Ask the owner to sign in and verify it in Settings → Inference.';
 const [b] = await tx`select used_tokens, limit_tokens from model_budgets where month = date_trunc('month', now() at time zone 'UTC')::date`;
 if (b && Number(b.usedTokens) >= Number(b.limitTokens)) return 'The monthly token allowance is spent. Ask an owner or admin to increase it, then resume triage in Settings → Workflows.';
 const [paused] = await tx`select reason from workflow_runs where definition_key = 'inbox-triage' and state in ('paused', 'failed') order by created_at desc limit 1`;
 return paused?.reason ? String(paused.reason) + ' Open Settings → Workflows to review the run.' : null;
}
type Actor = { userId: string; requestId: string };

export class MailService {
	readonly runnerProblem: () => string | null; readonly #db: Sql; readonly #sync?: MailSync; readonly #automatic: boolean;
	constructor(db: Sql, sync?: MailSync, automatic = false, runnerProblem: () => string | null = () => null) { this.runnerProblem = runnerProblem; this.#db = db; this.#sync = sync; this.#automatic = automatic; }
	async list(actor: Actor, organisationId: string, since?: string, limit = 50, before?: [string, string]) {
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await requireMember(tx, actor.userId, organisationId);
			const conn = await connection(tx); const [org] = await tx`select timezone from organisations where id = ${organisationId}`;
			const [lastSync] = await tx`select created_at as at, detail from audit_events where action in ('mail.synced', 'mail.sync_failed', 'mail.sync_started') order by created_at desc, id desc limit 1`;
			const threads = !conn || conn.status === 'disconnected' ? [] : await tx`select t.id, m.from_header, m.subject, m.snippet, m.sent_at, t.label_names,
                (select to_jsonb(mt) from mail_triage mt where mt.thread_id = t.id) as triage,
                exists(select 1 from outbox o where o.thread_id = t.id and o.state = 'drafted') as has_draft,
				(select count(*)::int from mail_attachments a join mail_messages am on am.id = a.message_id where am.thread_id = t.id) as attachment_count
				from mail_threads t join lateral (select from_header, subject, snippet, sent_at from mail_messages where thread_id = t.id order by sent_at desc, provider_id desc limit 1) m on true
				where t.connection_id = ${conn.id} and t.account_email = ${conn.accountEmail} and (${since ?? null}::timestamptz is null or t.last_message_at >= ${since ?? null}::timestamptz)
				and (${before?.[0] ?? null}::timestamptz is null or (t.last_message_at, t.id) < (${before?.[0] ?? null}::timestamptz, ${before?.[1] ?? null}::uuid))
				order by t.last_message_at desc, t.id desc limit ${limit + 1}`;
			const edge = threads[limit - 1];
			return { triageNotice: (await triageState(tx)) ?? this.runnerProblem(), outbox: await tx`select id, thread_id, subject, body, "to", cc, state, send_started_at from outbox where state = 'drafted' order by created_at limit 100`, automaticSyncEnabled: this.#automatic, nextBefore: threads.length > limit ? `${edge!.sentAt.toISOString()}|${edge!.id}` : null, connection: conn, timezone: org!.timezone as string, lastSync: lastSync ?? null, threads: threads.slice(0, limit), hasMore: threads.length > limit };
		});
	}
	async thread(actor: Actor, organisationId: string, threadId: string) {
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			await requireMember(tx, actor.userId, organisationId);
			const [thread] = await tx`select t.id, t.label_names, c.status as connection_status, o.timezone from mail_threads t
				join connections c on c.id = t.connection_id and c.account_email = t.account_email join organisations o on o.id = t.organisation_id
				where t.id = ${threadId} and c.status <> 'disconnected'`;
			if (!thread) throw notFound('That mail thread is not available. Return to Inbox and sync again.');
			const messages = await tx`select id, from_header, to_header, cc_header, subject, date_header, sent_at, snippet, label_ids, in_reply_to, body, body_unavailable
				from mail_messages where thread_id = ${threadId} order by sent_at, provider_id`;
			const attachments = await tx`select a.id, a.message_id, a.filename, a.media_type, a.size, a.provider_attachment_id from mail_attachments a
				join mail_messages m on m.id = a.message_id where m.thread_id = ${threadId} order by a.part_id`;
			const senders = new Map((await tx`select id, email, name from contacts where email = any(${tx.array(messages.flatMap((m) => addresses(m.fromHeader).map((a) => a.email)))}::text[])`).map((c) => [c.email, c]));
			return { ...thread, triageNotice: (await triageState(tx)) ?? this.runnerProblem(), triage: (await tx`select * from mail_triage where thread_id = ${threadId}`)[0] ?? null, outbox: await tx`select id, thread_id, subject, body, "to", cc, state, send_started_at from outbox where thread_id = ${threadId} order by created_at`, messages: messages.map((m) => ({ ...m, senderContact: senders.get(addresses(m.fromHeader)[0]?.email) ?? null, attachments: attachments.filter((a) => a.messageId === m.id) })) };
		});
	}
	async sync(actor: Actor, organisationId: string) {
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			if (await requireMember(tx, actor.userId, organisationId) === 'member') throw forbidden('Only an owner or admin can sync mail.');
		});
		if (!this.#sync) throw new HttpError(503, 'mail_unavailable', 'Mail sync is not configured. Ask the owner to finish setup.');
		return this.#sync.run(organisationId);
	}
}
