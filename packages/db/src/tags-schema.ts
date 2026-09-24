import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';
// Reference shape only; hand-written migrations remain the authority for tasks.
const tasks = pgTable('tasks', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
export const tags = pgTable('tags', {
 id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), name: text('name').notNull(),
 createdAt: at('created_at'), updatedAt: at('updated_at'),
}, t => [unique().on(t.organisationId, t.id), uniqueIndex('tags_name').on(t.organisationId, sql`lower(${t.name})`),
 check('tags_name_check', sql`${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 60`)]);
export const taskTags = pgTable('task_tags', {
 organisationId: tenant(), taskId: uuid('task_id').notNull(), tagId: uuid('tag_id').notNull(),
 attachedBy: uuid('attached_by').notNull(), attachedAt: at('attached_at'),
}, t => [primaryKey({ columns: [t.organisationId, t.taskId, t.tagId] }),
 index('task_tags_by_tag').on(t.organisationId, t.tagId, t.taskId),
 foreignKey({ columns: [t.organisationId, t.taskId], foreignColumns: [tasks.organisationId, tasks.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.tagId], foreignColumns: [tags.organisationId, tags.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.attachedBy], foreignColumns: [memberships.organisationId, memberships.userId] })]);
