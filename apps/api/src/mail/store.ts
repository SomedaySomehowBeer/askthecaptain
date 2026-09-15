import type { TransactionSql } from '@captain/db';
import type { MailThread } from '@captain/connectors/gmail';
import { notFound } from '../errors.ts';
export type MailConnection = { id: string; accountEmail: string; status: string; error: string | null };
export async function connection(tx: TransactionSql): Promise<MailConnection | null> {
	const [row] = await tx<MailConnection[]>`select id, account_email, status, error from connections where provider = 'google'`;
	return row ?? null;
}
export async function saveThread(tx: TransactionSql, organisationId: string, conn: MailConnection, thread: MailThread) {
	const labels = [...new Set(thread.messages.flatMap((m) => m.labelIds))];
	const [stored] = await tx`insert into mail_threads (organisation_id, connection_id, account_email, provider_id, label_ids, last_message_at)
		values (${organisationId}, ${conn.id}, ${conn.accountEmail}, ${thread.providerId}, ${tx.array(labels)}, ${thread.messages.at(-1)!.sentAt})
		on conflict (organisation_id, connection_id, provider_id) do update set account_email = excluded.account_email, label_ids = excluded.label_ids,
		last_message_at = excluded.last_message_at, updated_at = now() returning id`;
	for (const m of thread.messages) {
		const [message] = await tx`insert into mail_messages (organisation_id, connection_id, thread_id, provider_id, from_header, to_header, cc_header, bcc_header, subject,
			date_header, sent_at, snippet, label_ids, in_reply_to, body, body_unavailable)
			values (${organisationId}, ${conn.id}, ${stored!.id}, ${m.providerId}, ${m.fromHeader}, ${m.toHeader}, ${m.ccHeader}, ${m.bccHeader}, ${m.subject},
				${m.dateHeader}, ${m.sentAt}, ${m.snippet}, ${tx.array(m.labelIds)}, ${m.inReplyTo}, ${m.body}, ${m.bodyUnavailable})
			on conflict (organisation_id, connection_id, provider_id) do update set thread_id = excluded.thread_id, from_header = excluded.from_header,
			to_header = excluded.to_header, cc_header = excluded.cc_header, bcc_header = excluded.bcc_header, subject = excluded.subject, date_header = excluded.date_header,
			sent_at = excluded.sent_at, snippet = excluded.snippet, label_ids = excluded.label_ids, in_reply_to = excluded.in_reply_to,
			body = excluded.body, body_unavailable = excluded.body_unavailable returning id`;
		for (const a of m.attachments) await tx`insert into mail_attachments (organisation_id, message_id, part_id, filename, media_type, size, provider_attachment_id)
			values (${organisationId}, ${message!.id}, ${a.partId}, ${a.filename}, ${a.mediaType}, ${a.size}, ${a.providerAttachmentId})
			on conflict (organisation_id, message_id, part_id) do update set filename = excluded.filename, media_type = excluded.media_type,
			size = excluded.size, provider_attachment_id = excluded.provider_attachment_id`;
		await tx`delete from mail_attachments where message_id = ${message!.id} and not (part_id = any(${tx.array(m.attachments.map((a) => a.partId))}::text[]))`;
	}
	await tx`delete from mail_messages where thread_id = ${stored!.id} and not (provider_id = any(${tx.array(thread.messages.map((m) => m.providerId))}::text[]))`;
}
export async function requireMember(tx: TransactionSql, userId: string, organisationId: string) {
	const [row] = await tx`select role from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active'`;
	if (!row) throw notFound(); return row.role as string;
}
