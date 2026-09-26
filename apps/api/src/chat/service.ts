import { createHash } from 'node:crypto';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { HttpError, badRequest, forbidden, notFound } from '../errors.ts';
import { canManage, roleOf, type Actor } from '../tenant.ts';
import { lockMemberships, type LockedMembership, type MembershipLock } from './locks.ts';

/** Linked chat, PR B (adopted contract `docs/plans/linked-chat-2026-09.md`, D25): private conversations of explicitly
 *  named, active members, linked to tasks and projects, holding plain-text messages with client retry identities.
 *
 *  Row security and the migration's transition triggers are the authority for every read and write (contract §9);
 *  this service repeats the checks only to answer with useful errors, follows the global lock order (§6), and audits
 *  identities and counters in the participant-scoped `chat_audit_events` (§10), never in `audit_events`. */

export const participantLimit = 50;
export const linkLimit = 10;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_646);
const queryRevision = z.coerce.number().int().min(1).max(2_147_483_646);
const counter = z.coerce.number().int().min(0).max(2_147_483_647);
const upTo = (max: number) => z.coerce.number().int().min(1).max(max);
const title = z.string().trim().min(1).max(80);
const linkTarget = z.object({ kind: z.enum(['task', 'project']), targetId: uuid }).strict();

export const createConversation = z.object({
 id: uuid, title,
 // A bound on the request size only. The cap is on people, counted after removing duplicates and the caller (create).
 participantIds: z.array(uuid).max(participantLimit * 2).default([]),
 links: z.array(linkTarget).max(linkLimit).default([]),
}).strict();
export const renameConversation = z.object({ expectedRevision: revision, title }).strict();
export const addParticipants = z.object({ expectedRevision: revision, userIds: z.array(uuid).min(1).max(20) }).strict();
export const addLink = z.object({ expectedRevision: revision, kind: z.enum(['task', 'project']), targetId: uuid }).strict();
export const revisionQuery = z.object({ expectedRevision: queryRevision }).strict();
export const sendMessage = z.object({ id: uuid, body: z.string() }).strict();
export const listQuery = z.object({ cursor: z.string().min(1).max(300).optional(), limit: upTo(50).default(50) }).strict();
export const messagesQuery = z.object({ latest: upTo(100).optional(), after: counter.optional(), before: counter.optional(), limit: upTo(100).optional() }).strict()
 .refine(q => [q.latest, q.after, q.before].filter(v => v !== undefined).length === 1, 'Supply exactly one of latest, after or before.')
 .refine(q => q.latest === undefined || q.limit === undefined, 'latest is its own limit.');
export const changesQuery = z.object({ after: counter.default(0), limit: upTo(100).default(100) }).strict();

export type LinkKind = 'task' | 'project';
export type ConversationSummary = { id: string; title: string; revision: number; lastSeq: number; lastChange: number; lastMessageAt: Date | null; createdAt: Date };
export type Participant = { userId: string; name: string; addedAt: Date };
export type Link = { id: string; kind: LinkKind; targetId: string; title: string; state: string; createdAt: Date };
export type ConversationDetail = ConversationSummary & { createdBy: string | null; participants: Participant[]; links: Link[] };
/** A message as the API returns it. A tombstone keeps its identity and order with `body: null`. */
export type Message = { id: string; conversationId: string; seq: number; changeSeq: number; authorId: string | null; body: string | null;
 createdAt: Date; editedAt: Date | null; deletedAt: Date | null; deletedBy: string | null; revision: number };
type MessageRow = Message & { sentBodySha256?: Buffer | null };
type Locked = { id: string; title: string; revision: number; lastSeq: number; lastChange: number };

const conflict = (code: string, message: string) => new HttpError(409, code, message);
// One body for every identity conflict: nothing about another person's or tenant's row, not even whether it exists.
const conversationIdUnavailable = () => conflict('conversation_id_unavailable', 'That conversation id cannot be used. Nothing was created; start a new conversation to keep these details.');
const messageIdUnavailable = () => conflict('message_id_unavailable', 'That message id cannot be used. Nothing was sent; send it as a new message.');
const staleConversation = () => conflict('stale_revision', 'This conversation changed since you opened it. Reload it and try again.');
const staleMessage = () => conflict('stale_revision', 'This message changed since you opened it. Reload it and try again.');
const participantUnavailable = () => badRequest('participant_unavailable', 'Everyone added must be an active member of this organisation. Nobody was added.');
const linkTargetUnavailable = () => badRequest('link_target_unavailable', 'That task or project is not in this organisation.');
const invalidBody = () => badRequest('invalid_body', 'A message is 1 to 4,000 characters of plain text.');

/** Unique violations map to a 409 only by exact constraint name (contract §9.4); anything else stays an error. */
const messageIdConstraints = new Set(['messages_pkey', 'messages_organisation_id_id_key']);
const conversationIdConstraints = new Set(['conversations_pkey', 'conversations_organisation_id_id_key']);
function uniqueConstraint(error: unknown): string | null {
 return error instanceof Error && 'code' in error && error.code === '23505' && 'constraint_name' in error && typeof error.constraint_name === 'string' ? error.constraint_name : null;
}
/** An unexpected database failure in chat, reduced to its SQLSTATE. A Postgres error can carry private chat content in
 *  its detail, query, parameters or cause (a unique violation's detail quotes the conflicting value, a message body
 *  included), and the app's error handler logs what it is given. So nothing of the original is kept: not its message,
 *  detail, constraint, query, parameters or cause. It still answers 500; the request id is logged by the handler. */
export class ChatDatabaseError extends Error {
 readonly sqlState: string;
 constructor(sqlState: string) {
  super(`chat database operation failed (SQLSTATE ${sqlState})`);
  this.name = 'ChatDatabaseError';
  this.sqlState = sqlState;
 }
}
const sqlState = /^[0-9A-Z]{5}$/;
/** Service errors pass through; a database error (anything with a SQLSTATE) becomes a ChatDatabaseError. */
function redacted(error: unknown): unknown {
 if (error instanceof HttpError) return error;
 if (error instanceof Error && 'code' in error && typeof error.code === 'string' && sqlState.test(error.code)) return new ChatDatabaseError(error.code);
 return error;
}
/** Raised inside the send savepoint when `on conflict (id) do nothing` inserted nothing: the id is held by a row this
 *  person cannot see, or by one of their own that the pre-check did not match. */
class MessageIdTaken extends Error {}

const summaryColumns = 'c.id, c.title, c.revision, c.last_seq, c.last_change, c.last_message_at, c.created_at';
const messageColumns = 'id, conversation_id, seq, change_seq, author_id, body, created_at, edited_at, deleted_at, deleted_by, revision';

/** Trimmed at the ends, 1–4,000 code points and at most 16 KB of UTF-8 (contract §5). */
export function normaliseBody(raw: string): string {
 const body = raw.trim();
 const points = [...body].length;
 if (points < 1 || points > 4000 || Buffer.byteLength(body, 'utf8') > 16_384) throw invalidBody();
 return body;
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
const linkKey = (link: { kind: LinkKind; targetId: string }) => `${link.kind}:${link.targetId}`;
/** The immutable create identity: sha256 of the normalised original request (contract §4). */
export function createFingerprint(input: { title: string; participantIds: string[]; links: { kind: LinkKind; targetId: string }[] }): Buffer {
 return sha256(JSON.stringify({ title: input.title, participantIds: [...input.participantIds].sort(), links: input.links.map(linkKey).sort() }));
}
function publicMessage(row: MessageRow): Message {
 return { id: row.id, conversationId: row.conversationId, seq: row.seq, changeSeq: row.changeSeq, authorId: row.authorId, body: row.body,
  createdAt: row.createdAt, editedAt: row.editedAt, deletedAt: row.deletedAt, deletedBy: row.deletedBy, revision: row.revision };
}
/** The list cursor's activity key, exactly as the list query writes it: UTC, microseconds, one fixed shape
 *  (`to_char(… at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`). Anything else, including an impossible calendar
 *  date, is refused here so Postgres never sees an unparseable timestamp. */
const activityKey = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
export function validActivityKey(value: string): boolean {
 const parts = activityKey.exec(value);
 if (!parts) return false;
 const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
 const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
 return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}
export function encodeCursor(activity: string, id: string) { return Buffer.from(JSON.stringify([activity, id])).toString('base64url'); }
export function decodeCursor(cursor: string): [string, string] {
 try {
  const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && validActivityKey(value[0])) {
   const id = uuid.safeParse(value[1]);
   if (id.success) return [value[0], id.data];
  }
 } catch { /* fall through */ }
 throw badRequest('invalid_request', 'That page cursor cannot be read.');
}

export class ChatService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }

 /** A write in one tenant transaction. Strangers get the same 404 as everywhere else before anything is locked. */
 private async write<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  try { return await withTenant(this.#db, { organisationId, userId: actor.userId }, work); }
  catch (error) {
   const name = uniqueConstraint(error);
   if (name === 'conversation_links_target') throw conflict('link_exists', 'That task or project is already linked to this conversation.');
   if (name && conversationIdConstraints.has(name)) throw conversationIdUnavailable();
   if (name && messageIdConstraints.has(name)) throw messageIdUnavailable();
   // Any other constraint, named or not, stays a 500 (contract §9.4), without its content reaching the logs.
   throw redacted(error);
  }
 }

 /** One read-only snapshot for a page or change set (contract §8): every row and counter it returns is from the same
  *  moment. The tenant context is set exactly as `withTenant` does. */
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

 /** Step 2: the conversation row. Row security shows it only to an active participant, so anything else is a 404. */
 private async lockConversation(tx: TransactionSql, organisationId: string, conversationId: string): Promise<Locked> {
  const [row] = await tx<Locked[]>`select id, title, revision, last_seq, last_change from conversations
   where organisation_id = ${organisationId} and id = ${conversationId} for update`;
  if (!row) throw notFound();
  return row;
 }

 private audit(tx: TransactionSql, organisationId: string, actor: Actor, conversationId: string, action: string, subject: { kind: string; id: string }, detail: Record<string, unknown>) {
  return tx`insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, personal, request_id, detail)
   values (${organisationId}, ${conversationId}, ${actor.userId}, ${action}, ${subject.kind}, ${subject.id}, false, ${actor.requestId}, ${tx.json(detail as never)})`;
 }

 private async bumpRevision(tx: TransactionSql, conversationId: string, rename?: string): Promise<number> {
  const [row] = rename === undefined
   ? await tx<{ revision: number }[]>`update conversations set revision = revision + 1 where id = ${conversationId} returning revision`
   : await tx<{ revision: number }[]>`update conversations set title = ${rename}, revision = revision + 1 where id = ${conversationId} returning revision`;
  if (!row) throw notFound();
  return row.revision;
 }

 // Row security already confines these reads to the tenant; the organisation predicate is defence in depth.
 private async requireTarget(tx: TransactionSql, organisationId: string, link: { kind: LinkKind; targetId: string }) {
  const [row] = link.kind === 'task'
   ? await tx`select id from tasks where organisation_id = ${organisationId} and id = ${link.targetId}`
   : await tx`select id from projects where organisation_id = ${organisationId} and id = ${link.targetId}`;
  if (!row) throw linkTargetUnavailable();
 }

 private async detailIn(tx: TransactionSql, organisationId: string, conversationId: string): Promise<ConversationDetail> {
  const [conversation] = await tx<(ConversationSummary & { createdBy: string | null })[]>`select ${tx.unsafe(summaryColumns)}, c.created_by
   from conversations c where c.organisation_id = ${organisationId} and c.id = ${conversationId}`;
  if (!conversation) throw notFound();
  const participants = await tx<Participant[]>`select p.user_id, u.name, p.added_at from conversation_participants p join users u on u.id = p.user_id
   where p.conversation_id = ${conversationId} and p.state = 'active' order by lower(u.name), p.user_id`;
  const links = await tx<Link[]>`select l.id, l.target_kind as kind, coalesce(l.task_id, l.project_id) as target_id,
    coalesce(t.title, p.name) as title,
    coalesce(t.status, case when p.archived_at is not null then 'archived' else p.state end) as state, l.created_at
   from conversation_links l
   left join tasks t on t.organisation_id = l.organisation_id and t.id = l.task_id
   left join projects p on p.organisation_id = l.organisation_id and p.id = l.project_id
   where l.conversation_id = ${conversationId} order by l.created_at, l.id`;
  return { ...conversation, participants, links };
 }

 /** The caller's active conversations, most recent activity first, with a keyset cursor. */
 list(actor: Actor, organisationId: string, raw: unknown): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  const query = listQuery.parse(raw);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  return this.snapshot(actor, organisationId, async tx => {
   const rows = await tx<(ConversationSummary & { activityKey: string })[]>`select ${tx.unsafe(summaryColumns)},
     to_char(coalesce(c.last_message_at, c.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as activity_key
    from conversations c
    where c.organisation_id = ${organisationId}
     and exists (select 1 from conversation_participants p where p.conversation_id = c.id and p.user_id = ${actor.userId} and p.state = 'active')
     ${after ? tx`and (coalesce(c.last_message_at, c.created_at), c.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : tx``}
    order by coalesce(c.last_message_at, c.created_at) desc, c.id desc limit ${query.limit + 1}`;
   const page = rows.slice(0, query.limit);
   const last = page.at(-1);
   return { conversations: page.map(({ activityKey: _, ...summary }) => summary), nextCursor: rows.length > query.limit && last ? encodeCursor(last.activityKey, last.id) : null };
  });
 }

 get(actor: Actor, organisationId: string, conversationId: string): Promise<ConversationDetail> {
  return this.snapshot(actor, organisationId, tx => this.detailIn(tx, organisationId, conversationId));
 }

 /** Create through the bootstrap (contract §6, §9.2): lock the caller and every named participant first; only a
  *  `created` result adds the others and the links. A `matched` retry returns the current conversation and writes
  *  nothing; `unavailable` is the one generic 409. */
 create(actor: Actor, organisationId: string, raw: unknown): Promise<{ conversation: ConversationDetail; created: boolean }> {
  const input = createConversation.parse(raw);
  const me = actor.userId.toLowerCase();
  const others = [...new Set(input.participantIds)].filter(id => id !== me).sort();
  const links = [...new Map(input.links.map(link => [linkKey(link), link])).values()].sort((a, b) => linkKey(a).localeCompare(linkKey(b)));
  const fingerprint = createFingerprint({ title: input.title, participantIds: others, links });
  return this.write(actor, organisationId, async tx => {
   // The cap counts people, not list entries: naming yourself does not use a second place. Checked only once the caller
   // is known to be a member, so a stranger still gets the same 404 as everywhere else.
   if (others.length + 1 > participantLimit) throw conflict('participant_limit', `A conversation can have up to ${participantLimit} people.`);
   const { people } = await this.lockPeople(tx, organisationId, actor, new Map(others.map(id => [id, 'share' as const])));
   const [bootstrap] = await tx<{ result: string }[]>`select chat_create_conversation(${input.id}::uuid, ${input.title}::text, ${fingerprint}::bytea) as result`;
   if (bootstrap?.result === 'matched') return { conversation: await this.detailIn(tx, organisationId, input.id), created: false };
   if (bootstrap?.result !== 'created') throw conversationIdUnavailable();
   if (others.some(id => people.get(id)?.status !== 'active')) throw participantUnavailable();
   for (const link of links) await this.requireTarget(tx, organisationId, link);
   const [{ revision: current } = { revision: 1 }] = await tx<{ revision: number }[]>`select revision from conversations where id = ${input.id}`;
   // Initial participants and links belong to the creation itself: no revision bump (the bootstrap revision stands).
   for (const userId of others) await tx`insert into conversation_participants (organisation_id, conversation_id, user_id, state, added_by)
    values (${organisationId}, ${input.id}, ${userId}, 'active', ${actor.userId})`;
   if (others.length) await this.audit(tx, organisationId, actor, input.id, 'chat.participant_added', { kind: 'conversation', id: input.id }, { conversationId: input.id, userIds: others, revision: current });
   for (const link of links) {
    const [row] = await tx<{ id: string }[]>`insert into conversation_links (organisation_id, conversation_id, target_kind, task_id, project_id, linked_by)
     values (${organisationId}, ${input.id}, ${link.kind}, ${link.kind === 'task' ? link.targetId : null}, ${link.kind === 'project' ? link.targetId : null}, ${actor.userId}) returning id`;
    await this.audit(tx, organisationId, actor, input.id, 'chat.link_added', { kind: 'link', id: row!.id }, { conversationId: input.id, linkId: row!.id, targetKind: link.kind, targetId: link.targetId, revision: current });
   }
   return { conversation: await this.detailIn(tx, organisationId, input.id), created: true };
  });
 }

 rename(actor: Actor, organisationId: string, conversationId: string, raw: unknown): Promise<ConversationDetail> {
  const input = renameConversation.parse(raw);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   const conversation = await this.lockConversation(tx, organisationId, conversationId);
   if (conversation.revision !== input.expectedRevision) throw staleConversation();
   if (conversation.title !== input.title) {
    const next = await this.bumpRevision(tx, conversationId, input.title);
    await this.audit(tx, organisationId, actor, conversationId, 'chat.conversation_updated', { kind: 'conversation', id: conversationId }, { conversationId, revision: next });
   }
   return this.detailIn(tx, organisationId, conversationId);
  });
 }

 /** Adds active members, or re-adds people who left or were removed. Everyone named must be active, or nobody is
  *  added. Adding shares the full history (the web says so before confirming). */
 addParticipants(actor: Actor, organisationId: string, conversationId: string, raw: unknown): Promise<ConversationDetail> {
  const input = addParticipants.parse(raw);
  const me = actor.userId.toLowerCase();
  const targets = [...new Set(input.userIds)].filter(id => id !== me).sort();
  return this.write(actor, organisationId, async tx => {
   const { people } = await this.lockPeople(tx, organisationId, actor, new Map(targets.map(id => [id, 'share' as const])));
   const conversation = await this.lockConversation(tx, organisationId, conversationId);
   if (conversation.revision !== input.expectedRevision) throw staleConversation();
   if (targets.some(id => people.get(id)?.status !== 'active')) throw participantUnavailable();
   const existing = targets.length ? await tx<{ userId: string; state: string }[]>`select user_id, state from conversation_participants
    where conversation_id = ${conversationId} and user_id in ${tx(targets)} for update` : [];
   const known = new Map(existing.map(row => [row.userId, row.state]));
   const fresh = targets.filter(id => !known.has(id));
   const returning = targets.filter(id => known.has(id) && known.get(id) !== 'active');
   if (fresh.length + returning.length === 0) return this.detailIn(tx, organisationId, conversationId);
   const [{ active } = { active: 0 }] = await tx<{ active: number }[]>`select count(*)::int as active from conversation_participants where conversation_id = ${conversationId} and state = 'active'`;
   if (active + fresh.length + returning.length > participantLimit) throw conflict('participant_limit', `A conversation can have up to ${participantLimit} people.`);
   for (const userId of fresh) await tx`insert into conversation_participants (organisation_id, conversation_id, user_id, state, added_by)
    values (${organisationId}, ${conversationId}, ${userId}, 'active', ${actor.userId})`;
   if (returning.length) await tx`update conversation_participants set state = 'active', added_by = ${actor.userId}, added_at = now(), ended_at = null
    where conversation_id = ${conversationId} and user_id in ${tx(returning)}`;
   const next = await this.bumpRevision(tx, conversationId);
   const added = [...fresh, ...returning].sort();
   await this.audit(tx, organisationId, actor, conversationId, 'chat.participant_added', { kind: 'conversation', id: conversationId }, { conversationId, userIds: added, revision: next });
   return this.detailIn(tx, organisationId, conversationId);
  });
 }

 /** Leaving (the caller) or removing someone else (an owner or admin who is a participant). A leave audits and bumps
  *  the revision while the caller is still a participant, then changes their row (contract §9.3). */
 removeParticipant(actor: Actor, organisationId: string, conversationId: string, userId: string, raw: unknown): Promise<{ ok: true; revision: number }> {
  const { expectedRevision } = revisionQuery.parse(raw);
  const target = userId.toLowerCase();
  const self = target === actor.userId.toLowerCase();
  return this.write(actor, organisationId, async tx => {
   const { me } = await this.lockPeople(tx, organisationId, actor, self ? new Map() : new Map([[target, 'share' as const]]));
   const conversation = await this.lockConversation(tx, organisationId, conversationId);
   if (conversation.revision !== expectedRevision) throw staleConversation();
   const [row] = await tx<{ state: string }[]>`select state from conversation_participants where conversation_id = ${conversationId} and user_id = ${target} for update`;
   if (!row || row.state !== 'active') throw notFound();
   if (self) {
    const next = conversation.revision + 1;
    await this.audit(tx, organisationId, actor, conversationId, 'chat.participant_left', { kind: 'participant', id: target }, { conversationId, userId: target, revision: next });
    await this.bumpRevision(tx, conversationId);
    await tx`update conversation_participants set state = 'left', ended_at = now() where conversation_id = ${conversationId} and user_id = ${target}`;
    return { ok: true as const, revision: next };
   }
   if (!canManage(me.role)) throw forbidden('only an owner or admin in this conversation can remove someone else');
   await tx`update conversation_participants set state = 'removed', ended_at = now() where conversation_id = ${conversationId} and user_id = ${target}`;
   const next = await this.bumpRevision(tx, conversationId);
   await this.audit(tx, organisationId, actor, conversationId, 'chat.participant_removed', { kind: 'participant', id: target }, { conversationId, userId: target, revision: next });
   return { ok: true as const, revision: next };
  });
 }

 addLink(actor: Actor, organisationId: string, conversationId: string, raw: unknown): Promise<ConversationDetail> {
  const input = addLink.parse(raw);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   const conversation = await this.lockConversation(tx, organisationId, conversationId);
   if (conversation.revision !== input.expectedRevision) throw staleConversation();
   await this.requireTarget(tx, organisationId, input);
   const column = input.kind === 'task' ? tx`task_id` : tx`project_id`;
   const [existing] = await tx`select id from conversation_links where conversation_id = ${conversationId} and ${column} = ${input.targetId}`;
   if (existing) throw conflict('link_exists', 'That task or project is already linked to this conversation.');
   const [{ links } = { links: 0 }] = await tx<{ links: number }[]>`select count(*)::int as links from conversation_links where conversation_id = ${conversationId}`;
   if (links >= linkLimit) throw conflict('link_limit', `A conversation can link up to ${linkLimit} tasks and projects.`);
   const [row] = await tx<{ id: string }[]>`insert into conversation_links (organisation_id, conversation_id, target_kind, task_id, project_id, linked_by)
    values (${organisationId}, ${conversationId}, ${input.kind}, ${input.kind === 'task' ? input.targetId : null}, ${input.kind === 'project' ? input.targetId : null}, ${actor.userId}) returning id`;
   const next = await this.bumpRevision(tx, conversationId);
   await this.audit(tx, organisationId, actor, conversationId, 'chat.link_added', { kind: 'link', id: row!.id }, { conversationId, linkId: row!.id, targetKind: input.kind, targetId: input.targetId, revision: next });
   return this.detailIn(tx, organisationId, conversationId);
  });
 }

 removeLink(actor: Actor, organisationId: string, conversationId: string, linkId: string, raw: unknown): Promise<ConversationDetail> {
  const { expectedRevision } = revisionQuery.parse(raw);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   const conversation = await this.lockConversation(tx, organisationId, conversationId);
   if (conversation.revision !== expectedRevision) throw staleConversation();
   const [row] = await tx<{ id: string; targetKind: LinkKind; targetId: string }[]>`delete from conversation_links where id = ${linkId} and conversation_id = ${conversationId}
    returning id, target_kind, coalesce(task_id, project_id) as target_id`;
   if (!row) throw notFound();
   const next = await this.bumpRevision(tx, conversationId);
   await this.audit(tx, organisationId, actor, conversationId, 'chat.link_removed', { kind: 'link', id: row.id }, { conversationId, linkId: row.id, targetKind: row.targetKind, targetId: row.targetId, revision: next });
   return this.detailIn(tx, organisationId, conversationId);
  });
 }

 /** Send with the client's id (contract §4, §9.4). An identical retry returns the stored message, even after an edit;
  *  anything else holding the id is the one generic 409. Counters and the insert share a savepoint, so an id collision
  *  rolls the counters back and leaves the transaction usable for the reconciling read. */
 send(actor: Actor, organisationId: string, conversationId: string, raw: unknown): Promise<{ message: Message; created: boolean }> {
  const input = sendMessage.parse(raw);
  const body = normaliseBody(input.body);
  const hash = sha256(body);
  const me = actor.userId.toLowerCase();
  const reconcile = (row: MessageRow | undefined): { message: Message; created: false } | null => {
   if (!row) return null;
   if (row.conversationId === conversationId && row.authorId === me && !row.deletedAt && row.sentBodySha256 && hash.equals(row.sentBodySha256)) return { message: publicMessage(row), created: false };
   throw messageIdUnavailable();
  };
  const own = (tx: TransactionSql) => tx<MessageRow[]>`select ${tx.unsafe(messageColumns)}, sent_body_sha256 from messages where organisation_id = ${organisationId} and id = ${input.id}`.then(rows => rows[0]);
  return this.write(actor, organisationId, async tx => {
   await this.lockPeople(tx, organisationId, actor);
   await this.lockConversation(tx, organisationId, conversationId);
   const retried = reconcile(await own(tx));
   if (retried) return retried;
   let sent: MessageRow;
   try {
    sent = await tx.savepoint(async sp => {
     // `now()` is this transaction's start; a send that waited for the conversation lock may start before the one just
     // committed, and last_message_at never goes back (0042 trigger), so keep the later of the two.
     const [next] = await sp<{ lastSeq: number; lastChange: number }[]>`update conversations
      set last_seq = last_seq + 1, last_change = last_change + 1, last_message_at = greatest(last_message_at, now()) where id = ${conversationId} returning last_seq, last_change`;
     if (!next) throw notFound();
     const [row] = await sp<MessageRow[]>`insert into messages (id, organisation_id, conversation_id, seq, change_seq, author_id, body, sent_body_sha256)
      values (${input.id}, ${organisationId}, ${conversationId}, ${next.lastSeq}, ${next.lastChange}, ${actor.userId}, ${body}, ${hash})
      on conflict (id) do nothing returning ${sp.unsafe(messageColumns)}`;
     if (!row) throw new MessageIdTaken();
     return row;
    });
   } catch (error) {
    const name = uniqueConstraint(error);
    if (!(error instanceof MessageIdTaken) && !(name && messageIdConstraints.has(name))) throw error;
    // Rolled back to the savepoint; the locks are still held, so this read is still under the conversation lock.
    const again = reconcile(await own(tx));
    if (again) return again;
    throw messageIdUnavailable();
   }
   await this.audit(tx, organisationId, actor, conversationId, 'chat.message_sent', { kind: 'message', id: sent.id }, { conversationId, messageId: sent.id, seq: sent.seq });
   return { message: publicMessage(sent), created: true };
  });
 }

 /** Tombstone: the author, or an owner or admin who is a participant. The body and hash go; identity and order stay. */
 deleteMessage(actor: Actor, organisationId: string, conversationId: string, messageId: string, raw: unknown): Promise<Message> {
  const { expectedRevision } = revisionQuery.parse(raw);
  const me = actor.userId.toLowerCase();
  return this.write(actor, organisationId, async tx => {
   const { me: membership } = await this.lockPeople(tx, organisationId, actor);
   await this.lockConversation(tx, organisationId, conversationId);
   const [message] = await tx<MessageRow[]>`select ${tx.unsafe(messageColumns)} from messages where id = ${messageId} and conversation_id = ${conversationId} for update`;
   if (!message || message.deletedAt) throw notFound();
   if (message.revision !== expectedRevision) throw staleMessage();
   if (message.authorId !== me && !canManage(membership.role)) throw forbidden('only the author, or an owner or admin in this conversation, can delete a message');
   const [next] = await tx<{ lastChange: number }[]>`update conversations set last_change = last_change + 1 where id = ${conversationId} returning last_change`;
   const [tombstone] = await tx<MessageRow[]>`update messages set body = null, sent_body_sha256 = null, deleted_at = now(), deleted_by = ${actor.userId},
     revision = revision + 1, change_seq = ${next!.lastChange}
    where id = ${messageId} returning ${tx.unsafe(messageColumns)}`;
   await this.audit(tx, organisationId, actor, conversationId, 'chat.message_deleted', { kind: 'message', id: messageId }, { conversationId, messageId, seq: tombstone!.seq, revision: tombstone!.revision });
   return publicMessage(tombstone!);
  });
 }

 /** A display page in `seq` order, from one snapshot. */
 messages(actor: Actor, organisationId: string, conversationId: string, raw: unknown): Promise<{ conversation: { id: string; revision: number; lastSeq: number; lastChange: number }; messages: Message[]; hasMore: boolean }> {
  const query = messagesQuery.parse(raw);
  return this.snapshot(actor, organisationId, async tx => {
   const [conversation] = await tx<{ id: string; revision: number; lastSeq: number; lastChange: number }[]>`select id, revision, last_seq, last_change
    from conversations where organisation_id = ${organisationId} and id = ${conversationId}`;
   if (!conversation) throw notFound();
   const columns = tx.unsafe(messageColumns);
   let rows: MessageRow[], hasMore: boolean;
   if (query.latest !== undefined) {
    const found = await tx<MessageRow[]>`select ${columns} from messages where conversation_id = ${conversationId} order by seq desc limit ${query.latest + 1}`;
    hasMore = found.length > query.latest; rows = found.slice(0, query.latest).reverse();
   } else if (query.after !== undefined) {
    const limit = query.limit ?? 50;
    const found = await tx<MessageRow[]>`select ${columns} from messages where conversation_id = ${conversationId} and seq > ${query.after} order by seq limit ${limit + 1}`;
    hasMore = found.length > limit; rows = found.slice(0, limit);
   } else {
    const limit = query.limit ?? 50;
    const found = await tx<MessageRow[]>`select ${columns} from messages where conversation_id = ${conversationId} and seq < ${query.before!} order by seq desc limit ${limit + 1}`;
    hasMore = found.length > limit; rows = found.slice(0, limit).reverse();
   }
   return { conversation, messages: rows.map(publicMessage), hasMore };
  });
 }

 /** Changes after a cursor, in `change_seq` order, bounded by the snapshot's high-water mark (contract §8). Each row
  *  appears at its latest change; clients upsert by id. `next` never passes an undelivered change. */
 changes(actor: Actor, organisationId: string, conversationId: string, raw: unknown): Promise<{ conversation: { id: string; revision: number; lastSeq: number; highWater: number };
  changes: { changeSeq: number; kind: 'message'; message: Message }[]; next: number; complete: boolean }> {
  const query = changesQuery.parse(raw);
  return this.snapshot(actor, organisationId, async tx => {
   const [conversation] = await tx<{ id: string; revision: number; lastSeq: number; lastChange: number }[]>`select id, revision, last_seq, last_change
    from conversations where organisation_id = ${organisationId} and id = ${conversationId}`;
   if (!conversation) throw notFound();
   const found = await tx<MessageRow[]>`select ${tx.unsafe(messageColumns)} from messages where conversation_id = ${conversationId}
    and change_seq > ${query.after} and change_seq <= ${conversation.lastChange} order by change_seq limit ${query.limit + 1}`;
   const more = found.length > query.limit;
   const page = found.slice(0, query.limit);
   return {
    conversation: { id: conversation.id, revision: conversation.revision, lastSeq: conversation.lastSeq, highWater: conversation.lastChange },
    changes: page.map(row => ({ changeSeq: row.changeSeq, kind: 'message' as const, message: publicMessage(row) })),
    next: more ? page.at(-1)!.changeSeq : conversation.lastChange,
    complete: !more,
   };
  });
 }

 /** Work to chat (contract §7): only the caller's active conversations linked to this task or project, at most 20,
  *  with no count or hint about anyone else's. An unknown task or project is a 404 like any other. */
 forTarget(actor: Actor, organisationId: string, kind: LinkKind, targetId: string): Promise<{ conversations: ConversationSummary[] }> {
  return this.snapshot(actor, organisationId, async tx => {
   await this.requireTarget(tx, organisationId, { kind, targetId }).catch(error => { if (error instanceof HttpError) throw notFound(); throw error; });
   const column = kind === 'task' ? tx`l.task_id` : tx`l.project_id`;
   const conversations = await tx<ConversationSummary[]>`select ${tx.unsafe(summaryColumns)} from conversations c
    where c.organisation_id = ${organisationId}
     and exists (select 1 from conversation_participants p where p.conversation_id = c.id and p.user_id = ${actor.userId} and p.state = 'active')
     and exists (select 1 from conversation_links l where l.conversation_id = c.id and ${column} = ${targetId})
    order by coalesce(c.last_message_at, c.created_at) desc, c.id desc limit 20`;
   return { conversations };
  });
 }
}
