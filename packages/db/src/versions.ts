import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { withTenant, type TenantContext } from './context.ts';

/** The change journal (R3, docs/plans/versions-and-undo-2026-10.md §2; migration 0047). The database writes the journal:
 *  every write to a journalled table needs this transaction's change set, opened here, and its triggers record the
 *  typed changes, one version per record and the record thread's change line at commit. Services open the change set;
 *  they never write the journal themselves. */

/** The journalled tables and the fields an update compares, exactly as `journal_fields()` in 0047 (a test keeps them
 *  equal). Everything else is bookkeeping or fixed when the row is made. */
export const journalFields = {
	tasks: ['title', 'body', 'status', 'owner_id', 'due', 'evidence_required', 'completed_by', 'completed_at', 'series_id', 'period_start', 'period_end'],
	task_series: ['title', 'body', 'owner_id', 'evidence_required', 'recurrence', 'every_months', 'anchor', 'due_offset_days', 'paused_at'],
	evidence: ['kind', 'reference', 'label'],
	equipment: ['name', 'archived_at'],
	equipment_reservations: ['equipment_id', 'title', 'kind', 'status', 'starts_at', 'ends_at', 'setup_minutes', 'cleanup_minutes', 'task_id', 'owner_id'],
	stock_items: ['name', 'location', 'unit_label', 'current_count', 'counted_at', 'counted_by', 'reorder_point', 'preferred_supplier_id', 'notes', 'archived_at'],
	tags: ['name', 'owner_id', 'starts_on', 'ends_on', 'archived_at'],
	thread_tags: [],
	task_series_tags: [],
} as const satisfies Record<string, readonly string[]>;
export type JournalledTable = keyof typeof journalFields;
export const journalledTables = Object.keys(journalFields) as JournalledTable[];

export type JournalRecordKind = 'task' | 'reservation' | 'stock_item' | 'series' | 'equipment' | 'tag' | 'thread';
export type ChangeOperation = 'create' | 'update' | 'remove' | 'attach' | 'detach';
export type ActorKind = 'person' | 'workflow' | 'system';
/** `routine` is a system routine with no run (the series materialiser); `reversal` is V-C's. */
export type CauseKind = 'request' | 'workflow_run' | 'routine' | 'reversal';
export type RecordChange = { id: string; changeSetId: string; recordKind: JournalRecordKind; recordId: string; operation: ChangeOperation; field: string | null;
	itemKind: 'step' | 'evidence' | 'tag' | null; itemId: string | null; before: unknown; after: unknown; baseRevision: number | null; resultRevision: number;
	reversesChangeId: string | null; createdAt: Date };

export type ChangeSetRequest = {
	/** The client's retry id, or a deterministic id for a workflow step; omitted, the server makes a uuidv7. */
	id?: string | undefined;
	actorKind: ActorKind; causeKind: CauseKind; causeId?: string | null | undefined; requestId?: string | null | undefined;
	/** What the request asked for: a retry with the same id must carry the same fingerprint. */
	fingerprint?: Uint8Array | null | undefined;
};
/** `matched`: this id was already used, by the same actor for the same request, in an earlier transaction. Nothing may
 *  be written; answer from what that change set did. */
export type OpenedChangeSet = { id: string; matched: boolean };

/** The id names a change set this request may not use (another request, person or organisation holds it). */
export class ChangeSetUnavailable extends Error {
	readonly code = 'change_set_id_unavailable';
	constructor() { super('That change set id cannot be used. Nothing was changed; retry with a new id.'); this.name = 'ChangeSetUnavailable'; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opens this transaction's change set for the tenant set on `tx` and sets `app.change_set_id`. One per organisation
 *  per transaction. The actor is the transaction's person (`app.user_id`); the system has none. */
export async function openChangeSet(tx: TransactionSql, request: ChangeSetRequest): Promise<OpenedChangeSet> {
	if (request.id !== undefined && !uuid.test(request.id)) throw new TypeError('a change set id must be a UUID');
	const fingerprint = request.fingerprint ? Buffer.from(request.fingerprint) : null;
	const [row] = await tx<{ changeSetId: string; result: 'created' | 'matched' | 'unavailable' }[]>`select change_set_id, result from change_set_open(
		${request.id?.toLowerCase() ?? null}::uuid, ${request.actorKind}::text, ${request.causeKind}::text, ${request.causeId ?? null}::text,
		${request.requestId ?? null}::text, ${fingerprint}::bytea)`;
	if (!row || row.result === 'unavailable') throw new ChangeSetUnavailable();
	return { id: row.changeSetId, matched: row.result === 'matched' };
}

/** `withTenant` with this transaction's change set opened first. A matched retry still runs `work`, which must answer
 *  from the change set without writing. */
export function withChangeSet<T>(db: Sql, context: TenantContext, request: ChangeSetRequest, work: (tx: TransactionSql, changeSet: OpenedChangeSet) => Promise<T>): Promise<T> {
	return withTenant(db, context, async (tx) => work(tx, await openChangeSet(tx, request)));
}

/** A system write in its own transaction, for routines and test fixtures that have no request: opens a `system`
 *  change set (or, with `userId`, a `person` one) and runs `work`. */
export function journalled<T>(db: Sql, context: TenantContext & { causeKind?: CauseKind; causeId?: string }, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
	const { causeKind, causeId, ...tenant } = context;
	return withChangeSet(db, tenant, { actorKind: tenant.userId ? 'person' : 'system', causeKind: causeKind ?? 'routine', causeId: causeId ?? 'fixture' }, (tx) => work(tx));
}

/** sha256 of a canonical JSON rendering (object keys sorted), for request fingerprints. */
export function fingerprintOf(value: unknown): Buffer {
	return createHash('sha256').update(canonical(value), 'utf8').digest();
}
function canonical(value: unknown): string {
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort()
		.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
	return JSON.stringify(value ?? null);
}

/** A deterministic change set id (UUID version 8) from a stable key, such as a workflow step's idempotency key: the
 *  step's retry finds the change set its first attempt committed. */
export function changeSetIdFor(key: string): string {
	const bytes = createHash('sha256').update(`change-set:${key}`, 'utf8').digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The changes a change set made, as the reader may see them (row security applies), in the order they were made. */
export function changesOf(tx: TransactionSql, changeSetId: string): Promise<RecordChange[]> {
	return tx<RecordChange[]>`select id, change_set_id, record_kind, record_id, operation, field, item_kind, item_id, before, after, base_revision, result_revision,
		reverses_change_id, created_at from record_changes where change_set_id = ${changeSetId} order by id`;
}
