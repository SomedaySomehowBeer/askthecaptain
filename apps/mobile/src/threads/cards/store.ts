/** What a record thread's card needs beyond the thread detail: the record with its revision (a task with its steps, a
 *  booking), the organisation's zone for booking times, the members for owners, and tag names for change lines. Read
 *  only; nothing here is cached beyond the open screen. Each read reports its own failure in words. */
import type { ReadScope } from '../../account/contracts.ts';
import { parseMembers, type Member } from '../../account/members.ts';
import { organisationPath } from '../../api/paths.ts';
import type { ThreadCalls } from '../api.ts';
import { queryPath } from '../api.ts';
import type { Detail, Message, Tag } from '../contracts.ts';
import { parseTagPage } from '../options.ts';
import type { Names } from '../wording.ts';
import { reads, type Booking, type TaskDetail } from './records.ts';

export type RecordState = {
	readonly task: TaskDetail | null;
	readonly booking: Booking | null;
	readonly zone: string | null;
	readonly members: readonly Member[] | null;
	readonly tags: readonly Tag[] | null;
	readonly busy: boolean;
	/** Why the record could not be read, in words; the card stays read-only until it is. */
	readonly message: string;
	readonly waitUntil: number;
};
export const recordCopy = {
	failed: 'Could not load this record’s details. Editing is unavailable until they load.',
	wait: 'Captain asked you to wait before loading this record again.'
} as const;

export function createRecordStore(calls: ThreadCalls, scope: ReadScope, now: () => number, lost: () => void) {
	let live = true, detail: Detail | null = null, tagsAsked = false, membersAsked = false, flight: Promise<void> | null = null, queued = false;
	let state: RecordState = { task: null, booking: null, zone: null, members: null, tags: null, busy: false, message: '', waitUntil: 0 };
	const listeners = new Set<() => void>();
	const set = (next: Partial<RecordState>) => { if (live && calls.current(scope)) { state = { ...state, ...next }; listeners.forEach((fn) => fn()); } };
	const failed = (result: { status: number; retryAfter: number }) => {
		if (result.status === 404) { lost(); return; }
		set({ busy: false, message: result.status === 429 ? recordCopy.wait : recordCopy.failed, waitUntil: now() + Math.max(result.retryAfter, 5) * 1000 });
	};
	async function read() {
		const record = detail?.card.record;
		if (!record || !live) return;
		set({ busy: true });
		if (record.kind === 'task') {
			const r = await reads.task(calls, scope, record.id);
			if (!live || r.kind === 'stale') return; if (r.kind === 'error') { failed(r); return; }
			set({ task: r.value, zone: r.value.timezone });
		} else if (record.kind === 'booking') {
			const equipmentId = detail!.card.fold.equipmentId;
			if (typeof equipmentId !== 'string') return;
			if (!state.zone) {
				const z = await reads.zone(calls, scope);
				if (!live || z.kind === 'stale') return; if (z.kind === 'error') { failed(z); return; }
				set({ zone: z.value });
			}
			const r = await reads.booking(calls, scope, equipmentId, record.id);
			if (!live || r.kind === 'stale') return; if (r.kind === 'error') { failed(r); return; }
			set({ booking: r.value });
		}
		set({ busy: false, message: '', waitUntil: 0 });
	}
	/** One read at a time; a reload asked for during one runs once after it. */
	async function load() {
		if (flight) { queued = true; return flight; }
		if (now() < state.waitUntil) return;
		flight = (async () => { try { do { queued = false; await read(); } while (queued && live); } finally { flight = null; } })();
		return flight;
	}
	async function members() {
		if (membersAsked || !live) return; membersAsked = true;
		const r = await calls.request(scope, 'GET', organisationPath(scope.organisationId, 'members'), undefined, parseMembers);
		if (!live || r.kind !== 'ok') { membersAsked = r.kind === 'ok'; return; }
		set({ members: r.value });
	}
	async function tags() {
		if (tagsAsked || !live) return; tagsAsked = true;
		const r = await calls.request(scope, 'GET', queryPath(organisationPath(scope.organisationId, 'tags'), { offset: 0, limit: 50 }), undefined, parseTagPage);
		if (!live || r.kind !== 'ok') return;
		set({ tags: r.value.tags });
	}
	return {
		snapshot: () => state,
		subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
		dispose() { live = false; listeners.clear(); },
		/** The thread detail changed (loaded, or reloaded after a save or someone's change line). */
		detail(next: Detail | null, reload: boolean) {
			const first = detail === null && next !== null;
			detail = next;
			if (!next?.card.record) return;
			if (first || reload) void load();
			// A topic that became a task needs the members too (the first detail had no record).
			if (next.card.record.kind !== 'stock') void members();
		},
		load,
		/** The members, for an owner list outside a record's editor (a topic's "Make this a task"). Read once. */
		askMembers() { void members(); },
		/** Change lines name tags by id; a tag no longer on the thread is looked up once. */
		lines(messages: readonly Message[]) {
			const known = new Set([...(detail?.tags ?? []), ...(state.tags ?? [])].map((t) => t.id));
			const people = messages.some((m) => m.change?.changes.some((c) => c.field === 'ownerId' || c.field === 'countedBy'));
			if (messages.some((m) => m.change?.changes.some((c) => c.itemKind === 'tag' && c.itemId && !known.has(c.itemId)))) void tags();
			if (people) void members();
		}
	};
}

/** Names for change lines from what the screen has loaded: never a guess. */
export function namesFor(detail: Detail | null, record: RecordState, messages: readonly Message[]): Names {
	const people = new Map<string, string>();
	for (const m of record.members ?? []) if (m.name) people.set(m.userId, m.name);
	for (const m of messages) { if (m.authorId && m.authorName) people.set(m.authorId, m.authorName); if (m.change?.actorId && m.change.actorName) people.set(m.change.actorId, m.change.actorName); }
	const fold = detail?.card.fold;
	if (fold && typeof fold.ownerId === 'string' && typeof fold.ownerName === 'string') people.set(fold.ownerId, fold.ownerName);
	const tags = new Map<string, string>();
	for (const t of [...(record.tags ?? []), ...(detail?.tags ?? [])]) tags.set(t.id, t.name);
	const steps = new Map<string, string>();
	for (const m of messages) for (const c of m.change?.changes ?? []) if (c.itemKind === 'step' && c.itemId) {
		const row = (c.after ?? c.before) as Record<string, unknown> | null;
		if (row && typeof row === 'object' && typeof row.title === 'string') steps.set(c.itemId, row.title);
	}
	for (const s of record.task?.steps ?? []) steps.set(s.id, s.title);
	const equipment = new Map<string, string>();
	if (fold && typeof fold.equipmentId === 'string' && typeof fold.equipmentName === 'string') equipment.set(fold.equipmentId, fold.equipmentName);
	return { person: (id) => people.get(id), tag: (id) => tags.get(id), step: (id) => steps.get(id), equipment: (id) => equipment.get(id) };
}
