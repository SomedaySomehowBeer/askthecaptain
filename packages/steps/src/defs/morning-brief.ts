import { daily, defineWorkflow, infer, notify, read, text, write } from '../definition.ts';

/** Plan §6: at 06:30 read what is overdue and due this week, the outbox, today's events and overdue
 *  receivables, write a brief from that data, and push it to the owner. */
export const morningBrief = defineWorkflow({
	key: 'morning-brief', version: 2, name: 'Morning brief', job: 6,
	description: 'A short brief on your phone each morning: what is due, what is waiting, and who you are seeing.',
	triggers: [daily('06:30')],
	parameters: { tone: text('How the brief should read, in a sentence.', { maxLength: 400, default: 'Plain and brief.' }) },
	steps: [
		read('tasks.overdueAndThisWeek', { as: 'tasks' }),
		read('outbox.waiting', { as: 'outbox' }),
		read('calendar.today', { args: { today: { ref: 'tasks.today' }, tomorrow: { ref: 'tasks.tomorrow' } }, as: 'events' }),
		read('xero.overdueReceivables', { args: { today: { ref: 'tasks.today' } }, as: 'receivables' }),
		infer('writeBrief', { schema: 'brief', tier: 'large', args: { tasks: { ref: 'tasks' }, outbox: { ref: 'outbox' }, events: { ref: 'events' }, receivables: { ref: 'receivables' }, tone: { param: 'tone' } }, as: 'brief' }),
		write('briefs.record', { args: { brief: { ref: 'brief' }, tasks: { ref: 'tasks' }, outbox: { ref: 'outbox' }, events: { ref: 'events' }, receivables: { ref: 'receivables' } }, as: 'savedBrief' }),
		notify('push.owner', { args: { brief: { ref: 'savedBrief' } } })
	]
});
