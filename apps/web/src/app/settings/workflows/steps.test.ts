import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkflowCatalog, WorkflowDefinition } from '../../../lib/api.ts';
import { predicateTokens, runStates, singular, stateWords, stepLines, words, type Line } from './steps.ts';

const catalog: WorkflowCatalog = {
	'gmail.newThreads': { kind: 'read', does: 'reads mail threads that arrived since the last run', until: null },
	'attachments.extractText': { kind: 'read', does: 'extracts text from allowed attachments under the size cap (D13)', until: null },
	'classifyThread': { kind: 'infer', does: 'classifies a thread: category, needs owner, summary, facts', until: null },
	'outbox.sent': { kind: 'await', does: 'waits until a person sends or discards the draft', until: 'the draft is sent or discarded' }
};
const definition: WorkflowDefinition = {
	key: 'inbox-triage', version: 1, name: 'Inbox triage', description: '', job: 1, triggers: [],
	parameters: { draftReplies: { type: 'boolean', description: 'Draft replies for threads that need you.', default: true } },
	steps: [
		{ kind: 'read', key: 'gmail.newThreads', as: 'threads' },
		{ kind: 'each', list: 'threads', steps: [
			{ kind: 'read', key: 'attachments.extractText', args: { thread: { ref: 'item' }, allow: ['application/pdf', 'text/csv'], maxBytes: 5_000_000 }, as: 'attachments' },
			{ kind: 'infer', key: 'classifyThread', schema: 'triage', tier: 'small', args: { thread: { ref: 'item' } }, as: 'triage' },
			{ kind: 'branch', when: { and: [{ truthy: 'triage.needsOwner' }, { param: 'draftReplies' }] }, then: [
				{ kind: 'await', key: 'outbox.sent', args: { draft: { ref: 'outboxDraft' } }, timeoutDays: 7 }
			] },
			{ kind: 'write', key: 'gmail.label', args: { thread: { ref: 'item' }, label: 'Captain/Handled' }, when: { not: { eq: ['item.status', 'done'] } } }
		] }
	]
};
const flat = (tokens: { text: string }[]) => tokens.map((t) => t.text).join('');
const step = (line: Line | undefined) => { if (!line || line.type !== 'step') throw new Error(`expected a step, got ${line?.type}`); return line; };
const each = (line: Line | undefined) => { if (!line || line.type !== 'each') throw new Error(`expected an each, got ${line?.type}`); return line; };

describe('workflow step lines', () => {
	it('names things in words', () => {
		assert.equal(words('needsOwner'), 'needs owner');
		assert.equal(singular('threads'), 'thread'); assert.equal(singular('invoices.invoices'), 'invoice'); assert.equal(singular('shopStock.items'), 'item');
	});
	it('walks each and branch with the engine’s path shape and the loop noun', () => {
		const lines = stepLines(definition, catalog);
		assert.deepEqual(lines.map((l) => [l.type, l.path]), [
			['step', 'steps.0'], ['each', 'steps.1'], ['step', 'steps.1.steps.0'], ['step', 'steps.1.steps.1'], ['if', 'steps.1.steps.2'],
			['step', 'steps.1.steps.2.then.0'], ['end', 'steps.1.steps.2.end'], ['step', 'steps.1.steps.3'], ['end', 'steps.1.end']
		]);
		assert.equal(each(lines[1]).noun, 'thread'); assert.equal(flat(each(lines[1]).list), 'threads');
		assert.equal(step(lines[0]).does, 'Reads mail threads that arrived since the last run'); assert.equal(step(lines[0]).savedAs, 'threads'); assert.equal(step(lines[0]).label, 'Read');
		assert.equal(step(lines[2]).does, 'Extracts text from allowed attachments under the size cap'); assert.equal(flat(step(lines[2]).detail[0]!), 'With thread: thread · allow: application/pdf, text/csv · max bytes: 5,000,000');
		assert.equal(step(lines[3]).label, 'Ask the model'); assert.equal(flat(step(lines[3]).detail[0]!), 'The small model, answering in the “triage” shape.');
		assert.equal(flat(step(lines[5]).detail[0]!), 'Until the draft is sent or discarded, giving up after 7 days.');
		assert.equal(step(lines[7]).does, 'Runs the step “gmail.label”'); assert.equal(flat(step(lines[7]).when!), 'thread status is not “done”');
	});
	it('says predicates in words with chips for values and settings', () => {
		const scope = { nouns: ['thread'], definition };
		const tokens = predicateTokens({ and: [{ truthy: 'triage.needsOwner' }, { param: 'draftReplies' }] }, scope);
		assert.equal(flat(tokens), 'triage needs owner and draft replies is on');
		assert.deepEqual(tokens.map((t) => t.kind), ['value', 'text', 'text', 'setting', 'text']);
		assert.equal(tokens[3]?.kind === 'setting' ? tokens[3].title : null, 'Draft replies for threads that need you.');
		assert.equal(flat(predicateTokens({ not: { truthy: 'item.active' } }, scope)), 'thread active is not set');
		assert.equal(flat(predicateTokens({ gt: ['count.total', 1000] }, scope)), 'count total is more than 1,000');
	});
	it('lays a run’s journal over the definition, counting loop items', () => {
		const states = runStates([
			{ path: 'steps.0', state: 'succeeded' }, { path: 'steps.1[0].steps.0', state: 'succeeded' }, { path: 'steps.1[1].steps.0', state: 'succeeded' },
			{ path: 'steps.1[0].steps.2.then.0', state: 'waiting' }, { path: 'steps.1[1].steps.2.then.0', state: 'failed' }, { path: 'steps.1[1].steps.3', state: 'skipped' }
		]);
		assert.deepEqual(stateWords(states.get('steps.0')!), { text: 'done', tone: 'done' });
		assert.deepEqual(stateWords(states.get('steps.1.steps.0')!), { text: 'done ×2', tone: 'done' });
		assert.deepEqual(stateWords(states.get('steps.1.steps.2.then.0')!), { text: 'waiting · failed', tone: 'failed' });
		assert.deepEqual(stateWords(states.get('steps.1.steps.3')!), { text: 'skipped', tone: 'quiet' });
		assert.equal(states.get('steps.1.steps.1'), undefined);
	});
});
