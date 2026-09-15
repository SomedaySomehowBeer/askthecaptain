import { awaitStep, branch, daily, defineWorkflow, each, infer, notify, number, read, write } from '../definition.ts';

/** Plan §6: daily, read tasks due within the window; for each, wait until the reminder time and
 *  remind the owner, escalate after due; for receivables, draft a courteous chaser into the outbox. */
export const chaseDue = defineWorkflow({
	key: 'chase-due', version: 3, name: 'Chase what is due', job: 5,
	description: 'Reminds owners before something is due, escalates after, and drafts polite chasers for overdue invoices.',
	triggers: [daily('07:00')],
	parameters: {
		windowDays: number('How many days ahead to look.', 7, { min: 1, max: 60, integer: true }),
		remindDaysBefore: number('Remind this many days before the due date.', 2, { min: 0, max: 30, integer: true }),
		chaseAgainAfterDays: number('Wait this many days after sending before drafting another chaser.', 7, { min: 1, max: 365, integer: true }),
		chaseInvoicesAfterDays: number('Draft a chaser once an invoice is this many days overdue.', 14, { min: 1, max: 120, integer: true })
	},
	steps: [
		read('tasks.due', { args: { withinDays: { param: 'windowDays' } }, as: 'tasks' }),
		each('tasks', [
			awaitStep('time.beforeDue', { args: { task: { ref: 'item' }, daysBefore: { param: 'remindDaysBefore' } }, timeoutDays: 90, as: 'item' }),
			notify('push.taskOwner', { args: { task: { ref: 'item' }, daysBefore: { param: 'remindDaysBefore' } }, when: { truthy: 'item.active' } }),
			awaitStep('time.afterDue', { args: { task: { ref: 'item' } }, timeoutDays: 90, as: 'item' }),
			notify('push.escalate', { args: { task: { ref: 'item' } }, when: { and: [{ truthy: 'item.active' }, { not: { eq: ['item.status', 'done'] } }] } })
		], { independent: true }),
		read('xero.overdueReceivables', { args: { overdueDays: { param: 'chaseInvoicesAfterDays' }, requireComplete: true }, as: 'invoices' }),
		each('invoices.invoices', [
			branch({ truthy: 'item.contactEmail' }, [
				infer('draftChaser', { schema: 'draft', tier: 'large', args: { invoice: { ref: 'item' } }, as: 'draft' }),
				write('outbox.create', { args: { chaseAgainAfterDays: { param: 'chaseAgainAfterDays' }, to: { ref: 'item.contactEmail' }, invoice: { ref: 'item' }, draft: { ref: 'draft' } } })
			])
		])
	]
});
