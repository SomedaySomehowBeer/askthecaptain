import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
// Private saved Work views (D26). Migration 0040 owns the table, its triggers (revision bump; fixed identity and
// final tombstones), the owner-only RLS policies and the select/insert/update-only grant to `app`.
export const savedViews = pgTable('saved_views', {
 id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
 ownerId: uuid('owner_id').notNull(), section: text('section').notNull().default('work'), name: text('name'),
 filterVersion: smallint('filter_version'), filter: jsonb('filter'), deletedAt: timestamp('deleted_at', { withTimezone: true }),
 revision: integer('revision').notNull().default(1), createdAt: at('created_at'), updatedAt: at('updated_at'),
}, t => [unique().on(t.organisationId, t.id),
 foreignKey({ columns: [t.organisationId, t.ownerId], foreignColumns: [memberships.organisationId, memberships.userId] }).onDelete('cascade'),
 uniqueIndex('saved_views_name').on(t.organisationId, t.ownerId, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
 index('saved_views_list').on(t.organisationId, t.ownerId, sql`lower(${t.name})`, t.id).where(sql`${t.deletedAt} is null`),
 check('saved_views_section_check', sql`${t.section} = 'work'`),
 check('saved_views_name_check', sql`${t.name} is null or (${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 60)`),
 check('saved_views_filter_version_check', sql`${t.filterVersion} is null or ${t.filterVersion} > 0`),
 check('saved_views_filter_check', sql`${t.filter} is null or (jsonb_typeof(${t.filter}) = 'object' and octet_length(${t.filter}::text) <= 4096)`),
 check('saved_views_revision_check', sql`${t.revision} > 0`),
 check('saved_views_content', sql`(${t.deletedAt} is null and ${t.name} is not null and ${t.filter} is not null and ${t.filterVersion} is not null)
  or (${t.deletedAt} is not null and ${t.name} is null and ${t.filter} is null and ${t.filterVersion} is null)`),
]);
