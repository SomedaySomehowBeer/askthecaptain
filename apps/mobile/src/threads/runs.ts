/** Runs of change lines (owner decision, 3 October 2026; versions contract §3). Consecutive change lines, with no
 *  ordinary message (a tombstone included) and no gap in `seq` between them, show as one folded line until tapped.
 *  Presentation only: the messages, their order, gaps, the unread marker's message and the change feed are unchanged.
 *  Pure: no React, no network. */
import type { Message } from './contracts.ts';
import { actorOf } from './wording.ts';

export type DisplayItem =
	| { readonly kind: 'message'; readonly message: Message }
	| { readonly kind: 'changeLine'; readonly message: Message }
	/** `key` is the run's first line's id (stable while newer lines join it); `lines` are oldest first; `from`/`to` are
	 *  the first and newest lines' times; `actors` are the distinct actors in order of first appearance. */
	| { readonly kind: 'foldedRun'; readonly key: string; readonly lines: readonly Message[]; readonly newest: Message; readonly actors: readonly string[]; readonly from: string; readonly to: string };

/** The runs of consecutive change lines in `messages` (seq order), each as its lines; ordinary messages are not in any. */
export function changeRuns(messages: readonly Message[]): Message[][] {
	const runs: Message[][] = [];
	let run: Message[] = [];
	for (const m of messages) {
		const last = run.at(-1);
		if (m.kind === 'change' && last && m.seq === last.seq + 1) { run.push(m); continue; }
		if (run.length) runs.push(run);
		run = m.kind === 'change' ? [m] : [];
	}
	if (run.length) runs.push(run);
	return runs;
}

/** What the thread shows: each message, each change line of a run of one, an unfolded run's lines, and every other run
 *  as one folded item. A run whose first line is the first unread folds with the marker on it; a run where the first
 *  unread is a later line is shown unfolded, so the marker sits on that line (`firstUnreadSeq`). */
export function displayItems(messages: readonly Message[], options: { unfolded?: ReadonlySet<string>; firstUnreadSeq?: number | null } = {}): DisplayItem[] {
	const runs = new Map(changeRuns(messages).map((run) => [run[0]!.id, run]));
	const items: DisplayItem[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.kind !== 'change') { items.push({ kind: 'message', message: m }); continue; }
		const run = runs.get(m.id)!;
		const inside = options.firstUnreadSeq != null && run.some((line, n) => n > 0 && line.seq === options.firstUnreadSeq);
		if (run.length === 1 || inside || options.unfolded?.has(m.id)) for (const line of run) items.push({ kind: 'changeLine', message: line });
		else {
			const newest = run.at(-1)!;
			items.push({ kind: 'foldedRun', key: m.id, lines: run, newest, actors: [...new Set(run.map((line) => actorOf(line.change ?? { actorKind: 'system', actorName: null })))], from: m.createdAt, to: newest.createdAt });
		}
		i += run.length - 1;
	}
	return items;
}

/** The messages an item stands for, oldest first. */
export const itemMessages = (item: DisplayItem): readonly Message[] => item.kind === 'foldedRun' ? item.lines : [item.message];
