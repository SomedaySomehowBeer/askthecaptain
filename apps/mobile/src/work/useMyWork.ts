import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from '../account/AccountProvider.tsx';
import type { ReadScope } from '../account/contracts.ts';
import { myWorkPath } from '../api/paths.ts';
import { beginRead, finishRead, initialWorkList, listInert, type WorkListState, type WorkOp } from './my-work-list.ts';
import { parseMyWorkPage } from './my-work.ts';

/** The My work list for the screen (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1 and §3.5). It lives only in this
 *  mounted screen's memory, and is bound for its whole life to the ready scope the screen first rendered with.
 *
 *  - **Bound scope.** The first ready scope rendered is kept as `bound`, and every read names it as `expected`. The
 *    runner sends nothing unless its own current scope is exactly that, and builds the path from its own scope.
 *  - **Inert after a scope change.** `AccountStack` resets the tabs in an effect, after the new account has rendered
 *    once. In that render (and any before the reset commits) the rendered scope differs from `bound`: the hook returns
 *    the empty inert list, and `request` refuses. So no row of the old scope is shown under the new one, and no read,
 *    More included, is ever started for the new scope from this screen. Only the remounted screen reads the new scope.
 *  - **Answers.** An answer is applied only if the screen is still mounted, the list is not inert (the rendered scope
 *    still has the bound epoch), the read is the latest one, and the outcome is not `superseded`. Otherwise it is
 *    dropped before any state change.
 *  - Every mount reads page 0 once (a remount is a navigation event, not polling). Returning to the tab while mounted,
 *    or the app coming to the foreground, reads nothing. Refresh, More and Try again read only when asked, one at a
 *    time. */
export function useMyWork() {
	const account = useAccount();
	const view = account.snapshot.account;
	const scope: ReadScope | null = view.kind === 'signed-in' ? view.scope : null;
	const { read, now } = account;

	// The scope this list belongs to: the first ready scope rendered. Never replaced.
	const bound = useRef<ReadScope | null>(null);
	if (bound.current === null && scope !== null) bound.current = scope;
	const inert = listInert(bound.current, scope);
	// The latest rendered scope and list, readable synchronously from callbacks.
	const scopeRef = useRef<ReadScope | null>(scope); scopeRef.current = scope;
	const listRef = useRef<WorkListState>(initialWorkList);
	const mounted = useRef(false);
	const [list, setList] = useState<WorkListState>(initialWorkList);
	const commit = (next: WorkListState) => { listRef.current = next; setList(next); };
	const live = () => mounted.current && !listInert(bound.current, scopeRef.current);

	const request = useCallback((op: WorkOp) => {
		const expected = bound.current;
		if (expected === null || !live()) return;
		const started = beginRead(listRef.current, op, now());
		if (started === null) return;
		commit(started.state);
		const { seq, offset } = started;
		void read(expected, (current) => myWorkPath(current, offset), (value) => parseMyWorkPage(value, { scope: expected, offset })).then((outcome) => {
			if (!live()) return;
			const next = finishRead(listRef.current, seq, outcome);
			if (next !== listRef.current) commit(next);
		});
	}, [read, now]);

	useEffect(() => {
		mounted.current = true;
		// Page 0 once per mount; a strict-mode second effect finds the first read already started (beginRead refuses).
		request('first');
		return () => { mounted.current = false; };
	}, [request]);

	return { list: inert ? initialWorkList : list, inert, now, request };
}
