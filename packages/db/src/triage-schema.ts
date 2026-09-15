import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations, connections } from './connections-schema.ts';
import { mailMessages, mailThreads } from './mail-schema.ts';
import { workflowRuns } from './workflows-schema.ts';
const users = pgTable('users', { id: uuid('id').primaryKey() });
const org = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const mailTriage = pgTable('mail_triage', {
 organisationId: org(), threadId: uuid('thread_id').notNull(), category: text('category').notNull(), needsOwner: boolean('needs_owner').notNull(), summary: text('summary').notNull(),
 facts: jsonb('facts').notNull(), producedBy: uuid('produced_by').notNull(), model: text('model').notNull(), sourceMessageId: uuid('source_message_id').notNull(),
 createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow()
}, t => [primaryKey({ columns: [t.organisationId, t.threadId] }),
 foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [mailThreads.organisationId, mailThreads.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.sourceMessageId], foreignColumns: [mailMessages.organisationId, mailMessages.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.producedBy], foreignColumns: [workflowRuns.organisationId, workflowRuns.id] }).onDelete('cascade')]);
export const attachmentText = pgTable('attachment_text', {
 organisationId: org(), messageId: uuid('message_id').notNull(), attachmentId: text('attachment_id').notNull(), text: text('text').notNull(),
 extractedAt: at('extracted_at').notNull().defaultNow(), expiresAt: at('expires_at').notNull().default(sql`now() + interval '24 hours'`)
}, t => [primaryKey({ columns: [t.organisationId, t.messageId, t.attachmentId] }), check('text_cap', sql`char_length(${t.text}) <= 20000`),
 check('text_expiry', sql`${t.expiresAt} > ${t.extractedAt} and ${t.expiresAt} <= ${t.extractedAt} + interval '24 hours'`),
 foreignKey({ columns: [t.organisationId, t.messageId], foreignColumns: [mailMessages.organisationId, mailMessages.id] }).onDelete('cascade')]);
export const outbox = pgTable('outbox', {
 id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: org(), threadId: uuid('thread_id'), connectionId: uuid('connection_id').notNull(), accountEmail: text('account_email').notNull(),
 to: text('to').array().notNull(), cc: text('cc').array().notNull().default([]), subject: text('subject').notNull(), body: text('body').notNull(), inReplyTo: text('in_reply_to').notNull().default(''),
 invoiceProviderId: text('invoice_provider_id'), createdBy: uuid('created_by'), createdByPerson: uuid('created_by_person').references(() => users.id, { onDelete: 'set null' }), idempotencyKey: text('idempotency_key').notNull(),
 state: text('state', { enum: ['drafted', 'sent', 'discarded'] }).notNull().default('drafted'), sendStartedAt: at('send_started_at'), sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
 sentAt: at('sent_at'), providerMessageId: text('provider_message_id'), discardedBy: uuid('discarded_by').references(() => users.id, { onDelete: 'set null' }), discardedAt: at('discarded_at'),
 createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow()
}, t => [unique().on(t.organisationId, t.id), unique().on(t.organisationId, t.idempotencyKey),
 index('outbox_invoice_history').on(t.organisationId, t.invoiceProviderId, t.state, t.sentAt).where(sql`${t.invoiceProviderId} is not null`),
 foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [mailThreads.organisationId, mailThreads.id] }),
 foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.createdBy], foreignColumns: [workflowRuns.organisationId, workflowRuns.id] })]);
