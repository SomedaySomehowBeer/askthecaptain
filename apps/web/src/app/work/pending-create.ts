/** A saved-view create whose outcome is not yet known, kept in this tab's sessionStorage so a reload cannot turn an
 *  ambiguous save into a second logical create (contract §5). The record is written *before* the request is sent,
 *  restored and locked on the next load, and removed only when the outcome is confirmed (saved, or refused so that
 *  nothing was created) or the person explicitly starts a new view. It holds the create id and its exact payload,
 *  scoped to the signed-in user and organisation; never a token or anything from the session. */
import { isViewId, readFilter, sameFilter, viewName, type SavedFilter, type ViewScope } from './saved-views.ts';

export type CreateScope = ViewScope;
export type PendingCreate = { id: string; name: string; filter: SavedFilter; words: string };
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Restored = { state: 'none' } | { state: 'found'; record: PendingCreate } | { state: 'invalid' } | { state: 'unavailable' };

const recordVersion = 1;
/** The filter in words is display text written by `describeFilter`. Its longest honest form is 20 tag names of up to
 *  60 characters (API limit) joined by ", ", one project name of up to 60 plus a state such as " (archived)", and the
 *  fixed owner/status words: well under 1,600 characters. 4,000 leaves room for multi-code-unit names and future
 *  label wording while still bounding what a restored record may put on screen. */
export const maxWords = 4_000;
export const pendingKey = (scope: CreateScope): string => `captain.savedViewCreate.v${recordVersion}.${scope.userId.toLowerCase()}.${scope.organisationId.toLowerCase()}`;

/** This tab's sessionStorage, or null when the browser refuses it (private modes, disabled storage, quota). */
export function tabStorage(): StorageLike | null {
	try {
		if (typeof window === 'undefined') return null;
		const storage = window.sessionStorage;
		const probe = 'captain.storageProbe';
		storage.setItem(probe, '1'); storage.removeItem(probe);
		return storage;
	} catch { return null; }
}

export function encodePending(scope: CreateScope, record: PendingCreate): string {
	return JSON.stringify({ v: recordVersion, userId: scope.userId.toLowerCase(), organisationId: scope.organisationId.toLowerCase(), id: record.id, name: record.name, filter: record.filter, words: record.words });
}

/** Read back a stored record, trusting nothing: wrong scope, shape, id, name or filter is `invalid`. */
export function decodePending(scope: CreateScope, text: string | null): Restored {
	if (text === null) return { state: 'none' };
	let value: unknown;
	try { value = JSON.parse(text); } catch { return { state: 'invalid' }; }
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid' };
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort().join(',');
	if (keys !== 'filter,id,name,organisationId,userId,v,words') return { state: 'invalid' };
	if (record.v !== recordVersion || record.userId !== scope.userId.toLowerCase() || record.organisationId !== scope.organisationId.toLowerCase()) return { state: 'invalid' };
	if (!isViewId(record.id) || record.id !== record.id.toLowerCase()) return { state: 'invalid' };
	const name = viewName(record.name);
	if (typeof name !== 'string' || name !== record.name) return { state: 'invalid' };
	const filter = readFilter(record.filter);
	// The stored payload must already be the normalised form that was sent, byte for byte in meaning.
	if (!filter.ok || JSON.stringify(filter.filter) !== JSON.stringify(record.filter) || !sameFilter(filter.filter, record.filter as SavedFilter)) return { state: 'invalid' };
	if (typeof record.words !== 'string' || record.words.length === 0 || record.words.length > maxWords) return { state: 'invalid' };
	return { state: 'found', record: { id: record.id, name, filter: filter.filter, words: record.words } };
}

export function loadPending(storage: StorageLike | null, scope: CreateScope): Restored {
	if (!storage) return { state: 'unavailable' };
	try { return decodePending(scope, storage.getItem(pendingKey(scope))); }
	catch { return { state: 'unavailable' }; }
}

/** True only when the record is stored; the caller says so honestly when it is not. */
export function savePending(storage: StorageLike | null, scope: CreateScope, record: PendingCreate): boolean {
	if (!storage) return false;
	try { storage.setItem(pendingKey(scope), encodePending(scope, record)); return true; }
	catch { return false; }
}

export function clearPending(storage: StorageLike | null, scope: CreateScope): boolean {
	if (!storage) return false;
	try { storage.removeItem(pendingKey(scope)); return true; }
	catch { return false; }
}
