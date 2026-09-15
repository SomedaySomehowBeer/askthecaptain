import { sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './connections-schema.ts';
const memberships = pgTable('memberships', { organisationId: uuid('organisation_id').notNull(), userId: uuid('user_id').notNull() });
export const answers = pgTable('answers', {
 id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
 askedBy: uuid('asked_by').notNull(), question: text('question').notNull(), answer: text('answer').notNull(), sources: jsonb('sources').notNull(),
 confidence: text('confidence').notNull(), model: text('model').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.askedBy], foreignColumns: [memberships.organisationId, memberships.userId] }).onDelete('cascade'),
 index('answers_recent').on(t.organisationId, t.askedBy, t.createdAt.desc(), t.id.desc())]);
