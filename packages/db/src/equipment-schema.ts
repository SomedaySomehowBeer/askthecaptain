import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';
// Reference shapes only; the hand-written migrations own the work tables and GiST exclusion.
const projects = pgTable('projects', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const tasks = pgTable('tasks', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
export const equipment = pgTable('equipment', {
 id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), name: text('name').notNull(),
 archivedAt: timestamp('archived_at', { withTimezone: true }), revision: integer('revision').notNull().default(1),
 createdAt: at('created_at'), updatedAt: at('updated_at'),
}, t => [unique().on(t.organisationId, t.id), uniqueIndex('equipment_name').on(t.organisationId, sql`lower(${t.name})`),
 check('equipment_name_check', sql`${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 100`), check('equipment_revision_check', sql`${t.revision} > 0`)]);
export const equipmentReservations = pgTable('equipment_reservations', {
 id: uuid('id').primaryKey(), organisationId: tenant(), equipmentId: uuid('equipment_id').notNull(), title: text('title').notNull(),
 kind: text('kind').notNull().default('booking'), status: text('status').notNull().default('confirmed'),
 startsAt: timestamp('starts_at', { withTimezone: true }).notNull(), endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
 setupMinutes: integer('setup_minutes').notNull().default(0), cleanupMinutes: integer('cleanup_minutes').notNull().default(0),
 occupiedStartsAt: timestamp('occupied_starts_at', { withTimezone: true }).notNull(), occupiedEndsAt: timestamp('occupied_ends_at', { withTimezone: true }).notNull(),
 projectId: uuid('project_id'), taskId: uuid('task_id'), ownerId: uuid('owner_id'), createdBy: uuid('created_by').notNull(),
 revision: integer('revision').notNull().default(1), createdAt: at('created_at'), updatedAt: at('updated_at'),
}, t => [unique().on(t.organisationId, t.id), index('equipment_reservations_by_time').on(t.organisationId, t.equipmentId, t.occupiedStartsAt, t.id),
 foreignKey({ columns: [t.organisationId, t.equipmentId], foreignColumns: [equipment.organisationId, equipment.id] }),
 foreignKey({ columns: [t.organisationId, t.projectId], foreignColumns: [projects.organisationId, projects.id] }),
 foreignKey({ columns: [t.organisationId, t.taskId], foreignColumns: [tasks.organisationId, tasks.id] }),
 foreignKey({ columns: [t.organisationId, t.ownerId], foreignColumns: [memberships.organisationId, memberships.userId] }),
 foreignKey({ columns: [t.organisationId, t.createdBy], foreignColumns: [memberships.organisationId, memberships.userId] }),
 check('equipment_reservations_title_check', sql`${t.title} = btrim(${t.title}) and length(${t.title}) between 1 and 200`),
 check('equipment_reservations_kind_check', sql`${t.kind} in ('booking', 'maintenance')`),
 check('equipment_reservations_status_check', sql`${t.status} in ('confirmed', 'cancelled')`),
 check('equipment_reservations_revision_check', sql`${t.revision} > 0`),
 check('equipment_reservations_setup_minutes_check', sql`${t.setupMinutes} between 0 and 10080`),
 check('equipment_reservations_cleanup_minutes_check', sql`${t.cleanupMinutes} between 0 and 10080`),
 check('equipment_reservations_task_project_check', sql`${t.taskId} is null or ${t.projectId} is not null`),
 check('equipment_reservations_times_check', sql`isfinite(${t.startsAt}) and isfinite(${t.endsAt}) and ${t.startsAt} >= '1900-01-01T00:00:00Z' and ${t.endsAt} < '2200-01-01T00:00:00Z' and ${t.endsAt} > ${t.startsAt} and extract(epoch from ${t.endsAt} - ${t.startsAt}) <= 31622400`),
 check('equipment_reservations_setup_check', sql`${t.occupiedStartsAt} = ${t.startsAt} - ${t.setupMinutes} * interval '1 minute'`),
 check('equipment_reservations_cleanup_check', sql`${t.occupiedEndsAt} = ${t.endsAt} + ${t.cleanupMinutes} * interval '1 minute'`),
 // Migration 0036 also adds equipment_reservations_no_overlap (GiST, confirmed occupied [start,end)).
]);
