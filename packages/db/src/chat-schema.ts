import { sql } from 'drizzle-orm';
import { boolean, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { memberships, organisations } from './connections-schema.ts';

// Linked chat, PR B (D25; contract docs/plans/linked-chat-2026-09.md, adopted in #160). Migration 0041 owns these
// tables and everything Drizzle cannot describe: forced RLS and its policies, the row-transition triggers (§9.4),
// the three callable definer functions below, and the attribution foreign keys' `on delete set null (column)`
// form, which only nulls the attribution column and keeps `organisation_id` (Drizzle's `onDelete('set null')`
// would name every column, so it is not used here).
//
// Callable by `app` (nothing else is):
//   chat_participant(conversation_id uuid) returns boolean              -- stable; used by the policies
//   chat_create_conversation(p_id uuid, p_title text, p_fingerprint bytea) returns text
//       -- 'created' | 'matched' | 'unavailable'; call positionally
//   chat_end_membership(p_target uuid) returns void                     -- after the target's membership is 'removed'
//
// Constraint names the API maps (and only these; any other unique violation is a 500):
//   conversations_pkey, conversations_organisation_id_id_key            -> conversation id unavailable
//   messages_pkey, messages_organisation_id_id_key                      -> message id unavailable
//   conversation_links_target                                           -> link exists
// Named for diagnosis, never mapped to a 409: messages_conversation_seq, messages_conversation_change.
//
// At commit, a deferred constraint trigger (chat_conversations_seq_check, not callable) checks that every last_seq
// advance has its message; a failing commit raises check_violation (23514). Timestamps are the server's: created_at,
// added_at, ended_at, deleted_at and a send's last_message_at are assigned by the triggers, and a message's created_at
// is its send's last_message_at. Values a caller supplies for them are ignored.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
// Reference shapes only; hand-written migrations remain the authority for tasks and projects.
const projects = pgTable('projects', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
const tasks = pgTable('tasks', { id: uuid('id').primaryKey(), organisationId: uuid('organisation_id').notNull() });
/** An attribution column: the membership that acted, nulled (alone) when that membership is deleted. */
const member = (organisationId: AnyPgColumn, column: AnyPgColumn) =>
	foreignKey({ columns: [organisationId, column], foreignColumns: [memberships.organisationId, memberships.userId] });

export const conversations = pgTable('conversations', {
	id: uuid('id').primaryKey(), organisationId: tenant(),
	title: text('title').notNull(), createFingerprint: bytea('create_fingerprint').notNull(),
	createdBy: uuid('created_by'),
	lastSeq: integer('last_seq').notNull().default(0), lastChange: integer('last_change').notNull().default(0),
	lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
	revision: integer('revision').notNull().default(1), createdAt: at('created_at'),
}, (t) => [unique('conversations_organisation_id_id_key').on(t.organisationId, t.id),
	member(t.organisationId, t.createdBy), // on delete set null (created_by)
	index('conversations_by_activity').on(t.organisationId, sql`${t.lastMessageAt} desc nulls last`, t.id),
	check('conversations_title_check', sql`${t.title} = btrim(${t.title}) and char_length(${t.title}) between 1 and 80`),
	check('conversations_fingerprint_check', sql`octet_length(${t.createFingerprint}) = 32`),
	check('conversations_counters_check', sql`${t.lastSeq} >= 0 and ${t.lastChange} >= ${t.lastSeq} and ${t.revision} > 0`)]);

export const conversationParticipants = pgTable('conversation_participants', {
	organisationId: tenant(), conversationId: uuid('conversation_id').notNull(), userId: uuid('user_id').notNull(),
	state: text('state').notNull().default('active'), addedBy: uuid('added_by'), addedAt: at('added_at'),
	endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.conversationId, t.userId] }),
	foreignKey({ columns: [t.organisationId, t.conversationId], foreignColumns: [conversations.organisationId, conversations.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.userId], foreignColumns: [memberships.organisationId, memberships.userId] }).onDelete('cascade'),
	member(t.organisationId, t.addedBy), // on delete set null (added_by)
	index('conversation_participants_active_by_user').on(t.organisationId, t.userId, t.conversationId).where(sql`${t.state} = 'active'`),
	check('conversation_participants_state_check', sql`${t.state} in ('active', 'left', 'removed')`),
	check('conversation_participants_ended_check', sql`(${t.state} = 'active') = (${t.endedAt} is null)`)]);

export const conversationLinks = pgTable('conversation_links', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), conversationId: uuid('conversation_id').notNull(),
	targetKind: text('target_kind').notNull(), taskId: uuid('task_id'), projectId: uuid('project_id'),
	linkedBy: uuid('linked_by'), createdAt: at('created_at'),
}, (t) => [
	foreignKey({ columns: [t.organisationId, t.conversationId], foreignColumns: [conversations.organisationId, conversations.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.taskId], foreignColumns: [tasks.organisationId, tasks.id] }).onDelete('cascade'),
	foreignKey({ columns: [t.organisationId, t.projectId], foreignColumns: [projects.organisationId, projects.id] }).onDelete('cascade'),
	member(t.organisationId, t.linkedBy), // on delete set null (linked_by)
	uniqueIndex('conversation_links_target').on(t.conversationId, t.targetKind, sql`coalesce(${t.taskId}, ${t.projectId})`),
	index('conversation_links_by_task').on(t.organisationId, t.taskId).where(sql`${t.taskId} is not null`),
	index('conversation_links_by_project').on(t.organisationId, t.projectId).where(sql`${t.projectId} is not null`),
	check('conversation_links_target_check', sql`(${t.targetKind} = 'task' and ${t.taskId} is not null and ${t.projectId} is null)
		or (${t.targetKind} = 'project' and ${t.projectId} is not null and ${t.taskId} is null)`)]);

export const messages = pgTable('messages', {
	id: uuid('id').primaryKey(), organisationId: tenant(), conversationId: uuid('conversation_id').notNull(),
	seq: integer('seq').notNull(), changeSeq: integer('change_seq').notNull(), authorId: uuid('author_id'),
	body: text('body'), sentBodySha256: bytea('sent_body_sha256'), createdAt: at('created_at'),
	editedAt: timestamp('edited_at', { withTimezone: true }), deletedAt: timestamp('deleted_at', { withTimezone: true }),
	deletedBy: uuid('deleted_by'), revision: integer('revision').notNull().default(1),
}, (t) => [unique('messages_organisation_id_id_key').on(t.organisationId, t.id),
	unique('messages_conversation_seq').on(t.conversationId, t.seq),
	unique('messages_conversation_change').on(t.conversationId, t.changeSeq),
	foreignKey({ columns: [t.organisationId, t.conversationId], foreignColumns: [conversations.organisationId, conversations.id] }).onDelete('cascade'),
	member(t.organisationId, t.authorId), // on delete set null (author_id)
	member(t.organisationId, t.deletedBy), // on delete set null (deleted_by)
	check('messages_counters_check', sql`${t.seq} > 0 and ${t.changeSeq} > 0 and ${t.revision} > 0`),
	check('messages_body_check', sql`${t.body} is null or (char_length(${t.body}) between 1 and 4000 and octet_length(${t.body}) <= 16384)`),
	check('messages_hash_check', sql`${t.sentBodySha256} is null or octet_length(${t.sentBodySha256}) = 32`),
	check('messages_tombstone_check', sql`(${t.deletedAt} is null and ${t.body} is not null and ${t.sentBodySha256} is not null and ${t.deletedBy} is null)
		or (${t.deletedAt} is not null and ${t.body} is null and ${t.sentBodySha256} is null)`)]);

export const chatAuditEvents = pgTable('chat_audit_events', {
	id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: tenant(), conversationId: uuid('conversation_id').notNull(),
	actorId: uuid('actor_id'), action: text('action').notNull(), subjectKind: text('subject_kind').notNull(), subjectId: uuid('subject_id'),
	personal: boolean('personal').notNull().default(false), requestId: text('request_id'),
	detail: jsonb('detail').notNull().default({}), createdAt: at('created_at'),
}, (t) => [
	foreignKey({ columns: [t.organisationId, t.conversationId], foreignColumns: [conversations.organisationId, conversations.id] }).onDelete('cascade'),
	member(t.organisationId, t.actorId), // on delete set null (actor_id)
	index('chat_audit_events_by_conversation').on(t.organisationId, t.conversationId, t.createdAt, t.id),
	check('chat_audit_events_action_check', sql`${t.action} in ('chat.conversation_created', 'chat.conversation_updated',
		'chat.participant_added', 'chat.participant_removed', 'chat.participant_left', 'chat.link_added', 'chat.link_removed',
		'chat.message_sent', 'chat.message_edited', 'chat.message_deleted', 'chat.pin_added', 'chat.pin_removed',
		'chat.star_set', 'chat.star_cleared', 'chat.read_advanced')`),
	check('chat_audit_events_subject_check', sql`${t.subjectKind} in ('conversation', 'participant', 'link', 'message', 'pin', 'star', 'read')`),
	check('chat_audit_events_personal_check', sql`${t.personal} = (${t.action} in ('chat.star_set', 'chat.star_cleared', 'chat.read_advanced'))`),
	check('chat_audit_events_detail_check', sql`jsonb_typeof(${t.detail}) = 'object'`)]);
