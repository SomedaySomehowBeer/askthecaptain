import { daily, defineWorkflow, each, infer, manual, notify, onEvent, read, write } from '../definition.ts';

/** Plan §6 and D22. At 06:00, when a person asks from a thread, a note or Commitments, or on demand: read the
 *  seeds (candidate names past their thresholds, suggested duties sharing a reference, a thread or note a person
 *  chose, or clusters of the backlog on the first run; at most ten a run); for each, gather the nearest threads
 *  and notes from the index and widen deterministically; ask the model once what the evidence amounts to; write a
 *  proposed project with its brief, links, suggested tasks and evidence, or one suggested task, or a company link.
 *  Nothing is active until a person accepts it on Commitments. */
export const discoverProjects = defineWorkflow({
	key: 'discover-projects', version: 1, name: 'Discover projects', job: 4,
	description: 'Finds the projects your mail and notes are about and proposes them, with a brief and tasks, for you to accept.',
	triggers: [daily('06:00'), onEvent('discovery.requested'), manual()],
	parameters: {},
	steps: [
		read('discovery.seeds', { as: 'seeds' }),
		each('seeds', [
			read('discovery.evidence', { args: { seed: { ref: 'item' } }, as: 'evidence' }),
			infer('discoverProject', { schema: 'discovery', tier: 'large', args: { seed: { ref: 'item' }, evidence: { ref: 'evidence' } }, as: 'answer' }),
			write('discovery.record', { args: { seed: { ref: 'item' }, evidence: { ref: 'evidence' }, answer: { ref: 'answer' } }, as: 'outcome' })
		], { independent: true }),
		notify('discovery.notify', { args: { seeds: { ref: 'seeds' } } })
	]
});
