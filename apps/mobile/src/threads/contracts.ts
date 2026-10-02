/** R2 §5–7 wire contract. Kept client-local; no server module enters this bundle. */
export const filters = ['all', 'needs_you', 'tasks', 'bookings', 'stock', 'records', 'files', 'people'] as const;
export type Filter = typeof filters[number];
export type Kind = 'record' | 'topic' | 'private';
export type RecordKind = 'task' | 'booking' | 'stock';
export type Tag = { id: string; name: string };
export type Row = { id: string; kind: Kind; title: string; record: { kind: RecordKind; id: string } | null; facts: [string, string]; status: string | null; lastMessageAt: string | null; lastMessage: { authorName: string | null; excerpt: string } | null; unread: number; needsYou: boolean; starred: boolean; tags: Tag[] };
export type Group = { key: string; label: string; threads: number; needsYou: number; owner?: { id: string; name: string | null } | null; startsOn?: string | null; endsOn?: string | null };
export type ThreadList = { filter: Filter; available: boolean; threads: Row[]; nextCursor: string | null; groups: Group[] };
/** R3 §3: a change line's change set. `changes` are that change set's changes to this thread's record, as journalled (field
 *  names in camelCase); the client words them in code (wording.ts). */
export type ActorKind = 'person' | 'workflow' | 'system';
export type CauseKind = 'request' | 'workflow_run' | 'routine' | 'reversal' | 'baseline';
export type JournalRecordKind = 'task' | 'reservation' | 'stock_item' | 'series' | 'equipment' | 'tag' | 'thread';
export type ChangeOperation = 'create' | 'update' | 'remove' | 'attach' | 'detach';
export type LineChange = { id: string; recordKind: JournalRecordKind; recordId: string; operation: ChangeOperation; field: string | null; itemKind: 'step' | 'evidence' | 'tag' | null; itemId: string | null; before: unknown; after: unknown };
export type ChangeLine = { actorKind: ActorKind; actorId: string | null; actorName: string | null; causeKind: CauseKind; createdAt: string; changes: LineChange[]; truncated: boolean };
/** A plain message, or (R3) a change line: `kind: 'change'`, no body, never edited, deleted or pinned. */
export type Message = { id: string; threadId: string; kind: 'message' | 'change'; seq: number; changeSeq: number; authorId: string | null; authorName: string | null; body: string | null; createdAt: string; editedAt: string | null; deletedAt: string | null; deletedBy: string | null; revision: number; changeSetId?: string; change?: ChangeLine };
export type Pin = { id: string; messageId: string; pinnedBy: string | null; pinnedAt: string };
export type ChangedPin = Pin & { threadId: string; changeSeq: number; unpinnedAt: string | null; unpinnedBy: string | null };
export type Card = { record: { kind: RecordKind; id: string } | null; title: string; status: string | null; facts: [string, string]; fold: Record<string, unknown> };
export type Detail = { thread: { id: string; kind: Kind; title: string; revision: number; lastSeq: number; lastChange: number; readPosition: number; unread: number; starred: boolean; createdAt: string }; card: Card; tags: Tag[]; participants?: { userId: string; name: string; addedAt: string }[]; pin: Pin | null };
export type MessagePage = { thread: { id: string; revision: number; lastSeq: number; lastChange: number }; messages: Message[]; hasMore: boolean };
export type Change = { changeSeq: number; kind: 'message'; message: Message } | { changeSeq: number; kind: 'pin'; pin: ChangedPin };
export type Changes = { thread: { id: string; revision: number; lastSeq: number; highWater: number }; changes: Change[]; next: number; complete: boolean };
