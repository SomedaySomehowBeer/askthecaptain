import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { listInert } from '../../work/my-work-list.ts';
import type { Scale } from './geometry.ts';
import type { ScheduleRange } from './range.ts';
import {
	beginRead, createSchedule, press, pressEdge, pressRefresh, pressToday, readRequest, receive, setScale, settle, wakeDelay,
	type Intent, type ScheduleState, type SettledView
} from './schedule.ts';

/** The equipment schedule for its screen (contract docs/plans/expo-mobile-equipment-read-2026-09.md §4.4; design note
 *  revision 2). Effects only: every decision is in `schedule.ts`. It lives only in this mounted screen's memory, exactly
 *  as Inventory does (`useStock`):
 *
 *  - **Bound scope.** The first ready scope rendered is kept as `bound`; every read names it as `expected`, and the runner
 *    builds each path from its own current scope. After a scope change the hook is `inert` until the tabs reset remounts
 *    the screen: nothing is sent, no answer applies, and the screen shows only the loading line.
 *  - **One pump.** `pump` asks `beginRead` for the single read to send, sends it through the runner, applies the answer
 *    with `receive`, and pumps again. It runs after mount, after each answer, after each press and settle, and when the
 *    screen-wide wait or rolling budget ends. It never runs per scroll frame.
 *  - Nothing is cached between mounts, and nothing reads when the app comes to the foreground. */
export function useEquipmentSchedule() {
	const account = useAccount();
	const shown = account.snapshot.account;
	const scope: ReadScope | null = shown.kind === 'signed-in' ? shown.scope : null;
	const { read, now } = account;

	const bound = useRef<ReadScope | null>(null);
	if (bound.current === null && scope !== null) bound.current = scope;
	const inert = listInert(bound.current, scope);
	const scopeRef = useRef<ReadScope | null>(scope); scopeRef.current = scope;
	// The account's own membership check (design E2): signed in and not refreshing, read at the press, scope unchanged.
	const membershipChecked = shown.kind === 'signed-in' && !shown.refreshing && !inert;
	const checkedRef = useRef(membershipChecked); checkedRef.current = membershipChecked;

	const stateRef = useRef<ScheduleState | null>(null);
	if (stateRef.current === null && bound.current !== null) stateRef.current = createSchedule(bound.current);
	const [, setVersion] = useState(0);
	const mounted = useRef(false);
	const live = () => mounted.current && !listInert(bound.current, scopeRef.current);
	const commit = (next: ScheduleState) => {
		if (next === stateRef.current) return;
		stateRef.current = next;
		setVersion((v) => v + 1);
	};

	const pumpRef = useRef<() => void>(() => undefined);
	const pump = useCallback(() => {
		const expected = bound.current, current = stateRef.current;
		if (expected === null || current === null || !live()) return;
		const begun = beginRead(current, now());
		commit(begun.state);
		const sent = begun.read;
		if (sent === null) return;
		const { path, parse } = readRequest(sent);
		void read(expected, path, parse).then((outcome) => {
			if (!live() || stateRef.current === null) return;
			commit(receive(stateRef.current, sent, outcome, new Date()));
			pumpRef.current();
		});
	// `live` and `commit` read only refs.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [read, now]);
	pumpRef.current = pump;

	const hasState = stateRef.current !== null;
	useEffect(() => {
		mounted.current = true;
		pumpRef.current();
		return () => { mounted.current = false; };
	}, [hasState]);

	// Wakes the pump and re-renders when a screen-wide wait or the rolling budget stops blocking, so disabled controls
	// become enabled and queued reads go. It sends nothing itself; the gate still decides.
	const gate = stateRef.current?.gate ?? null;
	useEffect(() => {
		const current = stateRef.current;
		if (gate === null || current === null) return undefined;
		const delay = wakeDelay(current, now());
		if (delay === null) return undefined;
		const timer = setTimeout(() => { setVersion((v) => v + 1); pumpRef.current(); }, delay);
		return () => clearTimeout(timer);
	}, [gate, now]);

	/** Applies a pure transition, then pumps. False when refused or not live. */
	const act = (transition: (state: ScheduleState) => ScheduleState | null): boolean => {
		const current = stateRef.current;
		if (current === null || !live()) return false;
		const next = transition(current);
		if (next === null) return false;
		commit(next);
		pumpRef.current();
		return true;
	};

	return {
		state: inert ? null : stateRef.current,
		inert,
		now,
		membershipChecked,
		press: (intent: Intent) => act((s) => press(s, intent)),
		refresh: () => act((s) => pressRefresh(s, now(), checkedRef.current)),
		settle: (view: SettledView) => act((s) => settle(s, view)),
		scale: (scale: Scale) => act((s) => setScale(s, scale)),
		/** "Earlier dates" / "Later dates": the new range, for the screen to focus its edge date, or null when refused. */
		edge: (direction: 'earlier' | 'later'): ScheduleRange | null => {
			let range: ScheduleRange | null = null;
			act((s) => {
				const moved = pressEdge(s, direction, now());
				range = moved?.state.range ?? null;
				return moved?.state ?? null;
			});
			return range;
		},
		/** Today: true when the screen should centre now (re-anchoring first when now was outside the range). */
		today: (): boolean => {
			const current = stateRef.current;
			if (current === null || !live()) return false;
			const moved = pressToday(current, now(), new Date());
			if (moved === null) return false;
			commit(moved.state);
			pumpRef.current();
			return true;
		}
	};
}
