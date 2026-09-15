import { createHash } from 'node:crypto';
import { catalog, type Requirement } from './catalog.ts';
import { predicatePaths, type ParameterSpec, type Step, type WorkflowDefinition } from './definition.ts';

export type Problem = { path: string; message: string };
const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const key = /^[a-z][a-z0-9-]{1,40}$/;
const name = /^[a-z][A-Za-z0-9]*$/;
const MAX_DEPTH = 3;

/** Checks a definition is well-formed before it is offered to anyone: every step key exists in the
 *  catalogue with the right kind, every reference names something an earlier step saved (or the
 *  loop item, or a parameter), control flow is bounded, and triggers and parameters are sane. */
export function validateDefinition(definition: WorkflowDefinition): Problem[] {
	const problems: Problem[] = [];
	const at = (path: string, message: string) => problems.push({ path, message });
	if (!key.test(definition.key)) at('key', 'must be lower-case words joined by hyphens');
	if (!Number.isInteger(definition.version) || definition.version < 1) at('version', 'must be a positive integer');
	if (!definition.name.trim()) at('name', 'is required');
	if (!definition.description.trim()) at('description', 'is required');
	if (![1, 2, 3, 4, 5, 6].includes(definition.job)) at('job', 'must be one of the six jobs');
	if (definition.triggers.length === 0) at('triggers', 'at least one trigger');
	definition.triggers.forEach((trigger, i) => {
		if ((trigger.kind === 'daily' || trigger.kind === 'weekly') && !time.test(trigger.at)) at(`triggers.${i}.at`, 'must be HH:MM');
		if (trigger.kind === 'event' && !/^[a-z]+(\.[a-z]+)+$/.test(trigger.event)) at(`triggers.${i}.event`, 'must look like mail.synced');
	});
	for (const [paramName, spec] of Object.entries(definition.parameters)) {
		if (!name.test(paramName)) at(`parameters.${paramName}`, 'must be a camelCase name');
		if (spec.type === 'number' && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) at(`parameters.${paramName}`, 'min is above max');
	}
	if (definition.steps.length === 0) at('steps', 'at least one step');
	const params = new Set(Object.keys(definition.parameters));
	walk(definition.steps, 'steps', new Set<string>(), 0, params, at);
	return problems;
}

function walk(steps: Step[], path: string, saved: Set<string>, depth: number, params: Set<string>, at: (path: string, message: string) => void): void {
	if (depth > MAX_DEPTH) { at(path, `nesting deeper than ${MAX_DEPTH} is not allowed`); return; }
	steps.forEach((step, i) => {
		const here = `${path}.${i}`;
		if (step.kind === 'each') {
			checkPath(step.list, here + '.list', saved, params, at);
			walk(step.steps, here + '.steps', new Set([...saved, 'item']), depth + 1, params, at);
			return;
		}
		if (step.kind === 'branch') {
			for (const p of predicatePaths(step.when)) checkPath(p, here + '.when', saved, params, at);
			// Both arms see the same earlier outputs; what an arm saves is not promised after the branch.
			walk(step.then, here + '.then', new Set(saved), depth + 1, params, at);
			if (step.else) walk(step.else, here + '.else', new Set(saved), depth + 1, params, at);
			return;
		}
		const entry = catalog[step.key];
		if (!entry) { at(here + '.key', `${step.key} is not in the step catalogue`); return; }
		if (entry.kind !== step.kind) at(here + '.kind', `${step.key} is a ${entry.kind} step, not ${step.kind}`);
		if (step.kind === 'infer') {
			if (!step.schema) at(here + '.schema', 'an infer step names its output schema');
			else if (entry.schemas && !entry.schemas.includes(step.schema)) at(here + '.schema', `${step.key} does not produce ${step.schema}`);
			if (!step.tier) at(here + '.tier', 'an infer step declares a tier');
		}
		if (step.kind === 'await' && (!step.timeoutDays || step.timeoutDays <= 0)) at(here + '.timeoutDays', 'an await step has a positive timeout in days');
		if (step.when) for (const p of predicatePaths(step.when)) checkPath(p, here + '.when', saved, params, at);
		for (const [argName, value] of Object.entries(step.args ?? {})) {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				if ('ref' in value) checkPath(value.ref, `${here}.args.${argName}`, saved, params, at);
				if ('param' in value && !params.has(value.param)) at(`${here}.args.${argName}`, `parameter ${value.param} is not declared`);
			}
		}
		if (step.as) { if (!name.test(step.as)) at(here + '.as', 'must be a camelCase name'); else saved.add(step.as); }
	});
}

function checkPath(path: string, where: string, saved: Set<string>, params: Set<string>, at: (path: string, message: string) => void): void {
	const [root, second] = path.split('.');
	if (root === 'params') { if (!second || !params.has(second)) at(where, `parameter ${second ?? ''} is not declared`); return; }
	if (!root || !saved.has(root)) at(where, `${path} refers to nothing saved before this step`);
}

/** Every requirement any step in the definition has. */
export function requirementsOf(definition: WorkflowDefinition): Requirement[] {
	const found = new Set<Requirement>();
	const visit = (steps: Step[]) => { for (const step of steps) {
		if (step.kind === 'each') visit(step.steps);
		else if (step.kind === 'branch') { visit(step.then); if (step.else) visit(step.else); }
		else for (const r of catalog[step.key]?.requires ?? []) found.add(r);
	} };
	visit(definition.steps);
	return [...found];
}

/** Checks the parameters an organisation supplies against the specs and fills defaults. */
export function resolveParameters(specs: Record<string, ParameterSpec>, given: Record<string, unknown>): { values: Record<string, string | number | boolean>; problems: Problem[] } {
	const values: Record<string, string | number | boolean> = {}; const problems: Problem[] = [];
	for (const [paramName, spec] of Object.entries(specs)) {
		const raw = given[paramName];
		if (spec.type === 'text') {
			const value = typeof raw === 'string' ? raw.trim() : raw === undefined ? spec.default ?? '' : null;
			if (value === null) problems.push({ path: paramName, message: 'must be text' });
			else if (spec.required && !value) problems.push({ path: paramName, message: 'is required' });
			else if (spec.maxLength && value.length > spec.maxLength) problems.push({ path: paramName, message: `is longer than ${spec.maxLength} characters` });
			else values[paramName] = value;
		} else if (spec.type === 'boolean') {
			if (raw === undefined) values[paramName] = spec.default;
			else if (typeof raw === 'boolean') values[paramName] = raw;
			else problems.push({ path: paramName, message: 'must be true or false' });
		} else {
			const value = raw === undefined ? spec.default : raw;
			if (typeof value !== 'number' || !Number.isFinite(value)) problems.push({ path: paramName, message: 'must be a number' });
			else if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) problems.push({ path: paramName, message: `must be between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'}` });
			else values[paramName] = value;
		}
	}
	for (const extra of Object.keys(given)) if (!(extra in specs)) problems.push({ path: extra, message: 'is not a parameter of this workflow' });
	return { values, problems };
}

/** A stable digest of the definition's content, recorded on runs so the journal says which version ran. */
export function digestOf(definition: WorkflowDefinition): string {
	return createHash('sha256').update(JSON.stringify(definition, Object.keys(definition).sort())).digest('hex').slice(0, 16);
}
