/** R3 V-E history states (design boards 5–11) as contract-shaped synthetic answers. Never imported by production; no
 *  writes reach anything: an apply is refused as stale (`threads-history-stale`) or unavailable. */
import type { ApiClient, ApiOutcome } from '../src/auth/contracts.ts';
import type { MemberScope } from '../src/account/members.ts';
import { browserPendingUndo } from '../src/threads/history/storage.ts';
import { recordFixture, recordMembers, tid } from './thread-fixtures.ts';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const maya = u(41), tom = u(42), taskId = u(43), bookingId = u(45), production = u(48), autumn = u(54), orderStep = u(44), labelStep = u(50);
const hour = 3_600_000;
const ago = (hours: number) => new Date(Math.floor((Date.now() - hours * hour) / 60_000) * 60_000).toISOString();
const person = (id: string) => ({ kind: 'person', id, name: id === maya ? 'Maya Chen' : 'Tom Reilly' });
type Raw = Record<string, unknown>;
const entry = (n: number, x: Raw): Raw => ({ id: u(n), changeIds: [u(n)], recordKind: 'task', recordId: taskId, operation: 'update', field: null, fields: [], itemKind: null, itemId: null, before: null, after: null, reverses: [], state: 'reversible', ...x });
const due = (n: number, before: string, after: string, x: Raw = {}) => entry(n, { field: 'due', fields: ['due'], before, after, ...x });
const tagRow = (tagId: string) => ({ threadId: tid, tagId, addedBy: maya, addedAt: ago(30) });
const stepRow = (id: string, title: string) => ({ id, parentId: taskId, title, status: 'open' });
const set = (n: number, who: string, at: string, changes: Raw[], cause = 'request', reverses: string | null = null): Raw => ({ id: u(n), actor: person(who), causeKind: cause, reversesChangeSetId: reverses, createdAt: at, changes });
const names = { people: { [maya]: 'Maya Chen', [tom]: 'Tom Reilly' }, tags: { [production]: 'Production', [autumn]: 'Autumn range' } };

function taskSets(applied: boolean): Raw[] {
	const undoAt = ago(0.1), undone = (changeId: number) => ({ state: 'reversed', reversedBy: { changeId: u(changeId), changeSetId: u(630), actor: person(maya), at: undoAt } });
	return [
		...(applied ? [set(630, maya, undoAt, [due(731, '2026-10-08', '2026-10-06', { reverses: [u(702)] }), entry(732, { operation: 'detach', itemKind: 'tag', itemId: production, before: tagRow(production), reverses: [u(703)] })], 'reversal', u(602))] : []),
		set(601, tom, ago(0.5), [entry(701, { field: 'ownerId', fields: ['ownerId'], before: maya, after: tom })]),
		set(602, maya, ago(17), [due(702, '2026-10-06', '2026-10-08', applied ? undone(731) : {}), entry(703, { operation: 'attach', itemKind: 'tag', itemId: production, after: tagRow(production), ...(applied ? undone(732) : {}) })]),
		set(603, maya, ago(43), [due(704, '2026-10-02', '2026-10-06', { state: 'conflict', later: [{ id: u(applied ? 731 : 702), changeSetId: u(applied ? 630 : 602), actor: person(maya), at: applied ? undoAt : ago(17), field: 'due', before: applied ? '2026-10-08' : '2026-10-06', after: applied ? '2026-10-06' : '2026-10-08' }] }),
			entry(705, { operation: 'create', itemKind: 'step', itemId: orderStep, after: stepRow(orderStep, 'Order pallet wrap') })]),
		set(604, tom, ago(70), [entry(706, { operation: 'remove', itemKind: 'step', itemId: labelStep, before: stepRow(labelStep, 'Check label stock'), state: 'reversed', reversedBy: { changeId: u(799), changeSetId: u(698), actor: person(maya), at: ago(50) } }),
			entry(707, { operation: 'attach', itemKind: 'tag', itemId: autumn, after: tagRow(autumn), state: 'irreversible', reason: 'tag_gone' })])
	];
}
const bookingSets = (): Raw[] => [
	set(611, tom, ago(1.5), [{ ...entry(711, { recordKind: 'reservation', recordId: bookingId, field: 'time', fields: ['startsAt', 'endsAt'], before: { startsAt: '2026-10-07T21:00:00+00:00', endsAt: '2026-10-08T01:00:00+00:00' },
		after: { startsAt: '2026-10-09T02:00:00+00:00', endsAt: '2026-10-09T06:00:00+00:00' } }), changeIds: [u(711), u(712)] }]),
	set(612, maya, ago(17), [entry(713, { recordKind: 'reservation', recordId: bookingId, operation: 'create', after: { id: bookingId, title: 'Summer lager canning run' }, state: 'irreversible', reason: 'record_created' })])
];

/** The preview by these fixtures' rules: a conflict unless its later change is ticked, a blocked booking, else reversible. */
function preview(ids: readonly string[], booking: boolean, stale: boolean): Raw {
	const sets = booking ? bookingSets() : taskSets(false);
	const entries = sets.flatMap((s) => (s.changes as Raw[])).filter((e) => (e.changeIds as string[]).some((id) => ids.includes(id)));
	const changes: Raw[] = entries.map((e): Raw => {
		const later = e.later as { id: string }[] | undefined;
		const { later: _l, ...rest } = e;
		if (stale && e.id === u(702)) return { ...rest, state: 'conflict', later: [{ id: u(731), changeSetId: u(640), actor: person(tom), at: ago(0.2), field: 'due', before: '2026-10-08', after: '2026-10-09' }], now: '2026-10-09', proposed: null };
		if (e.state === 'conflict' && later && later.some((l) => !ids.includes(l.id))) return { ...e, now: '2026-10-08', proposed: null };
		if (booking) return { ...rest, state: 'blocked', reason: 'slot_taken', detail: { reservationId: u(653), title: 'Keg wash', ownerId: tom, ownerName: 'Tom Reilly', occupiedStartsAt: '2026-10-07T20:30:00.000Z', occupiedEndsAt: '2026-10-08T01:30:00.000Z' },
			now: e.after, proposed: e.before };
		const item = e.itemKind !== null;
		return { ...rest, state: 'reversible', now: item ? (e.operation === 'attach' || e.operation === 'create' ? e.after : null) : e.after, proposed: item ? (e.operation === 'attach' || e.operation === 'create' ? null : e.before) : e.before };
	});
	return { changes, basis: [{ recordKind: booking ? 'reservation' : 'task', recordId: booking ? bookingId : taskId, revision: stale ? 6 : 5 }], applicable: changes.every((c) => c.state === 'reversible'), names };
}

export function historyClient(scenario: string, scope: () => MemberScope | null): ApiClient {
	const booking = scenario === 'threads-history-booking';
	const r = recordFixture(booking ? 'booking' : 'task');
	let seeded = false;
	const ok = <T>(parse: (v: unknown) => T, value: unknown): ApiOutcome<T> => ({ ok: true, value: parse(value) });
	return {
		async get(path, _token, parse) {
			const url = new URL(path, 'https://harness.invalid'), p = url.pathname;
			if (p.endsWith('/members')) return ok(parse, { members: recordMembers });
			if (/\/organisations\/[^/]+$/.test(p)) return ok(parse, { id: scope()?.organisationId, name: 'Harbour Brewing', timezone: 'Australia/Sydney', locale: 'en-AU', createdAt: ago(400), role: 'owner' });
			if (p.includes('/tasks/')) return ok(parse, (r as { task: unknown }).task);
			if (p.includes('/history/')) {
				if (scenario === 'threads-history-failed') return { ok: false, kind: 'unavailable', status: 503 };
				if (scenario === 'threads-history-recovered' && !seeded) {
					const s = scope();
					if (s) { seeded = true; browserPendingUndo.save(s, tid, { id: u(650), changeIds: [u(701)], basis: [{ recordKind: 'task', recordId: taskId, revision: 5 }] }); }
				}
				const sets = scenario === 'threads-history-empty' ? [] : booking ? bookingSets() : taskSets(scenario === 'threads-history-applied');
				return ok(parse, { record: { kind: booking ? 'reservation' : 'task', id: booking ? bookingId : taskId, revision: 5, exists: true }, changeSets: sets, nextCursor: null,
					start: { kind: booking ? 'created' : 'baseline', changeSetId: u(booking ? 612 : 600), at: ago(booking ? 17 : 260), revision: 1 }, names });
			}
			if (p.endsWith('/messages')) return ok(parse, { thread: { id: tid, revision: r.detail.thread.revision, lastSeq: r.detail.thread.lastSeq, lastChange: r.detail.thread.lastChange }, messages: r.messages, hasMore: false });
			if (p.endsWith('/changes')) return ok(parse, { thread: { id: tid, revision: r.detail.thread.revision, lastSeq: r.detail.thread.lastSeq, highWater: r.detail.thread.lastChange }, changes: [], next: r.detail.thread.lastChange, complete: true });
			return ok(parse, r.detail);
		},
		async post(path, _token, body, parse) {
			if (path.endsWith('/reversals/preview')) return ok(parse, preview((body as { changeIds: string[] }).changeIds, booking, false));
			if (path.endsWith('/reversals') && scenario === 'threads-history-stale') {
				const ids = (body as { changeIds: string[] }).changeIds;
				return { ok: false, kind: 'refused', status: 409, code: 'stale_preview', detail: { preview: preview(ids, false, true), moved: [{ recordKind: 'task', recordId: taskId, revision: 6 }] } };
			}
			if (path.endsWith('/read')) return ok(parse, { readPosition: (body as { seq: number }).seq, unread: 0 });
			return { ok: false, kind: 'unavailable', status: 503 };
		},
		async patch() { return { ok: false, kind: 'unavailable', status: 503 }; },
		async delete() { return { ok: false, kind: 'unavailable', status: 503 }; }
	};
}
