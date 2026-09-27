import type { StepKind } from './definition.ts';

/** What a step needs before an organisation can enable a workflow that uses it (plan §6: a
 *  definition that names a capability the enabling person lacks fails at enablement). */
export type Requirement = 'connection:xero' | 'connection:shopify' | 'inference' | 'push';

export type CatalogEntry = {
	kind: StepKind;
	/** What the step does, in words the Settings page can show. */
	does: string;
	requires: Requirement[];
	/** Infer steps: the output schema keys this step may be asked for. */
	schemas?: string[];
	/** Await steps: what ends the wait. */
	until?: string;
};

export type Catalog = Readonly<Record<string, CatalogEntry>>;

/** The step catalogue (plan §6). Keys are stable names the runner binds to services and connectors;
 *  a definition may only name keys that exist here, with the matching kind. It holds exactly the steps
 *  the offered workflows use; the retired assistant's steps were removed with it (#133). */
export const catalog: Catalog = {
	// read
	'tasks.due': { kind: 'read', does: 'reads tasks due within a window, and overdue ones', requires: [] },
	'stock.items': { kind: 'read', does: 'reads the counted stock list for a location', requires: [] },
	'shopify.stockLevels': { kind: 'read', does: 'reads shop levels or reports that Shopify is disconnected or incomplete', requires: [] },
	// write
	'tasks.createInProject': { kind: 'write', does: 'creates a task in a named project', requires: [] },
	'stock.recordCount': { kind: 'write', does: 'journals the person’s recorded stock count without counting twice', requires: [] },
	// await
	'time.beforeDue': { kind: 'await', does: 'waits until the reminder time before a task is due', requires: [], until: 'the reminder time' },
	'time.afterDue': { kind: 'await', does: 'waits until a task is past due', requires: [], until: 'the due date has passed' },
	'stock.counted': { kind: 'await', does: 'waits for the counter to enter a count', requires: [], until: 'a count is entered' },
	// notify
	'push.taskOwner': { kind: 'notify', does: 'pushes a reminder to the task’s owner', requires: ['push'] },
	'push.escalate': { kind: 'notify', does: 'escalates an overdue task to the owner', requires: ['push'] },
	'push.counter': { kind: 'notify', does: 'asks the stock counter to count', requires: ['push'] }
};

export const requirementWords: Record<Requirement, string> = {
	'connection:xero': 'a connected Xero organisation',
	'connection:shopify': 'a connected Shopify store',
	inference: 'an inference runtime that is ready',
	push: 'a device subscribed to push'
};
