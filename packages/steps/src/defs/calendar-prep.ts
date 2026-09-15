import { daily, defineWorkflow, each, infer, read, write } from '../definition.ts';

/** Plan §6: each evening, for tomorrow's events, read related threads and contacts and write a
 *  one-paragraph preparation note onto the event. */
export const calendarPrep = defineWorkflow({
	key: 'calendar-prep', version: 1, name: 'Prepare for tomorrow', job: 3,
	description: 'Each evening, attaches a short preparation note to tomorrow’s meetings from your recent mail with those people.',
	triggers: [daily('18:00')],
	parameters: {},
	steps: [
		read('calendar.tomorrow', { as: 'events' }),
		each('events', [
			read('contacts.forEvent', { args: { event: { ref: 'item' } }, as: 'people' }),
			read('mail.relatedThreads', { args: { event: { ref: 'item' }, people: { ref: 'people' } }, as: 'threads' }),
			infer('prepareEventNote', { schema: 'note', tier: 'large', args: { event: { ref: 'item' }, people: { ref: 'people' }, threads: { ref: 'threads' } }, as: 'note' }),
			write('calendar.writeNote', { args: { event: { ref: 'item' }, note: { ref: 'note' } } })
		])
	]
});
