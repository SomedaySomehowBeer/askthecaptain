import type { TransactionSql } from '@captain/db';
import { HttpError, notFound } from '../errors.ts';
import type { Actor } from '../tenant.ts';

/** Tags on threads (threads contract §3, §5): the one place a tag is attached to anything. Other modules (bookings,
 *  series occurrences, the stocktake) attach tags through these helpers, so every attachment to a thread by a person is
 *  audited in the participant-scoped `chat_audit_events` like any other thread write. Every attachment, the system's
 *  too, is also journalled by the database (0047) under the caller's change set, as an item of the thread's record. */

export type RecordKind = 'task' | 'booking' | 'stock';
const column = { task: 'task_id', booking: 'reservation_id', stock: 'stock_item_id' } as const;

/** The record's thread, which its insert trigger made (migration 0046). A step has none. */
export async function recordThread(tx: TransactionSql, organisationId: string, kind: RecordKind, recordId: string, lock = false): Promise<{ id: string; revision: number }> {
 const [thread] = await tx<{ id: string; revision: number }[]>`select id, revision from threads
  where organisation_id = ${organisationId} and ${tx(column[kind])} = ${recordId} ${lock ? tx`for update` : tx``}`;
 if (!thread) throw notFound();
 return thread;
}

/** The named tags, held against a concurrent rename or archive. Every one must exist in this organisation. */
export async function requireTags(tx: TransactionSql, tagIds: string[], allowArchived = false): Promise<void> {
 const ids = [...new Set(tagIds.map(id => id.toLowerCase()))];
 if (!ids.length) return;
 const found = await tx<{ id: string; archivedAt: Date | null }[]>`select id, archived_at from tags where id in ${tx(ids)} order by id for share`;
 if (found.length !== ids.length) throw notFound('That tag is not available.');
 if (!allowArchived && found.some(tag => tag.archivedAt)) throw new HttpError(409, 'tag_archived', 'That tag is archived. Restore it before adding it.');
}

function audit(tx: TransactionSql, organisationId: string, actor: Actor, threadId: string, action: 'chat.tag_added' | 'chat.tag_removed', tagId: string, revision: number) {
 return tx`insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, request_id, detail)
  values (${organisationId}, ${threadId}, ${actor.userId}, ${action}, 'tag', ${tagId}, ${actor.requestId}, ${tx.json({ threadId, tagId, revision })})`;
}

/** Makes the thread carry exactly `tagIds` (`replace`) or adds them (`add`). The caller holds the thread lock and has
 *  checked the tags. A change moves the thread's revision once (`bump`), unless the thread is being created in this
 *  transaction; each tag added or removed is one chat-audit row. Returns whether anything changed. */
export async function writeThreadTags(tx: TransactionSql, organisationId: string, actor: Actor, threadId: string, tagIds: string[],
 options: { mode: 'replace' | 'add' | 'remove'; bump: boolean }): Promise<boolean> {
 const wanted = [...new Set(tagIds.map(id => id.toLowerCase()))].sort();
 const current = new Set((await tx<{ tagId: string }[]>`select tag_id from thread_tags where thread_id = ${threadId}`).map(row => row.tagId));
 const added = options.mode === 'remove' ? [] : wanted.filter(id => !current.has(id));
 const removed = options.mode === 'remove' ? wanted.filter(id => current.has(id)) : options.mode === 'replace' ? [...current].filter(id => !wanted.includes(id)).sort() : [];
 if (!added.length && !removed.length) return false;
 let revision = (await tx<{ revision: number }[]>`select revision from threads where id = ${threadId}`)[0]!.revision;
 if (options.bump) revision = (await tx<{ revision: number }[]>`update threads set revision = revision + 1 where id = ${threadId} returning revision`)[0]!.revision;
 for (const tagId of added) {
  await tx`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) values (${organisationId}, ${threadId}, ${tagId}, ${actor.userId})`;
  await audit(tx, organisationId, actor, threadId, 'chat.tag_added', tagId, revision);
 }
 for (const tagId of removed) {
  await tx`delete from thread_tags where thread_id = ${threadId} and tag_id = ${tagId}`;
  await audit(tx, organisationId, actor, threadId, 'chat.tag_removed', tagId, revision);
 }
 return true;
}

/** A new series occurrence receives its series' tags on its own thread, in the task's transaction (contract §3). With
 *  a person acting, each is audited as their thread write; the system routine has no person to record in the
 *  participant-scoped audit, and its routine change set is the record of the attachment. */
export async function attachSeriesTags(tx: TransactionSql, organisationId: string, actor: Actor | null, taskId: string, seriesId: string): Promise<string[]> {
 const tags = (await tx<{ tagId: string }[]>`select tag_id from task_series_tags where organisation_id = ${organisationId} and series_id = ${seriesId} order by tag_id`).map(row => row.tagId);
 if (!tags.length) return [];
 const thread = await recordThread(tx, organisationId, 'task', taskId);
 if (actor) await writeThreadTags(tx, organisationId, actor, thread.id, tags, { mode: 'add', bump: false });
 else await tx`insert into thread_tags (organisation_id, thread_id, tag_id) select ${organisationId}, ${thread.id}, unnest(${tags}::uuid[])`;
 return tags;
}

/** The tags each record's thread carries, by record id, in name order. */
export async function tagsOfRecords(tx: TransactionSql, kind: RecordKind, recordIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
 const byRecord = new Map<string, { id: string; name: string }[]>();
 if (!recordIds.length) return byRecord;
 const rows = await tx<{ recordId: string; id: string; name: string }[]>`select th.${tx(column[kind])} as record_id, tag.id, tag.name
  from threads th join thread_tags tt on tt.thread_id = th.id join tags tag on tag.organisation_id = tt.organisation_id and tag.id = tt.tag_id
  where th.${tx(column[kind])} in ${tx(recordIds)} order by lower(tag.name), tag.id`;
 for (const row of rows) byRecord.set(row.recordId, [...(byRecord.get(row.recordId) ?? []), { id: row.id, name: row.name }]);
 return byRecord;
}
