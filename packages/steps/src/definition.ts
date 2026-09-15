/** Workflow definitions (plan §6, D3). A definition is data: an ordered composition of typed steps
 *  with deterministic, bounded control flow. It is engine-neutral so the same definition runs on
 *  whichever execution engine §4 settles on, and it is journaled as it ran. Predicates are data
 *  expressions over earlier outputs and parameters, never functions and never model calls. */

export type Tier = 'small' | 'large';
export type StepKind = 'read' | 'infer' | 'write' | 'await' | 'notify';

/** A value reference: a dotted path into the run's data. Paths start with the name an earlier step
 *  was saved `as`, `item` inside an `each`, or `params` for the enablement's parameters. */
export type Path = string;

export type Predicate =
	| { truthy: Path }
	| { eq: [Path, string | number | boolean | null] }
	| { gt: [Path, number] }
	| { lt: [Path, number] }
	| { param: string }
	| { not: Predicate }
	| { and: Predicate[] }
	| { or: Predicate[] };

export type Args = Record<string, string | number | boolean | null | { ref: Path } | { param: string } | string[]>;

export type ActionStep = {
	kind: StepKind;
	/** A key from the step catalogue, for example `gmail.newThreads` or `tasks.suggestFromTriage`. */
	key: string;
	args?: Args;
	/** Name the output is saved under for later steps. */
	as?: string;
	/** The step runs only if this holds. */
	when?: Predicate;
	/** Infer steps only: the output schema key from the catalogue, and the model tier. */
	schema?: string;
	tier?: Tier;
	/** Await steps only: give up after this many days. */
	timeoutDays?: number;
};
export type EachStep = { kind: 'each'; list: Path; steps: Step[] };
export type BranchStep = { kind: 'branch'; when: Predicate; then: Step[]; else?: Step[] };
export type Step = ActionStep | EachStep | BranchStep;

export type Trigger =
	| { kind: 'event'; event: string }
	| { kind: 'daily'; at: string }
	| { kind: 'weekly'; day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; at: string }
	| { kind: 'manual' };

export type ParameterSpec =
	| { type: 'text'; description: string; default?: string; required?: boolean; maxLength?: number }
	| { type: 'boolean'; description: string; default: boolean }
	| { type: 'number'; description: string; default: number; min?: number; max?: number };

export type WorkflowDefinition = {
	key: string;
	version: number;
	name: string;
	/** One sentence in the owner's words: what it does for the business. */
	description: string;
	/** The job in plan §2 it moves sooner. */
	job: 1 | 2 | 3 | 4 | 5 | 6;
	triggers: Trigger[];
	parameters: Record<string, ParameterSpec>;
	steps: Step[];
};

// Small builders so definitions read like the plan's example while staying plain data.
export const read = (key: string, options: Omit<ActionStep, 'kind' | 'key'> = {}): ActionStep => ({ kind: 'read', key, ...options });
export const write = (key: string, options: Omit<ActionStep, 'kind' | 'key'> = {}): ActionStep => ({ kind: 'write', key, ...options });
export const notify = (key: string, options: Omit<ActionStep, 'kind' | 'key'> = {}): ActionStep => ({ kind: 'notify', key, ...options });
export const infer = (key: string, options: Omit<ActionStep, 'kind' | 'key' | 'schema' | 'tier'> & { schema: string; tier: Tier }): ActionStep => ({ kind: 'infer', key, ...options });
export const awaitStep = (key: string, options: Omit<ActionStep, 'kind' | 'key'> & { timeoutDays: number }): ActionStep => ({ kind: 'await', key, ...options });
export const each = (list: Path, steps: Step[]): EachStep => ({ kind: 'each', list, steps });
export const branch = (when: Predicate, then: Step[], otherwise?: Step[]): BranchStep => otherwise ? { kind: 'branch', when, then, else: otherwise } : { kind: 'branch', when, then };
export const onEvent = (event: string): Trigger => ({ kind: 'event', event });
export const daily = (at: string): Trigger => ({ kind: 'daily', at });
export const weekly = (day: Extract<Trigger, { kind: 'weekly' }>['day'], at: string): Trigger => ({ kind: 'weekly', day, at });
export const manual = (): Trigger => ({ kind: 'manual' });
export const text = (description: string, options: { default?: string; required?: boolean; maxLength?: number } = {}): ParameterSpec => ({ type: 'text', description, ...options });
export const boolean = (description: string, defaultValue: boolean): ParameterSpec => ({ type: 'boolean', description, default: defaultValue });
export const number = (description: string, defaultValue: number, options: { min?: number; max?: number } = {}): ParameterSpec => ({ type: 'number', description, default: defaultValue, ...options });
export const ref = (path: Path) => ({ ref: path });
export const param = (name: string) => ({ param: name });

export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition { return definition; }

/** Evaluate a predicate over run data. `data` maps saved names (and `item`, `params`) to values. */
export function evaluate(predicate: Predicate, data: Record<string, unknown>): boolean {
	if ('truthy' in predicate) return Boolean(lookup(data, predicate.truthy));
	if ('eq' in predicate) return lookup(data, predicate.eq[0]) === predicate.eq[1];
	if ('gt' in predicate) { const value = lookup(data, predicate.gt[0]); return typeof value === 'number' && value > predicate.gt[1]; }
	if ('lt' in predicate) { const value = lookup(data, predicate.lt[0]); return typeof value === 'number' && value < predicate.lt[1]; }
	if ('param' in predicate) return Boolean(lookup(data, `params.${predicate.param}`));
	if ('not' in predicate) return !evaluate(predicate.not, data);
	if ('and' in predicate) return predicate.and.every((p) => evaluate(p, data));
	return predicate.or.some((p) => evaluate(p, data));
}

export function lookup(data: Record<string, unknown>, path: Path): unknown {
	let current: unknown = data;
	for (const part of path.split('.')) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** The names a predicate reads, for validation. */
export function predicatePaths(predicate: Predicate): Path[] {
	if ('truthy' in predicate) return [predicate.truthy];
	if ('eq' in predicate) return [predicate.eq[0]];
	if ('gt' in predicate) return [predicate.gt[0]];
	if ('lt' in predicate) return [predicate.lt[0]];
	if ('param' in predicate) return [`params.${predicate.param}`];
	if ('not' in predicate) return predicatePaths(predicate.not);
	if ('and' in predicate) return predicate.and.flatMap(predicatePaths);
	return predicate.or.flatMap(predicatePaths);
}
