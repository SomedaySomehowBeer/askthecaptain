import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';
import { companies } from './contacts-schema.ts';
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const stockItems = pgTable('stock_items', {
 id: id(), organisationId: tenant(), name: text('name').notNull(), location: text('location').notNull(), unitLabel: text('unit_label').notNull(),
 currentCount: numeric('current_count'), countedAt: at('counted_at'), countedBy: uuid('counted_by'), reorderPoint: numeric('reorder_point'),
 preferredSupplierId: uuid('preferred_supplier_id'), notes: text('notes').notNull().default(''), archivedAt: at('archived_at'),
 // 0047: every update moves it (work_revision_bump), so a version and a reversal's basis can name it.
 revision: integer('revision').notNull().default(1),
 createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow()
}, (t) => [unique().on(t.organisationId, t.id), unique().on(t.organisationId, t.location, t.name), check('stock_items_revision_check', sql`${t.revision} > 0`),
 foreignKey({ columns: [t.organisationId, t.countedBy], foreignColumns: [memberships.organisationId, memberships.userId] }),
 foreignKey({ columns: [t.organisationId, t.preferredSupplierId], foreignColumns: [companies.organisationId, companies.id] })]);
export const stockCounts = pgTable('stock_counts', {
 id: id(), organisationId: tenant(), itemId: uuid('item_id').notNull(), countedAt: at('counted_at').notNull().default(sql`clock_timestamp()`),
 countedBy: uuid('counted_by').notNull(), count: numeric('count').notNull(), note: text('note').notNull().default('')
}, (t) => [unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.itemId], foreignColumns: [stockItems.organisationId, stockItems.id] }),
 foreignKey({ columns: [t.organisationId, t.countedBy], foreignColumns: [memberships.organisationId, memberships.userId] })]);
