import { ChangeSetUnavailable, fingerprintOf, openChangeSet, type OpenedChangeSet, type RecordChange, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { HttpError } from './errors.ts';
import type { Actor } from './tenant.ts';

/** A person's business write opens its change set here (versions contract §5): the client's `changeSetId` when it sent
 *  one, a server uuidv7 otherwise, with a fingerprint of what the request asked for. A retry with the same id and the
 *  same request is `matched` and writes nothing; the same id for anything else is `409 change_set_id_unavailable`. */
export const changeSetId = z.string().uuid().transform((value) => value.toLowerCase());
export const changeSetUnavailable = () => new HttpError(409, 'change_set_id_unavailable', 'That change id was already used for a different change. Nothing was saved; save again to use a new one.');

export async function personChangeSet(tx: TransactionSql, actor: Actor, operation: string, request: unknown, id?: string): Promise<OpenedChangeSet> {
	try {
		// The request id may come from the caller's x-request-id header: it is kept to the column's 200 characters.
		const requestId = actor.requestId.slice(0, 200) || null;
		return await openChangeSet(tx, { id, actorKind: 'person', causeKind: 'request', causeId: requestId, requestId,
			fingerprint: fingerprintOf({ operation, request }) });
	} catch (error) {
		if (error instanceof ChangeSetUnavailable) throw changeSetUnavailable();
		throw error;
	}
}

/** The record a change set created (`create` of a record, not of an item), when it created one. */
export async function createdRecord(tx: TransactionSql, changeSetId: string, kind: RecordChange['recordKind']): Promise<string | null> {
	const [row] = await tx<{ recordId: string }[]>`select record_id from record_changes where change_set_id = ${changeSetId} and record_kind = ${kind}
		and operation = 'create' and item_id is null order by id limit 1`;
	return row?.recordId ?? null;
}

/** The item a change set created on a record, with its full row as written. */
export async function createdItem(tx: TransactionSql, changeSetId: string, itemKind: 'step' | 'evidence'): Promise<{ itemId: string; after: Record<string, unknown> } | null> {
	const [row] = await tx<{ itemId: string; after: Record<string, unknown> }[]>`select item_id, after from record_changes where change_set_id = ${changeSetId}
		and item_kind = ${itemKind} and operation = 'create' order by id limit 1`;
	return row ?? null;
}

/** Every journalled write also names its change set in this response header, so a client whose body parser is strict
 *  (the thread detail) can still read it. */
export const changeSetHeader = 'Change-Set-Id';
