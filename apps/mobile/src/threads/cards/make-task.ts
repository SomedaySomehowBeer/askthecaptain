/** "Make this a task" (versions contract §6): the request body and the answer's check. Pure, so Node tests import it. */
import type { Detail } from '../contracts.ts';
import { parseDetail } from '../parse.ts';

/** The answer is this thread's detail, now a record thread on a task. */
export function parseMadeTask(raw: unknown, threadId: string): Detail {
	const d = parseDetail(raw);
	if (d.thread.id !== threadId || d.thread.kind !== 'record' || d.card.record?.kind !== 'task') throw new TypeError('make task: unexpected response');
	return d;
}
export function makeTaskBody(changeSetId: string, expectedRevision: number, ownerId: string | null, due: string) {
	return { changeSetId, expectedRevision, ownerId, ...(due ? { due } : {}) };
}

