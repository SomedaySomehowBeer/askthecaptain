import { awaitStep, daily, defineWorkflow, each, notify, number, read } from '../definition.ts';

/** Shared task reminders and escalation. No correspondence or provider reads. */
export const chaseDue = defineWorkflow({
	key: 'chase-due', version: 4, name: 'Task reminders', job: 5,
	description: 'Reminds task owners before the due date and alerts the enabling person when a task is overdue.',
	triggers: [daily('07:00')],
	parameters: {
		windowDays: number('How many days ahead to look.', 7, { min: 1, max: 60, integer: true }),
		remindDaysBefore: number('Remind this many days before the due date.', 2, { min: 0, max: 30, integer: true }),
	},
	steps: [
		read('tasks.due', { args: { withinDays: { param: 'windowDays' } }, as: 'tasks' }),
		each('tasks', [
			awaitStep('time.beforeDue', { args: { task: { ref: 'item' }, daysBefore: { param: 'remindDaysBefore' } }, timeoutDays: 90, as: 'item' }),
			notify('push.taskOwner', { args: { task: { ref: 'item' }, daysBefore: { param: 'remindDaysBefore' } }, when: { truthy: 'item.active' } }),
			awaitStep('time.afterDue', { args: { task: { ref: 'item' } }, timeoutDays: 90, as: 'item' }),
			notify('push.escalate', { args: { task: { ref: 'item' } }, when: { and: [{ truthy: 'item.active' }, { not: { eq: ['item.status', 'done'] } }] } })
		], { independent: true })
	]
});
