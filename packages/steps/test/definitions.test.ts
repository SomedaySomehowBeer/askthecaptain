import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalog, definitions, digestOf, evaluate, requirementWords, requirementsOf, resolveParameters, validateDefinition, type ActionStep, type Catalog, type Step, type WorkflowDefinition } from '../src/index.ts';
import { awaitStep, defineWorkflow, each, infer, manual, read, write } from '../src/definition.ts';

/** A catalogue for validation tests only. The product offers no infer step today, but D2 infer
 *  validation (schema, tier, kind) must keep working for the next business workflow that needs one. */
const testCatalog: Catalog = {
	'test.read': { kind: 'read', does: 'reads test records', requires: [] },
	'test.summarise': { kind: 'infer', does: 'summarises test records', requires: ['inference'], schemas: ['summary'] },
	'test.wait': { kind: 'await', does: 'waits for a test record', requires: [], until: 'the record is ready' }
};
const keysOf = (steps: Step[], found = new Map<string, string>()): Map<string, string> => {
	for (const step of steps) {
		if (step.kind === 'each') keysOf(step.steps, found);
		else if (step.kind === 'branch') { keysOf(step.then, found); keysOf(step.else ?? [], found); }
		else found.set(step.key, step.kind);
	}
	return found;
};

test('every shipped definition is valid and has a stable digest', () => {
	for (const definition of definitions) {
		assert.deepEqual(validateDefinition(definition), [], definition.key);
		assert.equal(digestOf(definition), digestOf(structuredClone(definition)), `${definition.key} digest is deterministic`);
	}
	assert.deepEqual(definitions.map((d) => d.key), ['chase-due', 'stocktake']);
});

test('requirements are collected from every step, including nested ones', () => {
	assert.deepEqual(requirementsOf(definitions[0]!).sort(), ['push']);
	assert.deepEqual(requirementsOf(definitions[1]!).sort(), ['push']);
});

test('the product catalogue holds exactly the steps the offered workflows use, with their kinds and known requirements', () => {
	const used = new Map<string, string>();
	for (const definition of definitions) keysOf(definition.steps, used);
	assert.deepEqual(Object.keys(catalog).sort(), [...used.keys()].sort());
	for (const [key, kind] of used) assert.equal(catalog[key]!.kind, kind, key);
	for (const entry of Object.values(catalog)) for (const requirement of entry.requires) assert.ok(requirement in requirementWords, requirement);
	assert.ok(!('connection:google' in requirementWords));
});

test('the retired assistant steps are no longer in the product catalogue', () => {
	const retired = defineWorkflow({ key: 'retired', version: 1, name: 'Retired', description: 'x', job: 1, triggers: [manual()], parameters: {},
		steps: [read('gmail.newThreads', { as: 'threads' }), infer('classifyThread', { schema: 'triage', tier: 'small', args: { t: { ref: 'threads' } } }), write('outbox.create')] });
	assert.deepEqual(validateDefinition(retired).map((p) => `${p.path}: ${p.message}`), ['steps.0.key: gmail.newThreads is not in the step catalogue',
		'steps.1.key: classifyThread is not in the step catalogue', 'steps.2.key: outbox.create is not in the step catalogue']);
	assert.deepEqual(requirementsOf(retired), []);
});

test('a definition that names an unknown step, the wrong kind, or an unsaved reference is refused', () => {
	const bad: WorkflowDefinition = defineWorkflow({
		key: 'bad', version: 1, name: 'Bad', description: 'x', job: 1, triggers: [{ kind: 'daily', at: '25:00' }], parameters: { limit: { type: 'number', description: 'n', default: 1, min: 5, max: 1 } },
		steps: [
			read('nope', { as: 'a' }),
			write('test.read'),
			infer('test.summarise', { schema: 'brief', tier: 'small', args: { t: { ref: 'threads' } } }),
			awaitStep('test.wait', { timeoutDays: 0, when: { param: 'missing' } }),
			each('a', [each('item', [each('item', [each('item', [read('test.read')])])])])
		]
	});
	const messages = validateDefinition(bad, testCatalog).map((p) => `${p.path}: ${p.message}`);
	for (const expected of ['triggers.0.at: must be HH:MM', 'parameters.limit: min is above max', 'steps.0.key: nope is not in the step catalogue',
		'steps.1.kind: test.read is a read step, not write', 'steps.2.schema: test.summarise does not produce brief', 'steps.2.args.t: threads refers to nothing saved before this step',
		'steps.3.timeoutDays: an await step has a positive timeout in days', 'steps.3.when: parameter missing is not declared'])
		assert.ok(messages.includes(expected), `expected "${expected}" in ${JSON.stringify(messages)}`);
	assert.ok(messages.some((m) => m.includes('nesting deeper than 3')));
});

test('an infer step is validated for its schema and tier and carries the inference requirement (D2)', () => {
	const summary = defineWorkflow({ key: 'summary', version: 1, name: 'Summary', description: 'x', job: 5, triggers: [manual()], parameters: {},
		steps: [read('test.read', { as: 'records' }), infer('test.summarise', { schema: 'summary', tier: 'large', args: { records: { ref: 'records' } }, as: 'result' })] });
	assert.deepEqual(validateDefinition(summary, testCatalog), []);
	assert.deepEqual(requirementsOf(summary, testCatalog), ['inference']);
	const bare: ActionStep = { kind: 'infer', key: 'test.summarise' };
	const messages = validateDefinition({ ...summary, steps: [bare] }, testCatalog).map((p) => `${p.path}: ${p.message}`);
	assert.deepEqual(messages, ['steps.0.schema: an infer step names its output schema', 'steps.0.tier: an infer step declares a tier']);
	assert.deepEqual(validateDefinition(summary).map((p) => p.path), ['steps.0.key', 'steps.1.key'], 'the product catalogue offers neither test step');
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
	const specs = definitions[0]!.parameters;
	assert.deepEqual(resolveParameters(specs, {}), { values: { windowDays: 7, remindDaysBefore: 2 }, problems: [] });
	assert.deepEqual(resolveParameters(specs, { windowDays: 1.5 }).problems, [{ path: 'windowDays', message: 'must be a whole number' }]);
	const bad = resolveParameters(specs, { windowDays: 90, remindDaysBefore: 'two', extra: 1 });
	assert.deepEqual(bad.problems.map((p) => p.path).sort(), ['extra', 'remindDaysBefore', 'windowDays']);
	const stock = resolveParameters(definitions[1]!.parameters, { location: '  ' });
	assert.deepEqual(stock.problems, [{ path: 'location', message: 'is required' }]);
});
