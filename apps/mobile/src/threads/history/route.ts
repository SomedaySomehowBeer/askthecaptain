/** The History screen at a change set: `/threads/[id]/history?changeSet=…` (a change line's link; ids are canonical
 *  UUIDs from the parser). Pure, so Node tests import it. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function historyRoute(threadId: string, changeSetId: string): string | null {
	return uuid.test(threadId) && uuid.test(changeSetId) ? `/threads/${threadId}/history?changeSet=${changeSetId}` : null;
}
