import { sql } from 'drizzle-orm';
import { boolean, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';
import { tags } from './tags-schema.ts';

// Threads (R2; contract docs/plans/threads-2026-09.md, D25, D27, D28). Migration 0046 owns these tables and everything
// Drizzle cannot describe: forced RLS and its policies, the row-transition guards, the record-thread insert triggers on
// tasks, equipment_reservations and stock_items, the definer functions below, and the attribution foreign keys'
// `on delete set null (column)` form, which only nulls the attribution column and keeps `organisation_id`.
// It replaces the linked-chat tables of 0042/0043, which 0046 drops.
//
// Callable by the runtime role `captain_runtime` (and, at parity, legacy `app`); by nothing else:
//   thread_visible(thread_id uuid) returns boolean                       -- stable; used by the policies
//   thread_create(p_id uuid, p_kind text, p_title text, p_fingerprint bytea) returns text
//       -- topic or private; 'created' | 'matched' | 'unavailable'; call positionally
//   thread_end_membership(p_target uuid) returns void                   -- after the target's membership is 'removed'
//
// Constraint names the API maps (and only these; any other unique violation is a 500):
//   threads_pkey, threads_organisation_id_id_key                         -> thread id unavailable
//   thread_messages_pkey, thread_messages_organisation_id_id_key         -> message id unavailable
//   thread_pins_live                                                     -> pin exists (one live pin per thread)
//
// At commit, a deferred constraint trigger (thread_seq_check, not callable) checks that every last_seq advance has its
// message. Timestamps are the server's: values a caller supplies are replaced by the guards.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
// Reference shapes only; hand-written migrations remain the authority for the record tables.
const tasks = pgTable('tasks', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const taskSeries = pgTable('task_series', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const reservations = pgTable('equipment_reservations', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const stockItems = pgTable('stock_items', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
/** An attribution column: the membership that acted, nulled (alone) when that membership is deleted. */
const member = (organisationId: AnyPgColumn, column: AnyPgColumn) =>
	foreignKey({ columns: [organisationId, column], foreignColumns: [memberships.organisationId, memberships.userId] });
const records = (t: { organisationId: AnyPgColumn; taskId: AnyPgColumn; reservationId: AnyPgColumn; stockItemId: AnyPgColumn }) => [
	foreignKey({ columns: [t.organisationId, t.taskId], foreignColumns: [tasks.organisationId, tasks.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.reservationId], foreignColumns: [reservations.organisationId, reservations.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.stockItemId], foreignColumns: [stockItems.organisationId, stockItems.id] }).onDelete('cascade')];

/** `record` threads belong to exactly one task, booking or stock item (made by the record's insert trigger); `topic`
 *  and `private` threads have a title and a create fingerprint and come only from thread_create. */
export const threads = pgTable('threads', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), kind: text('kind').notNull(),
	taskId: uuid('task_id'), reservationId: uuid('reservation_id'), stockItemId: uuid('stock_item_id'),
	title: text('title'), createFingerprint: bytea('create_fingerprint'), createdBy: uuid('created_by'),
	lastSeq: integer('last_seq').notNull().default(0), lastChange: integer('last_change').notNull().default(0),
	lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
	revision: integer('revision').notNull().default(1), createdAt: at('created_at'),
}, (t) => [unique('threads_organisation_id_id_key').on(t.organisationId, t.id), ...records(t),
	member(t.organisationId, t.createdBy), // on delete set null (created_by)
	uniqueIndex('threads_task').on(t.taskId).where(sql`${t.taskId} is not null`),
	uniqueIndex('threads_reservation').on(t.reservationId).where(sql`${t.reservationId} is not null`),
	uniqueIndex('threads_stock_item').on(t.stockItemId).where(sql`${t.stockItemId} is not null`),
	index('threads_by_activity').on(t.organisationId, sql`${t.lastMessageAt} desc nulls last`, sql`${t.id} desc`),
	check('threads_kind_check', sql`${t.kind} in ('record', 'topic', 'private')`),
	check('threads_shape_check', sql`(${t.kind} = 'record' and num_nonnulls(${t.taskId}, ${t.reservationId}, ${t.stockItemId}) = 1 and ${t.title} is null and ${t.createFingerprint} is null)
		or (${t.kind} <> 'record' and num_nonnulls(${t.taskId}, ${t.reservationId}, ${t.stockItemId}) = 0 and ${t.title} is not null and ${t.createFingerprint} is not null)`),
	check('threads_title_check', sql`${t.title} is null or (${t.title} = btrim(${t.title}) and char_length(${t.title}) between 1 and 80)`),
	check('threads_fingerprint_check', sql`${t.createFingerprint} is null or octet_length(${t.createFingerprint}) = 32`),
	check('threads_counters_check', sql`${t.lastSeq} >= 0 and ${t.lastChange} >= ${t.lastSeq} and ${t.revision} > 0`)]);

/** Private threads only. */
export const threadParticipants = pgTable('thread_participants', {
	organisationId: tenant(), threadId: uuid('thread_id').notNull(), userId: uuid('user_id').notNull(),
	state: text('state').notNull().default('active'), addedBy: uuid('added_by'), addedAt: at('added_at'),
	endedAt: timestamp('ended_at', { withTimezone: true }), readStartSeq: integer('read_start_seq').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.threadId, t.userId] }),
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.userId], foreignColumns: [memberships.organisationId, memberships.userId] }).onDelete('cascade'),
	member(t.organisationId, t.addedBy), // on delete set null (added_by)
	index('thread_participants_active_by_user').on(t.organisationId, t.userId, t.threadId).where(sql`${t.state} = 'active'`),
	check('thread_participants_state_check', sql`${t.state} in ('active', 'left', 'removed')`),
	check('thread_participants_ended_check', sql`(${t.state} = 'active') = (${t.endedAt} is null)`),
	check('thread_participants_read_start_check', sql`${t.readStartSeq} >= 0`)]);

/** A topic or private thread pointing at records; never makes the thread visible from the record. */
export const threadLinks = pgTable('thread_links', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), threadId: uuid('thread_id').notNull(),
	taskId: uuid('task_id'), reservationId: uuid('reservation_id'), stockItemId: uuid('stock_item_id'), linkedBy: uuid('linked_by'), createdAt: at('created_at'),
}, (t) => [...records(t),
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	member(t.organisationId, t.linkedBy), // on delete set null (linked_by)
	uniqueIndex('thread_links_target').on(t.threadId, sql`coalesce(${t.taskId}, ${t.reservationId}, ${t.stockItemId})`),
	check('thread_links_target_check', sql`num_nonnulls(${t.taskId}, ${t.reservationId}, ${t.stockItemId}) = 1`)]);

/** The one place a tag is attached to anything, on every thread kind. */
export const threadTags = pgTable('thread_tags', {
	organisationId: tenant(), threadId: uuid('thread_id').notNull(), tagId: uuid('tag_id').notNull(), attachedBy: uuid('attached_by'), attachedAt: at('attached_at'),
}, (t) => [primaryKey({ columns: [t.threadId, t.tagId] }),
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.tagId], foreignColumns: [tags.organisationId, tags.id] }).onDelete('cascade'),
	member(t.organisationId, t.attachedBy), // on delete set null (attached_by)
	index('thread_tags_by_tag').on(t.organisationId, t.tagId, t.threadId)]);

/** A series has no thread; each occurrence receives these on its own thread. Replaces task_series.project_id. */
export const taskSeriesTags = pgTable('task_series_tags', {
	organisationId: tenant(), seriesId: uuid('series_id').notNull(), tagId: uuid('tag_id').notNull(), createdAt: at('created_at'),
}, (t) => [primaryKey({ columns: [t.seriesId, t.tagId] }),
	foreignKey({ columns: [t.organisationId, t.seriesId], foreignColumns: [taskSeries.organisationId, taskSeries.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.tagId], foreignColumns: [tags.organisationId, tags.id] }).onDelete('cascade'),
	index('task_series_tags_by_tag').on(t.organisationId, t.tagId, t.seriesId)]);

export const threadMessages = pgTable('thread_messages', {
	id: uuid('id').primaryKey(), organisationId: tenant(), threadId: uuid('thread_id').notNull(), kind: text('kind').notNull().default('message'),
	seq: integer('seq').notNull(), changeSeq: integer('change_seq').notNull(), authorId: uuid('author_id'),
	body: text('body'), sentBodySha256: bytea('sent_body_sha256'), createdAt: at('created_at'),
	editedAt: timestamp('edited_at', { withTimezone: true }), deletedAt: timestamp('deleted_at', { withTimezone: true }),
	deletedBy: uuid('deleted_by'), revision: integer('revision').notNull().default(1),
}, (t) => [unique('thread_messages_organisation_id_id_key').on(t.organisationId, t.id),
	unique('thread_messages_thread_seq').on(t.threadId, t.seq),
	unique('thread_messages_thread_change').on(t.threadId, t.changeSeq),
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	member(t.organisationId, t.authorId), // on delete set null (author_id)
	member(t.organisationId, t.deletedBy), // on delete set null (deleted_by)
	check('thread_messages_kind_check', sql`${t.kind} in ('message', 'change', 'approval')`), // R2's guard accepts only 'message'
	check('thread_messages_counters_check', sql`${t.seq} > 0 and ${t.changeSeq} > 0 and ${t.revision} > 0`),
	check('thread_messages_body_check', sql`${t.body} is null or (char_length(${t.body}) between 1 and 4000 and octet_length(${t.body}) <= 16384)`),
	check('thread_messages_hash_check', sql`${t.sentBodySha256} is null or octet_length(${t.sentBodySha256}) = 32`),
	check('thread_messages_tombstone_check', sql`(${t.deletedAt} is null and ${t.body} is not null and ${t.sentBodySha256} is not null and ${t.deletedBy} is null)
		or (${t.deletedAt} is not null and ${t.body} is null and ${t.sentBodySha256} is null)`)]);

/** At most one live pin per thread, set and cleared by an owner or admin; it references the message, never its text. */
export const threadPins = pgTable('thread_pins', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), threadId: uuid('thread_id').notNull(),
	messageId: uuid('message_id').notNull(), changeSeq: integer('change_seq').notNull(),
	pinnedBy: uuid('pinned_by'), pinnedAt: at('pinned_at'),
	unpinnedBy: uuid('unpinned_by'), unpinnedAt: timestamp('unpinned_at', { withTimezone: true }),
}, (t) => [
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.messageId], foreignColumns: [threadMessages.organisationId, threadMessages.id] }).onDelete('cascade'),
	member(t.organisationId, t.pinnedBy), // on delete set null (pinned_by)
	member(t.organisationId, t.unpinnedBy), // on delete set null (unpinned_by)
	uniqueIndex('thread_pins_live').on(t.threadId).where(sql`${t.unpinnedAt} is null`),
	uniqueIndex('thread_pins_thread_change').on(t.threadId, t.changeSeq),
	check('thread_pins_change_check', sql`${t.changeSeq} > 0`),
	check('thread_pins_unpinned_check', sql`${t.unpinnedBy} is null or ${t.unpinnedAt} is not null`)]);

/** Personal rows: visible only to their own person, while that person can see the thread. */
export const threadStars = pgTable('thread_stars', {
	organisationId: tenant(), threadId: uuid('thread_id').notNull(), userId: uuid('user_id').notNull(), createdAt: at('created_at'),
}, (t) => [primaryKey({ columns: [t.threadId, t.userId] }),
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.userId], foreignColumns: [memberships.organisationId, memberships.userId] }).onDelete('cascade'),
	index('thread_stars_by_user').on(t.organisationId, t.userId)]);

export const threadReads = pgTable('thread_reads', {
	organisationId: tenant(), threadId: uuid('thread_id').notNull(), userId: uuid('user_id').notNull(),
	lastReadSeq: integer('last_read_seq').notNull(), updatedAt: at('updated_at'),
}, (t) => [primaryKey({ columns: [t.threadId, t.userId] }),
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.userId], foreignColumns: [memberships.organisationId, memberships.userId] }).onDelete('cascade'),
	check('thread_reads_seq_check', sql`${t.lastReadSeq} >= 0`)]);

/** Every thread write, readable by whoever can see the thread (a private thread's rows stay participant-scoped). */
export const chatAuditEvents = pgTable('chat_audit_events', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), threadId: uuid('thread_id').notNull(),
	actorId: uuid('actor_id'), action: text('action').notNull(), subjectKind: text('subject_kind').notNull(), subjectId: uuid('subject_id'),
	personal: boolean('personal').notNull().default(false), requestId: text('request_id'),
	detail: jsonb('detail').notNull().default({}), createdAt: at('created_at'),
}, (t) => [
	foreignKey({ columns: [t.organisationId, t.threadId], foreignColumns: [threads.organisationId, threads.id] }).onDelete('cascade'),
	member(t.organisationId, t.actorId), // on delete set null (actor_id)
	index('chat_audit_events_by_thread').on(t.organisationId, t.threadId, t.createdAt, t.id),
	check('chat_audit_events_action_check', sql`${t.action} in ('chat.thread_created', 'chat.conversation_created', 'chat.conversation_updated',
		'chat.participant_added', 'chat.participant_removed', 'chat.participant_left', 'chat.link_added', 'chat.link_removed',
		'chat.tag_added', 'chat.tag_removed', 'chat.message_sent', 'chat.message_edited', 'chat.message_deleted', 'chat.pin_added', 'chat.pin_removed',
		'chat.star_set', 'chat.star_cleared', 'chat.read_advanced')`),
	check('chat_audit_events_subject_check', sql`${t.subjectKind} in ('thread', 'conversation', 'participant', 'link', 'tag', 'message', 'pin', 'star', 'read')`),
	check('chat_audit_events_personal_check', sql`${t.personal} = (${t.action} in ('chat.star_set', 'chat.star_cleared', 'chat.read_advanced'))`),
	check('chat_audit_events_detail_check', sql`jsonb_typeof(${t.detail}) = 'object'`)]);
