import { daily, defineWorkflow, infer, notify, read, text } from '../definition.ts';

/** Plan §6: at 06:30 read what is overdue and due this week, the outbox, today's events and overdue
 *  receivables, write a brief from that data, and push it to the owner. */
export const morningBrief = defineWorkflow({
	key: 'morning-brief', version: 1, name: 'Morning brief', job: 6,
	description: 'A short brief on your phone each morning: what is due, what is waiting, and who you are seeing.',
	triggers: [daily('06:30')],
	parameters: { tone: text('How the brief should read, in a sentence.', { maxLength: 400, default: 'Plain and brief.' }) },
	steps: [
		read('tasks.overdueAndThisWeek', { as: 'tasks' }),
		read('outbox.waiting', { as: 'outbox' }),
		read('calendar.today', { as: 'events' }),
		read('xero.overdueReceivables', { as: 'receivables' }),
		infer('writeBrief', { schema: 'brief', tier: 'large', args: { tasks: { ref: 'tasks' }, outbox: { ref: 'outbox' }, events: { ref: 'events' }, receivables: { ref: 'receivables' }, tone: { param: 'tone' } }, as: 'brief' }),
		notify('push.owner', { args: { brief: { ref: 'brief' } } })
	]
});
