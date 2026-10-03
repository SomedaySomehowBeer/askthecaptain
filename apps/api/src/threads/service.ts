import { createHash } from 'node:crypto';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { changeSetId, personChangeSet } from '../changes.ts';
import { HttpError, badRequest, forbidden, notFound } from '../errors.ts';
import { canManage, roleOf, type Actor } from '../tenant.ts';
import { lockMemberships, type LockedMembership, type MembershipLock } from './locks.ts';
import { requireTags, writeThreadTags, type RecordKind } from './tags.ts';

/** Threads (R2 contract `docs/plans/threads-2026-09.md`, D25, D27, D28): one thread per task, booking and stock item,
 *  topics started by their first message, and private threads between named members. Replaces linked chat (0042/0043);
 *  every rule the contract keeps "as before" is the linked-chat contract's (§4–§9, §13) and is carried over here.
 *
 *  Row security and migration 0046's transition guards are the authority for every read and write; this service repeats
 *  the checks only to answer with useful errors, follows the global lock order (memberships, then the thread, then its
 *  rows), and audits identities and counters in `chat_audit_events`, never in the tenant-wide `audit_events`. */

export const participantLimit = 50;
/** Unread counts stop here: the API returns at most 51 and a client shows "50+" (linked-chat §13). */
export const unreadCap = 51;
export const excerptLength = 120;
export const groupLimit = 100;
export const titleLength = 80;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_646);
const queryRevision = z.coerce.number().int().min(1).max(2_147_483_646);
const counter = z.coerce.number().int().min(0).max(2_147_483_647);
const upTo = (max: number) => z.coerce.number().int().min(1).max(max);
const title = z.string().trim().min(1).max(titleLength);
const firstMessage = z.object({ id: uuid, body: z.string() }).strict();

/** Topic creation is one request with its first message (§5); a private thread names its people, the message optional. */
export const createThread = z.discriminatedUnion('kind', [
 z.object({ id: uuid, kind: z.literal('topic'), message: firstMessage }).strict(),
 z.object({ id: uuid, kind: z.literal('private'), title,
  // A bound on the request size only. The cap is on people, counted after removing duplicates and the caller.
  participantIds: z.array(uuid).max(participantLimit * 2).default([]), message: firstMessage.optional() }).strict(),
]);
export const renameThread = z.object({ expectedRevision: revision, title }).strict();
export const addParticipants = z.object({ expectedRevision: revision, userIds: z.array(uuid).min(1).max(20) }).strict();
export const revisionBody = z.object({ expectedRevision: revision }).strict();
export const revisionQuery = z.object({ expectedRevision: queryRevision }).strict();
/** A tag write is journalled (0047), so it also takes an optional change set id (versions contract §5). */
export const tagBody = z.object({ expectedRevision: revision, changeSetId: changeSetId.optional() }).strict();
export const tagQuery = z.object({ expectedRevision: queryRevision, changeSetId: changeSetId.optional() }).strict();
/** Topic to task (versions contract §0 decision 4, §6): the topic's thread becomes the new task's thread. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
 && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'A real calendar date.');
export const makeTask = z.object({ expectedRevision: revision, ownerId: uuid.nullable().optional(), due: day.nullable().optional(), changeSetId: changeSetId.optional() }).strict();
export const sendMessage = z.object({ id: uuid, body: z.string() }).strict();
export const filters = ['all', 'needs_you', 'tasks', 'bookings', 'stock', 'records', 'files', 'people'] as const;
export type Filter = typeof filters[number];
/** Files and People are listed and disabled until R7 (§2): accepted, with an empty page and `available: false`. */
const unavailableFilters = new Set<Filter>(['files', 'people']);
export const listQuery = z.object({ filter: z.enum(filters).default('all'), after: z.string().min(1).max(300).optional(), limit: upTo(50).default(50) }).strict();
export const messagesQuery = z.object({ latest: upTo(100).optional(), after: counter.optional(), before: counter.optional(), limit: upTo(100).optional() }).strict()
 .refine(q => [q.latest, q.after, q.before].filter(v => v !== undefined).length === 1, 'Supply exactly one of latest, after or before.')
 .refine(q => q.latest === undefined || q.limit === undefined, 'latest is its own limit.');
export const changesQuery = z.object({ after: counter.default(0), limit: upTo(100).default(100) }).strict();
export const editMessage = z.object({ expectedRevision: revision, body: z.string() }).strict();
export const pinMessage = z.object({ messageId: uuid }).strict();
export const readPosition = z.object({ seq: z.number().int().min(0).max(2_147_483_647) }).strict();

export type ThreadKind = 'record' | 'topic' | 'private';
export type RecordRef = { kind: RecordKind; id: string };
export type TagChip = { id: string; name: string };
/** A message as the API returns it. A tombstone keeps its identity and order with `body: null`. `authorName` is null
 *  only when the author attribution was deleted ("Former member").
 *
 *  A change line (`kind: 'change'`, versions contract §3) has no body; its author is the change set's actor (null for
 *  the system), and it carries `changeSetId` and `change`: who acted and why, and that change set's changes to this
 *  thread's record, which a client words in code. A plain message carries neither field. */
export type Message = { id: string; threadId: string; kind: 'message' | 'change' | 'approval'; seq: number; changeSeq: number; authorId: string | null; authorName: string | null;
 body: string | null; createdAt: Date; editedAt: Date | null; deletedAt: Date | null; deletedBy: string | null; revision: number;
 changeSetId?: string; change?: ChangeLine };
/** One change of a change line, with field names and full-row keys in the API's camelCase. */
export type LineChange = { id: string; recordKind: string; recordId: string; operation: 'create' | 'update' | 'remove' | 'attach' | 'detach'; field: string | null;
 itemKind: 'step' | 'evidence' | 'tag' | null; itemId: string | null; before: unknown; after: unknown };
export type ChangeLine = { actorKind: 'person' | 'workflow' | 'system'; actorId: string | null; actorName: string | null; causeKind: string; createdAt: Date;
 changes: LineChange[]; truncated: boolean };
/** A change line lists at most this many of its changes (a large cascade says `truncated`; History has them all). */
export const changeLineLimit = 50;
/** A pin references its message and never copies the text. `unpinnedAt` is null while it is live. */
export type Pin = { id: string; threadId: string; messageId: string; changeSeq: number; pinnedBy: string | null; pinnedAt: Date; unpinnedBy: string | null; unpinnedAt: Date | null };
export type Change = { changeSeq: number; kind: 'message'; message: Message } | { changeSeq: number; kind: 'pin'; pin: Pin };
export type Participant = { userId: string; name: string; addedAt: Date };
/** A list row (§6). `facts` are the card's two facts (§6 card table); `lastMessage` is the latest live message. */
export type ThreadRow = { id: string; kind: ThreadKind; title: string; record: RecordRef | null; facts: [string, string]; status: string | null;
 lastMessageAt: Date | null; lastMessage: { authorName: string | null; excerpt: string } | null; unread: number; needsYou: boolean; starred: boolean;
 tags: TagChip[] };
export type Group = { key: string; label: string; threads: number; needsYou: number; owner: { id: string; name: string | null } | null; startsOn: string | null; endsOn: string | null };
export type ThreadList = { filter: Filter; available: boolean; threads: ThreadRow[]; nextCursor: string | null; groups: Group[] };
/** The card on top of a thread (§6): small, computed by code from the record row, with the rest behind a fold-out. */
export type Card = { record: RecordRef | null; title: string; status: string | null; facts: [string, string]; fold: Record<string, unknown> };
export type ThreadDetail = {
 thread: { id: string; kind: ThreadKind; title: string; revision: number; lastSeq: number; lastChange: number; readPosition: number; unread: number; starred: boolean; createdAt: Date };
 card: Card; tags: TagChip[]; participants?: Participant[]; pin: { id: string; messageId: string; pinnedBy: string | null; pinnedAt: Date } | null;
};
type MessageRow = Omit<Message, 'changeSetId' | 'change'> & { sentBodySha256?: Buffer | null; changeSetId: string | null };
type Locked = { id: string; kind: ThreadKind; title: string | null; revision: number; lastSeq: number; lastChange: number };

const conflict = (code: string, message: string) => new HttpError(409, code, message);
// One body for every identity conflict: nothing about another person's or tenant's row, not even whether it exists.
const threadIdUnavailable = () => conflict('thread_id_unavailable', 'That thread id cannot be used. Nothing was created; start a new thread to keep these details.');
const messageIdUnavailable = () => conflict('message_id_unavailable', 'That message id cannot be used. Nothing was sent; send it as a new message.');
const staleThread = () => conflict('stale_revision', 'This thread changed since you opened it. Reload it and try again.');
const staleMessage = () => conflict('stale_revision', 'This message changed since you opened it. Reload it and try again.');
const participantUnavailable = () => badRequest('participant_unavailable', 'Everyone added must be an active member of this organisation. Nobody was added.');
const invalidBody = () => badRequest('invalid_body', 'A message is 1 to 4,000 characters of plain text.');
const pinExists = () => conflict('pin_exists', 'This thread already has a pinned message. Unpin it first.');
const deletedMessage = () => conflict('message_deleted', 'That message was deleted, so it cannot be pinned.');
const notPrivate = () => badRequest('thread_not_private', 'Only a private thread has a list of people.');
const notTopic = () => badRequest('thread_not_topic', 'Only a topic becomes a task. A private thread stays private.');
const alreadyRecord = () => conflict('thread_is_record', 'This thread already belongs to a record.');
const changeLineFixed = () => conflict('change_line_immutable', 'A change line records what changed. It cannot be edited, deleted or pinned.');

/** Unique violations map to a 409 only by exact constraint name (linked-chat §9.4); anything else stays an error. */
const messageIdConstraints = new Set(['thread_messages_pkey', 'thread_messages_organisation_id_id_key']);
const threadIdConstraints = new Set(['threads_pkey', 'threads_organisation_id_id_key']);
function uniqueConstraint(error: unknown): string | null {
 return error instanceof Error && 'code' in error && error.code === '23505' && 'constraint_name' in error && typeof error.constraint_name === 'string' ? error.constraint_name : null;
}
/** An unexpected database failure in a thread, reduced to its SQLSTATE. A Postgres error can carry private thread content
 *  in its detail, query, parameters or cause, and the app's error handler logs what it is given, so nothing of the
 *  original is kept. It still answers 500; the request id is logged by the handler. */
export class ThreadDatabaseError extends Error {
 readonly sqlState: string;
 constructor(sqlState: string) {
  super(`thread database operation failed (SQLSTATE ${sqlState})`);
  this.name = 'ThreadDatabaseError';
  this.sqlState = sqlState;
 }
}
const sqlState = /^[0-9A-Z]{5}$/;
function redacted(error: unknown): unknown {
 if (error instanceof HttpError) return error;
 if (error instanceof Error && 'code' in error && typeof error.code === 'string' && sqlState.test(error.code)) return new ThreadDatabaseError(error.code);
 return error;
}
class MessageIdTaken extends Error {}

/** Message reads join the author's name. `users` is a platform table outside row security, so a person who left keeps
 *  their name; only a deleted attribution (null `author_id`) has none. */
const messageColumns = 'm.id, m.thread_id, m.kind, m.seq, m.change_seq, m.author_id, u.name as author_name, m.body, m.created_at, m.edited_at, m.deleted_at, m.deleted_by, m.revision, m.change_set_id';
const messageSource = 'thread_messages m left join users u on u.id = m.author_id';
const pinColumns = 'id, thread_id, message_id, change_seq, pinned_by, pinned_at, unpinned_by, unpinned_at';

/** Trimmed at the ends, 1–4,000 code points and at most 16 KB of UTF-8 (linked-chat §5). */
export function normaliseBody(raw: string): string {
 const body = raw.trim();
 const points = [...body].length;
 if (points < 1 || points > 4000 || Buffer.byteLength(body, 'utf8') > 16_384) throw invalidBody();
 return body;
}
/** A topic's title (§5): the first line of its normalised first message, trimmed, at most 80 characters. */
export function topicTitle(body: string): string {
 const line = normaliseBody(body).split(/\r?\n/, 1)[0]!.trim();
 return [...line].slice(0, titleLength).join('').trim();
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
/** The immutable create identity (§5): sha256 of `{ title, participantIds sorted, firstMessageId }`. */
export function createFingerprint(input: { title: string; participantIds: string[]; firstMessageId: string | null }): Buffer {
 return sha256(JSON.stringify({ title: input.title, participantIds: [...input.participantIds].sort(), firstMessageId: input.firstMessageId }));
}
function publicMessage(row: MessageRow, lines: Map<string, ChangeLine> = new Map()): Message {
 const message: Message = { id: row.id, threadId: row.threadId, kind: row.kind, seq: row.seq, changeSeq: row.changeSeq, authorId: row.authorId, authorName: row.authorName, body: row.body,
  createdAt: row.createdAt, editedAt: row.editedAt, deletedAt: row.deletedAt, deletedBy: row.deletedBy, revision: row.revision };
 if (row.kind === 'change' && row.changeSetId) {
  message.changeSetId = row.changeSetId;
  message.change = lines.get(row.changeSetId) ?? { actorKind: 'system', actorId: null, actorName: null, causeKind: 'request', createdAt: row.createdAt, changes: [], truncated: false };
 }
 return message;
}
const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** The change lines' change sets and their changes to this thread's record, read as the caller (row security applies:
 *  a line is in a thread the caller can see, and its changes are that thread's record's). */
async function changeLines(tx: TransactionSql, threadId: string, rows: MessageRow[]): Promise<Map<string, ChangeLine>> {
 const ids = [...new Set(rows.filter(row => row.kind === 'change' && row.changeSetId).map(row => row.changeSetId!))];
 const lines = new Map<string, ChangeLine>();
 if (!ids.length) return lines;
 const [thread] = await tx<{ kind: ThreadKind; taskId: string | null; reservationId: string | null; stockItemId: string | null }[]>`select kind, task_id, reservation_id, stock_item_id
  from threads where id = ${threadId}`;
 if (!thread) return lines;
 const record = thread.taskId ? ['task', thread.taskId] : thread.reservationId ? ['reservation', thread.reservationId]
  : thread.stockItemId ? ['stock_item', thread.stockItemId] : ['thread', threadId];
 const sets = await tx<{ id: string; actorKind: ChangeLine['actorKind']; actorId: string | null; actorName: string | null; causeKind: string; createdAt: Date }[]>`select c.id, c.actor_kind,
   c.actor_id, u.name as actor_name, c.cause_kind, c.created_at from change_sets c left join users u on u.id = c.actor_id where c.id in ${tx(ids)}`;
 const changes = await tx<(LineChange & { changeSetId: string; n: number })[]>`select * from (select id, change_set_id, record_kind, record_id, operation, field, item_kind, item_id,
   before, after, row_number() over (partition by change_set_id order by id) as n from record_changes
   where change_set_id in ${tx(ids)} and record_kind = ${record[0]!} and record_id = ${record[1]!}) c where n <= ${changeLineLimit + 1} order by change_set_id, id`;
 for (const set of sets) {
  const mine = changes.filter(change => change.changeSetId === set.id);
  lines.set(set.id, { actorKind: set.actorKind, actorId: set.actorId, actorName: set.actorName, causeKind: set.causeKind, createdAt: set.createdAt,
   changes: mine.slice(0, changeLineLimit).map(({ changeSetId: _, n: __, field, ...change }) => ({ ...change, field: field === null ? null : camel(field) })),
   truncated: mine.length > changeLineLimit });
 }
 return lines;
}

/** The list cursor's activity key, exactly as the list query writes it: UTC, microseconds, one fixed shape. Anything
 *  else, including an impossible calendar date, is refused here so Postgres never sees an unparseable timestamp. */
const activityKey = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
export function validActivityKey(value: string): boolean {
 const parts = activityKey.exec(value);
 if (!parts) return false;
 const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
 const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
 return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}
/** An opaque cursor over `(last_message_at desc nulls last, id desc)`, bound to its filter: `[activityKey | null, id,
 *  filter]`. A thread with no message yet has a null key and sorts after every thread with one. */
export function encodeCursor(activity: string | null, id: string, filter: Filter): string {
 return Buffer.from(JSON.stringify([activity, id, filter])).toString('base64url');
}
export function decodeCursor(cursor: string, filter: Filter): [string | null, string] {
 let value: unknown;
 try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { value = null; }
 if (Array.isArray(value) && value.length === 3 && (value[0] === null || (typeof value[0] === 'string' && validActivityKey(value[0])))) {
  const id = uuid.safeParse(value[1]);
  if (id.success) {
   if (value[2] === filter) return [value[0], id.data];
   throw badRequest('invalid_request', 'That page cursor belongs to a different filter. Start the filter again from its first page.');
  }
 }
 throw badRequest('invalid_request', 'That page cursor cannot be read.');
}

/** The caller's unread count for the thread `t` after `position` (contract §6, amended 3 October 2026), at most
 *  `unreadCap`: each live ordinary message by someone else is 1, and each run of consecutive change lines that holds at
 *  least one line by someone else is 1. Any ordinary message, a deleted one included, ends a run; the read position
 *  starts one. The caller's own lines count 0, and so does a quiet line: the system's creation of the thread's record
 *  (its change set's actor is the system, it creates the record, and its other changes to the record are only what was
 *  created or attached with it, such as a series occurrence's tags). One windowed scan over the thread's unread rows. */
function unreadOf(tx: TransactionSql, me: string, position: ReturnType<TransactionSql>) {
 const recordKind = tx`case when t.task_id is not null then 'task' when t.reservation_id is not null then 'reservation'
  when t.stock_item_id is not null then 'stock_item' else 'thread' end`;
 const recordId = tx`coalesce(t.task_id, t.reservation_id, t.stock_item_id, t.id)`;
 const quiet = tx`(um.author_id is null and exists (select 1 from change_sets qc where qc.id = um.change_set_id and qc.actor_kind = 'system')
   and exists (select 1 from record_changes qr where qr.change_set_id = um.change_set_id and qr.record_kind = ${recordKind} and qr.record_id = ${recordId}
    and qr.operation = 'create' and qr.item_kind is null)
   and not exists (select 1 from record_changes qr where qr.change_set_id = um.change_set_id and qr.record_kind = ${recordKind} and qr.record_id = ${recordId}
    and qr.operation not in ('create', 'attach')))`;
 return tx`(select count(*)::int from (select 1 from (
   select w.kind, w.counts, row_number() over (partition by w.kind, w.run, w.counts order by w.seq) as k from (
    select um.kind, um.seq, count(*) filter (where um.kind <> 'change') over (order by um.seq) as run,
     (um.author_id is distinct from ${me}::uuid and case when um.kind = 'change' then not ${quiet} else um.deleted_at is null end) as counts
    from thread_messages um where um.thread_id = t.id and um.seq > ${position}) w) x
  where x.counts and (x.kind <> 'change' or x.k = 1) limit ${unreadCap}) counted)`;
}

/** Every visible thread with what a list row, a card and the needs-you rule read (contract §6), for the caller `me`.
 *  Row security on `threads` decides visibility; the record joins read through each record's own policy. The read
 *  position of a private thread is `max(read_start_seq, last_read_seq or 0)` as before; of a record or topic thread with
 *  no read row it is 0, so a thread the person has never opened is wholly unread. Unread counts stop at `unreadCap`. */
function visible(tx: TransactionSql, organisationId: string, me: string) {
 return tx`select t.id, t.kind, t.last_message_at, t.created_at, t.created_by, t.revision, t.last_seq, t.last_change,
   case when t.task_id is not null then 'task' when t.reservation_id is not null then 'booking' when t.stock_item_id is not null then 'stock' end as record_kind,
   coalesce(t.task_id, t.reservation_id, t.stock_item_id) as record_id,
   coalesce(t.title, tk.title, er.title, si.name) as title,
   case when tk.id is not null then tk.status
    when er.id is not null then (case when er.status = 'cancelled' then 'cancelled' when er.kind = 'maintenance' then 'maintenance' else er.status end)
    when si.id is not null then (case when si.current_count is null then 'not_counted' else 'counted' end) end as status,
   case when tk.id is not null then array[coalesce(ou.name, 'No owner'), coalesce(tk.due::text, 'No due date')]
    when er.id is not null then array[e.name, to_char(er.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')]
    when si.id is not null then array[case when si.current_count is null then 'Not counted' else si.current_count::text || ' ' || si.unit_label end,
     coalesce(to_char(si.counted_at at time zone o.timezone, 'YYYY-MM-DD'), 'Never counted')]
    when t.kind = 'private' then array[coalesce(cu.name, 'Former member'),
     (select count(*) from thread_participants pp where pp.thread_id = t.id and pp.state = 'active')::text || ' people']
    else array[coalesce(cu.name, 'Former member'), ''] end as facts,
   pos.read_position,
   ${unreadOf(tx, me, tx`pos.read_position`)} as unread,
   coalesce((tk.id is not null and tk.owner_id = ${me}::uuid and tk.status not in ('done', 'cancelled'))
    or (er.id is not null and er.owner_id = ${me}::uuid and er.status = 'confirmed' and er.ends_at > now()), false) as owns_open,
   exists (select 1 from thread_stars s where s.thread_id = t.id and s.user_id = ${me}::uuid) as starred
  from threads t
  join organisations o on o.id = t.organisation_id
  left join thread_participants p on t.kind = 'private' and p.thread_id = t.id and p.user_id = ${me}::uuid and p.state = 'active'
  left join thread_reads r on r.thread_id = t.id and r.user_id = ${me}::uuid
  left join tasks tk on tk.organisation_id = t.organisation_id and tk.id = t.task_id
  left join users ou on ou.id = tk.owner_id
  left join equipment_reservations er on er.organisation_id = t.organisation_id and er.id = t.reservation_id
  left join equipment e on e.organisation_id = er.organisation_id and e.id = er.equipment_id
  left join stock_items si on si.organisation_id = t.organisation_id and si.id = t.stock_item_id
  left join users cu on cu.id = t.created_by
  cross join lateral (select case when t.kind = 'private' then greatest(p.read_start_seq, coalesce(r.last_read_seq, 0))
   else coalesce(r.last_read_seq, 0) end as read_position) pos
  where t.organisation_id = ${organisationId}`;
}
type Visible = { id: string; kind: ThreadKind; lastMessageAt: Date | null; createdAt: Date; createdBy: string | null; revision: number; lastSeq: number; lastChange: number;
 recordKind: RecordKind | null; recordId: string | null; title: string; status: string | null; facts: [string, string]; readPosition: number; unread: number;
 ownsOpen: boolean; starred: boolean };

/** The filter's threads, each with `needs_you` (§6): unread messages, or an open task or booking the caller owns. */
function filtered(tx: TransactionSql, organisationId: string, me: string, filter: Filter) {
 const where = filter === 'needs_you' ? tx`where v.unread > 0 or v.owns_open`
  : filter === 'tasks' ? tx`where v.record_kind = 'task'`
   : filter === 'bookings' ? tx`where v.record_kind = 'booking'`
    : filter === 'stock' ? tx`where v.record_kind = 'stock'`
     : filter === 'records' ? tx`where v.kind = 'record'`
      : tx``;
 return tx`select v.*, (v.unread > 0 or v.owns_open) as needs_you from (${visible(tx, organisationId, me)}) v ${where}`;
}

export class ThreadsService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }

 /** A write in one tenant transaction. Strangers get the same 404 as everywhere else before anything is locked. */
 private async write<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  try { return await withTenant(this.#db, { organisationId, userId: actor.userId }, work); }
  catch (error) {
   const name = uniqueConstraint(error);
   if (name === 'thread_pins_live') throw pinExists();
   if (name && threadIdConstraints.has(name)) throw threadIdUnavailable();
   if (name && messageIdConstraints.has(name)) throw messageIdUnavailable();
   throw redacted(error);
  }
 }

 /** One read-only snapshot (linked-chat §8): every row and counter it returns is from the same moment. */
 private async snapshot<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  try {
   return await (this.#db.begin('isolation level repeatable read read only', async tx => {
    await tx`select set_config('app.organisation_id', ${organisationId}, true)`;
    await tx`select set_config('app.user_id', ${actor.userId}, true)`;
    return work(tx);
   }) as Promise<T>);
  } catch (error) { throw redacted(error); }
 }

 /** Step 1 of the lock order: memberships, sorted, final modes. The caller must be an active member. */
 private async lockPeople(tx: TransactionSql, organisationId: string, actor: Actor, others: Map<string, MembershipLock> = new Map()): Promise<{ me: LockedMembership; people: Map<string, LockedMembership> }> {
  const locks = new Map<string, MembershipLock>([[actor.userId, 'share'], ...others]);
  const people = await lockMemberships(tx, organisationId, locks);
  const me = people.get(actor.userId.toLowerCase());
  if (!me || me.status !== 'active') throw notFound();
  return { me, people };
 }

 /** Step 2: the thread row. Row security shows it only to someone who may see it, so anything else is a 404. */
 private async lockThread(tx: TransactionSql, organisationId: string, threadId: string): Promise<Locked> {
  const [row] = await tx<Locked[]>`select id, kind, title, revision, last_seq, last_change from threads
   where organisation_id = ${organisationId} and id = ${threadId} for update`;
  if (!row) throw notFound();
  return row;
 }

 /** One chat-audit row per write. Personal rows (stars, reads) are visible only to their actor. */
 private audit(tx: TransactionSql, organisationId: string, actor: Actor, threadId: string, action: string, subject: { kind: string; id: string }, detail: Record<string, unknown>, personal = false) {
  return tx`insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, personal, request_id, detail)
   values (${organisationId}, ${threadId}, ${actor.userId}, ${action}, ${subject.kind}, ${subject.id}, ${personal}, ${actor.requestId}, ${tx.json(detail as never)})`;
 }

 /** Moves `last_change` by one for a message or pin change (never with `revision`) and returns the new number. */
 private async nextChange(tx: TransactionSql, threadId: string): Promise<number> {
  const [row] = await tx<{ lastChange: number }[]>`update threads set last_change = last_change + 1 where id = ${threadId} returning last_change`;
  if (!row) throw notFound();
  return row.lastChange;
 }

 private async bumpRevision(tx: TransactionSql, threadId: string, rename?: string): Promise<number> {
  const [row] = rename === undefined
   ? await tx<{ revision: number }[]>`update threads set revision = revision + 1 where id = ${threadId} returning revision`
   : await tx<{ revision: number }[]>`update threads set title = ${rename}, revision = revision + 1 where id = ${threadId} returning revision`;
  if (!row) throw notFound();
  return row.revision;
 }

 private async tagsOf(tx: TransactionSql, threadIds: string[]): Promise<Map<string, TagChip[]>> {
  const byThread = new Map<string, TagChip[]>();
  if (!threadIds.length) return byThread;
  const rows = await tx<{ threadId: string; id: string; name: string }[]>`select tt.thread_id, tag.id, tag.name from thread_tags tt
   join tags tag on tag.organisation_id = tt.organisation_id and tag.id = tt.tag_id
   where tt.thread_id in ${tx(threadIds)} order by lower(tag.name), tag.id`;
  for (const row of rows) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), { id: row.id, name: row.name }]);
  return byThread;
 }

 private async detailIn(tx: TransactionSql, organisationId: string, threadId: string, me: string): Promise<ThreadDetail> {
  const [row] = await tx<Visible[]>`select * from (${visible(tx, organisationId, me)}) v where v.id = ${threadId}`;
  if (!row) throw notFound();
  const tags = (await this.tagsOf(tx, [threadId])).get(threadId) ?? [];
  const [pin] = await tx<{ id: string; messageId: string; pinnedBy: string | null; pinnedAt: Date }[]>`select id, message_id, pinned_by, pinned_at from thread_pins
   where organisation_id = ${organisationId} and thread_id = ${threadId} and unpinned_at is null`;
  const detail: ThreadDetail = {
   thread: { id: row.id, kind: row.kind, title: row.title, revision: row.revision, lastSeq: row.lastSeq, lastChange: row.lastChange, readPosition: row.readPosition,
    unread: row.unread, starred: row.starred, createdAt: row.createdAt },
   card: { record: row.recordKind ? { kind: row.recordKind, id: row.recordId! } : null, title: row.title, status: row.status, facts: row.facts,
    fold: await this.fold(tx, organisationId, row) },
   tags, pin: pin ?? null,
  };
  if (row.kind === 'private') detail.participants = await tx<Participant[]>`select p.user_id, u.name, p.added_at from thread_participants p join users u on u.id = p.user_id
   where p.thread_id = ${threadId} and p.state = 'active' order by lower(u.name), p.user_id`;
  return detail;
 }

 /** The card's fold-out (§6): the rest of the record, read-only, and the record's own screen where one exists. */
 private async fold(tx: TransactionSql, organisationId: string, row: Visible): Promise<Record<string, unknown>> {
  if (row.recordKind === 'task') {
   const [task] = await tx`select t.body, t.status, t.owner_id, u.name as owner_name, t.due::text as due, t.evidence_required, t.series_id
    from tasks t left join users u on u.id = t.owner_id where t.organisation_id = ${organisationId} and t.id = ${row.recordId}`;
   return { ...task, open: null };
  }
  if (row.recordKind === 'booking') {
   const [booking] = await tx`select r.equipment_id, e.name as equipment_name, r.kind, r.status, r.starts_at, r.ends_at, r.setup_minutes, r.cleanup_minutes,
     r.task_id, r.owner_id, u.name as owner_name
    from equipment_reservations r join equipment e on e.organisation_id = r.organisation_id and e.id = r.equipment_id left join users u on u.id = r.owner_id
    where r.organisation_id = ${organisationId} and r.id = ${row.recordId}`;
   return { ...booking, open: booking ? { kind: 'equipment', equipmentId: booking.equipmentId } : null };
  }
  if (row.recordKind === 'stock') {
   const [item] = await tx`select s.location, s.unit_label, s.current_count::text as current_count, s.counted_at, s.reorder_point::text as reorder_point, s.notes, s.archived_at
    from stock_items s where s.organisation_id = ${organisationId} and s.id = ${row.recordId}`;
   return { ...item, open: null };
  }
  return { createdBy: row.createdBy, open: null };
 }

 /** The list (§6): one read-only snapshot gives the page, its cursor and the headings over the whole filtered set. */
 list(actor: Actor, organisationId: string, raw: unknown): Promise<ThreadList> {
  const query = listQuery.parse(raw);
  const after = query.after ? decodeCursor(query.after, query.filter) : null;
  const me = actor.userId.toLowerCase();
  return this.snapshot(actor, organisationId, async tx => {
   if (unavailableFilters.has(query.filter)) return { filter: query.filter, available: false, threads: [], nextCursor: null, groups: [] };
   const page = after === null ? tx``
    : after[0] === null ? tx`where f.last_message_at is null and f.id < ${after[1]}::uuid`
     : tx`where f.last_message_at < ${after[0]}::timestamptz or (f.last_message_at = ${after[0]}::timestamptz and f.id < ${after[1]}::uuid) or f.last_message_at is null`;
   const rows = await tx<(Visible & { needsYou: boolean; activityKey: string | null })[]>`select f.*,
     to_char(f.last_message_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as activity_key
    from (${filtered(tx, organisationId, me, query.filter)}) f ${page}
    order by f.last_message_at desc nulls last, f.id desc limit ${query.limit + 1}`;
   const shown = rows.slice(0, query.limit);
   const ids = shown.map(row => row.id);
   const tags = await this.tagsOf(tx, ids);
   const latest = ids.length ? await tx<{ threadId: string; authorName: string | null; excerpt: string }[]>`select distinct on (m.thread_id) m.thread_id, u.name as author_name,
     left(m.body, ${excerptLength}) as excerpt
    from thread_messages m left join users u on u.id = m.author_id
    where m.thread_id in ${tx(ids)} and m.kind = 'message' and m.deleted_at is null order by m.thread_id, m.seq desc` : [];
   const lastMessage = new Map(latest.map(({ threadId, ...message }) => [threadId, message]));
   const groups = await tx<(Omit<Group, 'owner'> & { ownerId: string | null; ownerName: string | null })[]>`with f as (${filtered(tx, organisationId, me, query.filter)})
    select * from (
     select tag.id::text as key, tag.name as label, count(*)::int as threads, (count(*) filter (where f.needs_you))::int as needs_you,
      tag.owner_id, ou.name as owner_name, tag.starts_on::text as starts_on, tag.ends_on::text as ends_on
     from f join thread_tags tt on tt.thread_id = f.id join tags tag on tag.organisation_id = tt.organisation_id and tag.id = tt.tag_id
     left join users ou on ou.id = tag.owner_id
     group by tag.id, tag.name, tag.owner_id, ou.name, tag.starts_on, tag.ends_on
     union all
     select 'none', 'Other', count(*)::int, (count(*) filter (where f.needs_you))::int, null, null, null, null
     from f where not exists (select 1 from thread_tags tt where tt.thread_id = f.id) having count(*) > 0
    ) g order by threads desc, lower(label), key limit ${groupLimit}`;
   const last = shown.at(-1);
   return {
    filter: query.filter, available: true,
    threads: shown.map(row => ({ id: row.id, kind: row.kind, title: row.title, record: row.recordKind ? { kind: row.recordKind, id: row.recordId! } : null,
     facts: row.facts, status: row.status, lastMessageAt: row.lastMessageAt, lastMessage: lastMessage.get(row.id) ?? null, unread: row.unread,
     needsYou: row.needsYou, starred: row.starred, tags: tags.get(row.id) ?? [] })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.activityKey, last.id, query.filter) : null,
    groups: groups.map(({ ownerId, ownerName, ...group }) => ({ ...group, owner: ownerId ? { id: ownerId, name: ownerName } : null })),
   };
  });
 }

 get(actor: Actor, organisationId: string, threadId: string): Promise<ThreadDetail> {
  return this.snapshot(actor, organisationId, tx => this.detailIn(tx, organisationId, threadId, actor.userId.toLowerCase()));
 }

 /** Create through the bootstrap (§5): lock the caller and every named participant first; only a `created` result adds
  *  the others and the first message. A `matched` retry returns the current thread and writes nothing; `unavailable`
  *  is the one generic 409. A topic's first message is part of its creation, at seq 1, in the same transaction. */
 create(actor: Actor, organisationId: string, raw: unknown): Promise<{ thread: ThreadDetail; created: boolean }> {
  const input = createThread.parse(raw);
  const me = actor.userId.toLowerCase();
  const others = input.kind === 'private' ? [...new Set(input.participantIds)].filter(id => id !== me).sort() : [];
  const message = input.message ? { id: input.message.id, body: normaliseBody(input.message.body) } : null;
  const name = input.kind === 'topic' ? topicTitle(message!.body) : input.title;
  const fingerprint = createFingerprint({ title: name, participantIds: others, firstMessageId: message?.id ?? null });
  return this.write(actor, organisationId, async tx => {
   if (others.length + 1 > participantLimit) throw conflict('participant_limit', `A private thread can have up to ${participantLimit} people.`);
   const { people } = await this.lockPeople(tx, organisationId, actor, new Map(others.map(id => [id, 'share' as const])));
   const [bootstrap] = await tx<{ result: string }[]>`select thread_create(${input.id}::uuid, ${input.kind}::text, ${name}::text, ${fingerprint}::bytea) as result`;
   if (bootstrap?.result === 'matched') return { thread: await this.detailIn(tx, organisationId, input.id, me), created: false };
   if (bootstrap?.result !== 'created') throw threadIdUnavailable();
   if (others.some(id => people.get(id)?.status !== 'active')) throw participantUnavailable();
   // Initial participants and the first message belong to the creation itself: no revision bump.
   for (const userId of others) await tx`insert into thread_participants (organisation_id, thread_id, user_id, state, added_by)
    values (${organisationId}, ${input.id}, ${userId}, 'active', ${actor.userId})`;
   if (others.length) await this.audit(tx, organisationId, actor, input.id, 'chat.participant_added', { kind: 'thread', id: input.id }, { threadId: input.id, userIds: others, revision: 1 });
   if (message) {
    const sent = await this.insertMessage(tx, organisationId, actor, input.id, message.id, message.body);
    if (!sent) throw messageIdUnavailable();
   }
   return { thread: await this.detailIn(tx, organisationId, input.id, me), created: true };
  });
 }

 /** Rename a topic or private thread, with `expectedRevision`. A record thread's title is its record's. */
 rename(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<ThreadDetail> {
  const input = renameThread.parse(raw);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   const thread = await this.lockThread(tx, organisationId, threadId);
   if (thread.kind === 'record') throw badRequest('record_title', 'A record thread is titled by its record. Rename the record instead.');
   if (thread.revision !== input.expectedRevision) throw staleThread();
   if (thread.title !== input.title) {
    const next = await this.bumpRevision(tx, threadId, input.title);
    await this.audit(tx, organisationId, actor, threadId, 'chat.thread_updated', { kind: 'thread', id: threadId }, { threadId, revision: next });
   }
   return this.detailIn(tx, organisationId, threadId, actor.userId.toLowerCase());
  });
 }

 /** Adds active members to a private thread, or re-adds people who left or were removed. Everyone named must be
  *  active, or nobody is added. Adding shares the full history. */
 addParticipants(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<ThreadDetail> {
  const input = addParticipants.parse(raw);
  const me = actor.userId.toLowerCase();
  const targets = [...new Set(input.userIds)].filter(id => id !== me).sort();
  return this.write(actor, organisationId, async tx => {
   const { people } = await this.lockPeople(tx, organisationId, actor, new Map(targets.map(id => [id, 'share' as const])));
   const thread = await this.lockThread(tx, organisationId, threadId);
   if (thread.kind !== 'private') throw notPrivate();
   if (thread.revision !== input.expectedRevision) throw staleThread();
   if (targets.some(id => people.get(id)?.status !== 'active')) throw participantUnavailable();
   const existing = targets.length ? await tx<{ userId: string; state: string }[]>`select user_id, state from thread_participants
    where thread_id = ${threadId} and user_id in ${tx(targets)} for update` : [];
   const known = new Map(existing.map(row => [row.userId, row.state]));
   const fresh = targets.filter(id => !known.has(id));
   const returning = targets.filter(id => known.has(id) && known.get(id) !== 'active');
   if (fresh.length + returning.length === 0) return this.detailIn(tx, organisationId, threadId, me);
   const [{ active } = { active: 0 }] = await tx<{ active: number }[]>`select count(*)::int as active from thread_participants where thread_id = ${threadId} and state = 'active'`;
   if (active + fresh.length + returning.length > participantLimit) throw conflict('participant_limit', `A private thread can have up to ${participantLimit} people.`);
   for (const userId of fresh) await tx`insert into thread_participants (organisation_id, thread_id, user_id, state, added_by)
    values (${organisationId}, ${threadId}, ${userId}, 'active', ${actor.userId})`;
   if (returning.length) await tx`update thread_participants set state = 'active', added_by = ${actor.userId}, added_at = now(), ended_at = null
    where thread_id = ${threadId} and user_id in ${tx(returning)}`;
   const next = await this.bumpRevision(tx, threadId);
   await this.audit(tx, organisationId, actor, threadId, 'chat.participant_added', { kind: 'thread', id: threadId }, { threadId, userIds: [...fresh, ...returning].sort(), revision: next });
   return this.detailIn(tx, organisationId, threadId, me);
  });
 }

 /** Leaving (the caller) or removing someone else (an owner or admin who participates). A leave audits and bumps the
  *  revision while the caller is still a participant, then changes their row (linked-chat §9.3). */
 removeParticipant(actor: Actor, organisationId: string, threadId: string, userId: string, raw: unknown): Promise<{ ok: true; revision: number }> {
  const { expectedRevision } = revisionQuery.parse(raw);
  const target = userId.toLowerCase();
  const self = target === actor.userId.toLowerCase();
  return this.write(actor, organisationId, async tx => {
   const { me } = await this.lockPeople(tx, organisationId, actor, self ? new Map() : new Map([[target, 'share' as const]]));
   const thread = await this.lockThread(tx, organisationId, threadId);
   if (thread.kind !== 'private') throw notPrivate();
   if (thread.revision !== expectedRevision) throw staleThread();
   const [row] = await tx<{ state: string }[]>`select state from thread_participants where thread_id = ${threadId} and user_id = ${target} for update`;
   if (!row || row.state !== 'active') throw notFound();
   if (self) {
    const next = thread.revision + 1;
    await this.audit(tx, organisationId, actor, threadId, 'chat.participant_left', { kind: 'participant', id: target }, { threadId, userId: target, revision: next });
    await this.bumpRevision(tx, threadId);
    await tx`update thread_participants set state = 'left', ended_at = now() where thread_id = ${threadId} and user_id = ${target}`;
    return { ok: true as const, revision: next };
   }
   if (!canManage(me.role)) throw forbidden('only an owner or admin in this thread can remove someone else');
   await tx`update thread_participants set state = 'removed', ended_at = now() where thread_id = ${threadId} and user_id = ${target}`;
   const next = await this.bumpRevision(tx, threadId);
   await this.audit(tx, organisationId, actor, threadId, 'chat.participant_removed', { kind: 'participant', id: target }, { threadId, userId: target, revision: next });
   return { ok: true as const, revision: next };
  });
 }

 /** Adds or removes one tag on any thread (§5), with the thread's `expectedRevision`. Any member may tag a record or
  *  topic thread; any participant a private one. Archived tags stay attached but are not newly added. */
 setTag(actor: Actor, organisationId: string, threadId: string, tagId: string, attached: boolean, raw: unknown): Promise<ThreadDetail & { changeSetId: string }> {
  const { expectedRevision, changeSetId: wanted } = (attached ? tagBody : tagQuery).parse(raw);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   // A tag on a thread is journalled as an item of the thread's record (or of the thread itself): 0047.
   const changeSet = await personChangeSet(tx, actor, attached ? 'thread.tag_attach' : 'thread.tag_detach', { threadId, tagId, expectedRevision }, wanted);
   if (changeSet.matched) return { ...await this.detailIn(tx, organisationId, threadId, actor.userId.toLowerCase()), changeSetId: changeSet.id };
   const thread = await this.lockThread(tx, organisationId, threadId);
   if (thread.revision !== expectedRevision) throw staleThread();
   await requireTags(tx, [tagId], !attached);
   await writeThreadTags(tx, organisationId, actor, threadId, [tagId], { mode: attached ? 'add' : 'remove', bump: true });
   return { ...await this.detailIn(tx, organisationId, threadId, actor.userId.toLowerCase()), changeSetId: changeSet.id };
  });
 }

 /** Makes a topic thread a task's thread (contract §6): one new task titled as the thread, with no body; the thread
  *  keeps its id, messages and tags and becomes kind `record`, and no second thread is made. Journalled as the task's
  *  creation under the person's change set (its change line lands in this thread); a retry with the same change set id
  *  answers with the thread as it is now. A private thread, or one that is already a record's, is refused. */
 makeTask(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<ThreadDetail & { changeSetId: string }> {
  const { changeSetId: wanted, ...input } = makeTask.parse(raw);
  const me = actor.userId.toLowerCase();
  const owner = input.ownerId ?? null;
  return this.write(actor, organisationId, async tx => {
   const { people } = await this.lockPeople(tx, organisationId, actor, owner && owner !== me ? new Map([[owner, 'share' as const]]) : new Map());
   const changeSet = await personChangeSet(tx, actor, 'thread.make_task', { threadId, ownerId: owner, due: input.due ?? null, expectedRevision: input.expectedRevision }, wanted);
   if (changeSet.matched) return { ...await this.detailIn(tx, organisationId, threadId, me), changeSetId: changeSet.id };
   const thread = await this.lockThread(tx, organisationId, threadId);
   if (thread.kind === 'private') throw notTopic();
   if (thread.kind === 'record') throw alreadyRecord();
   if (thread.revision !== input.expectedRevision) throw staleThread();
   if (owner && people.get(owner)?.status !== 'active') throw badRequest('owner_invalid', 'The owner must be an active member of the organisation.');
   await tx`select thread_make_task(${threadId}::uuid, ${owner}::uuid, ${input.due ?? null}::date, ${input.expectedRevision}::integer)`;
   return { ...await this.detailIn(tx, organisationId, threadId, me), changeSetId: changeSet.id };
  });
 }

 /** One message with its author's name (and send hash, for reconciling retries), by id in this organisation. */
 private async readMessage(tx: TransactionSql, organisationId: string, id: string, options: { threadId?: string; lock?: boolean } = {}): Promise<MessageRow | undefined> {
  const [row] = await tx<MessageRow[]>`select ${tx.unsafe(messageColumns)}, m.sent_body_sha256 from ${tx.unsafe(messageSource)}
   where m.organisation_id = ${organisationId} and m.id = ${id}
    ${options.threadId === undefined ? tx`` : tx`and m.thread_id = ${options.threadId}`}
    ${options.lock ? tx`for update of m` : tx``}`;
  return row;
 }

 /** Advances the counters and inserts the message; undefined when its id is already held (nothing is inserted). */
 private async insertMessage(tx: TransactionSql, organisationId: string, actor: Actor, threadId: string, id: string, body: string): Promise<MessageRow | undefined> {
  // `now()` is this transaction's start; last_message_at never goes back (0046 guard), so keep the later of the two.
  const [next] = await tx<{ lastSeq: number; lastChange: number }[]>`update threads
   set last_seq = last_seq + 1, last_change = last_change + 1, last_message_at = greatest(last_message_at, now()) where id = ${threadId} returning last_seq, last_change`;
  if (!next) throw notFound();
  const [row] = await tx<{ id: string }[]>`insert into thread_messages (id, organisation_id, thread_id, seq, change_seq, author_id, body, sent_body_sha256)
   values (${id}, ${organisationId}, ${threadId}, ${next.lastSeq}, ${next.lastChange}, ${actor.userId}, ${body}, ${sha256(body)})
   on conflict (id) do nothing returning id`;
  if (!row) return undefined;
  await this.audit(tx, organisationId, actor, threadId, 'chat.message_sent', { kind: 'message', id }, { threadId, messageId: id, seq: next.lastSeq });
  return (await this.readMessage(tx, organisationId, id))!;
 }

 /** Send with the client's id (linked-chat §4, §9.4). An identical retry returns the stored message, even after an
  *  edit; anything else holding the id is the one generic 409. Counters and the insert share a savepoint, so an id
  *  collision rolls the counters back and leaves the transaction usable for the reconciling read. */
 send(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<{ message: Message; created: boolean }> {
  const input = sendMessage.parse(raw);
  const body = normaliseBody(input.body);
  const hash = sha256(body);
  const me = actor.userId.toLowerCase();
  const reconcile = (row: MessageRow | undefined): { message: Message; created: false } | null => {
   if (!row) return null;
   if (row.threadId === threadId && row.authorId === me && !row.deletedAt && row.sentBodySha256 && hash.equals(row.sentBodySha256)) return { message: publicMessage(row), created: false };
   throw messageIdUnavailable();
  };
  const own = (tx: TransactionSql) => this.readMessage(tx, organisationId, input.id);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   await this.lockThread(tx, organisationId, threadId);
   const retried = reconcile(await own(tx));
   if (retried) return retried;
   let sent: MessageRow;
   try {
    sent = await tx.savepoint(async sp => {
     const row = await this.insertMessage(sp, organisationId, actor, threadId, input.id, body);
     if (!row) throw new MessageIdTaken();
     return row;
    });
   } catch (error) {
    const name = uniqueConstraint(error);
    if (!(error instanceof MessageIdTaken) && !(name && messageIdConstraints.has(name))) throw error;
    const again = reconcile(await own(tx));
    if (again) return again;
    throw messageIdUnavailable();
   }
   return { message: publicMessage(sent), created: true };
  });
 }

 /** Tombstone: the author, or an owner or admin. The body and hash go; identity and order stay. A live pin on the
  *  message is unpinned in the same transaction with the next change number, so the unpin always follows the tombstone
  *  in the change feed. One request, one audit row, naming the unpinned pin. */
 deleteMessage(actor: Actor, organisationId: string, threadId: string, messageId: string, raw: unknown): Promise<Message> {
  const { expectedRevision } = revisionQuery.parse(raw);
  const me = actor.userId.toLowerCase();
  return this.write(actor, organisationId, async tx => {
   const { me: membership } = await this.lockPeople(tx, organisationId, actor);
   await this.lockThread(tx, organisationId, threadId);
   const message = await this.readMessage(tx, organisationId, messageId, { threadId, lock: true });
   if (!message || message.deletedAt) throw notFound();
   if (message.kind !== 'message') throw changeLineFixed();
   if (message.revision !== expectedRevision) throw staleMessage();
   if (message.authorId !== me && !canManage(membership.role)) throw forbidden('only the author, or an owner or admin, can delete a message');
   const tombstoned = await this.nextChange(tx, threadId);
   await tx`update thread_messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${actor.userId},
     revision = revision + 1, change_seq = ${tombstoned}
    where id = ${messageId}`;
   const tombstone = await this.readMessage(tx, organisationId, messageId);
   const [pin] = await tx<{ id: string }[]>`select id from thread_pins
    where organisation_id = ${organisationId} and thread_id = ${threadId} and message_id = ${messageId} and unpinned_at is null for update`;
   if (pin) {
    const unpinned = await this.nextChange(tx, threadId);
    await tx`update thread_pins set unpinned_at = now(), unpinned_by = ${actor.userId}, change_seq = ${unpinned} where id = ${pin.id}`;
   }
   await this.audit(tx, organisationId, actor, threadId, 'chat.message_deleted', { kind: 'message', id: messageId },
    { threadId, messageId, seq: tombstone!.seq, revision: tombstone!.revision, ...(pin ? { unpinnedPinId: pin.id } : {}) });
   return publicMessage(tombstone!);
  });
 }

 /** Author-only edit: a new body, `edited_at`, the next revision and change number. The send hash is kept, so a retried
  *  send still returns this (edited) message. The same body at the current revision writes nothing. */
 editMessage(actor: Actor, organisationId: string, threadId: string, messageId: string, raw: unknown): Promise<Message> {
  const input = editMessage.parse(raw);
  const body = normaliseBody(input.body);
  const me = actor.userId.toLowerCase();
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   await this.lockThread(tx, organisationId, threadId);
   const message = await this.readMessage(tx, organisationId, messageId, { threadId, lock: true });
   if (!message || message.deletedAt) throw notFound();
   if (message.kind !== 'message') throw changeLineFixed();
   if (message.authorId !== me) throw forbidden('only the author can edit a message');
   if (message.revision !== input.expectedRevision) throw staleMessage();
   if (message.body === body) return publicMessage(message);
   const changed = await this.nextChange(tx, threadId);
   await tx`update thread_messages set body = ${body}, edited_at = now(), revision = revision + 1, change_seq = ${changed} where id = ${messageId}`;
   const edited = await this.readMessage(tx, organisationId, messageId);
   await this.audit(tx, organisationId, actor, threadId, 'chat.message_edited', { kind: 'message', id: messageId },
    { threadId, messageId, seq: edited!.seq, revision: edited!.revision });
   return publicMessage(edited!);
  });
 }

 /** Sets the thread's one pin (§6): an owner or admin only, in every thread kind; `409 pin_exists` while one is live
  *  (nothing is replaced silently), `409 message_deleted` for a tombstone. Pins have server ids. */
 pin(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<Pin> {
  const { messageId } = pinMessage.parse(raw);
  return this.write(actor, organisationId, async tx => {
   const { me } = await this.lockPeople(tx, organisationId, actor);
   await this.lockThread(tx, organisationId, threadId);
   if (!canManage(me.role)) throw forbidden('only an owner or admin can pin a message');
   const [message] = await tx<{ deletedAt: Date | null; kind: string }[]>`select deleted_at, kind from thread_messages
    where organisation_id = ${organisationId} and id = ${messageId} and thread_id = ${threadId} for share`;
   if (!message) throw notFound();
   if (message.kind !== 'message') throw changeLineFixed();
   if (message.deletedAt) throw deletedMessage();
   const [live] = await tx`select 1 from thread_pins where thread_id = ${threadId} and unpinned_at is null`;
   if (live) throw pinExists();
   const changeSeq = await this.nextChange(tx, threadId);
   const [pin] = await tx<Pin[]>`insert into thread_pins (organisation_id, thread_id, message_id, pinned_by, change_seq)
    values (${organisationId}, ${threadId}, ${messageId}, ${actor.userId}, ${changeSeq}) returning ${tx.unsafe(pinColumns)}`;
   await this.audit(tx, organisationId, actor, threadId, 'chat.pin_added', { kind: 'pin', id: pin!.id }, { threadId, pinId: pin!.id, messageId, changeSeq });
   return pin!;
  });
 }

 /** Clears the thread's live pin: an owner or admin, with a fresh change number. */
 unpin(actor: Actor, organisationId: string, threadId: string): Promise<Pin> {
  return this.write(actor, organisationId, async tx => {
   const { me } = await this.lockPeople(tx, organisationId, actor);
   await this.lockThread(tx, organisationId, threadId);
   if (!canManage(me.role)) throw forbidden('only an owner or admin can unpin a message');
   const [live] = await tx<{ id: string; messageId: string }[]>`select id, message_id from thread_pins
    where organisation_id = ${organisationId} and thread_id = ${threadId} and unpinned_at is null for update`;
   if (!live) throw notFound();
   const changeSeq = await this.nextChange(tx, threadId);
   const [pin] = await tx<Pin[]>`update thread_pins set unpinned_at = now(), unpinned_by = ${actor.userId}, change_seq = ${changeSeq}
    where id = ${live.id} returning ${tx.unsafe(pinColumns)}`;
   await this.audit(tx, organisationId, actor, threadId, 'chat.pin_removed', { kind: 'pin', id: live.id }, { threadId, pinId: live.id, messageId: live.messageId, changeSeq });
   return pin!;
  });
 }

 /** A personal, idempotent star. Only a change writes, and its audit row is personal. */
 setStar(actor: Actor, organisationId: string, threadId: string, starred: boolean): Promise<{ starred: boolean }> {
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   await this.lockThread(tx, organisationId, threadId);
   const changed = starred
    ? await tx`insert into thread_stars (organisation_id, thread_id, user_id) values (${organisationId}, ${threadId}, ${actor.userId})
      on conflict do nothing returning user_id`
    : await tx`delete from thread_stars where thread_id = ${threadId} and user_id = ${actor.userId} returning user_id`;
   if (changed.length) await this.audit(tx, organisationId, actor, threadId, starred ? 'chat.star_set' : 'chat.star_cleared',
    { kind: 'star', id: threadId }, { threadId }, true);
   return { starred };
  });
 }

 /** The caller's read position: stores `max(position, min(seq, last_seq))` only when that moves it forward. The
  *  position is `max(read_start_seq, last_read_seq or 0)` in a private thread and `last_read_seq or 0` elsewhere. */
 markRead(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<{ readPosition: number; unread: number }> {
  const { seq } = readPosition.parse(raw);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   const thread = await this.lockThread(tx, organisationId, threadId);
   const [row] = await tx<{ readStartSeq: number | null; lastReadSeq: number | null }[]>`select p.read_start_seq, r.last_read_seq from threads t
    left join thread_participants p on p.thread_id = t.id and p.user_id = ${actor.userId} and p.state = 'active'
    left join thread_reads r on r.thread_id = t.id and r.user_id = ${actor.userId}
    where t.id = ${threadId}`;
   if (!row || (thread.kind === 'private' && row.readStartSeq === null)) throw notFound();
   const current = Math.max(thread.kind === 'private' ? row.readStartSeq! : 0, row.lastReadSeq ?? 0);
   const target = Math.min(seq, thread.lastSeq);
   let position = current;
   if (target > current) {
    await tx`insert into thread_reads (organisation_id, thread_id, user_id, last_read_seq) values (${organisationId}, ${threadId}, ${actor.userId}, ${target})
     on conflict (thread_id, user_id) do update set last_read_seq = excluded.last_read_seq`;
    await this.audit(tx, organisationId, actor, threadId, 'chat.read_advanced', { kind: 'read', id: threadId }, { threadId, lastReadSeq: target }, true);
    position = target;
   }
   const [{ unread } = { unread: 0 }] = await tx<{ unread: number }[]>`select ${unreadOf(tx, actor.userId, tx`${position}::int`)} as unread
    from threads t where t.id = ${threadId}`;
   return { readPosition: position, unread };
  });
 }

 /** A display page in `seq` order, from one snapshot. */
 messages(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<{ thread: { id: string; revision: number; lastSeq: number; lastChange: number }; messages: Message[]; hasMore: boolean }> {
  const query = messagesQuery.parse(raw);
  return this.snapshot(actor, organisationId, async tx => {
   const [thread] = await tx<{ id: string; revision: number; lastSeq: number; lastChange: number }[]>`select id, revision, last_seq, last_change
    from threads where organisation_id = ${organisationId} and id = ${threadId}`;
   if (!thread) throw notFound();
   const columns = tx.unsafe(messageColumns), source = tx.unsafe(messageSource);
   let rows: MessageRow[], hasMore: boolean;
   if (query.latest !== undefined) {
    const found = await tx<MessageRow[]>`select ${columns} from ${source} where m.thread_id = ${threadId} order by m.seq desc limit ${query.latest + 1}`;
    hasMore = found.length > query.latest; rows = found.slice(0, query.latest).reverse();
   } else if (query.after !== undefined) {
    const limit = query.limit ?? 50;
    const found = await tx<MessageRow[]>`select ${columns} from ${source} where m.thread_id = ${threadId} and m.seq > ${query.after} order by m.seq limit ${limit + 1}`;
    hasMore = found.length > limit; rows = found.slice(0, limit);
   } else {
    const limit = query.limit ?? 50;
    const found = await tx<MessageRow[]>`select ${columns} from ${source} where m.thread_id = ${threadId} and m.seq < ${query.before!} order by m.seq desc limit ${limit + 1}`;
    hasMore = found.length > limit; rows = found.slice(0, limit).reverse();
   }
   const lines = await changeLines(tx, threadId, rows);
   return { thread, messages: rows.map(row => publicMessage(row, lines)), hasMore };
  });
 }

 /** Changes after a cursor, in `change_seq` order, bounded by the snapshot's high-water mark (linked-chat §8). Messages
  *  and pins share the thread's change numbers, so both are fetched `limit + 1` deep and merged. Each row appears at its
  *  latest change; clients upsert by id. `next` never passes an undelivered change. */
 changes(actor: Actor, organisationId: string, threadId: string, raw: unknown): Promise<{ thread: { id: string; revision: number; lastSeq: number; highWater: number };
  changes: Change[]; next: number; complete: boolean }> {
  const query = changesQuery.parse(raw);
  return this.snapshot(actor, organisationId, async tx => {
   const [thread] = await tx<{ id: string; revision: number; lastSeq: number; lastChange: number }[]>`select id, revision, last_seq, last_change
    from threads where organisation_id = ${organisationId} and id = ${threadId}`;
   if (!thread) throw notFound();
   const messages = await tx<MessageRow[]>`select ${tx.unsafe(messageColumns)} from ${tx.unsafe(messageSource)} where m.thread_id = ${threadId}
    and m.change_seq > ${query.after} and m.change_seq <= ${thread.lastChange} order by m.change_seq limit ${query.limit + 1}`;
   const pins = await tx<Pin[]>`select ${tx.unsafe(pinColumns)} from thread_pins where thread_id = ${threadId}
    and change_seq > ${query.after} and change_seq <= ${thread.lastChange} order by change_seq limit ${query.limit + 1}`;
   const lines = await changeLines(tx, threadId, messages);
   const found: Change[] = [
    ...messages.map(row => ({ changeSeq: row.changeSeq, kind: 'message' as const, message: publicMessage(row, lines) })),
    ...pins.map(pin => ({ changeSeq: pin.changeSeq, kind: 'pin' as const, pin })),
   ].sort((a, b) => a.changeSeq - b.changeSeq).slice(0, query.limit + 1);
   const more = found.length > query.limit;
   const page = found.slice(0, query.limit);
   return {
    thread: { id: thread.id, revision: thread.revision, lastSeq: thread.lastSeq, highWater: thread.lastChange },
    changes: page,
    next: more ? page.at(-1)!.changeSeq : thread.lastChange,
    complete: !more,
   };
  });
 }
}
