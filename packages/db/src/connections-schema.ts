// Drizzle descriptions; hand-written SQL remains the migration authority.
import { sql } from 'drizzle-orm';
import { customType, foreignKey, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const at = (name: string) => timestamp(name, { withTimezone: true });
// Foundation references are described here until the rest of its schema is mapped.
export const organisations = pgTable('organisations', {
	id: id(), name: text('name').notNull(), timezone: text('timezone').notNull().default('Australia/Perth'),
	locale: text('locale').notNull().default('en-AU'), settings: jsonb('settings').notNull().default({}),
	createdAt: at('created_at').notNull().defaultNow(), dataKeyWrapped: bytea('data_key_wrapped')
});
const memberships = pgTable('memberships', {
	organisationId: uuid('organisation_id').notNull(), userId: uuid('user_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organisationId, t.userId] })]);
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
export const connections = pgTable('connections', {
	id: id(), organisationId: tenant(), provider: text('provider').notNull(), connectedBy: uuid('connected_by').notNull(),
	accountEmail: text('account_email'), providerAccountId: text('provider_account_id'), providerAccountName: text('provider_account_name'), scopes: text('scopes').array().notNull(),
	status: text('status', { enum: ['connected', 'refresh_failed', 'revoked', 'disconnected'] }).notNull(), error: text('error'),
	accessTokenEncrypted: bytea('access_token_encrypted'), refreshTokenEncrypted: bytea('refresh_token_encrypted'),
	accessTokenExpiresAt: at('access_token_expires_at'), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow()
}, (t) => [unique().on(t.organisationId, t.provider), unique().on(t.organisationId, t.id),
	foreignKey({ columns: [t.organisationId, t.connectedBy], foreignColumns: [memberships.organisationId, memberships.userId] })]);
export const syncCursors = pgTable('sync_cursors', {
	id: id(), organisationId: tenant(), connectionId: uuid('connection_id').notNull(), resource: text('resource').notNull(),
	cursor: text('cursor').notNull(), updatedAt: at('updated_at').notNull().defaultNow()
}, (t) => [unique().on(t.organisationId, t.connectionId, t.resource),
	foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade')]);
export const webhookEvents = pgTable('webhook_events', {
	id: id(), organisationId: tenant(), connectionId: uuid('connection_id').notNull(), provider: text('provider').notNull(),
	providerEventId: text('provider_event_id').notNull(), payload: jsonb('payload').notNull(),
	receivedAt: at('received_at').notNull().defaultNow(), processedAt: at('processed_at')
}, (t) => [unique().on(t.provider, t.providerEventId), unique().on(t.organisationId, t.connectionId, t.id),
	foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade')]);
export const webhookAttempts = pgTable('webhook_attempts', {
	id: id(), organisationId: tenant(), connectionId: uuid('connection_id').notNull(), webhookEventId: uuid('webhook_event_id').notNull(),
	attemptedAt: at('attempted_at').notNull().defaultNow(), completedAt: at('completed_at'), error: text('error')
}, (t) => [foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.connectionId, t.webhookEventId], foreignColumns: [webhookEvents.organisationId, webhookEvents.connectionId, webhookEvents.id] }).onDelete('cascade')]);
