import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitions, digestOf, evaluate, requirementsOf, resolveParameters, validateDefinition, type WorkflowDefinition } from '../src/index.ts';
import { awaitStep, defineWorkflow, each, infer, read, write } from '../src/definition.ts';

test('every shipped definition is valid and has a stable digest', () => {
	for (const definition of definitions) {
		assert.deepEqual(validateDefinition(definition), [], definition.key);
		assert.equal(digestOf(definition), digestOf(structuredClone(definition)), `${definition.key} digest is deterministic`);
	}
	assert.deepEqual(definitions.map((d) => d.key), ['inbox-triage', 'morning-brief', 'chase-due', 'calendar-prep', 'stocktake']);
});

test('requirements are collected from every step, including nested ones', () => {
	assert.deepEqual(requirementsOf(definitions[0]!).sort(), ['connection:google', 'inference']);
	assert.deepEqual(requirementsOf(definitions[1]!).sort(), ['inference', 'push']);
	assert.deepEqual(requirementsOf(definitions[4]!).sort(), ['connection:shopify', 'inference', 'push']);
});

test('a definition that names an unknown step, the wrong kind, or an unsaved reference is refused', () => {
	const bad: WorkflowDefinition = defineWorkflow({
		key: 'bad', version: 1, name: 'Bad', description: 'x', job: 1, triggers: [{ kind: 'daily', at: '25:00' }], parameters: { limit: { type: 'number', description: 'n', default: 1, min: 5, max: 1 } },
		steps: [
			read('nope', { as: 'a' }),
			write('gmail.newThreads'),
			infer('classifyThread', { schema: 'brief', tier: 'small', args: { t: { ref: 'threads' } } }),
			awaitStep('outbox.sent', { timeoutDays: 0, when: { param: 'missing' } }),
			each('a', [each('item', [each('item', [each('item', [read('tasks.due')])])])])
		]
	});
	const messages = validateDefinition(bad).map((p) => `${p.path}: ${p.message}`);
	for (const expected of ['triggers.0.at: must be HH:MM', 'parameters.limit: min is above max', 'steps.0.key: nope is not in the step catalogue',
		'steps.1.kind: gmail.newThreads is a read step, not write', 'steps.2.schema: classifyThread does not produce brief', 'steps.2.args.t: threads refers to nothing saved before this step',
		'steps.3.timeoutDays: an await step has a positive timeout in days', 'steps.3.when: parameter missing is not declared'])
		assert.ok(messages.includes(expected), `expected "${expected}" in ${JSON.stringify(messages)}`);
	assert.ok(messages.some((m) => m.includes('nesting deeper than 3')));
});

test('predicates evaluate over saved outputs, the loop item and parameters', () => {
	const data = { item: { status: 'open', amount: 12 }, triage: { needsOwner: true }, params: { draftReplies: false } };
	assert.equal(evaluate({ truthy: 'triage.needsOwner' }, data), true);
	assert.equal(evaluate({ and: [{ truthy: 'triage.needsOwner' }, { param: 'draftReplies' }] }, data), false);
	assert.equal(evaluate({ not: { eq: ['item.status', 'done'] } }, data), true);
	assert.equal(evaluate({ or: [{ gt: ['item.amount', 20] }, { lt: ['item.amount', 20] }] }, data), true);
	assert.equal(evaluate({ truthy: 'missing.path' }, data), false);
});

test('parameters are checked against their specs and defaults are filled', () => {
	const specs = definitions[2]!.parameters;
	assert.deepEqual(resolveParameters(specs, {}), { values: { windowDays: 7, remindDaysBefore: 2, chaseInvoicesAfterDays: 14 }, problems: [] });
	assert.deepEqual(resolveParameters(specs, { windowDays: 1.5 }).problems, [{ path: 'windowDays', message: 'must be a whole number' }]);
	const bad = resolveParameters(specs, { windowDays: 90, remindDaysBefore: 'two', extra: 1 });
	assert.deepEqual(bad.problems.map((p) => p.path).sort(), ['extra', 'remindDaysBefore', 'windowDays']);
	const stock = resolveParameters(definitions[4]!.parameters, { location: '  ' });
	assert.deepEqual(stock.problems, [{ path: 'location', message: 'is required' }]);
	assert.deepEqual(resolveParameters(definitions[0]!.parameters, { replyStyle: 'Warm, short.' }).values, { replyStyle: 'Warm, short.', draftReplies: true });
});
