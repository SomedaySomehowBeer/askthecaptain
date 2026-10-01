import { sql } from 'drizzle-orm';
import { check, date, foreignKey, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
/** A tag is a name, and optionally an owner and dates (D7, amended by 0046: projects are tags). It attaches to threads
 *  through thread_tags and to series through task_series_tags (threads-schema.ts). Migration 0046 also adds the
 *  `work_revision_bump` trigger and the owner/created_by `on delete set null (column)` foreign keys. */
export const tags = pgTable('tags', {
 id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), name: text('name').notNull(),
 ownerId: uuid('owner_id'), startsOn: date('starts_on'), endsOn: date('ends_on'), archivedAt: timestamp('archived_at', { withTimezone: true }),
 revision: integer('revision').notNull().default(1), createdBy: uuid('created_by'),
 createdAt: at('created_at'), updatedAt: at('updated_at'),
}, t => [unique().on(t.organisationId, t.id), uniqueIndex('tags_name').on(t.organisationId, sql`lower(${t.name})`),
 foreignKey({ name: 'tags_owner_fkey', columns: [t.organisationId, t.ownerId], foreignColumns: [memberships.organisationId, memberships.userId] }),
 foreignKey({ name: 'tags_created_by_fkey', columns: [t.organisationId, t.createdBy], foreignColumns: [memberships.organisationId, memberships.userId] }),
 check('tags_name_check', sql`${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 120`),
 check('tags_revision_check', sql`${t.revision} > 0`),
 check('tags_dates_check', sql`${t.startsOn} is null or ${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`)]);
