import type { WorkflowActionStep, WorkflowArg, WorkflowCatalog, WorkflowDefinition, WorkflowPredicate, WorkflowStep, WorkflowTrigger } from '../../../lib/api.ts';

/** Turns a workflow definition (plan §6, D3) into lines a person can read, one per step, in the
 *  manner of a shortcut: the catalogue's words for what the step does, the values it uses and
 *  saves as chips, and `each` and `branch` as indented blocks. Pure; the page renders the lines.
 *  Paths match the engine's journal paths with the loop index removed, so a run's step states can
 *  be laid over the same lines. */

export type Token = { kind: 'text'; text: string } | { kind: 'value'; text: string } | { kind: 'setting'; text: string; title?: string };
export type ActionKind = WorkflowActionStep['kind'];
export type Line =
	| { type: 'step'; path: string; depth: number; kind: ActionKind; label: string; does: string; detail: Token[][]; when: Token[] | null; savedAs: string | null }
	| { type: 'each'; path: string; depth: number; noun: string; list: Token[]; independent: boolean }
	| { type: 'if'; path: string; depth: number; when: Token[] }
	| { type: 'otherwise'; path: string; depth: number }
	| { type: 'end'; path: string; depth: number; of: 'each' | 'if'; noun?: string };

export const kindLabels: Record<ActionKind, string> = { read: 'Read', infer: 'Ask the model', write: 'Write', await: 'Wait', notify: 'Notify' };

const days: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
export const triggerWords = (trigger: WorkflowTrigger): string =>
	trigger.kind === 'daily' ? `every day at ${trigger.at}` : trigger.kind === 'weekly' ? `every ${days[trigger.day] ?? trigger.day} at ${trigger.at}`
	: trigger.kind === 'event' ? (trigger.event === 'mail.synced' ? 'when mail arrives' : `when ${trigger.event.replace('.', ' ')}`) : 'when you ask';

/** `needsOwner` → `needs owner`. */
export const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
/** The noun for one item of a list named `threads` or `invoices.invoices`. */
export const singular = (list: string): string => { const last = words(list.split('.').pop() ?? list); return last.length > 3 && last.endsWith('s') && !last.endsWith('ss') ? last.slice(0, -1) : last; };
const text = (t: string): Token => ({ kind: 'text', text: t });
const value = (t: string): Token => ({ kind: 'value', text: t });

type Scope = { nouns: string[]; definition: WorkflowDefinition };

function setting(name: string, scope: Scope): Token {
	const spec = scope.definition.parameters[name];
	return { kind: 'setting', text: words(name), ...(spec ? { title: spec.description } : {}) };
}

/** `triage.needsOwner` → [triage] needs owner; `item.status` inside each thread → [thread] status. */
function pathTokens(path: string, scope: Scope): Token[] {
	const [head, ...rest] = path.split('.');
	const tail = rest.map(words).join(' ');
	if (head === 'params') return [setting(rest[0] ?? '', scope), ...(rest.length > 1 ? [text(` ${rest.slice(1).map(words).join(' ')}`)] : [])];
	const name = head === 'item' ? scope.nouns[scope.nouns.length - 1] ?? 'item' : head === 'trigger' ? 'the trigger' : words(head ?? '');
	return tail ? [value(name), text(` ${tail}`)] : [value(name)];
}

const literal = (arg: string | number | boolean | null): string =>
	typeof arg === 'string' ? `“${arg}”` : typeof arg === 'number' ? arg.toLocaleString('en-AU') : typeof arg === 'boolean' ? (arg ? 'on' : 'off') : 'none';

function argTokens(arg: WorkflowArg, scope: Scope): Token[] {
	if (Array.isArray(arg)) return [text(arg.join(', '))];
	if (arg && typeof arg === 'object') return 'ref' in arg ? pathTokens(arg.ref, scope) : [setting(arg.param, scope)];
	return [text(literal(arg))];
}

export function predicateTokens(predicate: WorkflowPredicate, scope: Scope): Token[] {
	if ('truthy' in predicate) return predicate.truthy.includes('.') ? pathTokens(predicate.truthy, scope) : [...pathTokens(predicate.truthy, scope), text(' is present')];
	if ('eq' in predicate) { const [path, expected] = predicate.eq; return [...pathTokens(path, scope), text(expected === null ? ' is empty' : typeof expected === 'boolean' ? (expected ? ' is on' : ' is off') : ` is ${literal(expected)}`)]; }
	if ('gt' in predicate) return [...pathTokens(predicate.gt[0], scope), text(` is more than ${predicate.gt[1].toLocaleString('en-AU')}`)];
	if ('lt' in predicate) return [...pathTokens(predicate.lt[0], scope), text(` is less than ${predicate.lt[1].toLocaleString('en-AU')}`)];
	if ('param' in predicate) return [setting(predicate.param, scope), text(' is on')];
	if ('not' in predicate) {
		const inner = predicate.not;
		if ('eq' in inner) { const [path, expected] = inner.eq; return [...pathTokens(path, scope), text(expected === null ? ' is not empty' : typeof expected === 'boolean' ? (expected ? ' is off' : ' is on') : ` is not ${literal(expected)}`)]; }
		if ('truthy' in inner) return [...pathTokens(inner.truthy, scope), text(inner.truthy.includes('.') ? ' is not set' : ' is missing')];
		if ('param' in inner) return [setting(inner.param, scope), text(' is off')];
		return [text('not ('), ...predicateTokens(inner, scope), text(')')];
	}
	const list = 'and' in predicate ? predicate.and : predicate.or; const joiner = 'and' in predicate ? ' and ' : ' or ';
	return list.flatMap((p, i) => i === 0 ? predicateTokens(p, scope) : [text(joiner), ...predicateTokens(p, scope)]);
}

/** The catalogue's words, without the plan reference and with a capital. Missing keys are said plainly. */
const doesWords = (key: string, catalog: WorkflowCatalog): string => {
	const does = catalog[key]?.does; if (!does) return `Runs the step “${key}”`;
	const plain = does.replace(/\s*\(D\d+\)\s*$/, '');
	return plain.charAt(0).toUpperCase() + plain.slice(1);
};

function actionLine(step: WorkflowActionStep, path: string, depth: number, scope: Scope, catalog: WorkflowCatalog): Line {
	const detail: Token[][] = [];
	if (step.kind === 'infer') detail.push([text(`${step.tier === 'large' ? 'The large model' : 'The small model'}, answering in the “${step.schema ?? 'expected'}” shape.`)]);
	if (step.kind === 'await') detail.push([text(`Until ${catalog[step.key]?.until ?? 'it is done'}${step.timeoutDays ? `, giving up after ${step.timeoutDays} days` : ''}.`)]);
	const args = Object.entries(step.args ?? {});
	if (args.length) detail.push([text('With '), ...args.flatMap(([name, arg], i) => [text(`${i ? ' · ' : ''}${words(name)}: `), ...argTokens(arg, scope)])]);
	return { type: 'step', path, depth, kind: step.kind, label: kindLabels[step.kind], does: doesWords(step.key, catalog), detail, when: step.when ? predicateTokens(step.when, scope) : null, savedAs: step.as ? words(step.as) : null };
}

/** One line per step, control flow included, with the engine's path shape (`steps.1.steps.2.then.0`). */
export function stepLines(definition: WorkflowDefinition, catalog: WorkflowCatalog): Line[] {
	const lines: Line[] = [];
	const walk = (steps: WorkflowStep[], parent: string, depth: number, scope: Scope) => {
		steps.forEach((step, index) => {
			const path = `${parent}.${index}`;
			if (step.kind === 'each') {
				const noun = singular(step.list);
				lines.push({ type: 'each', path, depth, noun, list: pathTokens(step.list, scope), independent: Boolean(step.independent) });
				walk(step.steps, `${path}.steps`, depth + 1, { ...scope, nouns: [...scope.nouns, noun] });
				lines.push({ type: 'end', path: `${path}.end`, depth, of: 'each', noun });
			} else if (step.kind === 'branch') {
				lines.push({ type: 'if', path, depth, when: predicateTokens(step.when, scope) });
				walk(step.then, `${path}.then`, depth + 1, scope);
				if (step.else?.length) { lines.push({ type: 'otherwise', path: `${path}.otherwise`, depth }); walk(step.else, `${path}.else`, depth + 1, scope); }
				lines.push({ type: 'end', path: `${path}.end`, depth, of: 'if' });
			} else lines.push(actionLine(step, path, depth, scope, catalog));
		});
	};
	walk(definition.steps, 'steps', 0, { nouns: [], definition });
	return lines;
}

/** A journal path with its loop indices removed, so it matches a definition line. */
export const definitionPath = (runPath: string): string => runPath.replace(/\[\d+\]/g, '');

export type StateCounts = Partial<Record<'succeeded' | 'running' | 'waiting' | 'skipped' | 'failed', number>>;
/** How far a run got on each definition line, counting loop items. */
export function runStates(steps: { path: string; state: string }[]): Map<string, StateCounts> {
	const states = new Map<string, StateCounts>();
	for (const step of steps) {
		const path = definitionPath(step.path); const counts = states.get(path) ?? {};
		const state = step.state as keyof StateCounts; counts[state] = (counts[state] ?? 0) + 1; states.set(path, counts);
	}
	return states;
}

const stateNames: [keyof StateCounts, string][] = [['succeeded', 'done'], ['running', 'running'], ['waiting', 'waiting'], ['skipped', 'skipped'], ['failed', 'failed']];
/** `done ×12 · waiting ×3`, or `done` for a step that ran once. */
export function stateWords(counts: StateCounts): { text: string; tone: 'done' | 'waiting' | 'failed' | 'quiet' } {
	const parts = stateNames.filter(([state]) => counts[state]).map(([state, name]) => `${name}${(counts[state] ?? 0) > 1 ? ` ×${counts[state]}` : ''}`);
	const tone = counts.failed ? 'failed' : counts.waiting || counts.running ? 'waiting' : counts.succeeded ? 'done' : 'quiet';
	return { text: parts.join(' · '), tone };
}
