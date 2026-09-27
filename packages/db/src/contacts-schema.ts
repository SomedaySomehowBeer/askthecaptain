import { sql } from 'drizzle-orm';
import { foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './connections-schema.ts';
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const companies = pgTable('companies', {
 id: id(), organisationId: tenant(), name: text('name').notNull(), domain: text('domain'), notes: text('notes').notNull().default(''),
 externalRefs: jsonb('external_refs').notNull().default({}), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(), archivedAt: at('archived_at')
}, (t) => [unique().on(t.organisationId, t.id), unique().on(t.organisationId, t.domain)]);
export const contacts = pgTable('contacts', {
 id: id(), organisationId: tenant(), companyId: uuid('company_id'), name: text('name').notNull().default(''), email: text('email').notNull(),
 phone: text('phone').notNull().default(''), role: text('role').notNull().default(''), notes: text('notes').notNull().default(''), source: text('source').notNull(),
 firstSeenAt: at('first_seen_at').notNull().defaultNow(), lastSeenAt: at('last_seen_at').notNull().defaultNow(), archivedAt: at('archived_at')
}, (t) => [unique().on(t.organisationId, t.id), unique().on(t.organisationId, t.email),
 foreignKey({ columns: [t.organisationId, t.companyId], foreignColumns: [companies.organisationId, companies.id] })]);
