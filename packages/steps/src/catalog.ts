import type { StepKind } from './definition.ts';

/** What a step needs before an organisation can enable a workflow that uses it (plan §6: a
 *  definition that names a capability the enabling person lacks fails at enablement). */
export type Requirement = 'connection:google' | 'connection:xero' | 'connection:shopify' | 'inference' | 'push';

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

/** The step catalogue (plan §6). Keys are stable names the runner binds to services and connectors;
 *  a definition may only name keys that exist here, with the matching kind. */
export const catalog: Record<string, CatalogEntry> = {
	// read
	'gmail.newThreads': { kind: 'read', does: 'reads mail threads that arrived since the last run', requires: ['connection:google'] },
	'attachments.extractText': { kind: 'read', does: 'extracts text from allowed attachments under the size cap (D13)', requires: ['connection:google'] },
	'tasks.due': { kind: 'read', does: 'reads tasks due within a window, and overdue ones', requires: [] },
	'tasks.overdueAndThisWeek': { kind: 'read', does: 'reads overdue tasks and tasks due this week', requires: [] },
	'outbox.waiting': { kind: 'read', does: 'reads drafts waiting in the outbox', requires: [] },
	'calendar.today': { kind: 'read', does: "reads today's cached events and connection state", requires: [] },
	'calendar.tomorrow': { kind: 'read', does: "reads tomorrow's events", requires: ['connection:google'] },
	'mail.relatedThreads': { kind: 'read', does: 'reads recent threads with the people in an event', requires: ['connection:google'] },
	'contacts.forEvent': { kind: 'read', does: 'reads the contacts attending an event', requires: [] },
	'xero.overdueReceivables': { kind: 'read', does: 'reads cached overdue invoices and explicit Xero connection state', requires: [] },
	'stock.items': { kind: 'read', does: 'reads the counted stock list for a location', requires: [] },
	'shopify.stockLevels': { kind: 'read', does: 'reads sellable stock levels from the shop', requires: ['connection:shopify'] },
	// infer
	'classifyThread': { kind: 'infer', does: 'classifies a thread: category, needs owner, summary, facts', requires: ['inference'], schemas: ['triage'] },
	'draftReply': { kind: 'infer', does: 'drafts a reply in the owner’s voice', requires: ['inference'], schemas: ['draft'] },
	'writeBrief': { kind: 'infer', does: 'writes the morning brief from the day’s data', requires: ['inference'], schemas: ['brief'] },
	'draftChaser': { kind: 'infer', does: 'drafts a courteous chaser for an overdue invoice', requires: ['inference'], schemas: ['draft'] },
	'prepareEventNote': { kind: 'infer', does: 'writes a one-paragraph preparation note for an event', requires: ['inference'], schemas: ['note'] },
	'draftOrderEmail': { kind: 'infer', does: 'drafts a short order email to the preferred supplier', requires: ['inference'], schemas: ['draft'] },
	// write
	'briefs.record': { kind: 'write', does: 'saves the validated morning brief for Today', requires: [] },
	'triage.record': { kind: 'write', does: 'records the triage result for the thread', requires: [] },
	'tasks.suggestFromTriage': { kind: 'write', does: 'creates suggested tasks from the facts found', requires: [] },
	'tasks.completeFromConfirmations': { kind: 'write', does: 'completes duties whose confirmation arrived', requires: [] },
	'contacts.upsertFromTriage': { kind: 'write', does: 'keeps contacts current from the thread', requires: [] },
	'outbox.create': { kind: 'write', does: 'puts a draft in the outbox for a person to send (D5)', requires: [] },
	'gmail.label': { kind: 'write', does: 'labels the thread in Gmail', requires: ['connection:google'] },
	'tasks.createInProject': { kind: 'write', does: 'creates a task in a named project', requires: [] },
	'stock.recordCount': { kind: 'write', does: 'records a stock count', requires: [] },
	'calendar.writeNote': { kind: 'write', does: 'attaches a preparation note to an event', requires: ['connection:google'] },
	// await
	'outbox.sent': { kind: 'await', does: 'waits until a person sends or discards the draft', requires: [], until: 'the draft is sent or discarded' },
	'time.beforeDue': { kind: 'await', does: 'waits until the reminder time before a task is due', requires: [], until: 'the reminder time' },
	'time.afterDue': { kind: 'await', does: 'waits until a task is past due', requires: [], until: 'the due date has passed' },
	'stock.counted': { kind: 'await', does: 'waits for the counter to enter a count', requires: [], until: 'a count is entered' },
	// notify
	'push.owner': { kind: 'notify', does: 'pushes a message to the owner', requires: ['push'] },
	'push.taskOwner': { kind: 'notify', does: 'pushes a reminder to the task’s owner', requires: ['push'] },
	'push.escalate': { kind: 'notify', does: 'escalates an overdue task to the owner', requires: ['push'] },
	'push.counter': { kind: 'notify', does: 'asks the stock counter to count', requires: ['push'] }
};

export const requirementWords: Record<Requirement, string> = {
	'connection:google': 'a connected Google account',
	'connection:xero': 'a connected Xero organisation',
	'connection:shopify': 'a connected Shopify store',
	inference: 'an inference runtime that is ready',
	push: 'a device subscribed to push'
};
