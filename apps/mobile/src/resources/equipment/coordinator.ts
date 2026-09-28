import { laterWait, type Wait } from '../../account/clock.ts';
import type { ReadOutcome, ReadScope } from '../../account/contracts.ts';

/** One screen-wide read gate. No timers, credentials or effects: callers use the account's clamped clock and
 * execute only tickets returned by beginScheduleRead. Catalogue/cell state decides which failed operation may
 * be retried. This gate cannot turn a failed cell back into unread. Equipment contract §4.4. */
export const scheduleReadLimit = 30;
const minute = 60_000;
export type ScheduleReadKind = 'organisation' | 'catalogue' | 'occupancy';
export type ScheduleStop = 'retry' | 'access' | 'conflict' | 'zone' | 'superseded';
export type ScheduleTicket = {
	readonly sequence: number; readonly generation: number; readonly kind: ScheduleReadKind;
	readonly key: string; readonly retry: boolean;
};
export type ScheduleCoordinator = {
	readonly scope: ReadScope; readonly generation: number; readonly sequence: number;
	readonly inFlight: ScheduleTicket | null; readonly starts: readonly number[];
	readonly wait: Wait | null; readonly stop: ScheduleStop | null;
};
export type ScheduleBlock = 'scope' | 'busy' | 'wait' | 'budget' | 'stopped';
const sameScope = (a: ReadScope, b: ReadScope) =>
	a.epoch === b.epoch && a.userId === b.userId && a.organisationId === b.organisationId;
const recent = (state: ScheduleCoordinator, now: number) => state.starts.filter(start => start > now - minute);
const validNow = (now: number) => {
	if (!Number.isFinite(now) || now < 0) throw new TypeError('schedule clock: invalid reading');
};
/** A conflict or zone change stops only occupancy (§4.1, §4.4); the catalogue does not depend on either. A retry
 * stop admits only an explicit Try again; access and superseded admit nothing. */
const stopsRead = (stop: ScheduleStop | null, kind: ScheduleReadKind, retry: boolean): boolean =>
	stop === null ? false
	: stop === 'retry' ? !retry
	: stop === 'conflict' || stop === 'zone' ? kind === 'occupancy'
	: true;

export function createScheduleCoordinator(scope: ReadScope): ScheduleCoordinator {
	return { scope: Object.freeze({ ...scope }), generation: 1, sequence: 0, inFlight: null,
		starts: [], wait: null, stop: null };
}

/** Exactly at a server deadline or the oldest start's 60-second boundary, that limit no longer holds. */
export function scheduleReadBlock(state: ScheduleCoordinator, scope: ReadScope, kind: ScheduleReadKind, now: number,
	retry = false): ScheduleBlock | null {
	validNow(now);
	if (!sameScope(state.scope, scope)) return 'scope';
	if (state.inFlight !== null) return 'busy';
	if (state.wait !== null && now < state.wait.until) return 'wait';
	if (recent(state, now).length >= scheduleReadLimit) return 'budget';
	if (stopsRead(state.stop, kind, retry)) return 'stopped';
	return null;
}

export function beginScheduleRead(state: ScheduleCoordinator, scope: ReadScope, kind: ScheduleReadKind,
	key: string, now: number, retry = false): { readonly state: ScheduleCoordinator; readonly ticket: ScheduleTicket } | null {
	if (scheduleReadBlock(state, scope, kind, now, retry) !== null) return null;
	const ticket = Object.freeze({ sequence: state.sequence + 1, generation: state.generation, kind, key, retry });
	return { ticket, state: { ...state, sequence: ticket.sequence, inFlight: ticket,
		starts: [...recent(state, now), now] } };
}

/** Finishes only the exact outstanding ticket and releases the flight. `apply` means the caller may apply this
 * outcome to its matching catalogue/cell state; it does not mean success. An answer from a previous generation
 * (Refresh or re-anchor happened while it was in flight) is dropped: nothing is applied, though a server wait it
 * carried is still honoured. A superseded answer applies no business data and stops all reads. */
export function finishScheduleRead<T>(state: ScheduleCoordinator, ticket: ScheduleTicket, outcome: ReadOutcome<T>):
	{ readonly state: ScheduleCoordinator; readonly apply: boolean } {
	if (state.inFlight !== ticket) return { state, apply: false };
	const settled = { ...state, inFlight: null };
	if (outcome.kind === 'superseded') return { state: { ...settled, stop: 'superseded' }, apply: false };
	if (ticket.generation !== state.generation) return { apply: false, state: outcome.kind === 'unavailable'
		? { ...settled, wait: laterWait(state.wait, outcome.wait) } : settled };
	if (outcome.kind === 'ok') return { state: { ...settled,
		stop: state.stop === 'retry' && ticket.retry ? null : state.stop }, apply: true };
	const hardStop = state.stop !== null && state.stop !== 'retry' ? state.stop : null;
	if (outcome.kind === 'unavailable') return { state: { ...settled,
		wait: laterWait(state.wait, outcome.wait),
		stop: hardStop ?? (outcome.wait !== null && state.stop === null ? null : 'retry') }, apply: true };
	return { state: { ...settled, stop: outcome.kind === 'refused' &&
		(outcome.status === 403 || outcome.status === 404) ? 'access' : hardStop ?? 'retry' }, apply: true };
}

/** A parsed zone mismatch or contradictory retained revisions stops occupancy without changing account state. */
export function stopSchedule(state: ScheduleCoordinator, reason: 'zone' | 'conflict'): ScheduleCoordinator {
	if (state.stop === 'superseded' || state.stop === 'access') return state;
	return { ...state, stop: reason };
}

/** Refresh changes data identity; re-anchoring changes date identity. Both bump the generation, so an answer still
 * in flight is dropped when it lands; it keeps the single flight occupied until then, so no second request starts.
 * Neither bypasses a wait or the rate budget (the hook says why the control is unavailable rather than leaving it
 * dead). Re-anchoring preserves stops; a retry stop can then outlive the failed cell whose Try again would lift it,
 * so the hook must still offer Refresh while stop === 'retry'. An access stop needs the hook's completed membership
 * check. Superseded scopes cannot resume; the account reset must create a fresh screen. Sequence numbers never reset. */
export function restartSchedule(state: ScheduleCoordinator, scope: ReadScope, now: number,
	mode: 'refresh' | 'reanchor', membershipChecked = false): ScheduleCoordinator | null {
	if (state.stop === 'superseded') return null;
	if (mode === 'refresh' && state.stop === 'access' && !membershipChecked) return null;
	if (scheduleReadBlock({ ...state, inFlight: null, stop: null }, scope, 'organisation', now) !== null) return null;
	return { ...state, generation: state.generation + 1, stop: mode === 'refresh' ? null : state.stop };
}
