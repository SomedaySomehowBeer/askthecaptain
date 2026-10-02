import { fingerprintOf, openChangeSet, ChangeSetUnavailable, journalFields, withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { changeSetId, changeSetUnavailable } from '../changes.ts';
import { monthsPerPeriod, nextPeriod, type Recurrence } from '../commitments/series.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';
import { writeThreadTags } from '../threads/tags.ts';
import {
	Journal, camel, entriesOf, entryField, entryFields, recordKinds, shown, slotOf,
	type BlockedReason, type Change, type Entry, type IrreversibleReason, type ItemKind, type Operation, type RecordKind,
} from './model.ts';

/** History and selective reversal (R3 V-C; versions contract §4, §5; amendment §3–§4; D29).
 *
 *  Reads go through row security as the person, in one read-only snapshot, so a record's history is exactly as visible
 *  as the record (a private thread's to its participants alone; anything else is the generic 404). A reversal is an
 *  ordinary journalled write: one transaction, the records locked in a fixed order, the preview recomputed under the
 *  locks, and the inverse writes made with the same domain rules as the ordinary write paths. Its change set has cause
 *  `reversal`, and the database links each of its changes to the change it reverses (migration 0048). */

export const historyLimit = 50;
export const selectionLimit = 50;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_646);
export const recordKind = z.enum(recordKinds as [RecordKind, ...RecordKind[]]);
export const historyQuery = z.object({ before: z.string().min(1).max(300).optional(), limit: z.coerce.number().int().min(1).max(historyLimit).default(20) }).strict();
const changeIds = z.array(uuid).min(1).max(selectionLimit).transform(ids => [...new Set(ids)]);
export const previewInput = z.object({ changeIds }).strict();
const basisEntry = z.object({ recordKind, recordId: uuid, revision: revision.nullable() }).strict();
export const reversalInput = z.object({ id: changeSetId, changeIds, basis: z.array(basisEntry).max(selectionLimit) }).strict();

export type ActorView = { kind: 'person' | 'workflow' | 'system'; id: string | null; name: string | null };
export type LaterView = { id: string; changeSetId: string; actor: ActorView; at: Date; field: string | null; before: unknown; after: unknown };
/** A change's state (contract §5). `needs` and `blocked` arise only in a preview, against a selection and the records now. */
export type StateView =
	| { state: 'reversible' }
	| { state: 'conflict'; later: LaterView[] }
	| { state: 'needs'; needs: string[] }
	| { state: 'irreversible'; reason: IrreversibleReason }
	| { state: 'reversed'; reversedBy: { changeId: string; changeSetId: string; actor: ActorView; at: Date } }
	| { state: 'blocked'; reason: BlockedReason; detail?: Record<string, unknown> };
/** One entry: a change, or a coupled group written together (`field` is then `time`, `status` or `count`, and
 *  `before`/`after` are objects of the group's fields). For an item's create, remove, attach or detach, `field` is null
 *  and `before`/`after` are the item's row. `reverses` names the changes this entry reversed, when it is a reversal. */
export type EntryView = { id: string; changeIds: string[]; recordKind: RecordKind; recordId: string; operation: Operation; field: string | null; fields: string[];
	itemKind: ItemKind | null; itemId: string | null; before: unknown; after: unknown; reverses: string[] } & StateView;
export type ChangeSetView = { id: string; actor: ActorView; causeKind: string; reversesChangeSetId: string | null; createdAt: Date; changes: EntryView[] };
export type HistoryStart = { kind: 'baseline' | 'created' | 'first_change'; changeSetId: string; at: Date; revision: number };
export type Names = { people: Record<string, string | null>; tags: Record<string, string | null> };
export type History = { record: { kind: RecordKind; id: string; revision: number | null; exists: boolean }; changeSets: ChangeSetView[]; nextCursor: string | null;
	start: HistoryStart | null; names: Names };
/** `now` is the value (or item row) today; `proposed` what the reversal writes, or null when it is not decided (a
 *  conflict, a missing companion, an irreversible or already reversed change) or the item would not exist. */
export type PreviewEntry = EntryView & { now: unknown; proposed: unknown };
export type Basis = { recordKind: RecordKind; recordId: string; revision: number | null };
export type Preview = { changes: PreviewEntry[]; basis: Basis[]; applicable: boolean; names: Names };

const tables: Record<Exclude<RecordKind, 'thread'>, keyof typeof journalFields> = {
	task: 'tasks', reservation: 'equipment_reservations', stock_item: 'stock_items', series: 'task_series', equipment: 'equipment', tag: 'tags',
};
/** The fixed lock order (contract §4): memberships, then equipment, bookings, tasks, stock, series, threads, tags. Bookings
 *  lock their equipment first and tasks after (as the booking service does); threads come after their records (as every
 *  thread write does) and before the tags they carry. */
const lockOrder: RecordKind[] = ['equipment', 'reservation', 'task', 'stock_item', 'series', 'thread', 'tag'];
const changeColumns = `r.id, r.change_set_id, r.record_kind, r.record_id, r.operation, r.field, r.item_kind, r.item_id, r.before::text as before_text,
	r.after::text as after_text, r.before as shown_before, r.after as shown_after, r.reverses_change_id, r.created_at`;
type ChangeRow = Omit<Change, 'before' | 'after'> & { beforeText: string | null; afterText: string | null };
const toChange = ({ beforeText, afterText, ...row }: ChangeRow): Change => ({ ...row, before: beforeText === null ? null : JSON.parse(beforeText),
	after: afterText === null ? null : JSON.parse(afterText) });
type SetRow = { id: string; actorKind: ActorView['kind']; actorId: string | null; actorName: string | null; causeKind: string; causeId: string | null; createdAt: Date };
type Raw = Record<string, unknown>;
const recordKey = (kind: string, id: string) => `${kind}:${id}`;
const itemKey = (change: Pick<Change, 'recordKind' | 'recordId' | 'itemKind' | 'itemId'>) => `${recordKey(change.recordKind, change.recordId)}|${change.itemKind}:${change.itemId}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const camelRow = (row: unknown) => row && typeof row === 'object' && !Array.isArray(row)
	? Object.fromEntries(Object.entries(row as Raw).map(([key, value]) => [camel(key), value])) : row;
const conflict = (code: string, message: string) => new HttpError(409, code, message);
const staleCode = 'stale_preview';

/** What the person's records look like now, for the changes in question. Read as the person (row security applies). */
type RecordState = { kind: RecordKind; id: string; row: Raw | null; revision: number | null; threadId: string | null; converted: boolean };
type World = { records: Map<string, RecordState>; items: Map<string, Raw | null>; tags: Map<string, { archivedAt: string | null; name: string } | null> };

/** A reversal's plan for one record: per slot, the value to write and the earliest selected change it reverses. */
type Slot = { value: unknown; reverses: string };
type ItemPlan = { itemKind: ItemKind; itemId: string; exists?: Slot & { present: boolean; row: Raw | null }; fields: Map<string, Slot> };
type RecordPlan = { record: RecordState; fields: Map<string, Slot>; items: Map<string, ItemPlan> };
type Block = { reason: BlockedReason; slots: string[]; detail?: Record<string, unknown> };

export class VersionsService {
	readonly #db: Sql;
	constructor(db: Sql) { this.#db = db; }

	/** One read-only snapshot as the person, timestamps rendered in UTC as the journal writes them. */
	async #read<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
		await roleOf(this.#db, actor.userId, organisationId);
		return this.#db.begin('isolation level repeatable read read only', async tx => {
			await tx`select set_config('app.organisation_id', ${organisationId}, true)`;
			await tx`select set_config('app.user_id', ${actor.userId}, true)`;
			await tx`set local time zone 'UTC'`;
			return work(tx);
		}) as Promise<T>;
	}

	// Reads ------------------------------------------------------------------------------------------------------------

	/** A record's change sets, newest first, each with its changes to this record and their states, and where history
	 *  starts once the last page is reached. A record that is gone keeps its history while its versions are visible. */
	history(actor: Actor, organisationId: string, kind: RecordKind, recordId: string, raw: unknown): Promise<History> {
		const query = historyQuery.parse(raw);
		const cursor = query.before ? decodeCursor(query.before) : null;
		return this.#read(actor, organisationId, async tx => {
			const world = emptyWorld();
			const record = await this.#record(tx, world, kind, recordId);
			if (!record.row && !(await this.#hasVersions(tx, kind, recordId))) throw notFound();
			const page = cursor === null ? tx`` : tx`and (c.created_at < ${cursor[0]}::timestamptz or (c.created_at = ${cursor[0]}::timestamptz and c.id < ${cursor[1]}::uuid))`;
			const sets = await tx<(SetRow & { key: string })[]>`select c.id, c.actor_kind, c.actor_id, u.name as actor_name, c.cause_kind, c.cause_id, c.created_at,
				to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as key
				from change_sets c left join users u on u.id = c.actor_id
				where c.organisation_id = ${organisationId} and exists (select 1 from record_changes r where r.organisation_id = c.organisation_id
					and r.change_set_id = c.id and r.record_kind = ${kind} and r.record_id = ${recordId}) ${page}
				order by c.created_at desc, c.id desc limit ${query.limit + 1}`;
			const shownSets = sets.slice(0, query.limit);
			const ids = shownSets.map(set => set.id);
			const pageChanges = ids.length ? (await tx<ChangeRow[]>`select ${tx.unsafe(changeColumns)} from record_changes r where r.record_kind = ${kind}
				and r.record_id = ${recordId} and r.change_set_id in ${tx(ids)} order by r.id`).map(toChange) : [];
			const journal = await this.#journal(tx, [{ kind, id: recordId, from: pageChanges[0]?.id ?? null }]);
			await this.#loadItems(tx, world, journal.changes);
			const actors = await this.#actors(tx, journal.changes.map(change => change.changeSetId), shownSets);
			const views = shownSets.map(set => this.#setView(set, entriesOf(pageChanges.filter(change => change.changeSetId === set.id)),
				entry => historyState(entry, journal, world, actors)));
			const last = shownSets.at(-1);
			const more = sets.length > query.limit && last;
			return {
				record: { kind, id: recordId, revision: record.revision, exists: record.row !== null },
				changeSets: views, nextCursor: more ? encodeCursor(last.key, last.id) : null,
				start: more ? null : await this.#start(tx, kind, recordId),
				names: await this.#names(tx, world, pageChanges),
			};
		});
	}

	/** The record as it was at a revision: the latest version at that revision (a tag-only change keeps the revision). */
	version(actor: Actor, organisationId: string, kind: RecordKind, recordId: string, revisionValue: number) {
		return this.#read(actor, organisationId, async tx => {
			const [row] = await tx<{ changeSetId: string; revision: number; snapshot: Record<string, unknown>; createdAt: Date }[]>`select v.change_set_id, v.revision,
				v.snapshot, v.created_at from record_versions v where v.record_kind = ${kind} and v.record_id = ${recordId} and v.revision = ${revisionValue}
				order by v.id desc limit 1`;
			if (!row) throw notFound();
			const { removed, ...snapshot } = row.snapshot as { removed?: boolean } & Record<string, unknown>;
			return { recordKind: kind, recordId, revision: row.revision, changeSetId: row.changeSetId, createdAt: row.createdAt, removed: removed === true, snapshot };
		});
	}

	/** Read-only: what reversing these changes would do now (contract §5). */
	preview(actor: Actor, organisationId: string, raw: unknown): Promise<Preview> {
		const input = previewInput.parse(raw);
		return this.#read(actor, organisationId, tx => this.#preview(tx, input.changeIds).then(result => result.preview));
	}

	// The reversal ------------------------------------------------------------------------------------------------------

	/** Applies a preview: all of it as one new change set, or nothing and `409 stale_preview` with the fresh preview. The
	 *  same `id` again returns the same change set. */
	async apply(actor: Actor, organisationId: string, raw: unknown): Promise<{ changeSet: ChangeSetView; reversed: string[] }> {
		const input = reversalInput.parse(raw);
		await roleOf(this.#db, actor.userId, organisationId);
		const fingerprint = fingerprintOf({ operation: 'reversal', changeIds: [...input.changeIds].sort(),
			basis: [...input.basis].map(b => `${b.recordKind}:${b.recordId}:${b.revision}`).sort() });
		let stale: Stale | null = null;
		try {
			await withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
				await tx`set local time zone 'UTC'`;
				const [member] = await tx`select 1 from memberships where organisation_id = ${organisationId} and user_id = ${actor.userId} and status = 'active' for share`;
				if (!member) throw notFound();
				// Visible selected changes only: a change the person cannot see is the same 404 as one that does not exist.
				const selected = await this.#selected(tx, input.changeIds);
				const earliest = selected.reduce((a, b) => (a.id < b.id ? a : b));
				let opened;
				try {
					opened = await openChangeSet(tx, { id: input.id, actorKind: 'person', causeKind: 'reversal', causeId: earliest.changeSetId,
						requestId: actor.requestId.slice(0, 200) || null, fingerprint });
				} catch (error) { if (error instanceof ChangeSetUnavailable) throw changeSetUnavailable(); throw error; }
				if (opened.matched) return;
				await this.#lock(tx, selected);
				const { preview, plans } = await this.#preview(tx, input.changeIds);
				const moved = movedBasis(input.basis, preview.basis);
				// Rolling back takes the change set with it: nothing is written.
				if (!preview.applicable || moved.length) throw new Stale(preview, moved);
				await this.#write(tx, organisationId, actor, plans);
			});
		} catch (error) {
			if (error instanceof Stale) stale = error;
			// A booking slot taken or a name claimed between the check and the write, or a lock cycle with another writer:
			// nothing was written; answer with the preview as it is now.
			else if (error instanceof Error && 'code' in error && ['23P01', '23505', '40P01', '40001'].includes(String(error.code))) {
				const preview = await this.preview(actor, organisationId, { changeIds: input.changeIds });
				stale = new Stale(preview, movedBasis(input.basis, preview.basis));
			} else throw error;
		}
		if (stale) {
			throw new HttpError(409, staleCode, 'Nothing was undone: something changed since this preview. Here it is again.', undefined,
				{ preview: stale.preview, moved: stale.moved });
		}
		// The journal is written at commit, so the new change set is read back in a fresh snapshot.
		const changeSet = await this.#read(actor, organisationId, tx => this.#changeSet(tx, input.id));
		return { changeSet, reversed: [...input.changeIds].sort() };
	}

	// Internals ---------------------------------------------------------------------------------------------------------

	async #selected(tx: TransactionSql, ids: string[]): Promise<Change[]> {
		const rows = (await tx<ChangeRow[]>`select ${tx.unsafe(changeColumns)} from record_changes r where r.id in ${tx(ids)} order by r.id`).map(toChange);
		if (rows.length !== ids.length) throw notFound('Those changes are not available.');
		return rows;
	}

	/** Changes of each record from `from` on (everything later matters to the rules), or all of them. */
	async #journal(tx: TransactionSql, records: { kind: RecordKind; id: string; from: string | null }[]): Promise<Journal> {
		const changes: Change[] = [];
		for (const record of records) {
			const rows = await tx<ChangeRow[]>`select ${tx.unsafe(changeColumns)} from record_changes r where r.record_kind = ${record.kind} and r.record_id = ${record.id}
				${record.from ? tx`and r.id >= ${record.from}::uuid` : tx``} order by r.id`;
			changes.push(...rows.map(toChange));
		}
		return new Journal(changes);
	}

	async #hasVersions(tx: TransactionSql, kind: RecordKind, id: string): Promise<boolean> {
		return (await tx`select 1 from record_versions where record_kind = ${kind} and record_id = ${id} limit 1`).length > 0;
	}

	/** The record now, as the person sees it, with its revision and its thread. */
	async #record(tx: TransactionSql, world: World, kind: RecordKind, id: string): Promise<RecordState> {
		const key = recordKey(kind, id);
		const known = world.records.get(key);
		if (known) return known;
		let state: RecordState;
		if (kind === 'thread') {
			const [row] = await tx<{ row: string; kind: string; revision: number }[]>`select (to_jsonb(t) - 'organisation_id' - 'create_fingerprint')::text as row, t.kind, t.revision
				from threads t where t.id = ${id}`;
			state = { kind, id, row: row ? JSON.parse(row.row) : null, revision: row?.revision ?? null, threadId: row ? id : null, converted: row?.kind === 'record' };
		} else {
			const table = tables[kind];
			const extra = kind === 'stock_item' ? ` || jsonb_build_object('current_count', t.current_count::text, 'reorder_point', t.reorder_point::text)` : '';
			const [row] = await tx.unsafe<{ row: string; revision: number }[]>(`select ((to_jsonb(t) - 'organisation_id')${extra})::text as row, t.revision
				from ${table} t where t.id = $1 ${kind === 'task' ? 'and t.parent_id is null' : ''}`, [id]);
			const column = kind === 'task' ? 'task_id' : kind === 'reservation' ? 'reservation_id' : kind === 'stock_item' ? 'stock_item_id' : null;
			const thread = column && row ? (await tx.unsafe<{ id: string }[]>(`select id from threads where ${column} = $1`, [id]))[0] : undefined;
			state = { kind, id, row: row ? JSON.parse(row.row) : null, revision: row?.revision ?? null, threadId: thread?.id ?? null, converted: false };
		}
		world.records.set(key, state);
		return state;
	}

	/** Every record, item and tag the changes name, as they are now. */
	async #loadItems(tx: TransactionSql, world: World, changes: Change[]): Promise<void> {
		for (const change of changes) await this.#record(tx, world, change.recordKind, change.recordId);
		const steps = new Set<string>(), evidence = new Set<string>(), tags = new Set<string>();
		for (const change of changes) {
			if (change.itemKind === 'step') steps.add(change.itemId!);
			if (change.itemKind === 'evidence') {
				evidence.add(change.itemId!);
				const row = (change.before ?? change.after) as Raw | null;
				if (row && typeof row.task_id === 'string' && row.task_id !== change.recordId) steps.add(row.task_id);
			}
			if (change.itemKind === 'tag') tags.add(change.itemId!);
			if (change.recordKind === 'tag') tags.add(change.recordId);
		}
		if (steps.size) {
			const rows = await tx<{ id: string; parentId: string; row: string }[]>`select id, parent_id, (to_jsonb(t) - 'organisation_id')::text as row from tasks t where id in ${tx([...steps])}`;
			for (const id of steps) {
				const row = rows.find(r => r.id === id);
				world.items.set(`step:${id}`, row ? JSON.parse(row.row) : null);
			}
		}
		if (evidence.size) {
			const rows = await tx<{ id: string; row: string }[]>`select id, (to_jsonb(e) - 'organisation_id')::text as row from evidence e where id in ${tx([...evidence])}`;
			for (const id of evidence) { const row = rows.find(r => r.id === id); world.items.set(`evidence:${id}`, row ? JSON.parse(row.row) : null); }
		}
		if (tags.size) {
			const rows = await tx<{ id: string; name: string; archivedAt: string | null }[]>`select id, name, archived_at::text as archived_at from tags where id in ${tx([...tags])}`;
			for (const id of tags) { const row = rows.find(r => r.id === id); world.tags.set(id, row ? { archivedAt: row.archivedAt, name: row.name } : null); }
		}
		// Tag attachments: on the record's thread, or on a series.
		for (const change of changes) {
			if (change.itemKind !== 'tag' || world.items.has(itemKey(change))) continue;
			const record = world.records.get(recordKey(change.recordKind, change.recordId))!;
			let row: Raw | null = null;
			if (change.recordKind === 'series') {
				const [found] = await tx<{ row: string }[]>`select (to_jsonb(s) - 'organisation_id')::text as row from task_series_tags s where series_id = ${change.recordId} and tag_id = ${change.itemId}`;
				row = found ? JSON.parse(found.row) : null;
			} else if (record.threadId) {
				const [found] = await tx<{ row: string }[]>`select (to_jsonb(t) - 'organisation_id')::text as row from thread_tags t where thread_id = ${record.threadId} and tag_id = ${change.itemId}`;
				row = found ? JSON.parse(found.row) : null;
			}
			world.items.set(itemKey(change), row);
		}
	}

	/** Actors of the change sets named by these changes (the page's sets are already known). */
	async #actors(tx: TransactionSql, ids: string[], known: SetRow[] = []): Promise<Map<string, SetRow>> {
		const sets = new Map(known.map(set => [set.id, set]));
		const missing = [...new Set(ids)].filter(id => !sets.has(id));
		if (missing.length) {
			for (const row of await tx<SetRow[]>`select c.id, c.actor_kind, c.actor_id, u.name as actor_name, c.cause_kind, c.cause_id, c.created_at
				from change_sets c left join users u on u.id = c.actor_id where c.id in ${tx(missing)}`) sets.set(row.id, row);
		}
		return sets;
	}

	#setView(set: SetRow, entries: Entry[], state: (entry: Entry) => StateView): ChangeSetView {
		return { id: set.id, actor: actorView(set), causeKind: set.causeKind, reversesChangeSetId: set.causeKind === 'reversal' ? set.causeId : null,
			createdAt: set.createdAt, changes: entries.map(entry => ({ ...entryView(entry), ...state(entry) })) };
	}

	/** Where the record's history begins: its first version (the 0047 baseline, its creation, or its first change). */
	async #start(tx: TransactionSql, kind: RecordKind, id: string): Promise<HistoryStart | null> {
		const [first] = await tx<{ changeSetId: string; revision: number; causeKind: string; createdAt: Date; created: boolean }[]>`select v.change_set_id, v.revision,
			c.cause_kind, c.created_at, exists (select 1 from record_changes r where r.change_set_id = v.change_set_id and r.record_kind = v.record_kind
				and r.record_id = v.record_id and r.operation = 'create' and r.item_id is null) as created
			from record_versions v join change_sets c on c.id = v.change_set_id where v.record_kind = ${kind} and v.record_id = ${id} order by v.id limit 1`;
		if (!first) return null;
		return { kind: first.causeKind === 'baseline' ? 'baseline' : first.created ? 'created' : 'first_change', changeSetId: first.changeSetId, at: first.createdAt,
			revision: first.revision };
	}

	/** Names of the people and tags these changes mention, for wording them. A deleted tag's name is its last version's. */
	async #names(tx: TransactionSql, world: World, changes: Change[]): Promise<Names> {
		const people = new Set<string>(), tags = new Set<string>();
		const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		for (const change of changes) {
			if (change.itemKind === 'tag') tags.add(change.itemId!);
			if (change.field && ['owner_id', 'completed_by', 'counted_by'].includes(change.field))
				for (const value of [change.before, change.after]) if (typeof value === 'string' && uuidPattern.test(value)) people.add(value);
		}
		const names: Names = { people: {}, tags: {} };
		if (people.size) for (const row of await tx<{ id: string; name: string | null }[]>`select id, name from users where id in ${tx([...people])}`) names.people[row.id] = row.name;
		for (const id of tags) {
			const current = world.tags.get(id);
			if (current) { names.tags[id] = current.name; continue; }
			const [last] = await tx<{ name: string | null }[]>`select snapshot #>> '{row,name}' as name from record_versions where record_kind = 'tag' and record_id = ${id}
				order by id desc limit 1`;
			names.tags[id] = last?.name ?? null;
		}
		return names;
	}

	/** A change set as the person sees it now, across every record it touched. */
	async #changeSet(tx: TransactionSql, id: string): Promise<ChangeSetView> {
		const [set] = await tx<SetRow[]>`select c.id, c.actor_kind, c.actor_id, u.name as actor_name, c.cause_kind, c.cause_id, c.created_at
			from change_sets c left join users u on u.id = c.actor_id where c.id = ${id}`;
		if (!set) throw notFound();
		const changes = (await tx<ChangeRow[]>`select ${tx.unsafe(changeColumns)} from record_changes r where r.change_set_id = ${id} order by r.id`).map(toChange);
		const records = [...new Map(changes.map(change => [recordKey(change.recordKind, change.recordId), { kind: change.recordKind, id: change.recordId,
			from: changes.find(c => c.recordKind === change.recordKind && c.recordId === change.recordId)!.id }])).values()];
		const journal = await this.#journal(tx, records);
		const world = emptyWorld();
		await this.#loadItems(tx, world, journal.changes);
		const actors = await this.#actors(tx, journal.changes.map(change => change.changeSetId), [set]);
		return this.#setView(set, entriesOf(changes), entry => historyState(entry, journal, world, actors));
	}

	/** The preview, and the plans a reversal would write, computed in `tx` (under the locks when applying). */
	async #preview(tx: TransactionSql, ids: string[]): Promise<{ preview: Preview; plans: RecordPlan[] }> {
		const selected = await this.#selected(tx, ids);
		const chosen = new Set(selected.map(change => change.id));
		// The selected changes' own change sets, on the selected records: the entries they belong to.
		const records = [...new Map(selected.map(change => [recordKey(change.recordKind, change.recordId), change])).values()];
		const setChanges: Change[] = [];
		for (const record of records) {
			const sets = [...new Set(selected.filter(c => c.recordKind === record.recordKind && c.recordId === record.recordId).map(c => c.changeSetId))];
			setChanges.push(...(await tx<ChangeRow[]>`select ${tx.unsafe(changeColumns)} from record_changes r where r.record_kind = ${record.recordKind}
				and r.record_id = ${record.recordId} and r.change_set_id in ${tx(sets)} order by r.id`).map(toChange));
		}
		const journal = await this.#journal(tx, records.map(record => ({ kind: record.recordKind, id: record.recordId,
			from: setChanges.filter(c => c.recordKind === record.recordKind && c.recordId === record.recordId).reduce((a, b) => (a.id < b.id ? a : b)).id })));
		const world = emptyWorld();
		await this.#loadItems(tx, world, journal.changes);
		const actors = await this.#actors(tx, journal.changes.map(change => change.changeSetId));
		const entries = entriesOf(setChanges).filter(entry => entry.members.some(member => chosen.has(member.id)));

		// States from history and the selection; the entries still reversible make the plan.
		const states = new Map<string, StateView>();
		for (const entry of entries) {
			const base = historyState(entry, journal, world, actors, chosen);
			const missing = entry.members.filter(member => !chosen.has(member.id)).map(member => member.id);
			states.set(entry.key, base.state === 'reversible' && missing.length ? { state: 'needs', needs: missing } : base);
		}
		const plans = new Map<string, RecordPlan>();
		const contributing = entries.filter(entry => states.get(entry.key)!.state === 'reversible');
		for (const member of contributing.flatMap(entry => entry.members).sort((a, b) => (a.id < b.id ? -1 : 1))) {
			const record = world.records.get(recordKey(member.recordKind, member.recordId))!;
			const plan = plans.get(recordKey(record.kind, record.id)) ?? { record, fields: new Map(), items: new Map() };
			plans.set(recordKey(record.kind, record.id), plan);
			if (!member.itemKind) { if (!plan.fields.has(member.field!)) plan.fields.set(member.field!, { value: member.before, reverses: member.id }); continue; }
			const key = `${member.itemKind}:${member.itemId}`;
			const item = plan.items.get(key) ?? { itemKind: member.itemKind, itemId: member.itemId!, fields: new Map() };
			plan.items.set(key, item);
			if (member.operation === 'update') { if (!item.fields.has(member.field!)) item.fields.set(member.field!, { value: member.before, reverses: member.id }); }
			else if (!item.exists) item.exists = { value: null, reverses: member.id, present: member.operation === 'remove' || member.operation === 'detach', row: member.before as Raw | null };
		}

		// Domain rules against the records now, then "already as it would be".
		const blocks = new Map<string, Block[]>();
		for (const plan of plans.values()) blocks.set(recordKey(plan.record.kind, plan.record.id), await this.#check(tx, world, plan));
		const changes: PreviewEntry[] = entries.map(entry => {
			const first = entry.members[0]!;
			const plan = plans.get(recordKey(first.recordKind, first.recordId));
			let state = states.get(entry.key)!;
			const values = entry.members.map(member => valuesOf(member, world, state.state === 'reversible' ? plan : undefined));
			if (state.state === 'reversible') {
				const slots = entry.members.map(slotOf);
				const block = blocks.get(recordKey(first.recordKind, first.recordId))?.find(b => b.slots.some(slot => slots.includes(slot)));
				if (block) state = { state: 'blocked', reason: block.reason, ...(block.detail ? { detail: block.detail } : {}) };
				else if (values.every(value => same(value.now, value.proposed) && value.presentNow === value.presentAfter))
					state = { state: 'blocked', reason: 'already_current' };
			}
			const group = (key: 'now' | 'proposed') => entry.group
				? Object.fromEntries(entry.members.map((member, i) => [camel(member.field!), values[i]![key]]))
				: (first.field ? values[0]![key] : camelRow(values[0]![key]));
			return { ...entryView(entry), ...state, now: group('now'), proposed: state.state === 'reversible' || state.state === 'blocked' ? group('proposed') : null };
		});
		const basis = [...new Map(records.map(record => [recordKey(record.recordKind, record.recordId), record])).values()].map(record => {
			const state = world.records.get(recordKey(record.recordKind, record.recordId))!;
			return { recordKind: record.recordKind, recordId: record.recordId, revision: state.revision };
		}).sort((a, b) => recordKey(a.recordKind, a.recordId).localeCompare(recordKey(b.recordKind, b.recordId)));
		return { preview: { changes, basis, applicable: changes.every(change => change.state === 'reversible'), names: await this.#names(tx, world, setChanges) },
			plans: [...plans.values()] };
	}

	/** The domain rules the ordinary write paths apply, checked against the record as the plan would leave it. */
	async #check(tx: TransactionSql, world: World, plan: RecordPlan): Promise<Block[]> {
		const blocks: Block[] = [];
		const row = plan.record.row!;
		const final: Raw = { ...row, ...Object.fromEntries([...plan.fields].map(([field, slot]) => [field, slot.value])) };
		const changed = (field: string) => plan.fields.has(field) && !same(plan.fields.get(field)!.value, row[field]);
		const activeMember = async (id: unknown) => typeof id !== 'string'
			|| (await tx`select 1 from memberships where organisation_id = current_organisation_id() and user_id = ${id} and status = 'active'`).length > 0;
		const owner = async (field: string, slot: string, current: Raw) => {
			const value = slot.startsWith('i:') ? plan.items.get(slot.split(':').slice(1, 3).join(':'))?.fields.get(field)?.value : plan.fields.get(field)?.value;
			if (value !== undefined && value !== null && value !== current[field] && !(await activeMember(value))) blocks.push({ reason: 'owner_inactive', slots: [slot] });
		};
		const tagSlots = [...plan.items.values()].filter(item => item.itemKind === 'tag' && item.exists?.present);
		for (const item of tagSlots) {
			if (world.tags.get(item.itemId)?.archivedAt) blocks.push({ reason: 'tag_archived', slots: [`i:tag:${item.itemId}`] });
		}
		if (plan.record.kind === 'task') {
			await owner('owner_id', 'f:owner_id', row);
			for (const item of plan.items.values()) {
				if (item.itemKind === 'step') {
					const current = world.items.get(`step:${item.itemId}`) ?? null;
					if (current && item.fields.has('owner_id')) await owner('owner_id', `i:step:${item.itemId}:f:owner_id`, current);
					if (item.exists && !item.exists.present && current) {
						const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from evidence where task_id = ${item.itemId}`;
						if (n > 0) blocks.push({ reason: 'step_has_evidence', slots: [`i:step:${item.itemId}`] });
					}
				}
				if (item.itemKind === 'evidence' && item.exists?.present && item.exists.row?.kind === 'mail')
					blocks.push({ reason: 'evidence_kind_retired', slots: [`i:evidence:${item.itemId}`] });
			}
			// A done task that needs evidence keeps at least one piece.
			const [{ n: evidenceNow } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from evidence where task_id = ${plan.record.id}`;
			let evidenceAfter = evidenceNow;
			const evidenceSlots: string[] = [];
			for (const item of plan.items.values()) {
				if (item.itemKind !== 'evidence' || !item.exists) continue;
				const onRecord = ((item.exists.row ?? world.items.get(`evidence:${item.itemId}`)) as Raw | null)?.task_id === plan.record.id;
				if (!onRecord) continue;
				const present = world.items.get(`evidence:${item.itemId}`) != null;
				if (present && !item.exists.present) { evidenceAfter -= 1; evidenceSlots.push(`i:evidence:${item.itemId}`); }
				if (!present && item.exists.present) evidenceAfter += 1;
			}
			if (final.status === 'done' && final.evidence_required === true && evidenceAfter === 0 && (changed('status') || evidenceSlots.length))
				blocks.push({ reason: 'evidence_required', slots: [...(changed('status') ? ['f:status'] : []), ...evidenceSlots] });
		}
		if (plan.record.kind === 'reservation') {
			const timeSlots = ['equipment_id', 'starts_at', 'ends_at', 'setup_minutes', 'cleanup_minutes'].filter(field => plan.fields.has(field)).map(field => `f:${field}`);
			const fieldSlots = [...plan.fields.keys()].map(field => `f:${field}`);
			if (final.status === 'cancelled' && fieldSlots.some(slot => slot !== 'f:status'))
				blocks.push({ reason: 'reservation_cancelled', slots: fieldSlots.filter(slot => slot !== 'f:status') });
			const starts = Date.parse(String(final.starts_at)), ends = Date.parse(String(final.ends_at));
			if (!(ends > starts) || ends - starts > 366 * 86_400_000) blocks.push({ reason: 'invalid_time', slots: timeSlots });
			const occupying = final.status === 'confirmed' && (timeSlots.length > 0 || changed('status'));
			if (occupying) {
				const slots = [...timeSlots, ...(changed('status') ? ['f:status'] : [])];
				const [equipment] = await tx<{ archivedAt: Date | null }[]>`select archived_at from equipment where id = ${String(final.equipment_id)}`;
				if (!equipment) blocks.push({ reason: 'equipment_archived', slots });
				else if (equipment.archivedAt) blocks.push({ reason: 'equipment_archived', slots });
				const from = new Date(starts - Number(final.setup_minutes) * 60_000), to = new Date(ends + Number(final.cleanup_minutes) * 60_000);
				const [taken] = await tx<{ id: string; title: string; ownerId: string | null; ownerName: string | null; occupiedStartsAt: Date; occupiedEndsAt: Date }[]>`select r.id,
					r.title, r.owner_id, u.name as owner_name, r.occupied_starts_at, r.occupied_ends_at from equipment_reservations r left join users u on u.id = r.owner_id
					where r.equipment_id = ${String(final.equipment_id)} and r.status = 'confirmed' and r.id <> ${plan.record.id}
						and tstzrange(r.occupied_starts_at, r.occupied_ends_at, '[)') && tstzrange(${from}, ${to}, '[)') order by r.occupied_starts_at, r.id limit 1`;
				if (taken) blocks.push({ reason: 'slot_taken', slots, detail: { reservationId: taken.id, title: taken.title, ownerId: taken.ownerId, ownerName: taken.ownerName,
					occupiedStartsAt: taken.occupiedStartsAt, occupiedEndsAt: taken.occupiedEndsAt } });
			}
			await owner('owner_id', 'f:owner_id', row);
			if (changed('task_id') && final.task_id !== null) {
				const [task] = await tx`select 1 from tasks where id = ${String(final.task_id)} and parent_id is null and status <> 'cancelled'`;
				if (!task) blocks.push({ reason: 'task_unavailable', slots: ['f:task_id'] });
			}
		}
		if (plan.record.kind === 'stock_item') {
			const others = [...plan.fields.keys()].filter(field => field !== 'archived_at').map(field => `f:${field}`);
			if (final.archived_at !== null && others.length) blocks.push({ reason: 'stock_archived', slots: others });
			if (changed('unit_label') && final.current_count !== null) blocks.push({ reason: 'stock_unit_counted', slots: ['f:unit_label'] });
			if (changed('preferred_supplier_id') && final.preferred_supplier_id !== null) {
				const [supplier] = await tx`select 1 from companies where id = ${String(final.preferred_supplier_id)} and archived_at is null`;
				if (!supplier) blocks.push({ reason: 'supplier_unavailable', slots: ['f:preferred_supplier_id'] });
			}
			if (changed('name') || changed('location')) {
				const [taken] = await tx`select 1 from stock_items where location = ${String(final.location)} and name = ${String(final.name)} and id <> ${plan.record.id}`;
				if (taken) blocks.push({ reason: 'name_taken', slots: ['f:name', 'f:location'] });
			}
		}
		if (plan.record.kind === 'series') {
			await owner('owner_id', 'f:owner_id', row);
			const scheduleSlots = ['recurrence', 'every_months', 'anchor', 'due_offset_days'].filter(field => plan.fields.has(field)).map(field => `f:${field}`);
			if (scheduleSlots.length) {
				try {
					const rule = { recurrence: final.recurrence as Recurrence, everyMonths: final.every_months as number | null, anchor: String(final.anchor), dueOffsetDays: Number(final.due_offset_days) };
					monthsPerPeriod(rule); nextPeriod(rule, rule.anchor);
				} catch { blocks.push({ reason: 'recurrence_invalid', slots: scheduleSlots }); }
			}
		}
		if (plan.record.kind === 'equipment') {
			if (changed('name')) {
				const [taken] = await tx`select 1 from equipment where lower(name) = lower(${String(final.name)}) and id <> ${plan.record.id}`;
				if (taken) blocks.push({ reason: 'name_taken', slots: ['f:name'] });
			}
			if (changed('archived_at') && final.archived_at !== null) {
				const [busy] = await tx`select 1 from equipment_reservations where equipment_id = ${plan.record.id} and status = 'confirmed' and occupied_ends_at > now() limit 1`;
				if (busy) blocks.push({ reason: 'equipment_in_use', slots: ['f:archived_at'] });
			}
		}
		if (plan.record.kind === 'tag') {
			await owner('owner_id', 'f:owner_id', row);
			if (final.starts_on && final.ends_on && String(final.ends_on) < String(final.starts_on))
				blocks.push({ reason: 'tag_dates_invalid', slots: ['f:starts_on', 'f:ends_on'].filter(slot => plan.fields.has(slot.slice(2))) });
			if (changed('name')) {
				const [taken] = await tx`select 1 from tags where lower(name) = lower(${String(final.name)}) and id <> ${plan.record.id}`;
				if (taken) blocks.push({ reason: 'name_taken', slots: ['f:name'] });
			}
		}
		return blocks;
	}

	/** Locks every record the selection touches, and the equipment its bookings could occupy, in the fixed order. */
	async #lock(tx: TransactionSql, selected: Change[]): Promise<void> {
		const ids = new Map<RecordKind, Set<string>>(lockOrder.map(kind => [kind, new Set<string>()]));
		for (const change of selected) {
			ids.get(change.recordKind)!.add(change.recordId);
			if (change.recordKind === 'reservation' && change.field === 'equipment_id')
				for (const value of [change.before, change.after]) if (typeof value === 'string') ids.get('equipment')!.add(value);
		}
		const bookings = [...ids.get('reservation')!];
		if (bookings.length)
			for (const row of await tx<{ equipmentId: string }[]>`select equipment_id from equipment_reservations where id in ${tx(bookings)}`) ids.get('equipment')!.add(row.equipmentId);
		const threadOf = { task: 'task_id', reservation: 'reservation_id', stock_item: 'stock_item_id' } as const;
		const threads = new Set<string>(ids.get('thread'));
		for (const kind of ['task', 'reservation', 'stock_item'] as const) {
			const records = [...ids.get(kind)!];
			if (records.length && selected.some(change => change.recordKind === kind && change.itemKind === 'tag'))
				for (const row of await tx.unsafe<{ id: string }[]>(`select id from threads where ${threadOf[kind]} = any($1::uuid[])`, [records])) threads.add(row.id);
		}
		ids.set('thread', threads);
		for (const kind of lockOrder) {
			const sorted = [...ids.get(kind)!].sort();
			if (!sorted.length) continue;
			const table = kind === 'thread' ? 'threads' : tables[kind];
			await tx.unsafe(`select id from ${table} where id = any($1::uuid[]) order by id for update`, [sorted]);
		}
		// Tags being attached again are held against a concurrent archive or delete, as a tag write holds them.
		const attached = [...new Set(selected.filter(change => change.itemKind === 'tag').map(change => change.itemId!))].sort();
		if (attached.length) await tx`select id from tags where id in ${tx(attached)} order by id for share`;
	}

	/** The inverse writes, record by record, with each written change linked to the change it reverses (0048). */
	async #write(tx: TransactionSql, organisationId: string, actor: Actor, plans: RecordPlan[]): Promise<void> {
		const links: Record<string, string> = {};
		const key = (plan: RecordPlan, item: { itemKind: string; itemId: string } | null, field: string | null) =>
			`${plan.record.kind}:${plan.record.id}:${item?.itemKind ?? ''}:${item?.itemId ?? ''}:${field ?? ''}`;
		for (const plan of plans) {
			for (const [field, slot] of plan.fields) links[key(plan, null, field)] = slot.reverses;
			for (const item of plan.items.values()) {
				if (item.exists) links[key(plan, item, null)] = item.exists.reverses;
				for (const [field, slot] of item.fields) links[key(plan, item, field)] = slot.reverses;
			}
		}
		await tx`select set_config('app.reverses', ${JSON.stringify(links)}, true)`;
		const sorted = [...plans].sort((a, b) => lockOrder.indexOf(a.record.kind) - lockOrder.indexOf(b.record.kind) || a.record.id.localeCompare(b.record.id));
		for (const plan of sorted) {
			const { kind, id } = plan.record;
			if (kind !== 'thread' && plan.fields.size) {
				const table = tables[kind];
				const allowed = new Set<string>(journalFields[table]);
				const columns = [...plan.fields.keys()].filter(field => allowed.has(field));
				if (columns.length !== plan.fields.size) throw new Error('a reversal writes only journalled fields');
				const merged = { ...plan.record.row, ...Object.fromEntries([...plan.fields].map(([field, slot]) => [field, slot.value])), organisation_id: organisationId };
				const extra = kind === 'reservation' ? `, occupied_starts_at = p.starts_at - p.setup_minutes * interval '1 minute', occupied_ends_at = p.ends_at + p.cleanup_minutes * interval '1 minute',
					revision = t.revision + 1, updated_at = now()`
					: kind === 'equipment' ? ', revision = t.revision + 1, updated_at = now()' : kind === 'stock_item' ? ', updated_at = clock_timestamp()' : ', updated_at = now()';
				await tx.unsafe(`update ${table} t set ${columns.map(column => `${column} = p.${column}`).join(', ')}${extra}
					from jsonb_populate_record(null::${table}, $1::text::jsonb) p where t.id = $2`, [JSON.stringify(merged), id]);
			}
			let touched = false;
			for (const item of plan.items.values()) {
				if (item.itemKind === 'tag') {
					const present = item.exists!.present;
					if (kind === 'series') {
						if (present) await tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${organisationId}, ${id}, ${item.itemId})`;
						else await tx`delete from task_series_tags where series_id = ${id} and tag_id = ${item.itemId}`;
						touched = true;
					} else {
						await writeThreadTags(tx, organisationId, actor, plan.record.threadId!, [item.itemId], { mode: present ? 'add' : 'remove', bump: true });
					}
					continue;
				}
				const table = item.itemKind === 'step' ? 'tasks' : 'evidence';
				if (item.exists) {
					if (item.exists.present) {
						const row: Raw = { ...item.exists.row, ...Object.fromEntries([...item.fields].map(([field, slot]) => [field, slot.value])), organisation_id: organisationId };
						await tx.unsafe(`insert into ${table} select (jsonb_populate_record(null::${table}, $1::text::jsonb)).*`, [JSON.stringify(row)]);
						if (item.itemKind === 'evidence') await tx`update tasks set updated_at = now() where id = ${String(row.task_id)} and id <> ${id}`;
					} else {
						if (item.itemKind === 'evidence') await tx`update tasks set updated_at = now() where id = (select task_id from evidence where id = ${item.itemId}) and id <> ${id}`;
						await tx.unsafe(`delete from ${table} where id = $1`, [item.itemId]);
					}
				} else if (item.fields.size) {
					const allowed = new Set<string>(journalFields[table]);
					const columns = [...item.fields.keys()].filter(field => allowed.has(field));
					const merged = { ...(await this.#itemRow(tx, table, item.itemId)), ...Object.fromEntries([...item.fields].map(([field, slot]) => [field, slot.value])) };
					await tx.unsafe(`update ${table} t set ${columns.map(column => `${column} = p.${column}`).join(', ')}${table === 'tasks' ? ', updated_at = now()' : ''}
						from jsonb_populate_record(null::${table}, $1::text::jsonb) p where t.id = $2`, [JSON.stringify(merged), item.itemId]);
				}
				touched = true;
			}
			// An item change moves its record on, as the ordinary item writes do.
			if (touched && kind === 'task') await tx`update tasks set updated_at = now() where id = ${id}`;
			if (touched && kind === 'series') await tx`update task_series set updated_at = now() where id = ${id}`;
		}
	}

	async #itemRow(tx: TransactionSql, table: string, id: string): Promise<Raw> {
		const [row] = await tx.unsafe<{ row: string }[]>(`select to_jsonb(t)::text as row from ${table} t where id = $1`, [id]);
		if (!row) throw conflict(staleCode, 'That item changed.');
		return JSON.parse(row.row);
	}
}

class Stale extends Error {
	readonly preview: Preview; readonly moved: Basis[];
	constructor(preview: Preview, moved: Basis[]) { super('stale preview'); this.preview = preview; this.moved = moved; }
}

// Pure helpers ------------------------------------------------------------------------------------------------------------

const emptyWorld = (): World => ({ records: new Map(), items: new Map(), tags: new Map() });
const actorView = (set: SetRow): ActorView => ({ kind: set.actorKind, id: set.actorId, name: set.actorName });

function entryView(entry: Entry): Omit<EntryView, keyof StateView | 'state'> {
	const first = entry.members[0]!;
	return { id: first.id, changeIds: entry.members.map(member => member.id), recordKind: first.recordKind, recordId: first.recordId,
		operation: entry.group ? 'update' : first.operation, field: entryField(entry), fields: entryFields(entry), itemKind: first.itemKind, itemId: first.itemId,
		before: shown(entry, 'shownBefore'), after: shown(entry, 'shownAfter'),
		reverses: [...new Set(entry.members.map(member => member.reversesChangeId).filter((id): id is string => id !== null))] };
}

/** An entry's state from history alone (and, in a preview, the selection): reversed, irreversible, conflict or
 *  reversible. Later changes still in effect that are not selected are the conflict. */
function historyState(entry: Entry, journal: Journal, world: World, actors: Map<string, SetRow>, selected: Set<string> = new Set()): StateView {
	for (const member of entry.members) {
		const by = journal.reversedBy(member);
		if (by) {
			const set = actors.get(by.changeSetId)!;
			return { state: 'reversed', reversedBy: { changeId: by.id, changeSetId: by.changeSetId, actor: actorView(set), at: set.createdAt } };
		}
	}
	const reason = irreversible(entry, world);
	if (reason) return { state: 'irreversible', reason };
	const blocking = journal.liveLater(entry.members).filter(later => !selected.has(later.id));
	if (blocking.length) {
		return { state: 'conflict', later: blocking.map(later => {
			const set = actors.get(later.changeSetId)!;
			return { id: later.id, changeSetId: later.changeSetId, actor: actorView(set), at: set.createdAt, field: later.field ? camel(later.field) : null,
				before: later.shownBefore, after: later.shownAfter };
		}) };
	}
	return { state: 'reversible' };
}

function irreversible(entry: Entry, world: World): IrreversibleReason | null {
	const first = entry.members[0]!;
	if (!first.itemKind && first.operation === 'create') return 'record_created';
	if (!first.itemKind && first.operation === 'remove') return 'record_removed';
	const record = world.records.get(recordKey(first.recordKind, first.recordId));
	if (record?.converted) return 'became_task';
	if (!record?.row) return 'record_gone';
	for (const member of entry.members) {
		if (!member.itemKind) continue;
		if (member.itemKind === 'tag') { if (!world.tags.get(member.itemId!)) return 'tag_gone'; continue; }
		const now = world.items.get(`${member.itemKind}:${member.itemId}`) ?? null;
		if (member.operation === 'update' && !now) return 'item_gone';
		if (member.operation === 'create' && !now) return 'item_gone';
		if (member.itemKind === 'evidence' && member.operation === 'remove') {
			// Restoring evidence needs the task or step it was on.
			const on = (member.before as Raw | null)?.task_id;
			if (typeof on === 'string' && on !== first.recordId && !world.items.get(`step:${on}`)) return 'item_gone';
		}
	}
	return null;
}

/** A member's value now and after the plan (for an item's existence: its row, and whether it is there). */
function valuesOf(member: Change, world: World, plan: RecordPlan | undefined): { now: unknown; proposed: unknown; presentNow: boolean; presentAfter: boolean } {
	const record = world.records.get(recordKey(member.recordKind, member.recordId));
	if (!member.itemKind) {
		const now = record?.row?.[member.field!] ?? null;
		const slot = plan?.fields.get(member.field!);
		return { now, proposed: slot ? slot.value : now, presentNow: true, presentAfter: true };
	}
	const current = member.itemKind === 'tag' ? world.items.get(itemKey(member)) ?? null : world.items.get(`${member.itemKind}:${member.itemId}`) ?? null;
	const item = plan?.items.get(`${member.itemKind}:${member.itemId}`);
	const presentAfter = item?.exists ? item.exists.present : current !== null;
	if (member.operation === 'update') {
		const now = current?.[member.field!] ?? null;
		const slot = item?.fields.get(member.field!);
		return { now, proposed: presentAfter ? (slot ? slot.value : now) : null, presentNow: current !== null, presentAfter };
	}
	const after = item?.exists ? (item.exists.present ? item.exists.row : null) : current;
	return { now: current, proposed: after, presentNow: current !== null, presentAfter };
}

function movedBasis(sent: Basis[], now: Basis[]): Basis[] {
	const held = new Map(sent.map(b => [recordKey(b.recordKind, b.recordId), b.revision]));
	return now.filter(b => !held.has(recordKey(b.recordKind, b.recordId)) || held.get(recordKey(b.recordKind, b.recordId)) !== b.revision);
}

/** An opaque cursor over `(created_at desc, id desc)` of change sets. */
export function encodeCursor(key: string, id: string): string { return Buffer.from(JSON.stringify([key, id])).toString('base64url'); }
export function decodeCursor(cursor: string): [string, string] {
	let value: unknown;
	try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { value = null; }
	if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value[0])
		&& !Number.isNaN(Date.parse(value[0])) && uuid.safeParse(value[1]).success) return [value[0], String(value[1]).toLowerCase()];
	throw badRequest('invalid_request', 'That page cursor cannot be read.');
}
