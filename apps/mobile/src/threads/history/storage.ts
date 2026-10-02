/** The one thing History keeps in the browser: an undo whose answer was lost, so a reload can retry it with the same id
 *  or see it in History (versions contract §5 "the same id again returns the same change set"). Only its id, the change
 *  ids and the basis, under the person and organisation; never history, a preview, names or values. Cleared when it is
 *  reconciled, discarded, on sign-out and for a different person (AccountProvider). */
import type { ReadScope } from '../../account/contracts.ts';
import { isCanonicalUuid } from '../../api/paths.ts';
import type { WebStorage } from '../storage.ts';
import type { ApplyBody } from './api.ts';
import { journalKinds } from './parse.ts';

export type PendingUndoStorage = {
	load(scope: ReadScope, threadId: string): ApplyBody | null;
	save(scope: ReadScope, threadId: string, body: ApplyBody): boolean;
	clear(scope: ReadScope, threadId: string): void;
	/** Drops every pending undo that is not this person's (all of them for null). */
	person(userId: string | null): void;
};
const prefix = 'captain.pending-undo.';

function valid(x: unknown): x is ApplyBody {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
	const v = x as Record<string, unknown>;
	if (Object.keys(v).sort().join(',') !== 'basis,changeIds,id' || !isCanonicalUuid(v.id)) return false;
	if (!Array.isArray(v.changeIds) || !v.changeIds.length || v.changeIds.length > 50 || !v.changeIds.every(isCanonicalUuid) || new Set(v.changeIds).size !== v.changeIds.length) return false;
	return Array.isArray(v.basis) && v.basis.length <= 50 && v.basis.every((b: unknown) => {
		if (!b || typeof b !== 'object') return false;
		const r = b as Record<string, unknown>;
		return Object.keys(r).sort().join(',') === 'recordId,recordKind,revision' && (journalKinds as readonly unknown[]).includes(r.recordKind) && isCanonicalUuid(r.recordId)
			&& (r.revision === null || (typeof r.revision === 'number' && Number.isInteger(r.revision) && r.revision >= 1));
	});
}

export function createPendingUndoStorage(get: () => WebStorage | null): PendingUndoStorage {
	const key = (s: ReadScope, threadId: string) => `${prefix}${s.userId}.${s.organisationId}.${threadId}`;
	const clear = (s: ReadScope, threadId: string) => { try { get()?.removeItem(key(s, threadId)); } catch { /* nothing to claim */ } };
	return {
		load(s, threadId) {
			try {
				const raw = get()?.getItem(key(s, threadId));
				if (!raw) return null;
				const value: unknown = JSON.parse(raw);
				if (!valid(value)) { clear(s, threadId); return null; }
				return { id: value.id, changeIds: [...value.changeIds], basis: value.basis.map((b) => ({ ...b })) };
			} catch { clear(s, threadId); return null; }
		},
		save(s, threadId, body) {
			try { const store = get(); if (!store) return false; store.setItem(key(s, threadId), JSON.stringify({ id: body.id, changeIds: body.changeIds, basis: body.basis })); return true; } catch { return false; }
		},
		clear,
		person(userId) {
			try {
				const store = get(); if (!store) return;
				for (let i = store.length - 1; i >= 0; i--) { const k = store.key(i); if (k?.startsWith(prefix) && (!userId || !k.startsWith(`${prefix}${userId}.`))) store.removeItem(k); }
			} catch { /* best effort */ }
		}
	};
}
export const browserPendingUndo = createPendingUndoStorage(() => typeof window === 'undefined' ? null : window.sessionStorage);
