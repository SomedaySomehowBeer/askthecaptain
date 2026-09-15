import { sql } from 'drizzle-orm';
import { boolean, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { connections, organisations } from './connections-schema.ts';
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull();
export const mailThreads = pgTable('mail_threads', {
	id: id(), organisationId: tenant(), connectionId: uuid('connection_id').notNull(), accountEmail: text('account_email').notNull(), providerId: text('provider_id').notNull(),
	labelIds: text('label_ids').array().notNull().default([]), labelNames: text('label_names').array().notNull().default([]), lastMessageAt: at('last_message_at'), updatedAt: at('updated_at').defaultNow()
}, (t) => [unique().on(t.organisationId, t.id), unique().on(t.organisationId, t.connectionId, t.providerId), unique().on(t.organisationId, t.connectionId, t.id),
	foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade')]);
export const mailMessages = pgTable('mail_messages', {
	id: id(), organisationId: tenant(), connectionId: uuid('connection_id').notNull(), threadId: uuid('thread_id').notNull(), providerId: text('provider_id').notNull(),
	fromHeader: text('from_header').notNull(), toHeader: text('to_header').notNull(), ccHeader: text('cc_header').notNull(), bccHeader: text('bcc_header').notNull().default(''), subject: text('subject').notNull(),
	dateHeader: text('date_header').notNull(), sentAt: at('sent_at'), snippet: text('snippet').notNull(), labelIds: text('label_ids').array().notNull().default([]),
	inReplyTo: text('in_reply_to').notNull(), body: text('body').notNull(), bodyUnavailable: boolean('body_unavailable').notNull().default(false)
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId), unique().on(t.organisationId, t.id),
	foreignKey({ columns: [t.organisationId, t.connectionId, t.threadId], foreignColumns: [mailThreads.organisationId, mailThreads.connectionId, mailThreads.id] }).onDelete('cascade')]);
export const mailAttachments = pgTable('mail_attachments', {
	id: id(), organisationId: tenant(), messageId: uuid('message_id').notNull(), partId: text('part_id').notNull(), filename: text('filename').notNull(),
	mediaType: text('media_type').notNull(), size: integer('size').notNull(), providerAttachmentId: text('provider_attachment_id')
}, (t) => [unique().on(t.organisationId, t.messageId, t.partId),
	foreignKey({ columns: [t.organisationId, t.messageId], foreignColumns: [mailMessages.organisationId, mailMessages.id] }).onDelete('cascade')]);
