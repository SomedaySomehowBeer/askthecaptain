/** R3 §5 wire shapes for history, versions, the reversal preview and its apply, exactly as built in V-C
 *  (apps/api/src/versions/service.ts). Kept client-local: no server module enters this bundle. */
import type { ChangeOperation, JournalRecordKind } from '../contracts.ts';

export type HistoryActor = { kind: 'person' | 'workflow' | 'system'; id: string | null; name: string | null };
export type Later = { id: string; changeSetId: string; actor: HistoryActor; at: string; field: string | null; before: unknown; after: unknown };
export type ReversedBy = { changeId: string; changeSetId: string; actor: HistoryActor; at: string };
/** A change's state (contract §4–§5). `needs` and `blocked` arise only in a preview. Reason codes the client does not know
 *  yet are kept as they are and worded generically. */
export type EntryState =
	| { state: 'reversible' }
	| { state: 'conflict'; later: Later[] }
	| { state: 'needs'; needs: string[] }
	| { state: 'irreversible'; reason: string }
	| { state: 'reversed'; reversedBy: ReversedBy }
	| { state: 'blocked'; reason: string; detail: SlotTaken | Record<string, unknown> | null };
export type SlotTaken = { reservationId: string; title: string; ownerId: string | null; ownerName: string | null; occupiedStartsAt: string; occupiedEndsAt: string };
/** One entry: a change, or a coupled group written together (`field` `time`, `status` or `count`; `before`/`after` objects
 *  of the group's fields, named in `fields`, one per id in `changeIds`). */
export type Entry = {
	id: string; changeIds: string[]; recordKind: JournalRecordKind; recordId: string; operation: ChangeOperation; field: string | null; fields: string[];
	itemKind: 'step' | 'evidence' | 'tag' | null; itemId: string | null; before: unknown; after: unknown; reverses: string[];
} & EntryState;
export type CauseKind = 'request' | 'workflow_run' | 'routine' | 'reversal' | 'baseline';
export type ChangeSet = { id: string; actor: HistoryActor; causeKind: CauseKind; reversesChangeSetId: string | null; createdAt: string; changes: Entry[] };
export type HistoryStart = { kind: 'baseline' | 'created' | 'first_change'; changeSetId: string; at: string; revision: number };
export type Names = { people: Record<string, string | null>; tags: Record<string, string | null> };
export type HistoryPage = {
	record: { kind: JournalRecordKind; id: string; revision: number | null; exists: boolean };
	changeSets: ChangeSet[]; nextCursor: string | null; start: HistoryStart | null; names: Names;
};
export type Version = { recordKind: JournalRecordKind; recordId: string; revision: number; changeSetId: string; createdAt: string; removed: boolean; snapshot: Record<string, unknown> };
export type PreviewEntry = Entry & { now: unknown; proposed: unknown };
export type Basis = { recordKind: JournalRecordKind; recordId: string; revision: number | null };
export type Preview = { changes: PreviewEntry[]; basis: Basis[]; applicable: boolean; names: Names };
export type Applied = { changeSet: ChangeSet; reversed: string[] };
/** `409 stale_preview`: nothing was written; the preview recomputed under the locks and the basis entries that moved. */
export type Stale = { preview: Preview; moved: Basis[] };
