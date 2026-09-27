import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from '../account/AccountProvider.tsx';
import type { ReadScope } from '../account/contracts.ts';
import { stockPath } from '../api/paths.ts';
import { listInert } from '../work/my-work-list.ts';
import { parseStockList } from './stock.ts';
import { beginStockRead, finishStockRead, initialStockList, type StockListState, type StockOp } from './stock-list.ts';

/** The Inventory list for its screen (docs/plans/expo-mobile-inventory-read-2026-09.md §5). It lives only in this
 *  mounted screen's memory, exactly as a Work list does (`useWorkList`):
 *
 *  - **Bound scope.** The first ready scope rendered is kept as `bound`, and every read names it as `expected`. The
 *    runner sends nothing unless its own current scope is exactly that, and builds the path from its own scope.
 *  - **Inert after a scope change.** In the render where the rendered scope differs from `bound` (before the tabs reset
 *    remounts this screen), the hook returns the initial state and `inert`, `request` refuses, and no answer applies.
 *    The screen then shows only the neutral loading line: never the old rows, never the empty wording.
 *  - **Answers** apply only while mounted, not inert, for the latest read, and not `superseded`.
 *  - One `first` read per mount; Refresh and Try again only when asked, one at a time. Nothing is cached between
 *    mounts, and nothing reads when the app comes to the foreground. */
export function useStock() {
	const account = useAccount();
	const shown = account.snapshot.account;
	const scope: ReadScope | null = shown.kind === 'signed-in' ? shown.scope : null;
	const { read, now } = account;

	const bound = useRef<ReadScope | null>(null);
	if (bound.current === null && scope !== null) bound.current = scope;
	const inert = listInert(bound.current, scope);
	// The latest rendered scope and state, readable synchronously from callbacks.
	const scopeRef = useRef<ReadScope | null>(scope); scopeRef.current = scope;
	const stateRef = useRef<StockListState>(initialStockList);
	const mounted = useRef(false);
	const [state, setState] = useState<StockListState>(initialStockList);
	const commit = (next: StockListState) => { stateRef.current = next; setState(next); };
	const live = () => mounted.current && !listInert(bound.current, scopeRef.current);

	const request = useCallback((op: StockOp) => {
		const expected = bound.current;
		if (expected === null || !live()) return;
		const started = beginStockRead(stateRef.current, op, now());
		if (started === null) return;
		commit(started.state);
		const { seq } = started;
		void read(expected, (current) => stockPath(current), parseStockList).then((outcome) => {
			if (!live()) return;
			const next = finishStockRead(stateRef.current, seq, outcome);
			if (next !== stateRef.current) commit(next);
		});
	}, [read, now]);

	useEffect(() => {
		mounted.current = true;
		// Once per mount; a strict-mode second effect finds the first read already started (beginStockRead refuses).
		request('first');
		return () => { mounted.current = false; };
	}, [request]);

	return { state: inert ? initialStockList : state, inert, now, request };
}
