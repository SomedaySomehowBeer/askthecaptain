import { sql } from 'drizzle-orm';
import { boolean, date, foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { connections, organisations } from './connections-schema.ts';
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const calendars = pgTable('calendars', {
 id: id(), organisationId: tenant(), connectionId: uuid('connection_id').notNull(), accountEmail: text('account_email').notNull(), providerId: text('provider_id').notNull(),
 name: text('name').notNull(), isPrimary: boolean('is_primary').notNull().default(false), timezone: text('timezone').notNull(), accessRole: text('access_role').notNull(),
 selected: boolean('selected').notNull().default(false), syncedFrom: at('synced_from'), syncedTo: at('synced_to'), syncedAt: at('synced_at')
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId), unique().on(t.organisationId, t.id),
 foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade')]);
export const calendarEvents = pgTable('calendar_events', {
 id: id(), organisationId: tenant(), calendarId: uuid('calendar_id').notNull(), providerId: text('provider_id').notNull(), status: text('status').notNull(),
 summary: text('summary').notNull(), description: text('description').notNull(), location: text('location').notNull(), startsAt: at('starts_at').notNull(), endsAt: at('ends_at').notNull(),
 allDay: boolean('all_day').notNull(), startDate: date('start_date'), endDate: date('end_date'), timezone: text('timezone').notNull(), organiser: jsonb('organiser').notNull(),
 attendees: jsonb('attendees').notNull(), attendeesOmitted: boolean('attendees_omitted').notNull().default(false), recurringEventId: text('recurring_event_id'), htmlLink: text('html_link').notNull(), updatedAt: at('updated_at').notNull()
}, (t) => [unique().on(t.organisationId, t.calendarId, t.providerId),
 foreignKey({ columns: [t.organisationId, t.calendarId], foreignColumns: [calendars.organisationId, calendars.id] }).onDelete('cascade')]);
