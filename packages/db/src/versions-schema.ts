import { sql } from 'drizzle-orm';
import { check, customType, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { connections, memberships, organisations } from './connections-schema.ts';

// The change journal (R3; contract docs/plans/versions-and-undo-2026-10.md §2, D29). Migration 0047 owns these tables
// and everything Drizzle cannot describe: forced row security with record_visible(kind, id) in every policy, the
// journal triggers on the nine journalled tables (journal_guard immediately, journal_capture deferred to commit), the
// field lists in journal_fields() (mirrored in versions.ts), the `on delete set null (actor_id)` foreign key, and the
// grants (select on all three, insert on change_sets only: nothing is updated or deleted by the runtime).
//
// Callable by the runtime role (and, at parity, legacy `app`):
//   change_set_open(p_id uuid, p_actor_kind text, p_cause_kind text, p_cause_id text, p_request_id text, p_fingerprint bytea)
//       returns table (change_set_id uuid, result text)          -- 'created' | 'matched' | 'unavailable'; sets app.change_set_id
//   record_visible(p_kind text, p_id uuid) returns boolean       -- stable; used by the policies
//   journal_fields() returns jsonb                               -- immutable; the compared fields per table
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const recordKinds = sql`('task', 'reservation', 'stock_item', 'series', 'equipment', 'tag', 'thread')`;

export const changeSets = pgTable('change_sets', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), actorId: uuid('actor_id'), actorKind: text('actor_kind').notNull(),
	causeKind: text('cause_kind').notNull(), causeId: text('cause_id'), requestId: text('request_id'), fingerprint: bytea('fingerprint'),
	createdXact: xid8('created_xact').notNull().default(sql`pg_current_xact_id()`), createdAt: at('created_at'),
}, (t) => [unique('change_sets_organisation_id_id_key').on(t.organisationId, t.id),
	foreignKey({ columns: [t.organisationId, t.actorId], foreignColumns: [memberships.organisationId, memberships.userId] }), // on delete set null (actor_id)
	uniqueIndex('change_sets_one_per_transaction').on(t.organisationId, t.createdXact),
	index('change_sets_by_time').on(t.organisationId, t.createdAt.desc(), t.id.desc()),
	check('change_sets_actor_kind_check', sql`${t.actorKind} in ('person', 'workflow', 'system')`),
	check('change_sets_cause_kind_check', sql`${t.causeKind} in ('request', 'workflow_run', 'routine', 'reversal', 'baseline')`),
	check('change_sets_system_check', sql`${t.actorKind} <> 'system' or ${t.actorId} is null`),
	check('change_sets_cause_check', sql`${t.causeId} is null or char_length(${t.causeId}) between 1 and 200`),
	check('change_sets_request_check', sql`${t.requestId} is null or char_length(${t.requestId}) between 1 and 200`),
	check('change_sets_fingerprint_check', sql`${t.fingerprint} is null or octet_length(${t.fingerprint}) = 32`)]);

/** One per changed field or item; `before`/`after` are typed JSON (a field's value, or an item's or record's full row). */
export const recordChanges = pgTable('record_changes', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), changeSetId: uuid('change_set_id').notNull(),
	recordKind: text('record_kind').notNull(), recordId: uuid('record_id').notNull(), operation: text('operation').notNull(), field: text('field'),
	itemKind: text('item_kind'), itemId: uuid('item_id'), before: jsonb('before'), after: jsonb('after'),
	baseRevision: integer('base_revision'), resultRevision: integer('result_revision').notNull(), reversesChangeId: uuid('reverses_change_id'), createdAt: at('created_at'),
}, (t) => [unique('record_changes_organisation_id_id_key').on(t.organisationId, t.id),
	foreignKey({ columns: [t.organisationId, t.changeSetId], foreignColumns: [changeSets.organisationId, changeSets.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.reversesChangeId], foreignColumns: [t.organisationId, t.id] }).onDelete('cascade'),
	index('record_changes_by_record').on(t.organisationId, t.recordKind, t.recordId, t.id),
	index('record_changes_by_set').on(t.changeSetId, t.id),
	index('record_changes_by_item').on(t.organisationId, t.recordKind, t.recordId, t.itemKind, t.itemId, t.id).where(sql`${t.itemId} is not null`),
	check('record_changes_record_kind_check', sql`${t.recordKind} in ${recordKinds}`),
	check('record_changes_operation_check', sql`${t.operation} in ('create', 'update', 'remove', 'attach', 'detach')`),
	check('record_changes_item_check', sql`(${t.itemKind} is null) = (${t.itemId} is null) and (${t.itemKind} is null or ${t.itemKind} in ('step', 'evidence', 'tag'))`),
	check('record_changes_field_check', sql`(${t.operation} = 'update') = (${t.field} is not null) and (${t.field} is null or ${t.field} ~ '^[a-z_]{1,60}$')`),
	check('record_changes_shape_check', sql`(${t.operation} = 'update' and ${t.before} is not null and ${t.after} is not null)
		or (${t.operation} in ('create', 'attach') and ${t.before} is null and jsonb_typeof(${t.after}) = 'object')
		or (${t.operation} in ('remove', 'detach') and jsonb_typeof(${t.before}) = 'object' and ${t.after} is null)`),
	check('record_changes_tag_check', sql`(${t.operation} in ('attach', 'detach')) = (${t.itemKind} is not distinct from 'tag')`),
	check('record_changes_revision_check', sql`(${t.baseRevision} is null or ${t.baseRevision} > 0) and ${t.resultRevision} > 0`)]);

/** The full record after a change set, with its steps, evidence and tags; one per record per change set. */
export const recordVersions = pgTable('record_versions', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), changeSetId: uuid('change_set_id').notNull(),
	recordKind: text('record_kind').notNull(), recordId: uuid('record_id').notNull(), revision: integer('revision').notNull(), snapshot: jsonb('snapshot').notNull(),
	createdAt: at('created_at'),
}, (t) => [unique('record_versions_organisation_id_id_key').on(t.organisationId, t.id),
	unique('record_versions_one_per_set').on(t.changeSetId, t.recordKind, t.recordId),
	foreignKey({ columns: [t.organisationId, t.changeSetId], foreignColumns: [changeSets.organisationId, changeSets.id] }).onDelete('cascade'),
	index('record_versions_by_record').on(t.organisationId, t.recordKind, t.recordId, t.id),
	check('record_versions_record_kind_check', sql`${t.recordKind} in ${recordKinds}`),
	check('record_versions_revision_check', sql`${t.revision} > 0`),
	check('record_versions_snapshot_check', sql`jsonb_typeof(${t.snapshot}) = 'object'`)]);

/** Xero's sync state per connection (0047; it was read from audit_events before). Tenant-wide, written by the sync routine. */
export const xeroSyncState = pgTable('xero_sync_state', {
	organisationId: tenant(), connectionId: uuid('connection_id').primaryKey(), state: text('state').notNull(), error: text('error'),
	stateAt: at('state_at'), lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
}, (t) => [foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'),
	check('xero_sync_state_state_check', sql`${t.state} in ('started', 'synced', 'failed')`),
	check('xero_sync_state_error_check', sql`${t.error} is null or char_length(${t.error}) <= 1000`)]);
