import { awaitStep, branch, daily, defineWorkflow, each, infer, notify, number, read, write } from '../definition.ts';

/** Plan §6: daily, read tasks due within the window; for each, wait until the reminder time and
 *  remind the owner, escalate after due; for receivables, draft a courteous chaser into the outbox. */
export const chaseDue = defineWorkflow({
	key: 'chase-due', version: 1, name: 'Chase what is due', job: 5,
	description: 'Reminds owners before something is due, escalates after, and drafts polite chasers for overdue invoices.',
	triggers: [daily('07:00')],
	parameters: {
		windowDays: number('How many days ahead to look.', 7, { min: 1, max: 60 }),
		remindDaysBefore: number('Remind this many days before the due date.', 2, { min: 0, max: 30 }),
		chaseInvoicesAfterDays: number('Draft a chaser once an invoice is this many days overdue.', 14, { min: 1, max: 120 })
	},
	steps: [
		read('tasks.due', { args: { withinDays: { param: 'windowDays' } }, as: 'tasks' }),
		each('tasks', [
			awaitStep('time.beforeDue', { args: { task: { ref: 'item' }, daysBefore: { param: 'remindDaysBefore' } }, timeoutDays: 60 }),
			notify('push.taskOwner', { args: { task: { ref: 'item' } } }),
			awaitStep('time.afterDue', { args: { task: { ref: 'item' } }, timeoutDays: 60 }),
			notify('push.escalate', { args: { task: { ref: 'item' } }, when: { not: { eq: ['item.status', 'done'] } } })
		]),
		read('xero.overdueReceivables', { args: { overdueDays: { param: 'chaseInvoicesAfterDays' } }, as: 'invoices' }),
		each('invoices', [
			branch({ truthy: 'item.contactEmail' }, [
				infer('draftChaser', { schema: 'draft', tier: 'large', args: { invoice: { ref: 'item' } }, as: 'draft' }),
				write('outbox.create', { args: { to: { ref: 'item.contactEmail' }, draft: { ref: 'draft' } } })
			])
		])
	]
});
